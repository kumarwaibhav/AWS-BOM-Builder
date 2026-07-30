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

  // Accelerator families number a product series, not a generation: trn2 and
  // inf2 are AWS's CURRENT silicon, while m2 would be ancient. A bare /^t/
  // test also swallowed trn1/trn2 into the burstable branch, so Trainium -
  // exactly the hardware an AI workload comparison is about - was badged
  // LEGACY on screen.
  if (/^(?:trn|inf|dl)\d/.test(family)) return n >= 2 ? "Current" : "Previous";

  // Burstable T family only: t2, t3, t4g. The digit must follow the t directly,
  // or trn2 lands here again.
  if (/^t\d/.test(family)) return n >= 4 ? "Current" : n === 3 ? "Previous" : "Legacy";

  // Everything else follows the numeric generation convention (m5 -> m6 -> m7).
  // A family with no digit at all tells us nothing, so claim nothing.
  if (n === 0) return null;
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
  /**
   * A bill with no line items supports no claims at all.
   *
   * Found in Phase 7 against the live deployment: tj-dev is a summary-only
   * AWS export with zero itemised charges, and the note generators happily
   * asserted "every eligible charge is at standard On-Demand rates" and
   * "every line on this bill is zero-cost - there is spend activity to look
   * at". Both are false: there are no charges and no lines, and the invoice
   * states $871.66. The UI happened to mask it by short-circuiting on
   * lineCount === 0, but the API returned the misleading text to anything
   * else that asked.
   */
  const hasLines = items.length > 0;
  const note = (kind: DataNote["kind"], topic: DataNote["topic"], message: string) => {
    if (!hasLines) return;
    notes.push({ kind, topic, message });
  };
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
  let excludedZeroCostHours = 0;
  for (const i of items) {
    const t = instanceType(i);
    if (!t || hourlyRate(i) === null || i.costUsd < 0) continue;
    // Zero-cost rows must NOT enter the denominator.
    //
    // AWS prints an included-at-no-charge companion line beside a paid
    // instance line, e.g. "$0.00 for 1061 Mbps per m6a.xlarge instance-hour
    // (or partial hour) 719 Hrs USD 0.00" - that is EBS-optimized throughput
    // bundled with the instance, not a second set of instance hours. Counting
    // its hours halved every affected rate: on PSBA, m6a.2xlarge printed
    // $0.2222/hr and we reported $0.1111/hr, and six more machine types were
    // understated by exactly 50%. That number feeds the apples-to-apples
    // comparison against the target cloud, so a 2x understatement is the
    // worst kind of wrong - confidently precise and completely false.
    if (i.costUsd === 0) { excludedZeroCostHours += i.quantity as number; continue; }
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
  const excludedHoursLabel = Math.round(excludedZeroCostHours).toLocaleString();
  if (machineRates.length === 0) {
    // Distinguish "no instance charges at all" from "instance charges exist
    // but every one of them is $0.00". Saying the former when the latter is
    // true is exactly the class of false statement this layer must not make -
    // a fully free-tier or fully commitment-covered account does have
    // instance hours, they simply carry no cost on the usage line.
    note("absent", "machines", excludedZeroCostHours > 0
      ? "Every instance-hour on this bill is billed at $0.00 - " + excludedHoursLabel + " hours in total, "
        + "either free-tier usage or hours already covered by a commitment whose cost sits elsewhere. "
        + "There is no rate to compare, because nothing was charged per hour."
      : "This bill has no hourly instance charges, so there are no per-machine rates to compare.");
  } else {
    if (excludedZeroCostHours > 0) {
      note("context", "machines",
        excludedHoursLabel + " instance-hours on this bill are billed at " +
        "$0.00 - features such as EBS-optimized throughput that AWS includes with the instance. They are " +
        "excluded from the observed hourly rates, because counting them would understate what each machine " +
        "actually costs.");
    }
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

  // The machine-types panel is NET of commitment credits, because that is what
  // the account paid. An observed hourly rate must be GROSS, because AWS bills
  // covered usage at full price and credits it back on a separate line -
  // dividing the net cost by the hours would report a rate nobody was charged.
  // Both are right, and on the reference bills they diverge by up to 3.25x
  // (PSBA: $1,593.93 net against $5,183.87 gross). Two panels in one section
  // showing different totals for "instance spend" with nothing said about it
  // reads as an error in one of them.
  if (machineRates.length > 0) {
    const instanceGrossUsd = round2(machineRates.reduce((a, m) => a + m.costUsd, 0));
    const instanceNetUsd = round2(instanceTotal);
    if (Math.abs(instanceGrossUsd - instanceNetUsd) >= 0.01) {
      note("context", "machines",
        "Machine-type spend appears twice on this page, measured two different ways. The machine-types " +
        "panel is net of commitment discounts - " + usd(instanceNetUsd) + " - because that is what the " +
        "account actually paid. The observed hourly rates are gross - " + usd(instanceGrossUsd) + " - " +
        "because AWS bills covered usage at full price and credits it back on a separate line, so a rate " +
        "divided out of the net cost would be a rate nobody was charged. Both figures are correct.");
    }
  }

  /* ---- remaining data-availability notes ----------------------------- */
  // A classifier that returns null for an unrecognised description drops that
  // line out of its panel entirely. On B&G that quietly removed $147.03 of
  // Storage: the panel's own shares still summed to 100%, so nothing looked
  // wrong. Any shortfall against the category total is now stated on screen.
  function classifierShortfall(
    label: string,
    topic: DataNote["topic"],
    category: string,
    keyFn: (i: InsightLineItem) => string | null,
  ): number {
    const inCategory = items.filter(i => (i.serviceCategory || "Other") === category);
    const categoryTotal = inCategory.reduce((s, i) => s + i.costUsd, 0);
    const classified = items.reduce((s, i) => s + (keyFn(i) ? i.costUsd : 0), 0);
    if (categoryTotal <= 0) return classified;
    // Classified spend can exceed the category total, because these charges are
    // invoiced under several service headers - an EBS snapshot sits under EC2,
    // an S3 request under S3. Only a shortfall hides money.
    const missing = round2(categoryTotal - classified);
    const unclassifiedLines = inCategory.filter(i => keyFn(i) === null && i.costUsd !== 0).length;
    if (missing >= 0.01 && unclassifiedLines > 0) {
      note("partial", topic,
        usd(missing) + " of " + category.toLowerCase() + " spend across " + unclassifiedLines +
        " line " + (unclassifiedLines === 1 ? "item" : "items") + " is not shown in the " + label +
        " panel, because the bill's description does not name a recognisable " +
        (topic === "storage" ? "volume or tier type" : "engine") +
        ". It is still counted everywhere else on this page, including the total.");
    }
    return classified;
  }

  const storageTotal = classifierShortfall("storage classes", "storage", "Storage", storageClass);
  if (storageTotal === 0) {
    note("absent", "storage", "No storage charges appear on this bill.");
  }
  const dbTotal = classifierShortfall("database engines", "database", "Database", dbEngine);
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

  if (!hasLines) {
    notes.push({
      kind: "absent", topic: "bill",
      message: "This bill has no itemised charges, so there is nothing to break down. "
             + "The AWS console can export a one-page bill summary that carries only a grand total; "
             + "open Billing and Cost Management, expand 'Charges by service', and export that page instead.",
    });
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
