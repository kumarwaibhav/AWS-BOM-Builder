/**
 * BOM quality gate — the Phase 1 exit criteria for V2.
 *
 * verify-bills.ts proves the MONEY is right (line items reconcile to the
 * bill's own stated totals). This script proves the STRUCTURE is right:
 * every field the Consumption Insights layer will aggregate on must be
 * clean, or the insights will be confidently wrong.
 *
 * Usage: npx tsx scripts/validate-bom-quality.ts "<folder of PDFs>"
 */
import fs from "fs";
import path from "path";
// @ts-expect-error -- direct lib import avoids pdf-parse's debug entrypoint
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { parseAwsBill, isRegionName, isPlausibleUom, tokenizeLine } from "../server/billParser";

/** The closed category enum the enrichment step is constrained to. */
const VALID_CATEGORIES = new Set([
  "Compute", "Storage", "Database", "Networking & Content Delivery",
  "Analytics", "Management & Governance", "Security, Identity & Compliance",
  "Application Integration", "Machine Learning & AI", "Developer Tools",
  "Containers", "End User Computing", "Business Applications",
  "Migration & Transfer", "Media Services", "Internet of Things",
  "AWS Marketplace", "Support", "Other",
]);

interface Finding { severity: "FAIL" | "WARN"; message: string }

async function main() {
  const dir = process.argv[2];
  if (!dir) { console.error("usage: validate-bom-quality.ts <folder>"); process.exit(2); }
  const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith(".pdf")).sort();

  let failed = 0;
  const globalUnits = new Map<string, number>();

  for (const file of files) {
    const { text } = await pdfParse(fs.readFileSync(path.join(dir, file)));
    const parsed = parseAwsBill(text);
    const items = parsed.items;
    const findings: Finding[] = [];

    if (items.length === 0) {
      console.log(`\n[SKIP] ${file} — no itemised charges (summary-only export)`);
      continue;
    }

    // 1. category must be one of the closed enum, never blank
    const blank = items.filter(i => !i.serviceCategory);
    const unknown = items.filter(i => i.serviceCategory && !VALID_CATEGORIES.has(i.serviceCategory));
    const blankUsd = blank.reduce((s, i) => s + i.costUsd, 0);
    if (blank.length) findings.push({
      severity: blankUsd >= 0.01 ? "FAIL" : "WARN",
      message: `${blank.length} line(s) with no category, USD ${blankUsd.toFixed(2)} (fall through to LLM enrichment)`,
    });
    if (unknown.length) findings.push({
      severity: "FAIL",
      message: `${unknown.length} line(s) with a category outside the 19-value enum: ${[...new Set(unknown.map(i => i.serviceCategory))].join(", ")}`,
    });

    // 2. region must be a known AWS region name
    const badRegion = items.filter(i => !isRegionName(i.region));
    if (badRegion.length) findings.push({
      severity: "FAIL",
      message: `${badRegion.length} line(s) with an unrecognised region: ${[...new Set(badRegion.map(i => i.region))].slice(0, 5).join(", ")}`,
    });

    // 3. cost must be a finite 2dp number
    const badCost = items.filter(i => !Number.isFinite(i.costUsd) || Math.abs(i.costUsd * 100 - Math.round(i.costUsd * 100)) > 1e-6);
    if (badCost.length) findings.push({ severity: "FAIL", message: `${badCost.length} line(s) with a non-2dp or non-finite cost` });

    // 4. every unit that appears must be recognised — an unrecognised unit
    //    means the line was misread as a header and its charge was DROPPED
    for (const raw of text.replace(/­/g, "").split(/\r?\n/).map(l => l.replace(/ /g, " ").trimEnd())) {
      const t = tokenizeLine(raw);
      if (!t || !t.isGroupLine || isRegionName(t.description)) continue;
      const m = t.description.match(/^(\d[\d,]*(?:\.\d+)?)[  ]+(.{1,40})$/);
      if (!m || isPlausibleUom(m[2].trim())) continue;
      findings.push({ severity: "FAIL", message: `dropped charge USD ${t.costUsd.toFixed(2)} — unrecognised unit "${m[2].trim()}"` });
    }

    // 5. collect the UOM vocabulary for the cross-bill report
    items.forEach(i => { if (i.uom) globalUnits.set(i.uom, (globalUnits.get(i.uom) || 0) + 1); });

    const fails = findings.filter(f => f.severity === "FAIL");
    if (fails.length) failed++;
    const tag = fails.length ? "FAIL" : findings.length ? "WARN" : "PASS";
    console.log(`\n[${tag}] ${file}  (${items.length} items, ${new Set(items.map(i => i.serviceCategory)).size} categories, ${new Set(items.map(i => i.region)).size} regions)`);
    findings.forEach(f => console.log(`   ${f.severity}: ${f.message}`));
  }

  console.log("\n" + "=".repeat(90));
  console.log(`UOM vocabulary across all bills: ${globalUnits.size} distinct units`);
  const suspicious = [...globalUnits.entries()].filter(([u]) => /\s{2,}|[A-Za-z]\s[a-z]{1,3}(?:$|\s)|\d{2,}\s/.test(u));
  if (suspicious.length) {
    console.log(`\n${suspicious.length} unit strings look corrupted by PDF column wrapping:`);
    suspicious.sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([u, n]) => console.log(`   ${String(n).padStart(4)}x  "${u}"`));
  }
  console.log("=".repeat(90));
  console.log(failed === 0 ? "QUALITY GATE: PASS" : `QUALITY GATE: FAIL — ${failed} bill(s) with blocking findings`);
  process.exit(failed === 0 ? 0 : 1);
}
main();
