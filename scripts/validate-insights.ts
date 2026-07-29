/**
 * Phase 2 gate - insight invariants across every reference bill.
 *
 * The rule the whole feature rests on: NO MONEY MAY GO MISSING. Any
 * breakdown shown to a customer must account for every line item, and any
 * figure that cannot be derived must be declared unavailable rather than
 * silently omitted.
 *
 * Usage: npx tsx scripts/validate-insights.ts "<folder of PDFs>"
 */
import fs from "fs";
import path from "path";
// @ts-expect-error -- direct lib import avoids pdf-parse's debug entrypoint
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { parseAwsBill } from "../server/billParser";
import { computeInsights, pricingModel, instanceType, generation } from "../server/insights";
import type { InsightLineItem } from "../server/insights";

const money = (n: number) => "USD " + n.toFixed(2);
const near = (a: number, b: number, tol = 0.02) => Math.abs(a - b) <= tol;

async function main() {
  const dir = process.argv[2];
  const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith(".pdf")).sort();
  let pass = 0, fail = 0, skip = 0;

  for (const file of files) {
    const { text } = await pdfParse(fs.readFileSync(path.join(dir, file)));
    const items = parseAwsBill(text).items as InsightLineItem[];
    if (items.length === 0) { skip++; console.log(`\n[SKIP] ${file}`); continue; }

    const ins = computeInsights(items);
    const bad: string[] = [];
    const total = ins.totalUsd;
    const sumOf = (rows: { costUsd: number }[]) => Math.round(rows.reduce((s, r) => s + r.costUsd, 0) * 100) / 100;

    // I1 every full-coverage breakdown must account for the entire bill
    for (const [name, rows] of [
      ["byCategory", ins.byCategory], ["byRegion", ins.byRegion],
      ["byService", ins.byService], ["byPricingModel", ins.byPricingModel],
    ] as const) {
      if (!near(sumOf(rows as any), total, 0.05)) {
        bad.push(`I1 ${name} sums to ${money(sumOf(rows as any))}, bill total is ${money(total)}`);
      }
    }

    // I2 the region x category matrix must also reconstruct the whole bill
    if (!near(sumOf(ins.regionCategoryMatrix), total, 0.05)) {
      bad.push(`I2 matrix sums to ${money(sumOf(ins.regionCategoryMatrix))}, expected ${money(total)}`);
    }

    // I3 every line must receive exactly one pricing model
    const modelled = items.map(pricingModel);
    if (modelled.some(m => !m)) bad.push("I3 some lines have no pricing model");
    if (modelled.length !== items.length) bad.push("I3 pricing model count mismatch");

    // I4 partial breakdowns must never exceed their own population
    const instanceItems = items.filter(i => instanceType(i) !== null);
    const instanceTotal = Math.round(instanceItems.reduce((s, i) => s + i.costUsd, 0) * 100) / 100;
    if (!near(sumOf(ins.byInstanceType), instanceTotal, 0.05)) {
      bad.push(`I4 byInstanceType ${money(sumOf(ins.byInstanceType))} != instance spend ${money(instanceTotal)}`);
    }
    if (!near(sumOf(ins.byGeneration), instanceTotal, 0.05)) {
      bad.push(`I4 byGeneration ${money(sumOf(ins.byGeneration))} != instance spend ${money(instanceTotal)}`);
    }

    // I5 shares must be coherent
    const shareSum = ins.byCategory.reduce((s, r) => s + r.share, 0);
    if (total !== 0 && !near(shareSum, 1, 0.01)) bad.push(`I5 category shares sum to ${shareSum.toFixed(4)}, expected 1`);

    // I6 every instance type must resolve to a generation
    const noGen = ins.byInstanceType.filter(r => generation(r.key) === null);
    if (noGen.length) bad.push(`I6 ${noGen.length} instance type(s) with no generation: ${noGen.slice(0, 3).map(r => r.key).join(", ")}`);

    // I7 machine rates must be finite and non-negative. Zero is legitimate:
    // hours fully covered by a Reserved Instance or Savings Plan are billed
    // at USD 0.00 on the usage line, with the money in a separate fee.
    const badRate = ins.machineRates.filter(r => !Number.isFinite(r.effectiveRateUsd) || r.effectiveRateUsd < 0);
    if (badRate.length) bad.push(`I7 ${badRate.length} machine rate(s) non-finite or negative`);
    // I7b a blended rate must equal its components, so the UI can never show
    // a total that disagrees with the breakdown beneath it.
    for (const r of ins.machineRates) {
      const h = r.byModel.reduce((s2, m) => s2 + m.hours, 0);
      const c2 = r.byModel.reduce((s2, m) => s2 + m.costUsd, 0);
      if (!near(h, r.hours, 0.01)) { bad.push(`I7b ${r.instanceType}/${r.region} model hours ${h} != ${r.hours}`); break; }
      if (!near(c2, r.costUsd, 0.02)) { bad.push(`I7b ${r.instanceType}/${r.region} model cost ${c2} != ${r.costUsd}`); break; }
    }

    // I8 commitment arithmetic must be internally consistent
    const c = ins.commitment;
    if (c.coverageOfOnDemand < 0 || c.coverageOfOnDemand > 1.5) {
      bad.push(`I8 coverage ${(c.coverageOfOnDemand * 100).toFixed(1)}% outside a sane range`);
    }
    if (c.savingsPlanCreditsUsd < 0) bad.push("I8 savings-plan credits should be reported as a positive magnitude");
    const anyCommit = c.savingsPlanCreditsUsd > 0 || c.reservedUsd > 0 || c.spotUsd > 0 || c.savingsPlanFeesUsd > 0;
    if (anyCommit === c.hasNoCommitment) bad.push("I8 hasNoCommitment disagrees with the commitment figures");

    // I9 anything underivable must be declared, not hidden
    if (ins.machineRates.length === 0 && !ins.notes.some(n => /per-machine rates/.test(n.message))) {
      bad.push("I9 no machine rates, yet no note explaining why");
    }

    bad.length ? fail++ : pass++;
    console.log(`\n[${bad.length ? "FAIL" : "PASS"}] ${file}`);
    console.log(`   total ${money(total)} | ${ins.lineCount} lines | ${ins.categoryCount} cats | ${ins.regionCount} regions`
      + ` | ${ins.machineRates.length} machine/region rates`);
    console.log(`   commitment: gross OD ${money(c.grossOnDemandUsd)}, SP credits ${money(c.savingsPlanCreditsUsd)},`
      + ` SP fees ${money(c.savingsPlanFeesUsd)}, RI ${money(c.reservedUsd)}, Spot ${money(c.spotUsd)}`
      + ` -> coverage ${(c.coverageOfOnDemand * 100).toFixed(1)}%`);
    if (ins.notes.length) ins.notes.forEach(n => console.log(`   [${n.kind}/${n.topic}] ${n.message}`));
    bad.forEach(b => console.log(`   FAIL ${b}`));
  }

  console.log("\n" + "=".repeat(96));
  console.log(`INSIGHT INVARIANTS: ${pass} passed, ${fail} failed, ${skip} skipped`);
  process.exit(fail === 0 ? 0 : 1);
}
main();
