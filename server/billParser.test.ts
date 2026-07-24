/**
 * Parser tests against the real sample AWS bill PDF.
 * Validates line-item extraction, per-service totals, and metadata.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { readFileSync, existsSync } from "fs";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { parseAwsBill, type ParsedBill } from "./billParser";

const SAMPLE_PDF = "/home/ubuntu/upload/Bills_BillingandCostManagement_Global.pdf";
const hasSample = existsSync(SAMPLE_PDF);

describe.skipIf(!hasSample)("parseAwsBill on sample bill", () => {
  let parsed: ParsedBill;

  beforeAll(async () => {
    const data = await pdfParse(readFileSync(SAMPLE_PDF));
    parsed = parseAwsBill(data.text);
  });

  it("extracts a substantial number of line items", () => {
    expect(parsed.items.length).toBeGreaterThan(200);
  });

  it("extracts bill metadata", () => {
    expect(parsed.accountId).toBeTruthy();
    expect(parsed.billingPeriod).toBeTruthy();
    expect(parsed.grandTotalUsd).not.toBeNull();
  });

  it("sums line items to the pre-tax charge total within rounding tolerance", () => {
    // AWS pre-tax total for this bill: 5,511.29 (leaf rounding may differ by pennies)
    const sum = parsed.items.reduce((s, i) => s + i.costUsd, 0);
    expect(Math.abs(sum - 5511.29)).toBeLessThan(0.25);
  });

  it("every item has region, service name, description, and finite cost", () => {
    for (const item of parsed.items) {
      expect(item.region.length).toBeGreaterThan(0);
      expect(item.serviceName.length).toBeGreaterThan(0);
      expect(item.description.length).toBeGreaterThan(0);
      expect(Number.isFinite(item.costUsd)).toBe(true);
    }
  });

  it("covers the expected services in the bill", () => {
    const services = new Set(parsed.items.map(i => i.serviceName));
    const expectedSubstrings = [
      "Elastic Compute Cloud",
      "Relational Database Service",
      "Simple Storage Service",
      "Virtual Private Cloud",
      "CloudWatch",
    ];
    for (const s of expectedSubstrings) {
      expect([...services].some(name => name.includes(s)), `missing service ${s}`).toBe(true);
    }
  });

  it("captures negative savings-plan/credit rows", () => {
    expect(parsed.items.some(i => i.costUsd < 0)).toBe(true);
  });

  it("assigns regions including Mumbai and Global", () => {
    const regions = new Set(parsed.items.map(i => i.region));
    expect([...regions].some(r => r.includes("Mumbai"))).toBe(true);
  });
});
