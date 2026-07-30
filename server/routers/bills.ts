/**
 * Bills feature router: upload & parse AWS billing PDFs, list history,
 * fetch BOM items, and produce downloadable Excel files — all Supabase Storage-backed.
 * No user accounts, but no longer "trust whatever sessionId the client sends"
 * either: ctx.sessionId comes from a server-verified signed cookie (see
 * server/_core/sessionCookie.ts), never from request input.
 */
import { TRPCError } from "@trpc/server";
import { nanoid } from "nanoid";
import { z } from "zod";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { publicProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { parseAwsBill, hasItemizedCharges, detectBillCurrency } from "../billParser";
import { computeInsights } from "../insights";
import type { InsightLineItem } from "../insights";
import { enrichItems } from "../enrichment";
import { generateBomExcel } from "../excel";
import { storageGet, storagePut } from "../storage";

// Vercel Functions hard-cap the request body at 4.5 MB (platform limit,
// not configurable -- confirmed against Vercel's own docs, 2026-07-27).
// The PDF travels here base64-encoded inside a JSON body, which inflates
// its size by ~4/3, so the real usable ceiling is well under 4.5 MB of
// raw PDF bytes -- NOT the 25 MB this constant used to claim. That old
// number was never reachable in production: anything over ~3.3 MB raw
// was already being rejected by Vercel itself with a generic, unstyled
// "FUNCTION_PAYLOAD_TOO_LARGE" error before this code ever ran (found via
// direct testing against the live deployment). 3 MB raw leaves headroom
// for base64 inflation + JSON/HTTP overhead while staying safely under
// the hard 4.5 MB ceiling, and produces the app's own clear error
// instead of the platform's opaque one for anything larger.
const MAX_PDF_BYTES = 3 * 1024 * 1024; // 3 MB raw (see comment above)

/**
 * Postgres int4 ceiling. Without this bound, an id larger than 2^31-1
 * reaches the driver, overflows the column type, and the thrown error - which
 * embeds the full SELECT statement and every column name - is returned to the
 * caller verbatim. Found by fuzzing the deployed preview with billId 10^12:
 *
 *   Failed query: select "id", "sessionId", "fileName", "pdfKey", ...
 *
 * Rejecting it at the schema keeps the schema private and gives the caller a
 * plain validation error instead of a database stack trace.
 */
const MAX_BILL_ID = 2_147_483_647;

/**
 * A message that was written to be shown to a customer.
 *
 * Everything thrown inside the upload pipeline used to reach the customer
 * verbatim AND be persisted into the bill record, so the History archive
 * displayed library internals. Observed live: a PDF that pdf.js disliked
 * produced the entire user-facing error "bad XRef entry", in the toast and
 * then permanently in History.
 */
class UserFacingError extends Error {}

/**
 * Extract text from the PDF, retrying once.
 *
 * Observed live on the deployed preview: a byte-identical PDF - correct xref
 * entry offsets, correct startxref, valid trailer, read without complaint by
 * an independent parser, and delivered to the server intact - was accepted
 * once and then rejected four consecutive times with "bad XRef entry". The
 * extraction step is therefore not treated as deterministic. A retry costs
 * one PDF parse on a path that was already about to fail.
 */
async function extractPdfText(buffer: Buffer): Promise<string> {
  try {
    return (await pdfParse(buffer)).text;
  } catch (first) {
    console.error("[upload] PDF extraction failed, retrying once:", first);
    try {
      return (await pdfParse(buffer)).text;
    } catch (second) {
      console.error("[upload] PDF extraction failed on retry:", second);
      throw new UserFacingError(
        "This PDF could not be read. Its internal structure is not one the PDF reader accepts, " +
        "which is common in files produced by a PDF editor, by 'Print to PDF', or by a scanner. " +
        "Open the bill in AWS Billing and Cost Management, go to Bills, expand 'Charges by service', " +
        "and use your browser's own Save as PDF on that page - then upload the file it produces."
      );
    }
  }
}

export const billsRouter = router({
  /** Upload a PDF (base64), parse it, enrich, persist everything. */
  uploadAndParse: publicProcedure
    .input(
      z.object({
        fileName: z.string().min(1).max(500),
        base64: z.string().min(100),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const buffer = Buffer.from(input.base64, "base64");
      if (buffer.length > MAX_PDF_BYTES) {
        throw new TRPCError({
          code: "PAYLOAD_TOO_LARGE",
          message:
            "This PDF is too large to upload (limit: ~3 MB, a hosting platform constraint). " +
            "Try exporting a shorter billing period, or split a large consolidated bill into per-account PDFs.",
        });
      }
      if (!buffer.subarray(0, 5).toString("latin1").startsWith("%PDF")) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "File is not a valid PDF" });
      }

      // 1. store the original PDF in Supabase Storage
      const safeName = input.fileName.replace(/[^\w.\-]+/g, "_");
      const pdfKey = `bills/${ctx.sessionId}/${nanoid(10)}-${safeName}`;
      // These two steps run BEFORE the bill record exists, so they are outside
      // the pipeline's catch. Unguarded, a Supabase outage or a database error
      // here reached the customer as a raw driver message and left no failure
      // record at all - the upload simply appeared to evaporate.
      let billId: number;
      try {
        await storagePut(pdfKey, buffer, "application/pdf");

        // 2. create the bill record
        billId = await db.createBill({
          sessionId: ctx.sessionId,
          fileName: input.fileName,
          pdfKey,
          status: "processing",
        });
      } catch (err) {
        console.error("[upload] could not store the bill before processing:", err);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            "The bill could not be saved, so it was not processed. This is a problem on our side, " +
            "not with your file. Please try again in a moment.",
        });
      }

      try {
        // 3. extract text & parse
        const pdfText = await extractPdfText(buffer);
        const parsed = parseAwsBill(pdfText);
        if (parsed.items.length === 0) {
          // A bill in any currency other than USD parses to zero items, because
          // every amount pattern requires the literal "USD". Refusing is the
          // right outcome - reading "INR 41,500.00" as dollars would overstate
          // the BOM by roughly 85x, and converting it would mean inventing an
          // exchange rate this tool has no business inventing. But the customer
          // has to be told the actual reason, not asked to contact support.
          const currency = detectBillCurrency(pdfText);
          if (currency && currency !== "USD") {
            throw new UserFacingError(
              "This bill is denominated in " + currency + ", and this tool reads USD-denominated AWS " +
              "bills only. It will not convert " + currency + " to USD, because that would mean " +
              "applying an exchange rate the bill does not state. In the AWS console, open Billing " +
              "and Cost Management -> Payment preferences and check the invoice currency, or ask " +
              "the account owner for the USD version of this bill."
            );
          }
          throw new UserFacingError(
            hasItemizedCharges(pdfText)
              ? "No billing line items could be read from this PDF. It appears to contain a charges table, but none of the rows could be parsed - please share this file with support."
              : "This PDF is the AWS bill summary page, which shows only a grand total and no per-service charges. Open Billing and Cost Management -> Bills, expand 'Charges by service', then print or save that page as PDF and upload it here."
          );
        }

        // 4. LLM enrichment for ambiguous rows only. llmSucceededIndices
        //    reflects which items Gemini actually classified -- not which
        //    ones were merely *targeted* for enrichment, so a failed Gemini
        //    call (see enrichment.ts) is correctly reported as unenriched
        //    rather than silently mislabeled as AI-classified.
        const { items: enriched, llmSucceededIndices } = await enrichItems(parsed.items);

        // 5. Calculate grand total from line items (for reconciliation against
        //    the bill's own printed total). NOTE: an earlier "consolidation"
        //    step used to merge each on-demand line with its matching
        //    "covered by Compute Savings Plans" credit line here. It was
        //    removed — its instance-type matching collapsed different
        //    instance sizes in the same family (t3.small/t3.medium/t3.large
        //    all resolved to "t3", etc.), causing wrong lines to be merged
        //    and legitimate credits to be silently dropped, overstating a
        //    real bill's total by $56.74 (verified). The raw parsed+enriched
        //    items already reconcile with AWS's own total to the penny, and
        //    keeping the on-demand line and its savings-plan credit as two
        //    separate, clearly-labeled rows is more auditable anyway.
        const calculatedTotal = enriched.reduce((sum, item) => sum + item.costUsd, 0);

        // 6. persist BOM items
        await db.insertBomItems(
          enriched.map((item, idx) => ({
            billId,
            serialNo: idx + 1,
            region: item.region,
            serviceCategory: item.serviceCategory,
            serviceName: item.serviceName,
            description: item.description,
            quantity: item.quantity === null ? null : String(item.quantity),
            uom: item.uom,
            costUsd: item.costUsd.toFixed(2),
            llmEnriched: llmSucceededIndices.has(idx) ? 1 : 0,
          }))
        );

        // 7. generate the Excel BOM and store it in Supabase Storage
        const excelBuffer = await generateBomExcel(
          enriched.map((item, idx) => ({
            sno: idx + 1,
            region: item.region,
            serviceCategory: item.serviceCategory,
            serviceName: item.serviceName,
            description: item.description,
            quantity: item.quantity,
            uom: item.uom,
            costUsd: item.costUsd,
          })),
          {
            fileName: input.fileName,
            billingPeriod: parsed.billingPeriod,
            accountId: parsed.accountId,
            grandTotalUsd: parsed.grandTotalUsd,
            calculatedTotalUsd: calculatedTotal,
          }
        );
        const excelKey = `bom/${ctx.sessionId}/${nanoid(10)}-${safeName.replace(/\.pdf$/i, "")}-BOM.xlsx`;
        await storagePut(
          excelKey,
          excelBuffer,
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );

        // 8. finalize bill record
        await db.updateBill(billId, {
          status: "completed",
          excelKey,
          billingPeriod: parsed.billingPeriod,
          accountId: parsed.accountId,
          grandTotalUsd: parsed.grandTotalUsd === null ? null : parsed.grandTotalUsd.toFixed(2),
          calculatedTotalUsd: calculatedTotal.toFixed(2),
          itemCount: enriched.length,
        });

        return { billId, itemCount: enriched.length };
      } catch (err) {
        // Only messages deliberately written for a customer are shown. Storage,
        // database, enrichment and spreadsheet failures all used to be printed
        // verbatim in the toast and kept forever in the History archive.
        let message: string;
        if (err instanceof UserFacingError) {
          message = err.message;
        } else {
          console.error("[upload] unexpected failure for bill", billId, err);
          message =
            "Something went wrong while processing this bill, and it was not the bill's fault. " +
            "Please try uploading it again. If it fails a second time, send this file to support " +
            "and quote reference #" + billId + ".";
        }
        await db.updateBill(billId, { status: "failed", errorMessage: message });
        throw new TRPCError({ code: "UNPROCESSABLE_CONTENT", message });
      }
    }),

  /** Upload history for the current session. */
  list: publicProcedure.query(async ({ ctx }) => {
    return db.listBillsBySession(ctx.sessionId);
  }),

  /** A single bill + its BOM items (table preview). */
  get: publicProcedure
    .input(z.object({ billId: z.number().int().positive().max(MAX_BILL_ID) }))
    .query(async ({ input, ctx }) => {
      const bill = await db.getBillById(input.billId);
      if (!bill || bill.sessionId !== ctx.sessionId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Bill not found" });
      }
      const items = await db.getBomItemsByBill(bill.id);
      return { bill, items };
    }),

  /**
   * Consumption insights for a single bill.
   *
   * Computed on demand from the stored bom_items rather than cached, so
   * there is no schema change and no migration: the v2 branch and production
   * can keep sharing the same database safely. Aggregating ~1,100 rows is
   * sub-millisecond, so the cost is dominated by the existing DB read that
   * bills.get already performs.
   */
  getInsights: publicProcedure
    .input(z.object({ billId: z.number().int().positive().max(MAX_BILL_ID) }))
    .query(async ({ input, ctx }) => {
      const bill = await db.getBillById(input.billId);
      // Same ownership check as every other per-bill procedure: a bill that
      // is not yours is indistinguishable from one that does not exist.
      if (!bill || bill.sessionId !== ctx.sessionId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Bill not found" });
      }
      const rows = await db.getBomItemsByBill(bill.id);
      const items: InsightLineItem[] = rows.map(r => ({
        region: r.region,
        serviceCategory: r.serviceCategory,
        serviceName: r.serviceName,
        description: r.description,
        quantity: r.quantity === null ? null : Number(r.quantity),
        uom: r.uom,
        costUsd: Number(r.costUsd),
      }));
      return {
        billId: bill.id,
        fileName: bill.fileName,
        billingPeriod: bill.billingPeriod,
        accountId: bill.accountId,
        /** The invoice's own printed total, for the reconciliation banner. */
        statedTotalUsd: bill.grandTotalUsd === null ? null : Number(bill.grandTotalUsd),
        insights: computeInsights(items),
      };
    }),

  /** Signed Supabase Storage URL for the generated Excel BOM (re-download anytime). */
  downloadExcel: publicProcedure
    .input(z.object({ billId: z.number().int().positive().max(MAX_BILL_ID) }))
    .mutation(async ({ input, ctx }) => {
      const bill = await db.getBillById(input.billId);
      if (!bill || bill.sessionId !== ctx.sessionId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Bill not found" });
      }
      if (!bill.excelKey) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Excel file not generated for this bill" });
      }
      const { url } = await storageGet(bill.excelKey);
      return { url, fileName: bill.fileName.replace(/\.pdf$/i, "") + "-BOM.xlsx" };
    }),

  /** Signed Supabase Storage URL for the original uploaded PDF. */
  downloadPdf: publicProcedure
    .input(z.object({ billId: z.number().int().positive().max(MAX_BILL_ID) }))
    .mutation(async ({ input, ctx }) => {
      const bill = await db.getBillById(input.billId);
      if (!bill || bill.sessionId !== ctx.sessionId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Bill not found" });
      }
      const { url } = await storageGet(bill.pdfKey);
      return { url, fileName: bill.fileName };
    }),

  /** Delete a bill and its items from history. */
  remove: publicProcedure
    .input(z.object({ billId: z.number().int().positive().max(MAX_BILL_ID) }))
    .mutation(async ({ input, ctx }) => {
      const bill = await db.getBillById(input.billId);
      if (!bill || bill.sessionId !== ctx.sessionId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Bill not found" });
      }
      await db.deleteBill(bill.id);
      return { success: true };
    }),
});
