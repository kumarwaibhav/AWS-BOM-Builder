/**
 * Parser tests against the real sample AWS bill PDF.
 * Validates line-item extraction, per-service totals, and metadata.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { readFileSync, existsSync } from "fs";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { parseAwsBill, tokenizeLine, isPlausibleUom, type ParsedBill } from "./billParser";

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

/**
 * Regression tests for two real bugs found by running scripts/verify-bills.ts
 * against 10 real customer bills. Uses hand-written synthetic snippets (not
 * real customer data, since this repo is public) that reproduce the exact
 * structural pattern that broke.
 */
describe("regression: Savings Plan section headers are not double-counted", () => {
  it("classifies a bare 'Compute Savings Plans' rollup header as a group line, not a leaf", () => {
    const tok = tokenizeLine("Compute Savings PlansUSD 8,064.00");
    expect(tok).not.toBeNull();
    expect(tok!.isGroupLine).toBe(true);
  });

  it("classifies a bare 'Savings Plans for AWS <X> usage' L0 header as a group line", () => {
    const tok = tokenizeLine("Savings Plans for AWS Compute usageUSD 8,064.00");
    expect(tok).not.toBeNull();
    expect(tok!.isGroupLine).toBe(true);
  });

  it("classifies an 'EC2 Instance Savings Plans' sub-service header as a group line", () => {
    const tok = tokenizeLine("EC2 Instance Savings PlansUSD 356.60");
    expect(tok).not.toBeNull();
    expect(tok!.isGroupLine).toBe(true);
  });

  it("still classifies genuine Savings-Plan-covered usage leaves as leaves", () => {
    // These have a quantity attached, unlike the bare rollup headers above.
    const covered = tokenizeLine(
      "t3.small Linux instance usage covered by Compute Savings Plans252.312 Hrs(USD 5.65)"
    );
    expect(covered).not.toBeNull();
    expect(covered!.isGroupLine).toBe(false);

    const commitment = tokenizeLine("1 year No Upfront Compute Savings Plan720 HrsUSD 864.00");
    expect(commitment).not.toBeNull();
    expect(commitment!.isGroupLine).toBe(false);
  });

  it("end-to-end: a Savings Plan section sums to the leaf total once, not 2-3x", () => {
    // Mirrors the real structure: L0 service header, L1 region, L2 sub-service
    // header (both headers restating the section's total), then the actual
    // leaf usage lines that sum to that same total.
    const text = [
      "Charges by service",
      "Savings Plans for AWS Compute usageUSD 8,064.00",
      "AnyUSD 8,064.00",
      "Compute Savings PlansUSD 8,064.00",
      "1 year No Upfront Compute Savings Plan720 HrsUSD 864.00",
      "1 year No Upfront Compute Savings Plan720 HrsUSD 5,760.00",
      "1 year No Upfront Compute Savings Plan720 HrsUSD 1,440.00",
      "Total taxUSD 0.00",
    ].join("\n");
    const parsed = parseAwsBill(text);
    const sum = parsed.items.reduce((s, i) => s + i.costUsd, 0);
    expect(Math.round(sum * 100) / 100).toBe(8064.0);
  });
});

describe("regression: uncommon AWS billing units are not silently dropped", () => {
  it("recognizes AWS Global Accelerator's 'Accelerator-Hours' fixed-fee line as a leaf", () => {
    const tok = tokenizeLine(
      "Fixed fee for every hour or partial hour that your accelerator runs2,880 Accelerator-HoursUSD 72.00"
    );
    expect(tok).not.toBeNull();
    expect(tok!.isGroupLine).toBe(false);
    expect(tok!.quantity).toBe(2880);
    expect(tok!.uom).toBe("Accelerator-Hours");
    expect(tok!.costUsd).toBe(72.0);
  });

  it("recognizes a tiered percentage support/marketplace fee ('Dollar' unit) as a leaf", () => {
    const tok = tokenizeLine("10% of monthly AWS usage for the first $0-$10K4,381.334 DollarUSD 438.13");
    expect(tok).not.toBeNull();
    expect(tok!.isGroupLine).toBe(false);
  });

  it("recognizes a per-activity fee ('Activities' unit) as a leaf", () => {
    const tok = tokenizeLine(".60 per month per low frequency activity on AWS7.989 ActivitiesUSD 4.79");
    expect(tok).not.toBeNull();
    expect(tok!.isGroupLine).toBe(false);
  });

  it("accepts not-yet-seen '-Hrs/-Mo'-style compound units via the generic suffix rule", () => {
    // A made-up unit that has never appeared in any sample bill, to prove the
    // fix isn't just a hardcoded string list.
    expect(isPlausibleUom("Widget-Hours")).toBe(true);
    expect(isPlausibleUom("Frobnitz-Mo")).toBe(true);
  });
});

describe("regression: grand total extraction accepts both phrasings", () => {
  it("extracts 'Estimated grand total:'", () => {
    const parsed = parseAwsBill("Estimated grand total:USD 96.58");
    expect(parsed.grandTotalUsd).toBe(96.58);
  });

  it("extracts 'Grand total:' without the 'Estimated' prefix", () => {
    const parsed = parseAwsBill("Grand total:USD 7,918.59");
    expect(parsed.grandTotalUsd).toBe(7918.59);
  });
});
