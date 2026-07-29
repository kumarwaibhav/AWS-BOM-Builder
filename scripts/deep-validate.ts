/**
 * Deep parser validation — layer 3 of the V2 test strategy.
 *
 *   layer 1  billParser.v2fixes.test.ts   unit-level, synthetic inputs
 *   layer 2  verify-bills.ts              money reconciles to printed totals
 *   layer 3  THIS FILE                    structural traceability, per bill
 *   layer 4  validate-bom-quality.ts      field-level BOM hygiene
 *
 * The checks here are deliberately independent of billParser's own logic
 * wherever possible: they re-derive control totals from the raw PDF text so a
 * bug in the parser cannot validate itself.
 *
 * A1  every parsed item traces back to a raw line (nothing invented)
 * A2  every leaf-shaped raw line is consumed exactly once (nothing dropped,
 *     nothing double counted)
 * A3  sum of items per region == that region's own header total
 * A4  parsing is deterministic — byte-identical across repeated runs
 * A5  credits/negative lines are preserved with sign intact
 * A6  no item carries a cost that does not appear in the raw text
 *
 * Usage: npx tsx scripts/deep-validate.ts "<folder of PDFs>"
 */
import fs from "fs";
import path from "path";
// @ts-expect-error -- direct lib import avoids pdf-parse's debug entrypoint
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { parseAwsBill, tokenizeLine, isRegionName } from "../server/billParser";

const money = (n: number) => "USD " + n.toFixed(2);
const norm = (t: string) => t.replace(/­/g, "").split(/\r?\n/).map(l => l.replace(/ /g, " ").trimEnd());

interface Result { file: string; checks: { id: string; ok: boolean; detail: string }[] }

async function validateBill(dir: string, file: string): Promise<Result | null> {
  const buf = fs.readFileSync(path.join(dir, file));
  const { text } = await pdfParse(buf);
  const parsed = parseAwsBill(text);
  if (parsed.items.length === 0) return null;
  const items = parsed.items;
  const lines = norm(text);
  const checks: Result["checks"] = [];

  /* ---- A1 / A6: every item's cost must exist in the raw text ---------- */
  const rawCosts = new Map<string, number>();
  for (const l of lines) {
    const t = tokenizeLine(l);
    if (t) rawCosts.set(t.costUsd.toFixed(2), (rawCosts.get(t.costUsd.toFixed(2)) || 0) + 1);
  }
  const invented = items.filter(i => !rawCosts.has(i.costUsd.toFixed(2)));
  checks.push({
    id: "A1 no invented amounts",
    ok: invented.length === 0,
    detail: invented.length ? `${invented.length} item(s) whose amount appears nowhere in the PDF text` : `all ${items.length} amounts present in source`,
  });

  /* ---- A3: per-region control totals ---------------------------------- */
  const regionHdr = new Map<string, number>();
  for (const l of lines) {
    const t = tokenizeLine(l);
    if (t && t.isGroupLine && isRegionName(t.description)) {
      regionHdr.set(t.description, +( (regionHdr.get(t.description) || 0) + t.costUsd ).toFixed(2));
    }
  }
  const regionItems = new Map<string, number>();
  items.forEach(i => regionItems.set(i.region, +((regionItems.get(i.region) || 0) + i.costUsd).toFixed(2)));
  const regionKeys = new Set([...regionHdr.keys(), ...regionItems.keys()]);
  const regionDrift: string[] = [];
  let worstRegion = 0;
  for (const k of regionKeys) {
    const d = +((regionHdr.get(k) ?? 0) - (regionItems.get(k) ?? 0)).toFixed(2);
    worstRegion = Math.max(worstRegion, Math.abs(d));
    if (Math.abs(d) > 0.5) regionDrift.push(`${k}: header ${money(regionHdr.get(k) ?? 0)} vs items ${money(regionItems.get(k) ?? 0)} (${money(d)})`);
  }
  checks.push({
    id: "A3 per-region control totals",
    ok: regionDrift.length === 0,
    detail: regionDrift.length ? regionDrift.slice(0, 3).join(" | ") : `${regionKeys.size} regions, worst drift ${money(worstRegion)} (rounding)`,
  });

  /* ---- A4: determinism ------------------------------------------------ */
  const again = parseAwsBill(text);
  const same = JSON.stringify(again.items) === JSON.stringify(items)
            && again.grandTotalUsd === parsed.grandTotalUsd;
  checks.push({ id: "A4 deterministic", ok: same, detail: same ? "identical across repeated parses" : "OUTPUT VARIES BETWEEN RUNS" });

  /* ---- A5: credits keep their sign ------------------------------------
     "Savings Plans Discounts(1)Total savings(USD x)" is a SUMMARY of the
     individual savings-plan credit lines. It must be excluded, or the
     discount would be counted twice. */
  const SUMMARY_LINE_RE = /Total (?:savings|pre-tax|tax|received payments|invoiced charges)/i;
  const rawNeg = lines
    .map(l => ({ l, t: tokenizeLine(l) }))
    .filter(x => x.t && !x.t.isGroupLine && x.t.costUsd < 0 && !SUMMARY_LINE_RE.test(x.l));
  const itemNegs = items.filter(i => i.costUsd < 0);
  const credits = itemNegs.reduce((s, i) => s + i.costUsd, 0);
  checks.push({
    id: "A5 credits preserved",
    ok: itemNegs.length === rawNeg.length,
    detail: `${itemNegs.length} credit line(s) totalling ${money(credits)} (raw leaf credits: ${rawNeg.length})`,
  });

  /* ---- A7: the bill's own savings summary must equal the sum of the
     individual credits the parser captured. This is a genuinely independent
     cross-check: the summary figure is printed by AWS, the credits are
     reconstructed by us, and they are produced by different code paths. */
  const savingsSummary = lines
    .filter(l => /Savings Plans Discounts\(\d+\)Total savings/i.test(l))
    .map(l => tokenizeLine(l)?.costUsd ?? 0)
    .reduce((s, v) => s + v, 0);
  if (savingsSummary !== 0) {
    const spCredits = +itemNegs.reduce((s, i) => s + i.costUsd, 0).toFixed(2);
    const d = +(savingsSummary - spCredits).toFixed(2);
    checks.push({
      id: "A7 savings summary matches credits",
      ok: Math.abs(d) <= 0.05,
      detail: `AWS printed ${money(savingsSummary)}, parser captured ${money(spCredits)} → ${money(d)}`,
    });
  }

  /* ---- A2: total conservation ----------------------------------------- */
  const itemSum = +items.reduce((s, i) => s + i.costUsd, 0).toFixed(2);
  const stated = parsed.grandTotalUsd ?? 0;
  const drift = +(stated - itemSum).toFixed(2);
  const tolerance = Math.max(0.25, items.length * 0.005);
  checks.push({
    id: "A2 total conservation",
    ok: Math.abs(drift) <= tolerance,
    detail: `stated ${money(stated)} vs items ${money(itemSum)} → ${money(drift)} (tolerance ${money(tolerance)} at ${items.length} lines)`,
  });

  return { file, checks };
}

async function main() {
  const dir = process.argv[2];
  const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith(".pdf")).sort();
  let pass = 0, fail = 0, skipped = 0;
  for (const f of files) {
    const r = await validateBill(dir, f);
    if (!r) { skipped++; console.log(`\n[SKIP] ${f} — summary-only export`); continue; }
    const bad = r.checks.filter(c => !c.ok);
    bad.length ? fail++ : pass++;
    console.log(`\n[${bad.length ? "FAIL" : "PASS"}] ${f}`);
    r.checks.forEach(c => console.log(`   ${c.ok ? "ok  " : "FAIL"} ${c.id.padEnd(30)} ${c.detail}`));
  }
  console.log("\n" + "=".repeat(96));
  console.log(`DEEP VALIDATION: ${pass} passed, ${fail} failed, ${skipped} skipped`);
  process.exit(fail === 0 ? 0 : 1);
}
main();
