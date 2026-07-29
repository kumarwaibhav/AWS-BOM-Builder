/**
 * Full-pipeline audit: PDF -> parse -> Excel BOM -> insights, per bill.
 *
 * Runs the REAL production code paths and hunts for errors rather than
 * confirming known-good behaviour. Each check targets a specific class of
 * mistake:
 *   NUMERIC   NaN / Infinity / impossible shares
 *   ROUNDING  per-row rounding that stops a chart matching its own header
 *   STRUCTURE duplicate or empty keys, mis-sorted output, cell collisions
 *   SEMANTIC  headline figures that disagree with the underlying rows
 *   EXCEL     the workbook not containing what the BOM claims
 *   NOTES     plain-English notes asserting something untrue
 *
 * Usage: npx tsx scripts/audit-full.ts "<folder of PDFs>"
 */
import fs from "fs";
import path from "path";
import ExcelJS from "exceljs";
// @ts-expect-error -- direct lib import avoids pdf-parse's debug entrypoint
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { parseAwsBill } from "../server/billParser";
import { generateBomExcel } from "../server/excel";
import { computeInsights } from "../server/insights";
import type { InsightLineItem } from "../server/insights";

type Issue = { sev: "ERROR" | "WARN"; area: string; detail: string };
const usd = (n: number) => "$" + n.toFixed(2);
const finite = (n: unknown) => typeof n === "number" && Number.isFinite(n);

async function auditBill(dir: string, file: string) {
  const issues: Issue[] = [];
  const err = (area: string, detail: string) => issues.push({ sev: "ERROR", area, detail });
  const warn = (area: string, detail: string) => issues.push({ sev: "WARN", area, detail });

  const { text } = await pdfParse(fs.readFileSync(path.join(dir, file)));
  const parsed = parseAwsBill(text);
  const raw = parsed.items;
  if (raw.length === 0) return { file, skipped: true, issues, stats: null };

  const items: InsightLineItem[] = raw.map(r => ({
    region: r.region, serviceCategory: r.serviceCategory, serviceName: r.serviceName,
    description: r.description, quantity: r.quantity, uom: r.uom, costUsd: r.costUsd,
  }));
  const ins = computeInsights(items);
  const exact = items.reduce((s, i) => s + i.costUsd, 0);

  /* NUMERIC */
  ([["totalUsd", ins.totalUsd], ["coverage", ins.commitment.coverageOfOnDemand],
    ["grossOnDemand", ins.commitment.grossOnDemandUsd],
    ["spCredits", ins.commitment.savingsPlanCreditsUsd]] as Array<[string, number]>)
    .forEach(([k, v]) => { if (!finite(v)) err("NUMERIC", `${k} is ${v}`); });

  for (const [name, rows] of Object.entries(ins) as Array<[string, any]>) {
    if (!Array.isArray(rows)) continue;
    rows.forEach((r: any, idx: number) => {
      if (!r || typeof r !== "object") return;
      for (const [k, v] of Object.entries(r)) {
        if (typeof v === "number" && !Number.isFinite(v)) err("NUMERIC", `${name}[${idx}].${k} = ${v}`);
      }
      if (typeof r.share === "number") {
        if (r.share < -0.0001) warn("NUMERIC", `${name} negative share ${(r.share * 100).toFixed(2)}% for "${r.key}"`);
        if (r.share > 1.0001) err("NUMERIC", `${name} share > 100% (${(r.share * 100).toFixed(2)}%) for "${r.key}"`);
      }
    });
  }

  /* ROUNDING */
  for (const [name, rows] of [["byCategory", ins.byCategory], ["byRegion", ins.byRegion],
                              ["byService", ins.byService], ["byPricingModel", ins.byPricingModel]] as const) {
    const s = rows.reduce((a, r) => a + r.costUsd, 0);
    const drift = Math.abs(s - ins.totalUsd);
    if (drift > 0.05) err("ROUNDING", `${name} rows sum to ${usd(s)} vs total ${usd(ins.totalUsd)} (drift ${usd(drift)})`);
    else if (drift > 0.005) warn("ROUNDING", `${name} drift ${usd(drift)} from per-row rounding`);
  }
  if (Math.abs(ins.totalUsd - Math.round(exact * 100) / 100) > 0.005) {
    err("ROUNDING", `totalUsd ${usd(ins.totalUsd)} != exact sum ${usd(exact)}`);
  }

  /* STRUCTURE */
  for (const [name, rows] of Object.entries(ins) as Array<[string, any]>) {
    if (!Array.isArray(rows) || !rows.length || !("key" in (rows[0] ?? {}))) continue;
    const keys = rows.map((r: any) => r.key);
    if (new Set(keys).size !== keys.length) err("STRUCTURE", `${name} has duplicate keys`);
    if (keys.some((k: string) => k == null || k === "")) err("STRUCTURE", `${name} has an empty key`);
    const sortedKeys = [...rows].sort((a: any, b: any) => b.costUsd - a.costUsd).map((r: any) => r.key);
    if (JSON.stringify(sortedKeys) !== JSON.stringify(keys)) err("STRUCTURE", `${name} is not sorted by cost descending`);
  }
  const mkeys = ins.regionCategoryMatrix.map(m => m.region + " " + m.category);
  if (new Set(mkeys).size !== mkeys.length) err("STRUCTURE", "regionCategoryMatrix has colliding cells");
  if (ins.topLineItems.length !== Math.min(10, items.length)) {
    err("STRUCTURE", `topLineItems has ${ins.topLineItems.length}, expected ${Math.min(10, items.length)}`);
  }

  /* SEMANTIC */
  const trueTop = [...items].sort((a, b) => b.costUsd - a.costUsd)[0];
  if (ins.topLineItems[0] && Math.abs(ins.topLineItems[0].costUsd - trueTop.costUsd) > 0.005) {
    err("SEMANTIC", `topLineItems[0] ${usd(ins.topLineItems[0].costUsd)} != true max ${usd(trueTop.costUsd)}`);
  }
  const catCheck = new Map<string, number>();
  items.forEach(i => catCheck.set(i.serviceCategory || "Other",
    (catCheck.get(i.serviceCategory || "Other") ?? 0) + i.costUsd));
  ins.byCategory.forEach(r => {
    const truth = catCheck.get(r.key);
    if (truth === undefined) err("SEMANTIC", `byCategory has "${r.key}" which is not in the data`);
    else if (Math.abs(truth - r.costUsd) > 0.005) err("SEMANTIC", `byCategory "${r.key}" ${usd(r.costUsd)} != recomputed ${usd(truth)}`);
  });
  if (ins.regionCount !== new Set(items.map(i => i.region)).size) err("SEMANTIC", "regionCount disagrees with the data");
  if (ins.lineCount !== items.length) err("SEMANTIC", "lineCount disagrees with the data");

  const modelSum = ins.byPricingModel.reduce((s, r) => s + r.costUsd, 0);
  if (Math.abs(modelSum - ins.totalUsd) > 0.05) err("SEMANTIC", `pricing models sum to ${usd(modelSum)} vs ${usd(ins.totalUsd)}`);
  const modelLines = ins.byPricingModel.reduce((s, r) => s + r.lineCount, 0);
  if (modelLines !== items.length) err("SEMANTIC", `pricing models cover ${modelLines} lines of ${items.length}`);

  const matrixSum = ins.regionCategoryMatrix.reduce((s, m) => s + m.costUsd, 0);
  if (Math.abs(matrixSum - ins.totalUsd) > 0.05) err("SEMANTIC", `matrix sums to ${usd(matrixSum)} vs ${usd(ins.totalUsd)}`);

  ins.machineRates.forEach(r => {
    const h = r.byModel.reduce((s, m) => s + m.hours, 0);
    const c = r.byModel.reduce((s, m) => s + m.costUsd, 0);
    if (Math.abs(h - r.hours) > 0.01) err("SEMANTIC", `${r.instanceType}/${r.region} hours ${h} != ${r.hours}`);
    if (Math.abs(c - r.costUsd) > 0.02) err("SEMANTIC", `${r.instanceType}/${r.region} cost ${usd(c)} != ${usd(r.costUsd)}`);
    if (r.hours <= 0) err("SEMANTIC", `${r.instanceType}/${r.region} has ${r.hours} hours`);
    if (Math.abs(r.costUsd / r.hours - r.effectiveRateUsd) > 1e-6) err("SEMANTIC", `${r.instanceType} effective rate mismatch`);
    if (r.isBlended !== (r.byModel.length > 1)) err("SEMANTIC", `${r.instanceType} isBlended flag wrong`);
  });

  /* NOTES */
  ins.notes.forEach(n => {
    if (/undefined|NaN|\[object|Infinity/.test(n.message)) err("NOTES", `malformed: ${n.message.slice(0, 90)}`);
    if (!/[.!]$/.test(n.message.trim())) warn("NOTES", `no full stop: ${n.message.slice(0, 60)}`);
  });
  const cm = ins.commitment;
  if (ins.notes.some(n => n.topic === "commitment" && n.kind === "absent") !== cm.hasNoCommitment) {
    err("NOTES", "commitment note contradicts the commitment figures");
  }
  if (ins.notes.some(n => n.topic === "commitment" && n.kind === "partial")
      && !(cm.savingsPlanCreditsUsd > 0 && cm.savingsPlanFeesUsd === 0)) {
    err("NOTES", "payer-account note shown but the figures do not support it");
  }

  /* EXCEL */
  // Mirror the production caller exactly (server/routers/bills.ts), including
  // the sno column it assigns - passing raw items would silently produce a
  // workbook with an empty first column and prove nothing about production.
  const excelRows = raw.map((item, idx) => ({
    sno: idx + 1,
    region: item.region,
    serviceCategory: item.serviceCategory,
    serviceName: item.serviceName,
    description: item.description,
    quantity: item.quantity,
    uom: item.uom,
    costUsd: item.costUsd,
  }));
  const buf = await generateBomExcel(excelRows, {
    fileName: file, billingPeriod: parsed.billingPeriod, accountId: parsed.accountId,
    grandTotalUsd: parsed.grandTotalUsd, calculatedTotalUsd: exact,
  });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  const ws = wb.getWorksheet("AWS BOM");
  if (!ws) {
    err("EXCEL", "worksheet 'AWS BOM' missing");
  } else {
    let dataRows = 0, cellSum = 0, badCost = 0, blankCat = 0, blankRegion = 0;
    ws.eachRow((row, n) => {
      if (n === 1) return;
      const sno = row.getCell(1).value;
      if (typeof sno !== "number") return;           // TOTAL row
      dataRows++;
      const cost = row.getCell(8).value;
      if (typeof cost !== "number") badCost++; else cellSum += cost;
      if (!String(row.getCell(3).value ?? "").trim()) blankCat++;
      if (!String(row.getCell(2).value ?? "").trim()) blankRegion++;
    });
    if (dataRows !== items.length) err("EXCEL", `sheet has ${dataRows} data rows, BOM has ${items.length}`);
    if (badCost > 0) err("EXCEL", `${badCost} cost cell(s) not numeric (breaks downstream SUM)`);
    if (Math.abs(cellSum - exact) > 0.02) err("EXCEL", `sheet costs sum to ${usd(cellSum)} vs BOM ${usd(exact)}`);
    if (blankCat > 0) warn("EXCEL", `${blankCat} row(s) with a blank service category`);
    if (blankRegion > 0) warn("EXCEL", `${blankRegion} row(s) with a blank region`);
  }

  return {
    file, skipped: false, issues,
    stats: { lines: items.length, total: ins.totalUsd, cats: ins.categoryCount,
             regions: ins.regionCount, rates: ins.machineRates.length, notes: ins.notes.length },
  };
}

async function main() {
  const dir = process.argv[2];
  const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith(".pdf")).sort();
  let errors = 0, warns = 0, clean = 0, skipped = 0;

  for (const f of files) {
    const r = await auditBill(dir, f);
    if (r.skipped) { skipped++; console.log(`\n[SKIP ] ${f}`); continue; }
    const e = r.issues.filter(i => i.sev === "ERROR").length;
    const w = r.issues.filter(i => i.sev === "WARN").length;
    errors += e; warns += w; if (e === 0 && w === 0) clean++;
    const s = r.stats!;
    console.log(`\n[${e ? "ERROR" : w ? "WARN " : "OK   "}] ${f}`);
    console.log(`         ${s.lines} lines | ${usd(s.total)} | ${s.cats} cats | ${s.regions} regions | ${s.rates} rates | ${s.notes} notes`);
    r.issues.forEach(i => console.log(`         ${i.sev} ${i.area.padEnd(9)} ${i.detail}`));
  }

  console.log("\n" + "=".repeat(100));
  console.log(`FULL AUDIT: ${clean} clean, ${errors} error(s), ${warns} warning(s), ${skipped} skipped, of ${files.length} bills`);
  process.exit(errors === 0 ? 0 : 1);
}
main();
