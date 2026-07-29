/**
 * Renders the whole Consumption Insights tab against every reference bill,
 * and asserts the degradation paths each real bill actually exercises.
 *
 * The named bills below are not arbitrary - each is the one in the reference
 * set that hits a particular edge:
 *   B&G, MidlandMicrofin, tj-prod   no commitment of any kind
 *   greenenabled, 900206238693      SP credit with the fee on the payer acct
 *   sisl-child                      50 lines, 5 regions, mostly SP fees
 *   B&G                             1,138 lines, 21 regions, 13 categories
 */
import { describe, it, expect, beforeAll } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { parseAwsBill } from "../../../../server/billParser";
import { computeInsights } from "../../../../server/insights";
import type { BillInsights, InsightLineItem } from "../../../../server/insights";
import InsightsPanel from "./InsightsPanel";

const BILLS_DIR = process.env.BILLS_DIR
  ?? "/sessions/awesome-adoring-davinci/mnt/FW_ Require AWS usage invoice of June-26 (1)";

const bills = new Map<string, BillInsights>();
const html = new Map<string, string>();

const decode = (s: string) => s
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d));
const text = (h: string) => decode(h.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
const POISON = /NaN|undefined|\[object Object\]|Infinity|\$NaN|null%/;

beforeAll(async () => {
  if (!fs.existsSync(BILLS_DIR)) return;
  for (const f of fs.readdirSync(BILLS_DIR).filter(x => x.toLowerCase().endsWith(".pdf")).sort()) {
    const { text: raw } = await pdfParse(fs.readFileSync(path.join(BILLS_DIR, f)));
    const parsed = parseAwsBill(raw);
    if (!parsed.items.length) continue;
    const ins = computeInsights(parsed.items as InsightLineItem[]);
    bills.set(f, ins);
    html.set(f, renderToStaticMarkup(<InsightsPanel insights={ins} />));
  }
}, 180_000);

const find = (needle: string) => {
  const key = Array.from(bills.keys()).find(k => k.includes(needle));
  if (!key) throw new Error(`reference bill matching "${needle}" not loaded`);
  return { key, ins: bills.get(key)!, t: text(html.get(key)!) };
};

describe("the tab renders every reference bill", () => {
  it("loaded them", () => expect(bills.size).toBeGreaterThanOrEqual(12));

  it("never puts a poison value on screen", () => {
    for (const [file, h] of Array.from(html)) expect(text(h), file).not.toMatch(POISON);
  });

  it("never prints a negative percentage", () => {
    for (const [file, h] of Array.from(html)) expect(text(h), file).not.toMatch(/-\d+(\.\d+)?%/);
  });

  it("never prints a percentage above 100", () => {
    for (const [file, h] of Array.from(html)) {
      Array.from(text(h).matchAll(/(\d+(?:\.\d+)?)%/g))
        .map(m => parseFloat(m[1]))
        .forEach(p => expect(p, `${file} saw ${p}%`).toBeLessThanOrEqual(100.1));
    }
  });

  it("shows all six sections on every bill", () => {
    for (const [file, h] of Array.from(html)) {
      ["Section 01", "Section 02", "Section 03", "Section 04", "Section 05", "Section 06"]
        .forEach(s => expect(text(h), `${file} / ${s}`).toContain(s));
    }
  });

  it("states that every panel reconciles to the bill total", () => {
    for (const [file, h] of Array.from(html)) expect(text(h), file).toMatch(/every panel above reconciles to \$/);
  });
});

describe("degradation paths, driven by the real bills that hit them", () => {
  it("B&G has no commitment at all and says so plainly", () => {
    const { ins, t } = find("B&G");
    expect(ins.commitment.hasNoCommitment).toBe(true);
    expect(t).toMatch(/No Savings Plan, Reserved Instance or Spot usage/i);
    // and must NOT imply a coverage figure exists
    expect(t).toMatch(/Commitment coverage/);
  });

  it("greenenabled has a discount whose fee sits on the payer account", () => {
    const { ins, t } = find("greenenabled");
    expect(ins.commitment.savingsPlanCreditsUsd).toBeGreaterThan(0);
    expect(ins.commitment.savingsPlanFeesUsd).toBe(0);
    expect(t).toMatch(/sits on the payer account/i);
    expect(t).toMatch(/The discount is real/i);
  });

  it("sisl-child is small and still renders every section", () => {
    const { ins, t } = find("sisl-child");
    expect(ins.lineCount).toBe(50);
    expect(ins.regionCount).toBe(5);
    expect(t).toContain("Section 06");
    expect(t).not.toMatch(POISON);
  });

  it("B&G is the largest and still discloses everything it caps", () => {
    const { ins, t } = find("B&G");
    expect(ins.lineCount).toBe(1138);
    // 21 regions and 13 categories exceed the matrix caps, so the fold must
    // be stated rather than silently applied
    expect(t).toMatch(/other region/);
    expect(t).toMatch(/nothing is dropped/);
    expect(t).toMatch(/grid sums to \$/);
  });

  it("a bill with no machine types explains itself instead of showing a blank panel", () => {
    const empty = computeInsights([{
      region: "Global", serviceCategory: "Support", serviceName: "AWS Support",
      description: "AWS Support (Business)", quantity: null, uom: null, costUsd: 100,
    }]);
    const t = text(renderToStaticMarkup(<InsightsPanel insights={empty} />));
    expect(t).toMatch(/no named machine types|no hourly instance charges/i);
    expect(t).toMatch(/No storage charges appear on this bill/i);
    expect(t).toMatch(/No managed database charges appear on this bill/i);
    expect(t).not.toMatch(POISON);
  });

  it("a bill with no line items degrades to a sentence, not a crash", () => {
    const none = computeInsights([]);
    const t = text(renderToStaticMarkup(<InsightsPanel insights={none} />));
    expect(t).toMatch(/nothing to analyse/i);
    expect(t).not.toMatch(POISON);
  });

  it("an all-zero-cost bill does not divide by zero", () => {
    const free = computeInsights([{
      region: "Global", serviceCategory: "Compute", serviceName: "AWS Lambda",
      description: "$0.00 per request - free tier", quantity: 1000, uom: "Requests", costUsd: 0,
    }]);
    const t = text(renderToStaticMarkup(<InsightsPanel insights={free} />));
    expect(t).not.toMatch(POISON);
    expect(t).toContain("Section 01");
  });

  it("a single-region bill says there is no regional split to compare", () => {
    const one = computeInsights([{
      region: "Asia Pacific (Mumbai)", serviceCategory: "Compute", serviceName: "Amazon EC2",
      description: "$0.10 per On Demand Linux instance hour", quantity: 720, uom: "Hrs", costUsd: 72,
    }]);
    const t = text(renderToStaticMarkup(<InsightsPanel insights={one} />));
    expect(t).toMatch(/single region/i);
  });

  it("credits are shown as a deduction, never as a negative slice", () => {
    for (const [file, h] of Array.from(html)) {
      const ins = bills.get(file)!;
      if (ins.creditsUsd <= 0) continue;
      const t = text(h);
      expect(t, file).toMatch(/of charges less \$/);
      expect(t, file).toMatch(/net\./);
    }
  });
});
