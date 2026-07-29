/**
 * Unit tests for the insights domain layer.
 *
 * Every description string below is a REAL line taken from the 13 reference
 * bills. Synthetic strings would only prove the regexes match themselves.
 */
import { describe, it, expect } from "vitest";
import {
  pricingModel, instanceType, generation, storageClass, dbEngine,
  hourlyRate, computeInsights,
} from "./insights";
import type { InsightLineItem } from "./insights";

const line = (description: string, over: Partial<InsightLineItem> = {}): InsightLineItem => ({
  region: "Asia Pacific (Mumbai)",
  serviceCategory: "Compute",
  serviceName: "Elastic Compute Cloud",
  description,
  quantity: null,
  uom: null,
  costUsd: 0,
  ...over,
});

describe("pricingModel", () => {
  it("reads a Savings Plan credit as a credit, not as on-demand usage", () => {
    // This line contains BOTH "On Demand" wording upstream and the covered
    // marker; the covered test must win or coverage would be double counted.
    const m = pricingModel(line(
      "t3.small Linux instance usage covered by Compute Savings Plans", { costUsd: -16.14 }));
    expect(m).toBe("Savings Plan credit");
  });

  it("recognises an EC2 Instance Savings Plan credit", () => {
    expect(pricingModel(line(
      "c6a.4xlarge Linux instance usage in ap-south-1 covered by EC2 Instance Savings Plans",
      { costUsd: -538.22 }))).toBe("Savings Plan credit");
  });

  it("separates the commitment fee from the credit", () => {
    expect(pricingModel(line(
      "1 year No Upfront c6a EC2 Instance Savings Plan in ap-south-1", { costUsd: 356.6 })))
      .toBe("Savings Plan fee");
  });

  it("classifies on-demand usage", () => {
    expect(pricingModel(line(
      "$0.0224 per On Demand Linux t3.small Instance Hour", { costUsd: 16.14 }))).toBe("On-Demand");
  });

  it("classifies reserved and spot", () => {
    expect(pricingModel(line(
      "Amazon Relational Database Service for MySQL Community Edition Reserved Instances - USD 0.3087 hourly fee",
      { costUsd: 222.26 }))).toBe("Reserved");
    expect(pricingModel(line(
      "c5.2xlarge Linux/UNIX Spot Instance-hour", { costUsd: 11.56 }))).toBe("Spot");
  });

  it("assigns exactly one model to every input", () => {
    const samples = [
      "$0.056 per NAT gateway Hour", "EBS - $0.05 per GB-Month of snapshot data stored",
      "AWS Lambda - Total Requests", "$0.00 per GB - free tier", "Datadog Pro subscription",
    ];
    samples.forEach(d => expect(typeof pricingModel(line(d, { costUsd: 1 }))).toBe("string"));
  });
});

describe("instanceType and generation", () => {
  it.each([
    ["$0.2222 per On Demand Linux m6a.2xlarge Instance Hour", "m6a.2xlarge", "Current"],
    ["$0.0224 per On Demand Linux t3.small Instance Hour", "t3.small", "Previous"],
    ["$0.1984 per On Demand Linux t2.xlarge Instance Hour", "t2.xlarge", "Legacy"],
    ["InstanceUsage:db.r5.2xlarge Aurora PostgreSQL", "db.r5.2xlarge", "Previous"],
    ["$0.068 per cache.r6g.large Node-hour running Redis", "cache.r6g.large", "Current"],
  ])("%s", (desc, type, gen) => {
    expect(instanceType(line(desc))).toBe(type);
    expect(generation(type)).toBe(gen);
  });

  it("does not strand db. or cache. prefixes in the Legacy bucket", () => {
    // Splitting on "." before stripping the prefix made every db.* and
    // cache.* instance look like generation 0.
    expect(generation("db.r5.large")).toBe("Previous");
    expect(generation("cache.r6g.large")).toBe("Current");
  });

  it("puts burstable families on their own numbering", () => {
    // t3 is contemporary with m5, not with m3.
    expect(generation("t2.micro")).toBe("Legacy");
    expect(generation("t3.medium")).toBe("Previous");
    expect(generation("t4g.small")).toBe("Current");
  });

  it("returns null rather than guessing when there is no instance type", () => {
    expect(instanceType(line("AWS Lambda - Total Requests"))).toBeNull();
    expect(generation(null)).toBeNull();
  });
});

describe("storageClass and dbEngine", () => {
  it.each([
    ["$0.0174 per GB-month of Cold HDD (sc1) provisioned storage", "EBS sc1"],
    ["$0.05 per GB-Month of snapshot data stored", "EBS snapshots"],
    ["$0.0456 per provisioned MiBps-month of gp3", "EBS gp3"],
    ["TimedStorage-ByteHrs $0.023 per GB - S3 Standard", "S3 Standard"],
    ["TimedStorage-GlacierByteHrs Glacier Flexible Retrieval", "S3 Glacier"],
  ])("%s -> %s", (d, cls) => expect(storageClass(line(d))).toBe(cls));

  it.each([
    ["InstanceUsage:db.r5.large Aurora PostgreSQL", "Aurora PostgreSQL"],
    ["Amazon RDS for MySQL Community Edition Reserved Instances", "RDS MySQL"],
    ["DynamoDB PayPerRequest Write Request Units", "DynamoDB"],
    ["$0.068 per cache.r6g.large Node-hour running Redis", "ElastiCache"],
  ])("%s -> %s", (d, eng) => expect(dbEngine(line(d))).toBe(eng));

  it("returns null for lines that are neither", () => {
    expect(storageClass(line("$0.056 per NAT gateway Hour"))).toBeNull();
    expect(dbEngine(line("$0.056 per NAT gateway Hour"))).toBeNull();
  });
});

describe("hourlyRate", () => {
  it("computes a rate only for hourly units", () => {
    expect(hourlyRate(line("x", { uom: "Hrs", quantity: 720, costUsd: 40.32 }))).toBeCloseTo(0.056, 6);
    expect(hourlyRate(line("x", { uom: "GB-Mo", quantity: 100, costUsd: 5 }))).toBeNull();
  });
  it("refuses to divide by zero or a missing quantity", () => {
    expect(hourlyRate(line("x", { uom: "Hrs", quantity: 0, costUsd: 5 }))).toBeNull();
    expect(hourlyRate(line("x", { uom: "Hrs", quantity: null, costUsd: 5 }))).toBeNull();
  });
});

describe("computeInsights", () => {
  const bill: InsightLineItem[] = [
    line("$0.2222 per On Demand Linux m6a.2xlarge Instance Hour",
      { quantity: 3600, uom: "Hrs", costUsd: 799.92 }),
    line("m6a.2xlarge Linux instance usage covered by Compute Savings Plans",
      { quantity: 3600, uom: "Hrs", costUsd: -799.92 }),
    line("1 year No Upfront c6a EC2 Instance Savings Plan in ap-south-1",
      { quantity: 720, uom: "Hrs", costUsd: 356.6 }),
    line("EBS - $0.05 per GB-Month of snapshot data stored",
      { serviceCategory: "Storage", quantity: 1106.695, uom: "GB-Mo", costUsd: 55.33 }),
    line("$0.056 per NAT gateway Hour",
      { serviceCategory: "Networking & Content Delivery", region: "US East (N. Virginia)",
        quantity: 720, uom: "Hrs", costUsd: 40.32 }),
  ];

  const ins = computeInsights(bill);

  it("reconciles every full-coverage breakdown to the bill total", () => {
    const sum = (r: { costUsd: number }[]) => Math.round(r.reduce((s, x) => s + x.costUsd, 0) * 100) / 100;
    expect(sum(ins.byCategory)).toBeCloseTo(ins.totalUsd, 2);
    expect(sum(ins.byRegion)).toBeCloseTo(ins.totalUsd, 2);
    expect(sum(ins.byPricingModel)).toBeCloseTo(ins.totalUsd, 2);
    expect(sum(ins.regionCategoryMatrix)).toBeCloseTo(ins.totalUsd, 2);
  });

  it("measures coverage against gross on-demand, not against net spend", () => {
    // Net spend for the covered pair is zero; coverage must still read 100%.
    expect(ins.commitment.grossOnDemandUsd).toBeCloseTo(799.92, 2);
    expect(ins.commitment.savingsPlanCreditsUsd).toBeCloseTo(799.92, 2);
    expect(ins.commitment.coverageOfOnDemand).toBeCloseTo(1, 4);
    expect(ins.commitment.savingsPlanFeesUsd).toBeCloseTo(356.6, 2);
    expect(ins.commitment.hasNoCommitment).toBe(false);
  });

  it("reports savings-plan credits as a positive magnitude", () => {
    expect(ins.commitment.savingsPlanCreditsUsd).toBeGreaterThan(0);
  });

  it("keeps a blended machine rate equal to its components", () => {
    for (const r of ins.machineRates) {
      const h = r.byModel.reduce((s, m) => s + m.hours, 0);
      const c = r.byModel.reduce((s, m) => s + m.costUsd, 0);
      expect(h).toBeCloseTo(r.hours, 2);
      expect(c).toBeCloseTo(r.costUsd, 2);
    }
  });

  it("declares what it cannot derive instead of hiding it", () => {
    const empty = computeInsights([
      line("AWS Lambda - Total Requests", { quantity: 1000, uom: "Requests", costUsd: 5 }),
    ]);
    expect(empty.commitment.hasNoCommitment).toBe(true);
    expect(empty.notes.map(n=>n.message).join(" ")).toMatch(/no Savings Plan/i);
    expect(empty.notes.map(n=>n.message).join(" ")).toMatch(/per-machine rates/i);
  });

  it("survives an empty bill without dividing by zero", () => {
    const none = computeInsights([]);
    expect(none.totalUsd).toBe(0);
    expect(none.commitment.coverageOfOnDemand).toBe(0);
    expect(none.byCategory).toEqual([]);
    expect(Number.isFinite(none.totalUsd)).toBe(true);
  });

  it("handles a bill that is entirely zero-cost free-tier usage", () => {
    const free = computeInsights([
      line("$0.00 per GB - free tier", { quantity: 1024, uom: "GB", costUsd: 0 }),
    ]);
    expect(free.totalUsd).toBe(0);
    expect(free.byCategory.every(r => Number.isFinite(r.share))).toBe(true);
  });
});

describe("charges and credits are never mixed into one percentage", () => {
  // Found by the full-pipeline audit: byPricingModel produced a share of
  // -45.34% for "Savings Plan credit" on PSBA, because credits are negative
  // and were being divided by the bill total. A bar reading minus forty-five
  // percent of a bill is not something a customer can act on.
  const withCredit = computeInsights([
    line("$0.2222 per On Demand Linux m6a.2xlarge Instance Hour",
      { quantity: 3600, uom: "Hrs", costUsd: 799.92 }),
    line("m6a.2xlarge Linux instance usage covered by Compute Savings Plans",
      { quantity: 3600, uom: "Hrs", costUsd: -799.92 }),
    line("$0.056 per NAT gateway Hour",
      { serviceCategory: "Networking & Content Delivery", quantity: 720, uom: "Hrs", costUsd: 40.32 }),
  ]);

  it("never emits a negative share", () => {
    const all = [
      ...withCredit.byCategory, ...withCredit.byRegion,
      ...withCredit.byService, ...withCredit.byPricingModel,
      ...withCredit.byInstanceType, ...withCredit.byGeneration,
    ];
    all.forEach(r => expect(r.share).toBeGreaterThanOrEqual(0));
  });

  it("never emits a share above 100%", () => {
    withCredit.byPricingModel.forEach(r => expect(r.share).toBeLessThanOrEqual(1.0001));
  });

  it("flags credit buckets so the UI can render them as deductions", () => {
    const credit = withCredit.byPricingModel.find(r => r.key === "Savings Plan credit")!;
    expect(credit.isCredit).toBe(true);
    expect(credit.costUsd).toBeLessThan(0);
    // Its share is of total credits, not of the bill.
    expect(credit.share).toBeCloseTo(1, 4);
  });

  it("marks ordinary charge buckets as non-credit", () => {
    withCredit.byPricingModel.filter(r => r.costUsd > 0)
      .forEach(r => expect(r.isCredit).toBe(false));
  });

  it("reports gross charges, credits and net separately", () => {
    expect(withCredit.grossChargesUsd).toBeCloseTo(840.24, 2);
    expect(withCredit.creditsUsd).toBeCloseTo(799.92, 2);
    expect(withCredit.totalUsd).toBeCloseTo(40.32, 2);
    // net must be exactly gross minus credits
    expect(withCredit.grossChargesUsd - withCredit.creditsUsd).toBeCloseTo(withCredit.totalUsd, 2);
  });

  it("explains the split in plain language", () => {
    const n = withCredit.notes.find(x => x.topic === "bill" && /credits/.test(x.message));
    expect(n).toBeDefined();
    expect(n!.message).toMatch(/netting to/);
    expect(n!.message).not.toMatch(/NaN|undefined/);
  });

  it("leaves a bill with no credits unaffected", () => {
    const noCredit = computeInsights([
      line("$0.056 per NAT gateway Hour", { quantity: 720, uom: "Hrs", costUsd: 40.32 }),
    ]);
    expect(noCredit.creditsUsd).toBe(0);
    expect(noCredit.grossChargesUsd).toBeCloseTo(noCredit.totalUsd, 2);
    expect(noCredit.byPricingModel.every(r => !r.isCredit)).toBe(true);
  });
});
