/**
 * Independent bill-accuracy verification harness.
 *
 * Runs the app's real parseAwsBill() against a folder of raw AWS billing
 * PDFs (the exact function the deployed server calls), then cross-checks
 * its output against a SEPARATE, independently-written extraction of each
 * bill's own stated totals -- not by reusing billParser.ts's regexes, but
 * by scanning the raw text fresh, so a bug in billParser.ts's own total
 * extraction can't silently pass its own check.
 *
 * Three independent numbers are compared per bill:
 *   1. calculatedTotal        - sum of parsed line items (what bills.ts stores
 *                                as calculatedTotalUsd)
 *   2. appGrandTotal          - parseAwsBill()'s own extraction of the
 *                                bill's printed total (what bills.ts stores
 *                                as grandTotalUsd)
 *   3. independentGrandTotal  - this script's own fresh regex scan of the
 *                                bill's printed total, plus the sum of
 *                                per-provider "Total pre-tax" subtotal lines
 *                                as a second cross-check
 *
 * Usage: npx tsx scripts/verify-bills.ts "<folder of PDFs>"
 */
import fs from "fs";
import path from "path";
// @ts-expect-error -- import the lib file directly to avoid pdf-parse's
// package.json "main" pulling in its debug demo entrypoint.
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { parseAwsBill } from "../server/billParser";

const round2 = (n: number) => Math.round(n * 100) / 100;

interface IndependentTotals {
  independentGrandTotal: number | null;
  grandTotalLineText: string | null;
  providerSubtotals: number[];
  providerSubtotalSum: number | null;
}

/**
 * Fresh, separate extraction of a bill's own stated totals -- deliberately
 * NOT calling into billParser.ts, so this can catch phrasing billParser.ts's
 * own regex misses (e.g. "Grand total:" without the "Estimated" prefix).
 */
function independentExtractTotals(text: string): IndependentTotals {
  const lines = text
    .replace(/ /g, " ")
    .split(/\r?\n/)
    .map(l => l.trim());

  let independentGrandTotal: number | null = null;
  let grandTotalLineText: string | null = null;
  const providerSubtotals: number[] = [];

  for (const l of lines.slice(0, 400)) {
    if (independentGrandTotal === null) {
      // Matches both "Estimated grand total:USD X" and "Grand total:USD X"
      const gt = l.match(/(?:estimated\s+)?grand total:\s*usd\s?([\d,.]+)/i);
      if (gt) {
        independentGrandTotal = parseFloat(gt[1].replace(/,/g, ""));
        grandTotalLineText = l;
      }
    }
    // Per-provider subtotal lines: "<Provider Name>(N)Total pre-taxUSD X"
    const pt = l.match(/\(\d+\)total pre-tax\s*usd\s?([\d,.]+)/i);
    if (pt) providerSubtotals.push(parseFloat(pt[1].replace(/,/g, "")));
  }

  const providerSubtotalSum =
    providerSubtotals.length > 0 ? round2(providerSubtotals.reduce((a, b) => a + b, 0)) : null;

  return { independentGrandTotal, grandTotalLineText, providerSubtotals, providerSubtotalSum };
}

interface BillResult {
  file: string;
  pages: number;
  itemCount: number;
  billingPeriod: string | null;
  accountId: string | null;
  calculatedTotal: number;
  appGrandTotal: number | null;
  independentGrandTotal: number | null;
  providerSubtotalSum: number | null;
  providerCount: number;
  issues: string[];
}

async function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error("Usage: npx tsx scripts/verify-bills.ts <folder of PDFs>");
    process.exit(1);
  }

  const files = fs
    .readdirSync(dir)
    .filter(f => f.toLowerCase().endsWith(".pdf"))
    .sort();

  if (files.length === 0) {
    console.error(`No PDF files found in ${dir}`);
    process.exit(1);
  }

  const results: BillResult[] = [];

  for (const file of files) {
    const buf = fs.readFileSync(path.join(dir, file));
    const data = await pdfParse(buf);
    const parsed = parseAwsBill(data.text);
    const calculatedTotal = round2(parsed.items.reduce((s, i) => s + i.costUsd, 0));
    const { independentGrandTotal, providerSubtotalSum, providerSubtotals } =
      independentExtractTotals(data.text);

    const issues: string[] = [];

    if (parsed.items.length === 0) {
      issues.push("Zero line items extracted (no itemized charges section found in this PDF)");
    }

    const badItems = parsed.items.filter(i => Number.isNaN(i.costUsd));
    if (badItems.length > 0) {
      issues.push(`${badItems.length} item(s) have NaN costUsd`);
    }

    if (parsed.grandTotalUsd === null && independentGrandTotal !== null) {
      issues.push(
        `App's grandTotalUsd extraction found nothing, but an independent scan found USD ${independentGrandTotal} -- billParser.ts's own regex is missing a phrasing variant in this bill`
      );
    } else if (
      parsed.grandTotalUsd !== null &&
      independentGrandTotal !== null &&
      Math.abs(parsed.grandTotalUsd - independentGrandTotal) > 0.01
    ) {
      issues.push(
        `App grandTotalUsd (USD ${parsed.grandTotalUsd}) disagrees with independent scan (USD ${independentGrandTotal})`
      );
    }

    if (independentGrandTotal !== null) {
      const diff = round2(Math.abs(calculatedTotal - independentGrandTotal));
      if (diff > 0.01) {
        issues.push(
          `Calculated line-item sum (USD ${calculatedTotal}) vs. bill's stated total (USD ${independentGrandTotal}): diff USD ${diff}`
        );
      }
    }

    if (
      providerSubtotalSum !== null &&
      independentGrandTotal !== null &&
      Math.abs(providerSubtotalSum - independentGrandTotal) > 0.01
    ) {
      issues.push(
        `Sum of per-provider "Total pre-tax" lines (USD ${providerSubtotalSum}) disagrees with the stated grand total (USD ${independentGrandTotal})`
      );
    }

    results.push({
      file,
      pages: data.numpages,
      itemCount: parsed.items.length,
      billingPeriod: parsed.billingPeriod,
      accountId: parsed.accountId,
      calculatedTotal,
      appGrandTotal: parsed.grandTotalUsd,
      independentGrandTotal,
      providerSubtotalSum,
      providerCount: providerSubtotals.length,
      issues,
    });
  }

  // ---- report ----
  console.log("\n" + "=".repeat(100));
  console.log("BILL ACCURACY VERIFICATION REPORT");
  console.log("=".repeat(100));

  let passCount = 0;
  for (const r of results) {
    const status = r.issues.length === 0 ? "PASS" : "FAIL";
    if (status === "PASS") passCount++;
    console.log(`\n[${status}] ${r.file}`);
    console.log(
      `  pages=${r.pages} items=${r.itemCount} period="${r.billingPeriod}" account=${r.accountId} providers=${r.providerCount}`
    );
    console.log(
      `  calculatedTotal=${r.calculatedTotal}  appGrandTotal=${r.appGrandTotal}  independentGrandTotal=${r.independentGrandTotal}  providerSubtotalSum=${r.providerSubtotalSum}`
    );
    for (const issue of r.issues) {
      console.log(`  - ${issue}`);
    }
  }

  console.log("\n" + "=".repeat(100));
  console.log(`SUMMARY: ${passCount}/${results.length} bills passed all checks`);
  console.log("=".repeat(100) + "\n");

  // machine-readable dump too
  fs.writeFileSync(
    path.join(path.dirname(new URL(import.meta.url).pathname), "verify-bills-results.json"),
    JSON.stringify(results, null, 2)
  );

  process.exit(results.some(r => r.issues.length > 0) ? 1 : 0);
}

main();
