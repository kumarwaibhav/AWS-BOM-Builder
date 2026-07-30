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

describe("zero-cost companion lines must not halve a machine rate", () => {
  // Found by reading the live rate table on PSBA. AWS prints an
  // included-at-no-charge line beside a paid instance line:
  //
  //   $0.2222 per On Demand Linux m6a.2xlarge Instance Hour   3,600 Hrs  $799.92
  //   $0.00 for 1061 Mbps per m6a.2xlarge instance-hour       3,600 Hrs    $0.00
  //
  // That second line is EBS-optimized throughput bundled with the instance,
  // not another 3,600 instance-hours. Counting its hours reported $0.1111/hr
  // for a machine the bill prices at $0.2222 - exactly half - and did the
  // same to six more machine types on that one bill.
  const withFreeCompanion = computeInsights([
    line("$0.2222 per On Demand Linux m6a.2xlarge Instance Hour",
      { quantity: 3600, uom: "Hrs", costUsd: 799.92 }),
    line("$0.00 for 1061 Mbps per m6a.2xlarge instance-hour (or partial hour)",
      { quantity: 3600, uom: "Hrs", costUsd: 0 }),
  ]);

  it("reports the rate the bill actually prints", () => {
    const r = withFreeCompanion.machineRates.find(x => x.instanceType === "m6a.2xlarge")!;
    expect(r.effectiveRateUsd).toBeCloseTo(0.2222, 4);
    expect(r.hours).toBeCloseTo(3600, 1);
    expect(r.costUsd).toBeCloseTo(799.92, 2);
  });

  it("does not treat the free companion line as a second pricing model", () => {
    const r = withFreeCompanion.machineRates.find(x => x.instanceType === "m6a.2xlarge")!;
    expect(r.isBlended).toBe(false);
    expect(r.byModel).toHaveLength(1);
    expect(r.byModel[0].model).toBe("On-Demand");
  });

  it("discloses the excluded hours rather than dropping them silently", () => {
    const msg = withFreeCompanion.notes.map(n => n.message).join(" ");
    expect(msg).toMatch(/3,600 instance-hours/);
    expect(msg).toMatch(/billed at \$0\.00/);
    expect(msg).toMatch(/excluded from the observed hourly rates/);
  });

  it("still blends genuinely different PAID rates for the same machine", () => {
    const twoPaid = computeInsights([
      line("$0.3740 per On Demand Linux c6a.4xlarge Instance Hour",
        { quantity: 1000, uom: "Hrs", costUsd: 374 }),
      line("c6a.4xlarge reserved instance applied",
        { quantity: 1000, uom: "Hrs", costUsd: 123.8 }),
    ]);
    const r = twoPaid.machineRates.find(x => x.instanceType === "c6a.4xlarge")!;
    expect(r.isBlended).toBe(true);
    expect(r.byModel).toHaveLength(2);
    expect(r.effectiveRateUsd).toBeCloseTo((374 + 123.8) / 2000, 4);
  });
});

describe("an all-zero-cost instance bill is described accurately", () => {
  // A regression I introduced with the zero-cost rate fix and caught by
  // re-reading the branch: excluding every zero-cost line can empty
  // machineRates, and the empty branch then claimed "this bill has no hourly
  // instance charges". That is false for a fully free-tier or fully
  // commitment-covered account - the hours exist, they just cost nothing.
  const allFree = computeInsights([
    line("$0.00 per On Demand Linux t3.micro Instance Hour - free tier",
      { quantity: 744, uom: "Hrs", costUsd: 0 }),
  ]);

  it("does not claim there are no instance charges", () => {
    const msg = allFree.notes.filter(n => n.topic === "machines").map(n => n.message).join(" ");
    expect(msg).not.toMatch(/no hourly instance charges/);
  });

  it("says every instance-hour was billed at zero, and how many", () => {
    const msg = allFree.notes.filter(n => n.topic === "machines").map(n => n.message).join(" ");
    expect(msg).toMatch(/Every instance-hour on this bill is billed at \$0\.00/);
    expect(msg).toMatch(/744 hours/);
    expect(allFree.machineRates).toEqual([]);
  });

  it("still says the plain thing when there really are no instance lines", () => {
    const none = computeInsights([
      line("AWS Lambda - Total Requests", { quantity: 1000, uom: "Requests", costUsd: 5 }),
    ]);
    const msg = none.notes.filter(n => n.topic === "machines").map(n => n.message).join(" ");
    expect(msg).toMatch(/no hourly instance charges/);
  });
});

describe("panels must disclose what their classifier could not name", () => {
  // Found live on B&G: the storage-classes panel showed $4,883.31 while the
  // Storage category totalled $5,030.34. The panel's own shares still summed
  // to 100%, so nothing on the page looked wrong - $147.03 had simply
  // vanished from view.
  const storageLines = (): InsightLineItem[] => [
    line("$0.10 per GB-month of snapshot data stored - Asia Pacific (Mumbai)",
      { serviceCategory: "Storage", costUsd: 900 }),
    line("$0.114 per GB-month of General Purpose (gp2) provisioned storage",
      { serviceCategory: "Storage", costUsd: 100 }),
    // Neither of these names a volume or tier type, so storageClass() -> null.
    line("AWS Backup - warm storage protected by backup plan",
      { serviceCategory: "Storage", serviceName: "AWS Backup", costUsd: 30 }),
    line("FSx for Windows File Server throughput capacity",
      { serviceCategory: "Storage", serviceName: "FSx", costUsd: 17.03 }),
  ];

  it("states the dollar amount and line count missing from the storage panel", () => {
    const ins = computeInsights(storageLines());
    const n = ins.notes.find(x => x.topic === "storage" && x.kind === "partial");
    expect(n).toBeDefined();
    expect(n!.message).toContain("$47.03");
    expect(n!.message).toContain("2 line items");
    expect(n!.message).toMatch(/still counted everywhere else/);
  });

  it("keeps the hidden spend in the bill total, so nothing is lost", () => {
    const ins = computeInsights(storageLines());
    const panel = ins.byStorageClass.reduce((s, r) => s + r.costUsd, 0);
    expect(ins.totalUsd).toBe(1047.03);
    expect(panel).toBe(1000);
    expect(ins.totalUsd - panel).toBeCloseTo(47.03, 2);
  });

  it("says nothing when every storage line was classified", () => {
    const ins = computeInsights(storageLines().slice(0, 2));
    expect(ins.notes.find(x => x.topic === "storage" && x.kind === "partial")).toBeUndefined();
  });

  it("does not fire on classified spend that exceeds its category total", () => {
    // EBS snapshots are invoiced under the EC2 header, so classified storage
    // can legitimately be larger than the Storage category. That is not a
    // shortfall and must not be reported as one.
    const ins = computeInsights([
      line("$0.10 per GB-month of snapshot data stored", { serviceCategory: "Compute", costUsd: 500 }),
      line("$0.114 per GB-month of General Purpose (gp2) provisioned storage",
        { serviceCategory: "Storage", costUsd: 100 }),
    ]);
    expect(ins.notes.find(x => x.topic === "storage" && x.kind === "partial")).toBeUndefined();
  });

  it("applies the same disclosure to database engines", () => {
    const ins = computeInsights([
      line("$0.068 per RDS db.t3.medium instance-hour running MySQL",
        { serviceCategory: "Database", serviceName: "Relational Database Service", costUsd: 200 }),
      line("Amazon Keyspaces - on-demand read request units",
        { serviceCategory: "Database", serviceName: "Amazon Keyspaces", costUsd: 12.5 }),
    ]);
    const n = ins.notes.find(x => x.topic === "database" && x.kind === "partial");
    expect(n).toBeDefined();
    expect(n!.message).toContain("$12.50");
    expect(n!.message).toContain("1 line item");
    expect(n!.message).toContain("engine");
  });

  it("ignores zero-cost unclassified lines, which hide no money", () => {
    const ins = computeInsights([
      line("$0.114 per GB-month of General Purpose (gp2) provisioned storage",
        { serviceCategory: "Storage", costUsd: 100 }),
      line("AWS Backup - warm storage protected by backup plan",
        { serviceCategory: "Storage", serviceName: "AWS Backup", costUsd: 0 }),
    ]);
    expect(ins.notes.find(x => x.topic === "storage" && x.kind === "partial")).toBeUndefined();
  });
});

describe("generation must not call current silicon legacy", () => {
  // A bare /^t/ test swallowed trn1/trn2 into the burstable branch, so
  // trn2.48xlarge - AWS's newest Trainium, exactly the hardware an AI workload
  // comparison is about - was badged LEGACY on screen.
  it("treats accelerator series numbers as a series, not a generation", () => {
    expect(generation("trn2.48xlarge")).toBe("Current");
    expect(generation("inf2.xlarge")).toBe("Current");
    expect(generation("trn1.32xlarge")).toBe("Previous");
    expect(generation("inf1.xlarge")).toBe("Previous");
  });

  it("still reads the burstable T family correctly", () => {
    expect(generation("t4g.nano")).toBe("Current");
    expect(generation("t3.small")).toBe("Previous");
    expect(generation("t2.xlarge")).toBe("Legacy");
    expect(generation("db.t3.xlarge")).toBe("Previous");
  });

  it("still reads the numeric generation convention correctly", () => {
    expect(generation("m8g.large")).toBe("Current");
    expect(generation("m7i.large")).toBe("Current");
    expect(generation("m5.large")).toBe("Previous");
    expect(generation("m4.large")).toBe("Legacy");
    expect(generation("cache.r6g.large")).toBe("Current");
  });

  it("claims nothing about a family with no generation digit", () => {
    // Better an absent badge than a wrong one.
    expect(generation("metal")).toBeNull();
    expect(generation(null)).toBeNull();
  });
});

describe("net and gross instance spend must not silently disagree", () => {
  // Found by validating the live API across all 12 parseable reference bills:
  // the machine-types panel and the rate table report "instance spend"
  // differently on 8 of them, by up to 3.25x (PSBA: $1,593.93 against
  // $5,183.87), with nothing on the page saying so. Both are correct - net is
  // what was paid, gross is what a rate must be measured against - but two
  // different totals for the same words read as an error in one of them.
  const covered = (): InsightLineItem[] => [
    line("$0.2222 per On Demand Linux m6a.2xlarge Instance Hour",
      { quantity: 3600, uom: "Hrs", costUsd: 799.92 }),
    line("m6a.2xlarge Linux instance usage covered by Compute Savings Plans",
      { quantity: 3600, uom: "Hrs", costUsd: -799.92 }),
  ];

  it("states both figures when they diverge", () => {
    const ins = computeInsights(covered());
    const n = ins.notes.find(x => /appears twice on this page/.test(x.message));
    expect(n).toBeDefined();
    expect(n!.topic).toBe("machines");
    expect(n!.message).toContain("$0.00");     // net: the credit cancels the charge
    expect(n!.message).toContain("$799.92");   // gross: what the rate is measured on
    expect(n!.message).toMatch(/Both figures are correct/);
  });

  it("says nothing when there is no commitment, so the two agree", () => {
    const ins = computeInsights([
      line("$0.10 per On Demand Linux m7i.large Instance Hour",
        { quantity: 1000, uom: "Hrs", costUsd: 100 }),
    ]);
    expect(ins.notes.find(x => /appears twice on this page/.test(x.message))).toBeUndefined();
  });

  it("says nothing when there are no hourly rates at all", () => {
    const ins = computeInsights([
      line("$0.023 per GB - first 50 TB / month of storage used",
        { serviceCategory: "Storage", quantity: 100, uom: "GB-Mo", costUsd: 2.3 }),
    ]);
    expect(ins.notes.find(x => /appears twice on this page/.test(x.message))).toBeUndefined();
  });

  it("keeps the gross figure equal to the rate table it describes", () => {
    const ins = computeInsights(covered());
    const gross = ins.machineRates.reduce((a, m) => a + m.costUsd, 0);
    const n = ins.notes.find(x => /appears twice on this page/.test(x.message))!;
    expect(n.message).toContain("$" + gross.toFixed(2));
  });
});

describe("a service header that spans categories must say which part it is", () => {
  // "Elastic Compute Cloud" is the AWS invoice HEADER, not the product. NAT
  // Gateway and EBS are billed under it and are networking and storage
  // charges. The composition panel grouped by the header and labelled by the
  // header, so it displayed "Elastic Compute Cloud" under Networking with
  // nothing to explain it. The classification is correct - NAT Gateway maps to
  // Cloud NAT on the target cloud, not to a VM - but the field that makes it
  // correct was the field never shown.
  const R = "Asia Pacific (Mumbai)";
  const L = (cat: string, svc: string, desc: string, cost: number): InsightLineItem =>
    ({ region: R, serviceCategory: cat, serviceName: svc, description: desc,
       quantity: null, uom: null, costUsd: cost });
  const bill = () => [
    L("Networking & Content Delivery", "Elastic Compute Cloud",
      "Amazon Elastic Compute Cloud NatGateway — $0.056 per NAT gateway Hour", 639.29),
    L("Storage", "Elastic Compute Cloud",
      "EBS — $0.05 per GB-Month of snapshot data stored", 120),
    L("Compute", "Elastic Compute Cloud",
      "Amazon Elastic Compute Cloud running Linux/UNIX — $0.10 per On Demand Linux m7i.large Instance Hour", 400),
    L("Compute", "Elastic Compute Cloud",
      "Amazon Elastic Compute Cloud running Ubuntu Pro Linux — $0.12 per hour", 50),
    L("Database", "Relational Database Service",
      "Amazon Relational Database Service for MySQL — $0.25 per db.m6g.large instance hour", 200),
  ];

  it("names the sub-service when the header sits in a surprising category", () => {
    const s = computeInsights(bill()).servicesByCategory;
    expect(s["Networking & Content Delivery"][0].key).toBe("Elastic Compute Cloud · NatGateway");
    expect(s["Storage"][0].key).toBe("Elastic Compute Cloud · EBS");
  });

  it("does not fragment a category whose sub-services differ", () => {
    // Under Compute the header is not confusing, and qualifying would split one
    // row into "running Linux/UNIX" and "running Ubuntu Pro Linux".
    const s = computeInsights(bill()).servicesByCategory;
    expect(s["Compute"]).toHaveLength(1);
    expect(s["Compute"][0].key).toBe("Elastic Compute Cloud");
    expect(s["Compute"][0].costUsd).toBe(450);
  });

  it("leaves a service that sits in exactly one category untouched", () => {
    const s = computeInsights(bill()).servicesByCategory;
    expect(s["Database"][0].key).toBe("Relational Database Service");
  });

  it("still reconciles every category to its own total", () => {
    const ins = computeInsights(bill());
    for (const row of ins.byCategory) {
      const svcs = ins.servicesByCategory[row.key];
      expect(svcs.reduce((a, r) => a + r.costUsd, 0)).toBeCloseTo(row.costUsd, 2);
    }
  });
});

describe("Redshift node families do not follow EC2's ladder", () => {
  // ra3 is Redshift's CURRENT node type. generation() parsed the first integer
  // out of the family and mapped it onto EC2's convention, so ra3 -> 3 ->
  // Legacy. On one reference bill that was the single largest machine line:
  // $449.38, 26.4% of machine spend, top row of the panel. "LEGACY" beside a
  // customer's production Redshift cluster is a factual error they will catch.
  it("reads the Redshift ladder by its letters, not its digit", () => {
    expect(generation("ra3.large")).toBe("Current");
    expect(generation("ra3.4xlarge")).toBe("Current");
    expect(generation("dc2.large")).toBe("Previous");
    expect(generation("ds2.xlarge")).toBe("Legacy");
  });

  it("leaves every other ladder alone", () => {
    expect(generation("m5.large")).toBe("Previous");
    expect(generation("r6g.xlarge")).toBe("Current");
    expect(generation("g6.xlarge")).toBe("Current");
    expect(generation("trn2.48xlarge")).toBe("Current");
    expect(generation("t3.medium")).toBe("Previous");
  });
});
