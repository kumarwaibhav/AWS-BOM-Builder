/**
 * Bills feature router: upload & parse AWS billing PDFs, list history,
 * fetch BOM items, and produce downloadable Excel files — all Cloudflare R2-backed.
 * No authentication required — anonymous access via sessionId.
 */
import { TRPCError } from "@trpc/server";
import { nanoid } from "nanoid";
import { z } from "zod";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { publicProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { parseAwsBill } from "../billParser";
import { enrichItems } from "../enrichment";
import { generateBomExcel } from "../excel";
import { storageGet, storagePut } from "../storage";
import { consolidateSavingsPlans } from "../consolidation";

const MAX_PDF_BYTES = 25 * 1024 * 1024; // 25 MB

export const billsRouter = router({
  /** Upload a PDF (base64), parse it, enrich, persist everything. */
  uploadAndParse: publicProcedure
    .input(
      z.object({
        fileName: z.string().min(1).max(500),
        base64: z.string().min(100),
        sessionId: z.string().min(1).max(128),
      })
    )
    .mutation(async ({ input }) => {
      const buffer = Buffer.from(input.base64, "base64");
      if (buffer.length > MAX_PDF_BYTES) {
        throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "PDF exceeds 25 MB limit" });
      }
      if (!buffer.subarray(0, 5).toString("latin1").startsWith("%PDF")) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "File is not a valid PDF" });
      }

      // 1. store the original PDF in R2
      const safeName = input.fileName.replace(/[^\w.\-]+/g, "_");
      const pdfKey = `bills/${input.sessionId}/${nanoid(10)}-${safeName}`;
      await storagePut(pdfKey, buffer, "application/pdf");

      // 2. create the bill record
      const billId = await db.createBill({
        sessionId: input.sessionId,
        fileName: input.fileName,
        pdfKey,
        status: "processing",
      });

      try {
        // 3. extract text & parse
        const pdfData = await pdfParse(buffer);
        const parsed = parseAwsBill(pdfData.text);
        if (parsed.items.length === 0) {
          throw new Error(
            "No billing line items found. Please upload a complete AWS 'Bills' PDF export (Billing and Cost Management → Bills → Print/Save as PDF)."
          );
        }

        // 4. LLM enrichment for ambiguous rows only
        const enrichedFlags = parsed.items.map(i => i.needsEnrichment || !i.serviceCategory);
        const enriched = await enrichItems(parsed.items);

        // 5. Consolidate Compute Savings Plan line pairs
        const consolidated = consolidateSavingsPlans(enriched);

        // 6. Calculate grand total from line items (for reconciliation)
        const calculatedTotal = consolidated.reduce((sum, item) => sum + item.costUsd, 0);

        // 7. persist BOM items
        await db.insertBomItems(
          consolidated.map((item, idx) => ({
            billId,
            serialNo: idx + 1,
            region: item.region,
            serviceCategory: item.serviceCategory,
            serviceName: item.serviceName,
            description: item.description,
            quantity: item.quantity === null ? null : String(item.quantity),
            uom: item.uom,
            costUsd: item.costUsd.toFixed(2),
            llmEnriched: enrichedFlags[consolidated.indexOf(item)] ? 1 : 0,
          }))
        );

        // 8. generate the Excel BOM and store it in R2
        const excelBuffer = await generateBomExcel(
          consolidated.map((item, idx) => ({
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
        const excelKey = `bom/${input.sessionId}/${nanoid(10)}-${safeName.replace(/\.pdf$/i, "")}-BOM.xlsx`;
        await storagePut(
          excelKey,
          excelBuffer,
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );

        // 9. finalize bill record
        await db.updateBill(billId, {
          status: "completed",
          excelKey,
          billingPeriod: parsed.billingPeriod,
          accountId: parsed.accountId,
          grandTotalUsd: parsed.grandTotalUsd === null ? null : parsed.grandTotalUsd.toFixed(2),
          calculatedTotalUsd: calculatedTotal.toFixed(2),
          itemCount: consolidated.length,
        });

        return { billId, itemCount: consolidated.length };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to parse PDF";
        await db.updateBill(billId, { status: "failed", errorMessage: message });
        throw new TRPCError({ code: "UNPROCESSABLE_CONTENT", message });
      }
    }),

  /** Upload history for the current session. */
  list: publicProcedure
    .input(z.object({ sessionId: z.string().min(1).max(128) }))
    .query(async ({ input }) => {
      return db.listBillsBySession(input.sessionId);
    }),

  /** A single bill + its BOM items (table preview). */
  get: publicProcedure
    .input(z.object({ billId: z.number().int().positive(), sessionId: z.string().min(1).max(128) }))
    .query(async ({ input }) => {
      const bill = await db.getBillById(input.billId);
      if (!bill || bill.sessionId !== input.sessionId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Bill not found" });
      }
      const items = await db.getBomItemsByBill(bill.id);
      return { bill, items };
    }),

  /** Presigned R2 URL for the generated Excel BOM (re-download anytime). */
  downloadExcel: publicProcedure
    .input(z.object({ billId: z.number().int().positive(), sessionId: z.string().min(1).max(128) }))
    .mutation(async ({ input }) => {
      const bill = await db.getBillById(input.billId);
      if (!bill || bill.sessionId !== input.sessionId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Bill not found" });
      }
      if (!bill.excelKey) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Excel file not generated for this bill" });
      }
      const { url } = await storageGet(bill.excelKey);
      return { url, fileName: bill.fileName.replace(/\.pdf$/i, "") + "-BOM.xlsx" };
    }),

  /** Presigned R2 URL for the original uploaded PDF. */
  downloadPdf: publicProcedure
    .input(z.object({ billId: z.number().int().positive(), sessionId: z.string().min(1).max(128) }))
    .mutation(async ({ input }) => {
      const bill = await db.getBillById(input.billId);
      if (!bill || bill.sessionId !== input.sessionId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Bill not found" });
      }
      const { url } = await storageGet(bill.pdfKey);
      return { url, fileName: bill.fileName };
    }),

  /** Delete a bill and its items from history. */
  remove: publicProcedure
    .input(z.object({ billId: z.number().int().positive(), sessionId: z.string().min(1).max(128) }))
    .mutation(async ({ input }) => {
      const bill = await db.getBillById(input.billId);
      if (!bill || bill.sessionId !== input.sessionId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Bill not found" });
      }
      await db.deleteBill(bill.id);
      return { success: true };
    }),
});
