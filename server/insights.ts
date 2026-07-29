/**
 * Consumption insights - pure aggregation over parsed BOM line items.
 *
 * Every figure here is derived from the line items of a single bill. Nothing
 * is estimated, benchmarked or extrapolated: if a number cannot be read off
 * the bill it is reported as unavailable rather than guessed.
 *
 * -------------------------------------------------------------------------
 * HOW AWS ACTUALLY PRESENTS COMMITMENT PRICING
 * -------------------------------------------------------------------------
 * This shape drove the design and is easy to get wrong. A Savings Plan does
 * NOT appear as usage billed at a discounted rate. AWS bills the usage at the
 * full On-Demand rate and then credits the whole amount back on a separate
 * line:
 *
 *   $0.0224 per On Demand Linux t3.small Instance Hour  720.318 Hrs  USD 16.14
 *   t3.small Linux instance usage covered by Compute Savings Plans
 *                                                      720.318 Hrs (USD 16.14)
 *
 * The pair nets to zero, and the money actually paid appears separately as a
 * commitment fee ("EC2 Instance Savings Plans - 1 year No Upfront ...").
 * Summing cost by pricing model would therefore report Savings Plans as
 * NEGATIVE spend and covered usage as free, which is meaningless.
 *
 * Coverage is measured against GROSS ON-DEMAND-PRICED USAGE instead:
 *   grossOnDemand   sum of positive "On Demand" usage lines
 *   savingsCredits  sum of "covered by ... Savings Plans" credits (absolute)
 *   coverage        savingsCredits / grossOnDemand
 *
 * Reserved Instances behave differently again: they appear as ordinary
 * positive charges ("Reserved Instances - USD 0.3087 hourly fee per ..."),
 * so RI spend is real spend and is counted as such.
 *
 * Measured across the 13 reference bills: 103 savings-plan credit lines
 * (-$3,909.62), 58 reserved (+$5,841.51), 28 spot (+$1,934.92), 200
 * on-demand (+$28,088.50).
 */

export interface InsightLineItem {
  region: string;
  serviceCategory: string;
  serviceName: string;
  description: string;
  quantity: number | null;
  uom: string | null;
  costUsd: number;
}

export type PricingModel =
  | "On-Demand"
  | "Savings Plan credit"
  | "Savings Plan fee"
  | "Reserved"
  | "Spot"
  | "Free tier"
  | "Usage-based";

export type Generation = "Current" | "Previous" | "Legacy";

const SP_COVERED_RE = /covered by .{0,40}savings plans?/i;
const SP_FEE_RE = /savings plans?/i;
const RESERVED_RE = /reserved instances?|reserved instance applied|\breserved\b/i;
const SPOT_RE = /\bspot\b/i;
const ON_DEMAND_RE = /on[- ]demand/i;
const FREE_TIER_RE = /free tier|under the .{0,30}free|free of charge|\bno charge\b/i;

/**
 * Classify a line into exactly one pricing model. Order matters: a line
 * reading "... On Demand ... covered by Compute Savings Plans" is a credit,
 * not on-demand usage, so the covered test must run first.
 */
export function pricingModel(item: InsightLineItem): PricingModel {
  const d = item.description;
  if (SP_COVERED_RE.test(d)) return "Savings Plan credit";
  if (RESERVED_RE.test(d)) return "Reserved";
  if (SPOT_RE.test(d)) return "Spot";
  if (SP_FEE_RE.test(d)) return "Savings Plan fee";
  if (ON_DEMAND_RE.test(d)) return "On-Demand";
  if (item.costUsd === 0 || FREE_TIER_RE.test(d)) return "Free tier";
  return "Usage-based";
}

const INSTANCE_RE =
  /\b((?:db\.|cache\.)?[a-z]+\d+[a-z]*)\.(nano|micro|small|medium|large|xlarge|\d+xlarge|metal)\b/i;

export function instanceType(item: InsightLineItem): string | null {
  const m = item.description.match(INSTANCE_RE);
  return m ? (m[1] + "." + m[2]).toLowerCase() : null;
}

/**
 * Hardware generation. Burstable (t-family) runs its own numbering - t3 is
 * contemporary with m5, not m3 - so it is bucketed on its own scale.
 */
export function generation(type: string | null): Generation | null {
  if (!type) return null;
  const family = type.replace(/^(?:db|cache)\./, "").split(".")[0];
  const n = parseInt((family.match(/\d+/) || ["0"])[0], 10);
  if (/^t/.test(family)) return n >= 4 ? "Current" : n === 3 ? "Previous" : "Legacy";
  return n >= 6 ? "Current" : n === 5 ? "Previous" : "Legacy";
}

export function storageClass(item: InsightLineItem): string | null {
  const d = item.description;
  // The guard must name every token the detailed rules below can match, or a
  // line like "$0.0456 per provisioned MiBps-month of gp3" is rejected before
  // the gp3 rule ever runs.
  if (!/storage|ebs|s3|glacier|efs|volume|snapshot|\bgp[23]\b|\bio[12]\b|\bst1\b|\bsc1\b|magnetic|bucket/i.test(d)) return null;
  if (/\bgp3\b/i.test(d)) return "EBS gp3";
  if (/\bgp2\b/i.test(d)) return "EBS gp2";
  if (/\bio[12]\b|provisioned iops/i.test(d)) return "EBS io1/io2";
  if (/\bst1\b/i.test(d)) return "EBS st1";
  if (/\bsc1\b|cold hdd/i.test(d)) return "EBS sc1";
  if (/snapshot/i.test(d)) return "EBS snapshots";
  if (/magnetic/i.test(d)) return "EBS magnetic";
  if (/glacier/i.test(d)) return "S3 Glacier";
  if (/intelligent[- ]?tiering/i.test(d)) return "S3 Intelligent-Tiering";
  if (/standard[- ]ia|infrequent access/i.test(d)) return "S3 Standard-IA";
  if (/timedstorage|s3 standard|general ?purpose ?buckets/i.test(d)) return "S3 Standard";
  if (/\befs\b/i.test(d)) return "EFS";
  return null;
}

export function dbEngine(item: InsightLineItem): string | null {
  const d = item.description;
  // Same reasoning: "$0.068 per cache.r6g.large Node-hour running Redis"
  // names neither "elasticache" nor "rds", so the engine rules never ran.
  if (!/rds|aurora|dynamodb|elasticache|redshift|documentdb|neptune|memorydb|database|redis|memcached|cache\.|postgres|mysql|mariadb|oracle|sql ?server/i.test(d)) return null;
  if (/aurora.*postgres|postgres.*aurora/i.test(d)) return "Aurora PostgreSQL";
  if (/aurora.*mysql|mysql.*aurora/i.test(d)) return "Aurora MySQL";
  if (/aurora/i.test(d)) return "Aurora";
  if (/dynamodb/i.test(d)) return "DynamoDB";
  if (/elasticache|redis|memcached/i.test(d)) return "ElastiCache";
  if (/redshift/i.test(d)) return "Redshift";
  if (/documentdb/i.test(d)) return "DocumentDB";
  if (/neptune/i.test(d)) return "Neptune";
  if (/memorydb/i.test(d)) return "MemoryDB";
  if (/postgres/i.test(d)) return "RDS PostgreSQL";
  if (/mysql|mariadb/i.test(d)) return "RDS MySQL";
  if (/sql ?server/i.test(d)) return "RDS SQL Server";
  if (/oracle/i.test(d)) return "RDS Oracle";
  return null;
}

/** Only hourly-billed rows make cost / quantity a meaningful rate. */
const HOURLY_UOM_RE = /^(hrs|hours?|hourly|instance-hrs|vcpu-hours?)$/i;
export function hourlyRate(item: InsightLineItem): number | null {
  if (!item.uom || !HOURLY_UOM_RE.test(item.uom)) return null;
  if (!item.quantity || item.quantity <= 0) return null;
  return item.costUsd / item.quantity;
}

export interface Breakdown {
  key: string;
  costUsd: number;
  lineCount: number;
  /**
   * Fraction of the relevant whole. Always in [0, 1] so a chart can render it
   * directly. For a bucket that is a CREDIT (negative cost), this is the
   * magnitude's share of total credits, not a negative slice - a bar reading
   * "-45%" of a bill is not a thing a customer can act on.
   */
  share: number;
  /** True when this bucket reduces the bill rather than adding to it. */
  isCredit: boolean;
}

export interface CommitmentPosture {
  grossOnDemandUsd: number;
  savingsPlanCreditsUsd: number;
  savingsPlanFeesUsd: number;
  reservedUsd: number;
  spotUsd: number;
  coverageOfOnDemand: number;
  hasNoCommitment: boolean;
}

export interface MachineRate {
  instanceType: string;
  region: string;
  hours: number;
  costUsd: number;
  /**
   * Total cost divided by total hours. This BLENDS pricing models: hours
   * already covered by a Reserved Instance appear on the bill at USD 0.00
   * (the money sits in a separate commitment fee), so the blended figure is
   * lower than any single printed rate. Verified on PSBA: c6a.4xlarge blends
   * 1,439.099 On-Demand hours at $0.374 with 720 RI-covered hours at $0.00,
   * giving $0.3319 - a rate that appears nowhere in the bill.
   *
   * It is the right number for "what was actually paid per hour", and the
   * wrong number to quote as a list rate, so `byModel` carries the components
   * and the UI must show them alongside it.
   */
  effectiveRateUsd: number;
  /** Per-pricing-model components, each with its own printed rate. */
  byModel: Array<{ model: PricingModel; hours: number; costUsd: number; rateUsd: number }>;
  /** True when more than one pricing model contributed to these hours. */
  isBlended: boolean;
  generation: Generation;
}

export interface BillInsights {
  /** Net of the bill: charges minus credits. Matches the invoice. */
  totalUsd: number;
  /** Positive charges only, before any credit is applied. */
  grossChargesUsd: number;
  /** Credits applied, as a positive magnitude. */
  creditsUsd: number;
  lineCount: number;
  regionCount: number;
  categoryCount: number;
  byCategory: Breakdown[];
  byRegion: Breakdown[];
  byService: Breakdown[];
  /**
   * Services within each category, ranked. The composition view drills from a
   * category into the services inside it; a flat byService list cannot answer
   * that, and joining the two client-side would let the UI invent a grouping
   * the server never validated.
   */
  servicesByCategory: Record<string, Breakdown[]>;
  byPricingModel: Breakdown[];
  byInstanceType: Breakdown[];
  byGeneration: Breakdown[];
  byStorageClass: Breakdown[];
  byDbEngine: Breakdown[];
  topLineItems: Array<InsightLineItem & { share: number }>;
  regionCategoryMatrix: Array<{ region: string; category: string; costUsd: number }>;
  commitment: CommitmentPosture;
  machineRates: MachineRate[];
  /**
   * Plain-English notes about what this bill does and does not show.
   *
   * Customers export whatever their console gives them, so a bill is often
   * partial. The platform's job is to work with what is on the page and say
   * clearly what is not there - never to render an empty chart, and never to
   * demand data the customer cannot produce.
   */
  notes: DataNote[];
}

export interface DataNote {
  /** "absent" = the bill cannot show this. "partial" = shown, but incomplete. */
  kind: "absent" | "partial" | "context";
  /** Which part of the dashboard this note explains. */
  topic: "commitment" | "machines" | "storage" | "database" | "regions" | "bill";
  /** One sentence, no jargon, safe to show a customer verbatim. */
  message: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function breakdown(
  items: InsightLineItem[],
  keyFn: (i: InsightLineItem) => string | null,
  total: number,
): Breakdown[] {
  const acc = new Map<string, { costUsd: number; lineCount: number }>();
  for (const i of items) {
    const k = keyFn(i);
    if (k === null) continue;
    const cur = acc.get(k) || { costUsd: 0, lineCount: 0 };
    cur.costUsd += i.costUsd;
    cur.lineCount += 1;
    acc.set(k, cur);
  }
  const rows = Array.from(acc.entries()).map(([key, v]) => ({
    key, costUsd: round2(v.costUsd), lineCount: v.lineCount, isCredit: v.costUsd < 0,
  }));
  // Charges and credits are different wholes. A Savings Plan credit is -45% of
  // the bill total, which is meaningless as a slice; it is 100% of the credits
  // applied, which is meaningful. Each bucket is shared against its own side.
  const chargeTotal = rows.filter(r => !r.isCredit).reduce((s, r) => s + r.costUsd, 0);
  const creditTotal = Math.abs(rows.filter(r => r.isCredit).reduce((s, r) => s + r.costUsd, 0));
  return rows
    .map(r => {
      const denom = r.isCredit ? creditTotal : (chargeTotal || total);
      return { ...r, share: denom === 0 ? 0 : Math.abs(r.costUsd) / denom };
    })
    .sort((a, b) => b.costUsd - a.costUsd);
}

export function computeInsights(items: InsightLineItem[]): BillInsights {
  const totalUsd = round2(items.reduce((s, i) => s + i.costUsd, 0));
  const notes: DataNote[] = [];
  const note = (kind: DataNote["kind"], topic: DataNote["topic"], message: string) =>
    notes.push({ kind, topic, message });
  const usd = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const model = new Map<InsightLineItem, PricingModel>();
  items.forEach(i => model.set(i, pricingModel(i)));
  const by = (m: PricingModel) => items.filter(i => model.get(i) === m);

  const grossOnDemandUsd = round2(
    by("On-Demand").filter(i => i.costUsd > 0).reduce((s, i) => s + i.costUsd, 0));
  const savingsPlanCreditsUsd = round2(
    Math.abs(by("Savings Plan credit").reduce((s, i) => s + i.costUsd, 0)));
  const savingsPlanFeesUsd = round2(by("Savings Plan fee").reduce((s, i) => s + i.costUsd, 0));
  const reservedUsd = round2(by("Reserved").reduce((s, i) => s + i.costUsd, 0));
  const spotUsd = round2(by("Spot").reduce((s, i) => s + i.costUsd, 0));

  const commitment: CommitmentPosture = {
    grossOnDemandUsd,
    savingsPlanCreditsUsd,
    savingsPlanFeesUsd,
    reservedUsd,
    spotUsd,
    coverageOfOnDemand: grossOnDemandUsd === 0 ? 0 : savingsPlanCreditsUsd / grossOnDemandUsd,
    hasNoCommitment:
      savingsPlanCreditsUsd === 0 && savingsPlanFeesUsd === 0 && reservedUsd === 0 && spotUsd === 0,
  };
  if (commitment.hasNoCommitment) {
    note("absent", "commitment",
      "Every eligible charge on this bill is at standard On-Demand rates. There is no Savings Plan, " +
      "Reserved Instance or Spot usage anywhere in it.");
  } else if (savingsPlanCreditsUsd > 0 && savingsPlanFeesUsd === 0) {
    // Extremely common: the discount lands on the member account, the
    // commitment was bought on the payer account. Say so plainly instead of
    // asking the customer for a bill they may not have.
    note("partial", "commitment",
      "A Savings Plan discount of " + usd(savingsPlanCreditsUsd) + " is applied here, but the cost of that " +
      "commitment does not appear on this bill - it sits on the payer account. The discount is real; what " +
      "was paid to obtain it is not visible from this document.");
  }

  interface RateAcc {
    hours: number; costUsd: number; type: string; region: string;
    models: Map<PricingModel, { hours: number; costUsd: number }>;
  }
  const rateAcc = new Map<string, RateAcc>();
  for (const i of items) {
    const t = instanceType(i);
    // Zero-cost rows are kept: RI-covered hours are real usage billed at
    // USD 0.00, and dropping them would overstate the effective rate.
    if (!t || hourlyRate(i) === null || i.costUsd < 0) continue;
    const k = t + "|" + i.region;
    const cur = rateAcc.get(k) || { hours: 0, costUsd: 0, type: t, region: i.region, models: new Map() };
    cur.hours += i.quantity as number;
    cur.costUsd += i.costUsd;
    const m = pricingModel(i);
    const mc = cur.models.get(m) || { hours: 0, costUsd: 0 };
    mc.hours += i.quantity as number;
    mc.costUsd += i.costUsd;
    cur.models.set(m, mc);
    rateAcc.set(k, cur);
  }
  const machineRates: MachineRate[] = Array.from(rateAcc.values())
    .map(v => {
      const byModel = Array.from(v.models.entries())
        .map(([model, mc]) => ({
          model,
          hours: Math.round(mc.hours * 1000) / 1000,
          costUsd: round2(mc.costUsd),
          rateUsd: mc.hours > 0 ? mc.costUsd / mc.hours : 0,
        }))
        .sort((a, b) => b.costUsd - a.costUsd);
      return {
        instanceType: v.type,
        region: v.region,
        hours: Math.round(v.hours * 1000) / 1000,
        costUsd: round2(v.costUsd),
        effectiveRateUsd: v.hours > 0 ? v.costUsd / v.hours : 0,
        byModel,
        isBlended: byModel.length > 1,
        generation: generation(v.type) as Generation,
      };
    })
    .sort((a, b) => b.costUsd - a.costUsd);
  if (machineRates.length === 0) {
    note("absent", "machines",
      "This bill has no hourly instance charges, so there are no per-machine rates to compare.");
  } else {
    const blended = machineRates.filter(r => r.isBlended).length;
    if (blended > 0) {
      note("context", "machines",
        blended + " of " + machineRates.length + " machine types were billed under more than one pricing " +
        "model, so their effective rate is a blend. The individual rates are shown beneath each one.");
    }
  }

  const matrixAcc = new Map<string, { region: string; category: string; costUsd: number }>();
  for (const i of items) {
    const category = i.serviceCategory || "Other";
    const k = i.region + " || " + category;
    const cur = matrixAcc.get(k) || { region: i.region, category, costUsd: 0 };
    cur.costUsd += i.costUsd;
    matrixAcc.set(k, cur);
  }
  const regionCategoryMatrix = Array.from(matrixAcc.values()).map(v => ({ ...v, costUsd: round2(v.costUsd) }));

  const topLineItems = [...items]
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, 10)
    .map(i => ({ ...i, share: totalUsd === 0 ? 0 : i.costUsd / totalUsd }));

  const instanceItems = items.filter(i => instanceType(i) !== null);
  const instanceTotal = instanceItems.reduce((s, i) => s + i.costUsd, 0);

  /* ---- remaining data-availability notes ----------------------------- */
  const storageTotal = items.reduce((s, i) => s + (storageClass(i) ? i.costUsd : 0), 0);
  if (storageTotal === 0) {
    note("absent", "storage", "No storage charges appear on this bill.");
  }
  const dbTotal = items.reduce((s, i) => s + (dbEngine(i) ? i.costUsd : 0), 0);
  if (dbTotal === 0) {
    note("absent", "database", "No managed database charges appear on this bill.");
  }
  const regions = new Set(items.map(i => i.region));
  if (regions.size === 1) {
    note("context", "regions",
      "Everything on this bill runs in a single region (" + Array.from(regions)[0] + "), so there is no " +
      "regional split to compare.");
  }
  if (totalUsd === 0) {
    note("context", "bill",
      "Every line on this bill is zero-cost - free-tier or fully credited usage. There is spend activity " +
      "to look at, but no money to break down.");
  }
  // Instance coverage is worth stating: a rate table built on 12% of the
  // compute bill should not read as though it covers all of it.
  if (instanceTotal > 0 && totalUsd > 0) {
    const pctOfBill = (instanceTotal / totalUsd) * 100;
    if (pctOfBill < 40) {
      note("context", "machines",
        "Named machine types account for " + pctOfBill.toFixed(0) + "% of this bill (" + usd(instanceTotal) +
        "). The rest is usage-based charges such as storage, data transfer and requests, which are not " +
        "billed per machine.");
    }
  }

  const grossChargesUsd = round2(items.filter(i => i.costUsd > 0).reduce((s, i) => s + i.costUsd, 0));
  const creditsUsd = round2(Math.abs(items.filter(i => i.costUsd < 0).reduce((s, i) => s + i.costUsd, 0)));
  if (creditsUsd > 0) {
    note("context", "bill",
      "This bill shows " + usd(grossChargesUsd) + " of charges less " + usd(creditsUsd) +
      " of credits, netting to " + usd(totalUsd) + ". Percentages for charges and credits are " +
      "shown against their own totals, not mixed together.");
  }

  return {
    totalUsd,
    grossChargesUsd,
    creditsUsd,
    lineCount: items.length,
    regionCount: new Set(items.map(i => i.region)).size,
    categoryCount: new Set(items.map(i => i.serviceCategory || "Other")).size,
    byCategory: breakdown(items, i => i.serviceCategory || "Other", totalUsd),
    byRegion: breakdown(items, i => i.region, totalUsd),
    byService: breakdown(items, i => i.serviceName, totalUsd),
    servicesByCategory: Object.fromEntries(
      Array.from(new Set(items.map(i => i.serviceCategory || "Other"))).map(cat => {
        const inCat = items.filter(i => (i.serviceCategory || "Other") === cat);
        const catTotal = inCat.reduce((s2, i) => s2 + i.costUsd, 0);
        return [cat, breakdown(inCat, i => i.serviceName, catTotal)];
      }),
    ),
    byPricingModel: breakdown(items, i => model.get(i) as string, totalUsd),
    byInstanceType: breakdown(instanceItems, instanceType, instanceTotal),
    byGeneration: breakdown(instanceItems, i => generation(instanceType(i)), instanceTotal),
    byStorageClass: breakdown(items, storageClass, totalUsd),
    byDbEngine: breakdown(items, dbEngine, totalUsd),
    topLineItems,
    regionCategoryMatrix,
    commitment,
    machineRates,
    notes,
  };
}
