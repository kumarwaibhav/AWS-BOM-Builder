/**
 * Renders every insights component against the REAL insight payload of every
 * reference bill, using React's server renderer (no DOM dependency).
 *
 * The gate this enforces, from the build plan: nothing may be hidden without
 * being disclosed, no NaN or undefined may reach the screen, and the figures
 * a component prints must match the figures it was given. A component that
 * silently drops rows is worse than one that crashes - a spend breakdown
 * that quietly omits money is the failure mode this whole project exists to
 * prevent.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { parseAwsBill } from "../../../../server/billParser";
import { computeInsights } from "../../../../server/insights";
import type { BillInsights, InsightLineItem } from "../../../../server/insights";

import RankedList from "./RankedList";
import CoverageBar from "./CoverageBar";
import CompositionAccordion from "./CompositionAccordion";
import RateTable from "./RateTable";
import RegionCategoryMatrix from "./RegionCategoryMatrix";
import CategoryKey from "./CategoryKey";
import DataNotes from "./DataNotes";
import { categoryToken } from "./tokens";

/**
 * Folder holding the reference bill PDFs. These suites render every component
 * against REAL bill data; the previous default was an absolute sandbox path that
 * exists on no other machine, so the loader returned early, zero cases were
 * generated, and the suite passed while testing nothing.
 */
const BILLS_DIR = process.env.BILLS_DIR
  ?? path.resolve(process.cwd(), "reference-bills");

type Case = { file: string; ins: BillInsights; items: InsightLineItem[] };
const cases: Case[] = [];

beforeAll(async () => {
  if (!fs.existsSync(BILLS_DIR)) return;          // CI without the bills: skip
  const files = fs.readdirSync(BILLS_DIR).filter(f => f.toLowerCase().endsWith(".pdf")).sort();
  for (const f of files) {
    const { text } = await pdfParse(fs.readFileSync(path.join(BILLS_DIR, f)));
    const parsed = parseAwsBill(text);
    if (!parsed.items.length) continue;
    const items = parsed.items as InsightLineItem[];
    cases.push({ file: f, ins: computeInsights(items), items });
  }
}, 120_000);

/** Anything that must never reach a customer's screen. */
const POISON = /NaN|undefined|null%|\[object Object\]|Infinity|\$NaN/;
/** Strip tags and decode the entities React escapes, so assertions can match
 *  real category names like "Networking & Content Delivery". */
const decode = (s: string) => s
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d));
const text = (html: string) => decode(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

describe("insight components render every reference bill", () => {
  it("loaded the reference bills", () => {
    expect(cases.length).toBeGreaterThanOrEqual(12);
  });

  it("CategoryKey shows every category present, with no poison values", () => {
    for (const { file, ins } of cases) {
      const html = renderToStaticMarkup(<CategoryKey categories={ins.byCategory} />);
      expect(text(html), file).not.toMatch(POISON);
      // every category on the bill must appear in the key
      for (const c of ins.byCategory) expect(text(html), `${file} / ${c.key}`).toContain(c.key);
    }
  });

  it("RankedList discloses everything it hides", () => {
    for (const { file, ins } of cases) {
      const rows = ins.byInstanceType.map(r => ({ key: r.key, costUsd: r.costUsd, share: r.share }));
      const html = renderToStaticMarkup(<RankedList rows={rows} hue="var(--cat-compute)" limit={5} />);
      expect(text(html), file).not.toMatch(POISON);
      if (rows.length > 5) {
        // the count and the remainder must both be stated
        expect(text(html), file).toMatch(/\+ \d+ more not shown/);
        expect(text(html), file).toMatch(/\$[\d,]+\.\d{2}/);
      }
    }
  });

  it("RankedList renders an empty set as a sentence, not a blank panel", () => {
    const html = renderToStaticMarkup(<RankedList rows={[]} />);
    expect(text(html)).toMatch(/Nothing to show/);
  });

  it("CoverageBar never prints a negative or >100% share", () => {
    for (const { file, ins } of cases) {
      const html = renderToStaticMarkup(<CoverageBar commitment={ins.commitment} />);
      const t = text(html);
      expect(t, file).not.toMatch(POISON);
      expect(t, file).not.toMatch(/-\d+(\.\d+)?%/);
      const pcts = Array.from(t.matchAll(/(\d+(?:\.\d+)?)%/g)).map(m => parseFloat(m[1]));
      pcts.forEach(p => expect(p, `${file} pct ${p}`).toBeLessThanOrEqual(100.1));
    }
  });

  it("CompositionAccordion only shows services that belong to the open category", () => {
    // Regression: the first version of this test stubbed servicesFor to return
    // every service, which rendered EC2 and CloudFront under "Database". That
    // exposed a real gap - computeInsights had no per-category service
    // breakdown at all, so the UI would have had to invent the grouping.
    for (const { file, ins } of cases) {
      const top = ins.byCategory[0];
      const svcs = ins.servicesByCategory[top.key] ?? [];
      const sum = svcs.reduce((s, r) => s + r.costUsd, 0);
      expect(Math.abs(sum - top.costUsd), `${file} / ${top.key}`).toBeLessThan(0.05);
    }
  });

  it("CompositionAccordion lists every category and opens the largest", () => {
    for (const { file, ins } of cases) {
      const svc = (cat: string) => ins.servicesByCategory[cat] ?? [];
      const html = renderToStaticMarkup(
        <CompositionAccordion categories={ins.byCategory} servicesFor={svc} total={ins.totalUsd} />,
      );
      expect(text(html), file).not.toMatch(POISON);
      for (const c of ins.byCategory) expect(text(html), `${file} / ${c.key}`).toContain(c.key);
      expect(html, file).toContain('aria-expanded="true"');
    }
  });

  it("RateTable always shows component rates beside a blended figure", () => {
    for (const { file, ins } of cases) {
      const html = renderToStaticMarkup(<RateTable rates={ins.machineRates} />);
      const t = text(html);
      expect(t, file).not.toMatch(POISON);
      if (ins.machineRates.some(r => r.isBlended)) {
        expect(t, file).toMatch(/blended/);
        // a blended row must print at least two model chips
        const firstBlend = ins.machineRates.find(r => r.isBlended)!;
        firstBlend.byModel.forEach(m => expect(t, `${file} / ${m.model}`).toContain(m.model));
      }
      expect(t, file).toMatch(/not published list prices/);
    }
  });

  it("RegionCategoryMatrix reconciles to the bill and states any fold", () => {
    for (const { file, ins } of cases) {
      const html = renderToStaticMarkup(<RegionCategoryMatrix insights={ins} />);
      const t = text(html);
      expect(t, file).not.toMatch(POISON);
      expect(t, file).toMatch(/grid sums to \$/);
      if (ins.byRegion.length > 8 || ins.byCategory.length > 8) {
        expect(t, file).toMatch(/other region|other categor/);
        expect(t, file).toMatch(/nothing is dropped/);
      }
      // the printed grid total must be 100% of the bill
      expect(t, file).toMatch(/\(100\.0% of the bill\)/);
    }
  });

  it("DataNotes renders every note as a readable sentence", () => {
    for (const { file, ins } of cases) {
      const html = renderToStaticMarkup(<DataNotes notes={ins.notes} />);
      const t = text(html);
      expect(t, file).not.toMatch(POISON);
      ins.notes.forEach(n => {
        // the message must survive rendering intact
        const head = n.message.slice(0, 40).replace(/\s+/g, " ");
        expect(t, `${file} / ${head}`).toContain(head);
      });
    }
  });
});

describe("colour contract holds for real category names", () => {
  it("every category on every bill maps to a real token", () => {
    const seen = new Set<string>();
    cases.forEach(c => c.ins.byCategory.forEach(b => seen.add(b.key)));
    expect(seen.size).toBeGreaterThan(5);
    const css = fs.readFileSync(path.resolve(__dirname, "../../index.css"), "utf8");
    for (const cat of Array.from(seen)) {
      const token = categoryToken(cat);
      expect(css, `${cat} -> ${token}`).toContain(`${token}:`);
    }
  });

  it("no category falls back to Other unless it IS Other", () => {
    const seen = new Set<string>();
    cases.forEach(c => c.ins.byCategory.forEach(b => seen.add(b.key)));
    const fellBack = Array.from(seen).filter(c => categoryToken(c) === "--cat-other" && c.toLowerCase() !== "other");
    expect(fellBack).toEqual([]);
  });
});

describe("DataNotes must not print the same caveat twice on one page", () => {
  const notes = [
    { kind: "context", topic: "machines", message: "MACHINE NOTE" },
    { kind: "partial", topic: "storage", message: "STORAGE NOTE" },
    { kind: "context", topic: "bill", message: "BILL NOTE" },
  ] as const;

  it("renders only the excluded-topic complement in the catch-all section", () => {
    // Section 06 previously rendered every note again, so a reader saw the
    // same sentence in two places on one page.
    const html = renderToStaticMarkup(
      <DataNotes notes={notes as never} exclude={["machines", "storage"] as never} />);
    expect(html).toContain("BILL NOTE");
    expect(html).not.toContain("MACHINE NOTE");
    expect(html).not.toContain("STORAGE NOTE");
  });

  it("still renders a single topic when asked for one inline", () => {
    const html = renderToStaticMarkup(<DataNotes notes={notes as never} topic="storage" />);
    expect(html).toContain("STORAGE NOTE");
    expect(html).not.toContain("BILL NOTE");
  });

  it("renders nothing rather than an empty box when the complement is empty", () => {
    const html = renderToStaticMarkup(
      <DataNotes notes={notes as never} exclude={["machines", "storage", "bill"] as never} />);
    expect(html).toBe("");
  });

  it("falls back to every note when neither filter is given", () => {
    const html = renderToStaticMarkup(<DataNotes notes={notes as never} />);
    for (const n of notes) expect(html).toContain(n.message);
  });
});

describe("reference bills", () => {
  it("were actually found, so these tests are testing something", () => {
    if (process.env.ALLOW_NO_BILLS === "1") return;
    expect(cases.length,
      `No reference bill PDFs found in ${BILLS_DIR}. Every test in this file renders a `
      + `component against REAL bill data, so without them the file generates zero tests `
      + `and passes while checking nothing. Point BILLS_DIR at the folder containing the `
      + `bill PDFs, or set ALLOW_NO_BILLS=1 to acknowledge running without them.`
    ).toBeGreaterThan(0);
  });
});
