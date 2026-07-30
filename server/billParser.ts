/**
 * AWS Billing PDF → BOM line-item parser.
 *
 * pdf-parse extracts the AWS bill text WITHOUT column spacing — the three
 * table columns (Description | Usage Quantity | Amount in USD) are glued
 * together on a single line, e.g.:
 *
 *   "Elastic Compute CloudUSD 1,703.20"                       ← service (L0)
 *   "Asia Pacific (Hyderabad)USD 130.57"                      ← region (L1)
 *   "Amazon Elastic Compute Cloud NatGatewayUSD 121.04"       ← sub-service (L2)
 *   "$0.056 per NAT gateway Hour2,160 HrsUSD 120.96"          ← usage leaf (L3)
 *   "t3.small ... Savings Plans252.312 Hrs(USD 5.65)"         ← negative credit
 *
 * Long descriptions wrap across multiple lines, sometimes leaving the
 * quantity+amount alone on a following line ("93.387 GB-MoUSD 8.52").
 *
 * The parser walks lines, tracks service/region/sub-service context via
 * known region names + hierarchy rules, and emits one BOM item per leaf.
 */

export interface BomLineItem {
  region: string;
  serviceCategory: string;
  serviceName: string;
  description: string;
  quantity: number | null;
  uom: string | null;
  costUsd: number;
  /** true when the parser could not confidently classify — LLM enrichment target */
  needsEnrichment: boolean;
}

export interface ParsedBill {
  billingPeriod: string | null;
  accountId: string | null;
  grandTotalUsd: number | null;
  items: BomLineItem[];
}

/* ------------------------------------------------------------------ */
/* Service name → category mapping (covers common AWS services)        */
/* ------------------------------------------------------------------ */

const CATEGORY_RULES: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /marketplace|openvpn|sold by/i, category: "AWS Marketplace" },
  { pattern: /nat ?gateway|virtual private cloud|vpc|cloudfront|route ?53|direct connect|elastic load balancing|api gateway|global accelerator|transit gateway|data transfer|app mesh|cloud map|vpn|registrar|domain/i, category: "Networking & Content Delivery" },
  { pattern: /elastic compute cloud|\bec2\b|lambda|lightsail|\bbatch\b|elastic beanstalk|app runner|fargate|savings plan/i, category: "Compute" },
  { pattern: /simple storage service|\bs3\b|glacier|elastic file system|\befs\b|\bfsx\b|storage gateway|\bbackup\b|\bebs\b/i, category: "Storage" },
  { pattern: /relational database|\brds\b|dynamodb|elasticache|redshift|documentdb|neptune|timestream|memorydb|aurora|keyspaces/i, category: "Database" },
  { pattern: /athena|elastic mapreduce|\bemr\b|kinesis|\bglue\b|quicksight|opensearch|elasticsearch|\bmsk\b|managed streaming|lake formation|data pipeline|firehose/i, category: "Analytics" },
  { pattern: /cloudwatch|cloudtrail|\bconfig\b|systems manager|cloudformation|organizations|control tower|service catalog|trusted advisor|license manager|managed grafana|managed prometheus|auto ?scaling|cost explorer|aws budgets|cost and usage report/i, category: "Management & Governance" },
  { pattern: /identity and access|\biam\b|key management|\bkms\b|secrets manager|certificate manager|guardduty|inspector|macie|\bwaf\b|shield|cognito|security hub|directory service|firewall|detective/i, category: "Security, Identity & Compliance" },
  { pattern: /simple notification|\bsns\b|simple queue|\bsqs\b|step functions|eventbridge|\bmq\b|appflow|simple workflow/i, category: "Application Integration" },
  { pattern: /sagemaker|comprehend|rekognition|polly|transcribe|translate|textract|\blex\b|bedrock|forecast|personalize|kendra/i, category: "Machine Learning & AI" },
  { pattern: /codebuild|codecommit|codedeploy|codepipeline|codeartifact|cloud9|x-ray|codestar|amplify|\bkiro\b/i, category: "Developer Tools" },
  { pattern: /elastic container|\becs\b|\beks\b|kubernetes|container registry|\becr\b/i, category: "Containers" },
  { pattern: /workspaces|appstream|worklink/i, category: "End User Computing" },
  { pattern: /simple email|\bses\b|workmail|\bchime\b|pinpoint/i, category: "Business Applications" },
  { pattern: /database migration|\bdms\b|migration hub|datasync|snowball|transfer family|elastic disaster recovery|\bdrs\b/i, category: "Migration & Transfer" },
  { pattern: /elemental|mediaconvert|medialive|mediapackage|\bivs\b|interactive video/i, category: "Media Services" },
  { pattern: /\biot\b/i, category: "Internet of Things" },
  // Anchored: a bare /support/i also matched Marketplace products whose vendor
  // blurb contains the word ("Ubuntu 18 | support by Gigabits"), filing $507
  // of third-party software under AWS Support.
  { pattern: /\b(?:aws|business|developer|enterprise|basic)\s+support\b|^support$/i, category: "Support" },
];

/**
 * Leaf-level overrides, evaluated before the service-header rules.
 *
 * An AWS bill nests sub-services under a service header, and the header is
 * normally the correct signal: GuardDuty analysing Lambda logs is Security,
 * not Compute; CloudWatch delivering logs to S3 is Management, not Storage.
 * Deriving the category from the leaf description instead would misfile all
 * of those. These are the narrow exceptions where the sub-service names a
 * genuinely different product from the header it is billed under.
 */
const SUBSERVICE_OVERRIDES: Array<{ pattern: RegExp; category: string }> = [
  // EBS is a storage product invoiced beneath the "Elastic Compute Cloud"
  // header. Without this, every EBS volume and snapshot charge lands in
  // Compute - $14,094.59 across the 13 reference bills.
  { pattern: /\bEBS\b|\belastic block store\b/i, category: "Storage" },
  // NAT Gateway is likewise invoiced under the EC2 header but is a
  // networking charge - $3,868.89 across the reference bills.
  { pattern: /\bnat ?gateway\b/i, category: "Networking & Content Delivery" },
];

/** Classify an AWS service name into a category; empty string when unknown. */
export function classifyService(serviceName: string, subService = "", description = ""): string {
  for (const rule of SUBSERVICE_OVERRIDES) {
    if (rule.pattern.test(subService)) return rule.category;
  }
  // The service header is the authoritative signal and is matched ALONE first.
  // Folding the sub-service into the same haystack lets a usage-type name
  // hijack the category whenever it happens to contain another service's
  // keyword: "OpenSearch ESDomain" matched /domain/ and became Networking,
  // "Inspector EC2-Scanning" matched /ec2/ and became Compute, "GuardDuty
  // PaidLambdaNetworkLogsAnalyzed" matched /lambda/ and became Compute.
  // That mislabelled $3,415.79 across the 13 reference bills.
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(serviceName)) return rule.category;
  }

  // Only when the header says nothing does the sub-service get a vote - some
  // bills carry a bare header ("Bandwidth") whose meaning lives in the leaf.
  const haystack = `${serviceName} ${subService}`.trim();
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(haystack)) return rule.category;
  }

  // Marketplace LAST, as a fallback for third-party software the rules could
  // not otherwise place. It must not pre-empt the real rules: Bedrock
  // foundation models (Claude, Cohere) are invoiced through Marketplace but
  // are genuinely Machine Learning & AI consumption, and a presales engineer
  // needs them mapped to the target cloud's AI service, not buried under
  // "third-party software".
  if (/\bAWS Marketplace\b|\bsold by\b/i.test(description)) return "AWS Marketplace";
  return "";
}

/* ------------------------------------------------------------------ */
/* Known AWS region display names used in bills                        */
/* ------------------------------------------------------------------ */

const REGION_NAMES = [
  "Global", "Any",
  "US East (N. Virginia)", "US East (Northern Virginia)", "US East (Ohio)",
  "US West (N. California)", "US West (Northern California)", "US West (Oregon)",
  "Africa (Cape Town)", "Asia Pacific (Hong Kong)", "Asia Pacific (Hyderabad)",
  "Asia Pacific (Jakarta)", "Asia Pacific (Melbourne)", "Asia Pacific (Mumbai)",
  "Asia Pacific (Osaka)", "Asia Pacific (Seoul)", "Asia Pacific (Singapore)",
  "Asia Pacific (Sydney)", "Asia Pacific (Tokyo)", "Asia Pacific (Malaysia)",
  "Asia Pacific (Thailand)", "Canada (Central)", "Canada West (Calgary)",
  "Europe (Frankfurt)", "Europe (Ireland)", "Europe (London)", "Europe (Milan)",
  "Europe (Paris)", "Europe (Spain)", "Europe (Stockholm)", "Europe (Zurich)",
  "EU (Frankfurt)", "EU (Ireland)", "EU (London)", "EU (Milan)", "EU (Paris)",
  "EU (Spain)", "EU (Stockholm)", "EU (Zurich)",
  "Israel (Tel Aviv)", "Middle East (Bahrain)", "Middle East (UAE)",
  "South America (Sao Paulo)", "South America (São Paulo)",
  "Mexico (Central)", "Asia Pacific (Taipei)", "Asia Pacific (New Zealand)",
  "US West (Los Angeles)", "China (Beijing)", "China (Ningxia)",
  "AWS GovCloud (US-East)", "AWS GovCloud (US-West)", "No Region",
];

/**
 * The geographic groups AWS names regions under. A new region is essentially
 * always a new city inside one of these, so matching the group prefix plus a
 * parenthesised place recognises regions that do not exist yet.
 *
 * This closes a whitelist-enumerating-an-open-world bug with real consequences.
 * "Mexico (Central)" launched in January 2025 and was absent from the list, so
 * its line was not recognised as a region header at all: currentRegion never
 * advanced and every Mexican charge was silently attributed to whichever region
 * happened to precede it - or to "Global" if it came first. The region x
 * category grid is the direct input for per-region price comparison against
 * another cloud, so a charge filed under the wrong region is worse than one
 * filed under none.
 *
 * The prefix is required precisely so that a service name carrying a
 * parenthesised qualifier - "...for MySQL Community Edition (Multi-AZ)" - can
 * never be mistaken for a region.
 */
const REGION_GROUP_RE =
  /^(?:US East|US West|Africa|Asia Pacific|Canada|Canada West|Europe|EU|Israel|Middle East|South America|Mexico|China|AWS GovCloud)\s*\([A-Za-z0-9 .,'’ÀÁÂÃÄÅàáâãäåÇçÈÉÊËèéêëÌÍÎÏìíîïÑñÒÓÔÕÖòóôõöÙÚÛÜùúûü-]+\)$/;
const REGION_SET = new Set(REGION_NAMES.map(r => r.toLowerCase()));

/**
 * True when the PDF contains an itemised "Charges by service" table.
 *
 * The AWS console can export two very different documents: the one-page
 * "AWS estimated bill summary", which carries only a grand total, and the
 * full Bills page with per-service charge detail. Only the latter can become
 * a BOM. Detecting the difference lets the upload path tell the user exactly
 * which export they supplied and how to get the right one, instead of a
 * generic "no line items found".
 */
export function hasItemizedCharges(text: string): boolean {
  return /DescriptionUsage QuantityAmount in USD/i.test(text)
      || /Charges by service/i.test(text);
}

/**
 * The currency this bill is denominated in, or null if it cannot be determined.
 *
 * Every amount pattern in this parser requires the literal string "USD", so a
 * bill in any other currency yields zero line items. That is the safe outcome -
 * silently reading "INR 41,500.00" as 41,500 dollars would overstate a BOM by
 * roughly 85x - but the upload path used to blame the file and tell the customer
 * to contact support. AWS bills many countries in local currency, so a
 * presales engineer anywhere outside the USD default hits this immediately.
 *
 * Verified live: a normalised INR bill extracted cleanly and produced 0 items.
 */
export function detectBillCurrency(text: string): string | null {
  // The table header is the most reliable statement of the billed currency,
  // then the summary total, then the grand-total line.
  const patterns = [
    /Amount in ([A-Z]{3})\b/,
    /Total in ([A-Z]{3})\b/,
    /Total (?:pre-tax|tax)\s*([A-Z]{3})\s?[\d,]/,
    /(?:Estimated\s+)?grand total:?\s*([A-Z]{3})\s?[\d,]/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1].toUpperCase();
  }
  // No ISO code anywhere: fall back to a leading currency symbol on a rate line.
  const sym = text.match(/(?:^|\s)(?:Rs\.?|₹|€|£|¥)\s?\d/);
  if (sym) {
    const c = sym[0].trim()[0];
    return c === "\u20B9" || /R/i.test(c) ? "INR"
         : c === "\u20AC" ? "EUR"
         : c === "\u00A3" ? "GBP"
         : c === "\u00A5" ? "JPY" : null;
  }
  return null;
}

export function isRegionName(name: string): boolean {
  const t = name.trim();
  return REGION_SET.has(t.toLowerCase()) || REGION_GROUP_RE.test(t);
}

/* ------------------------------------------------------------------ */
/* Tokenization of a glued line                                        */
/* ------------------------------------------------------------------ */

/** Parse "USD 1,572.63" / "(USD 5.65)" → signed number, or null. */
export function parseUsd(raw: string): number | null {
  const m = raw.trim().match(/^\(?\s*-?\s*USD\s*(-?[\d,]+(?:\.\d+)?)\s*\)?$/i);
  if (!m) return null;
  const negative = raw.trim().startsWith("(") || m[1].startsWith("-");
  const val = parseFloat(m[1].replace(/,/g, "").replace(/^-/, ""));
  if (Number.isNaN(val)) return null;
  return negative ? -val : val;
}

/**
 * Trailing amount: "...(USD 5.65)" or "...USD 120.96" at end of line.
 * The description text immediately precedes it with no separator.
 */
const TRAILING_AMOUNT_RE = /(\((?:USD)\s?-?[\d,]+(?:\.\d+)?\)|(?<!\()USD\s?-?[\d,]+(?:\.\d+)?)\s*$/;

/**
 * Quantity + UOM glued to the end of the description, right before the amount:
 * "...NAT gateway Hour2,160 Hrs" → qty=2160, uom="Hrs".
 * UOM = 1–3 word tokens (letters, digits-in-unit, dashes, slashes, parens).
 * The quantity number is glued directly after description text.
 */
const QTY_UOM_TAIL_RE = /(\d[\d,]*(?:\.\d+)?)[ \u00a0]+([A-Za-z][A-Za-z0-9/()\-]*(?:[ \u00a0][A-Za-z][A-Za-z0-9/()\-]*){0,2})$/;
/**
 * Stricter variant used first: quantity glued directly to non-space text
 * (the usual case: "...Hour2,160 Hrs", "...queries468,273,455 Queries").
 * A glued quantity is unambiguous evidence of the Usage Quantity column.
 */
const GLUED_QTY_UOM_TAIL_RE = /(?<=[a-z)\]%.])(\d[\d,]*(?:\.\d+)?)[ \u00a0]+([A-Za-z][A-Za-z0-9/()\-]*(?:[ \u00a0][A-Za-z][A-Za-z0-9/()\-]*){0,2})$/;

/**
 * Whitelist of usage units seen in AWS bills. A trailing "<number> <word(s)>"
 * group only counts as the Usage Quantity column when the word(s) look like a
 * unit — this prevents sub-service headers such as
 * "Amazon Virtual Private Cloud Public IPv4 AddressesUSD 32.42" (→ "4 Addresses")
 * or "Amazon Route 53 DNS-QueriesUSD 187.31" (→ "53 DNS-Queries")
 * from being misread as usage leaves.
 */
const UOM_WHITELIST_RE = new RegExp(
  "^(" +
    [
      "Hrs", "Hours?", "Hourly",
      "GB", "GB-Mo", "GB-Month", "GB-Hours?", "GB-Second(s)?", "TB", "MB",
      "Months?", "Days?", "Minutes?", "Seconds?", "Second",
      "Requests?", "IA-Requests?", "Queries", "Query",
      "API Calls?", "Calls?",
      "vCPU-Hours?", "ACU-Hrs", "ACU-hours?", "LCU-Hrs", "LCU-hours?",
      "ReadCapacityUnit-Hrs", "WriteCapacityUnit-Hrs", "Unit-Hrs", "Units?",
      "HostedZones?", "HostedZone",
      "Config RuleEvaluations", "RuleEvaluations",
      "Alarms?", "Metrics?", "Events?", "Objects?", "Keys?", "Secrets?",
      "Findings?", "Instances?", "Certificates?", "Rules?", "WebACLs?", "ACLs?",
      "Checks?", "Messages?", "Notifications?", "Emails?", "Dashboards?",
      "Snapshots?", "Volumes?", "Gateways?", "Endpoints?", "Zones?",
      "Assessments?", "Scans?", "Evaluations?", "Executions?", "Invocations?",
      "Transitions?", "Deliveries", "Records?", "Streams?", "Shards?",
      "Signals?", "Observations?", "Fees?", "IPs?",
      "vCPU-Hours?", "GB-mos?", "Finding Ingestion Events?",
      "Security Checks?", "ConfigurationItemRecorded",
      "Lambda-GB-Second(s)?", "Build-Mins?", "build minutes?",
      "IOPS-Mo", "IOs?", "Ops?", "Operations?", "Transactions?",
      "Devices?", "Connections?", "Sessions?", "Users?", "Licenses?",
      "Domains?", "Tokens?", "Pieces?", "Items?", "Resources?", "Rotations?",
      "traces?", "GetRecords?", "Puts?", "Gets?",
      // AWS Config kerned artifacts (e.g. "APS3-Config urationItemRecorded")
      "APS\\d+-?Config ?urationItemRecorded", "Config ?urationItemRecorded",
      "Config ?RuleEvaluations",
      // Confirmed via real-bill verification (scripts/verify-bills.ts):
      // these were silently dropping genuine leaf charges because the unit
      // wasn't recognized, forcing the line to fall through to the
      // "no quantity found" default of isGroupLine: true.
      "Accelerator-Hours?", "Dollars?", "Activit(?:y|ies)", "Faces?-Mo",
      // "5,188 PagesUSD 7.78" (Textract) was read as a group header because
      // "Pages" was unlisted, silently dropping the whole $7.78 charge and
      // leaving bill 900206238693 short by exactly that amount.
      "Pages?", "Documents?", "Jobs?", "Tasks?", "Hosts?", "Clusters?",
      "Nodes?", "Buckets?", "Tables?", "Indexes?", "Partitions?",
    ].join("|") +
  ")$",
  "i"
);

/** Generic fallback for AWS compound units following the common
 *  "<Concept>-<TimeUnit>" convention (GB-Mo, ACU-Hrs, GiBps-mo, Tag-Mo,
 *  Faces-Mo, Accelerator-Hours, ...). Whitelisting every concept AWS could
 *  ever bill by name is a losing battle -- catching the SHAPE of the unit
 *  is far more durable than an ever-growing exact-string list. */
const UOM_COMPOUND_SUFFIX_RE = /-(Hours?|Hrs|Mo|Month|Sec|Seconds?)$/i;

/** Leaf usage-line description markers: rate lines start with "$x per ..." or "USDx per ...". */
const RATE_PREFIX_RE = /^(\$|USD ?\d|Rs\.? ?\d|€|£)/;
/** Credit / free-tier / savings-plan leaf lines (no rate prefix).
 *  NOTE: must NOT match product names like "T4GCPUCredits" or "CPU Credits"
 *  (usage-type headers) — require credit-context wording, not the bare word. */
const CREDIT_LINE_RE = /(covered by|free of charge|free tier|under .*free|savings? plans?|credit applied|applied credit|aws credits?\b|promotional credits?|\bfree\b|reserved instance applied|per month .*free|instance usage under|usage under .*plan)/i;

/** Test whether a unit phrase (1–4 words) looks like a usage unit: the
 *  whole phrase or its last word must be whitelisted (handles multi-word
 *  units such as "Security Checks", "Finding Ingestion Events"). */
export function isPlausibleUom(phrase: string): boolean {
  const p = phrase.trim();
  if (!p || p.length > 40) return false;
  if (UOM_WHITELIST_RE.test(p) || UOM_COMPOUND_SUFFIX_RE.test(p)) return true;
  const words = p.split(/[ \u00a0]+/);
  if (words.length >= 2 && words.length <= 4) {
    const last = words[words.length - 1];
    return UOM_WHITELIST_RE.test(last) || UOM_COMPOUND_SUFFIX_RE.test(last);
  }
  return false;
}

/**
 * Clean a raw UOM captured from the PDF.
 *
 * pdf-parse reproduces the visual text, so a unit can arrive kerned apart
 * ("Config uration ItemRecorded"), carrying a region-code prefix
 * ("APS3-ConfigurationItemRecorded"), or with leaked rate text in front of it
 * ("per Secret5 Secrets", "Annotation Requests6 Requests", "address720 Hrs").
 * The cost and quantity on these rows are correct - only the label is dirty -
 * but an unnormalised label silently excludes the row from any per-unit
 * analysis that keys on the unit, such as effective hourly rate.
 */
export function normalizeUom(raw: string | null): string | null {
  if (raw == null) return null;
  let u = raw.trim().replace(/[\s\u00a0]+/g, " ");
  if (!u) return null;

  // 1) repair kerning splits inside a single word. Only join when the next
  //    fragment starts lowercase, so real multi-word units ("Security Checks",
  //    "Finding Ingestion Events") are left intact.
  u = u.replace(/([a-z])\s+([a-z])/g, "$1$2");

  // 2) leaked rate text before the real unit: keep the trailing unit when it
  //    stands on its own as a recognised unit.
  const tail = u.match(/(?:^|\D)(\d[\d,]*)\s*([A-Za-z][A-Za-z0-9/()-]*)$/);
  if (tail && isPlausibleUom(tail[2])) return tail[2];

  // 3) AWS region-code prefix ("APS3-", "USE1-"). Requires a digit before the
  //    dash so compound units such as "GB-Mo" are never truncated.
  const stripped = u.replace(/^[A-Z]{2,4}\d-\s*/, "");
  if (stripped !== u && isPlausibleUom(stripped)) return stripped;

  return u;
}

export interface TokenizedLine {
  description: string;
  quantity: number | null;
  uom: string | null;
  costUsd: number;
  /** true = description + amount only (service/region/sub-service header) */
  isGroupLine: boolean;
}

/**
 * Tokenize a glued bill line into description / quantity / uom / amount.
 * Returns null when the line carries no trailing USD amount.
 */
export function tokenizeLine(line: string): TokenizedLine | null {
  const amountMatch = line.match(TRAILING_AMOUNT_RE);
  if (!amountMatch) return null;
  const costUsd = parseUsd(amountMatch[1]);
  if (costUsd === null) return null;

  let rest = line.slice(0, amountMatch.index).trimEnd();

  // 0) Whole-line qty column FIRST: "77,315 Security ChecksUSD 61.85",
  //    "2.755 GBUSD 0.55", "12 GBUSD 0.08" — the entire line is the usage
  //    quantity column (wrapped from a long description). Must run before
  //    the glued rule, which would otherwise split decimals ("2." + "755 GB").
  const wholeLine0 = rest.match(/^(\d[\d,]*(?:\.\d+)?)[ \u00a0]+(.{1,40}?)$/);
  if (wholeLine0 && isPlausibleUom(wholeLine0[2])) {
    const quantity = parseFloat(wholeLine0[1].replace(/,/g, ""));
    if (!Number.isNaN(quantity)) {
      return { description: "", quantity, uom: wholeLine0[2].trim(), costUsd, isGroupLine: false };
    }
  }

  // 1) Glued quantity: "...Hour2,160 Hrs" — number fused to description text.
  //    This is unambiguous evidence of the Usage Quantity column, provided
  //    the unit looks plausible (a short word group) AND either the unit is
  //    whitelisted or the line reads as a rate/credit line.
  const glued = rest.match(GLUED_QTY_UOM_TAIL_RE);
  if (glued) {
    const quantity = parseFloat(glued[1].replace(/,/g, ""));
    const uom = glued[2].trim();
    const before = rest.slice(0, glued.index ?? 0).trim();
    // A rate/credit prefix is evidence the line IS a usage leaf, so an
    // unrecognised unit is still accepted - but only as a single bare token.
    // Without that restriction "$0.10 per Hour720 Hrs" splits at the rate's
    // decimal, yielding quantity 10 and unit "per Hour720 Hrs".
    const plausible =
      isPlausibleUom(uom) || RATE_PREFIX_RE.test(before) || CREDIT_LINE_RE.test(before);
    if (!Number.isNaN(quantity) && before.length > 0 && plausible) {
      return { description: before, quantity, uom, costUsd, isGroupLine: false };
    }
  }

  // 2) Spaced quantity: only when the whole remaining text IS the qty column
  //    (wrapped line whose qty+amount landed alone: "93.387 GB-MoUSD 8.52"),
  //    or the description part is a rate/credit line. Requiring this prevents
  //    header names containing numbers ("Amazon Route 53 HostedZone") from
  //    being split mid-description.
  const spaced = rest.match(QTY_UOM_TAIL_RE);
  if (spaced) {
    const quantity = parseFloat(spaced[1].replace(/,/g, ""));
    const uom = spaced[2].trim();
    const before = rest.slice(0, spaced.index ?? 0).trim();
    const acceptable =
      isPlausibleUom(uom) &&
      (before.length === 0 || RATE_PREFIX_RE.test(before) || CREDIT_LINE_RE.test(before));
    if (!Number.isNaN(quantity) && acceptable) {
      return { description: before, quantity, uom, costUsd, isGroupLine: false };
    }
  }

  const restTrim = rest.trim();

  const BARE_SAVINGS_PLAN_HEADER_RE =
    /^(?:[A-Za-z0-9]+\s+){0,3}Savings Plans$|^Savings Plans for AWS [A-Za-z]+(?:\s+[A-Za-z]+)? usage$/i;
  if (BARE_SAVINGS_PLAN_HEADER_RE.test(restTrim)) {
    return { description: restTrim, quantity: null, uom: null, costUsd, isGroupLine: true };
  }

  // Rate/credit lines whose quantity wrapped onto another line still must be
  // treated as leaves (not group headers) so context is not corrupted.
  if (RATE_PREFIX_RE.test(restTrim) || CREDIT_LINE_RE.test(restTrim)) {
    return { description: restTrim, quantity: null, uom: null, costUsd, isGroupLine: false };
  }

  return { description: rest.trim(), quantity: null, uom: null, costUsd, isGroupLine: true };
}

/* ------------------------------------------------------------------ */
/* Main parser                                                         */
/* ------------------------------------------------------------------ */

const SECTION_END_RE = /^(Charges by account|Invoices$|Tax Invoices|Savings ?\(|Taxes by service)/i;
const PROVIDER_RE = /^(.+?)\(\d+\)Total (?:pre-tax|tax)USD\s?[\d,.]+$/i;
const TABLE_HEADER_RE = /^DescriptionUsage QuantityAmount in USD$/i;
const TOTAL_TAX_RE = /^Total taxUSD/i;
const PAGE_ARTIFACT_RE = /^(Page \d+ of \d+|Billing period|Account ID|Date printed)/i;

/**
 * Top-level service names appear as "NameUSD x.xx" group lines. We treat a
 * group line as L0 service when we're at document scope (no region pending)
 * OR when its name matches a known service-ish heuristic. Since indentation
 * is lost, we use this rule: after a provider header, the FIRST group line
 * is a service; a region-name group line switches region within the current
 * service; any other group line following a region is a sub-service; a group
 * line that is neither region nor following-a-region is a NEW service if the
 * previous context已 completed. To disambiguate reliably we track state:
 *   state SERVICE → expect region next
 *   after region  → group lines are sub-services until a new region or
 *                   a line that matches a known service name pattern.
 *
 * The practical, robust discriminator used here: a group line is a NEW
 * top-level service when the NEXT meaningful line is a REGION group line.
 * (In AWS bills a service header is always immediately followed by a region
 * header.) Otherwise it's a sub-service.
 */
export function parseAwsBill(text: string): ParsedBill {
  // Normalize: strip zero-width chars, unify nbsp
  const lines = text
    .replace(/\u00ad/g, "")
    .split(/\r?\n/)
    .map(l => l.replace(/\u00a0/g, " ").trimEnd());

  /* ---- header metadata ---- */
  let billingPeriod: string | null = null;
  let accountId: string | null = null;
  let grandTotalUsd: number | null = null;

  for (let i = 0; i < Math.min(lines.length, 60); i++) {
    const l = lines[i].trim();
    if (!billingPeriod) {
      const bp = l.match(/^([A-Z][a-z]{2}\s+\d{1,2}\s*-\s*[A-Z][a-z]{2}\s+\d{1,2},\s*\d{4})$/);
      if (bp) billingPeriod = bp[1];
    }
    if (!accountId && /^\d{12}$/.test(l)) accountId = l;
    if (grandTotalUsd === null) {
      // Some bills print "Grand total:" without the "Estimated" prefix
      // (confirmed on a real bill via scripts/verify-bills.ts) -- match both.
      const gt = l.match(/(?:Estimated\s+)?grand total:\s*USD\s?([\d,.]+)/i);
      if (gt) grandTotalUsd = parseFloat(gt[1].replace(/,/g, ""));
    }
  }

  /* ---- locate charges section ---- */
  let start = lines.findIndex(l => /^Charges by service$/i.test(l.trim()));
  if (start === -1) start = 0;

  const items: BomLineItem[] = [];

  let currentService = "";
  let currentRegion = "";
  let currentSubService = "";
  let lastItem: BomLineItem | null = null;
  /** wrapped description fragments awaiting their qty/amount line */
  let pendingDesc = "";

  // Pre-tokenize meaningful lines for lookahead
  interface Row { raw: string; tok: TokenizedLine | null }
  const rows: Row[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    if (SECTION_END_RE.test(raw)) break;
    if (TABLE_HEADER_RE.test(raw) || PAGE_ARTIFACT_RE.test(raw)) continue;
    if (TOTAL_TAX_RE.test(raw)) { rows.push({ raw, tok: null }); continue; }
    rows.push({ raw, tok: tokenizeLine(raw) });
  }

  /** Pure standalone amount line: "USD 0.00" or "(USD 5.65)". */
  const PURE_AMOUNT_RE = /^\(?USD\s?-?[\d,]+(?:\.\d+)?\)?$/i;

  /** Find the next row that is a group line or leaf, to support lookahead. */
  const nextGroupIsRegion = (idx: number): boolean => {
    for (let j = idx + 1; j < rows.length; j++) {
      const r = rows[j];
      if (!r.tok) continue;
      if (r.tok.isGroupLine) return isRegionName(r.tok.description);
      return false; // next meaningful tokenized row is a leaf
    }
    return false;
  };

  for (let i = 0; i < rows.length; i++) {
    const { raw, tok } = rows[i];

    if (TOTAL_TAX_RE.test(raw)) {
      // provider block ended
      currentService = "";
      currentRegion = "";
      currentSubService = "";
      lastItem = null;
      pendingDesc = "";
      continue;
    }

    if (PROVIDER_RE.test(raw)) {
      currentService = "";
      currentRegion = "";
      currentSubService = "";
      lastItem = null;
      pendingDesc = "";
      continue;
    }

    if (!tok) {
      // No trailing amount → wrapped description fragment.
      // Either continuation of previous leaf's description (rare) or the
      // beginning of a long leaf description whose qty+amount follow later.
      pendingDesc = pendingDesc ? `${pendingDesc} ${raw}` : raw;
      continue;
    }

    // Pure "USD x.xx" line closing a buffered wrapped leaf:
    // join fragments + amount and re-tokenize as one logical line.
    if (pendingDesc && PURE_AMOUNT_RE.test(raw)) {
      const joined = `${pendingDesc}${raw}`;
      const jt = tokenizeLine(joined);
      pendingDesc = "";
      if (jt) {
        const serviceName0 = currentService || currentSubService || "Unknown Service";
        const category0 = classifyService(serviceName0, currentSubService, jt.description);
        const desc0 = jt.description;
        const prefix0 =
          currentSubService && !desc0.startsWith(currentSubService)
            ? `${currentSubService} — `
            : "";
        const item0: BomLineItem = {
          region: currentRegion || "Global",
          serviceCategory: category0,
          serviceName: serviceName0,
          description: `${prefix0}${desc0}`,
          quantity: jt.quantity,
          uom: normalizeUom(jt.uom),
          costUsd: jt.costUsd,
          needsEnrichment: category0 === "",
        };
        items.push(item0);
        lastItem = item0;
      }
      continue;
    }

    if (tok.isGroupLine) {
      // A buffered fragment followed by a group line means the fragment was
      // stray text (rare) — discard it.
      pendingDesc = "";
      lastItem = null;
      const name = tok.description;
      if (isRegionName(name)) {
        currentRegion = name;
        currentSubService = "";
      } else if (!currentService || nextGroupIsRegion(i)) {
        // service header (always followed by a region header)
        currentService = name;
        currentRegion = "";
        currentSubService = "";
      } else {
        currentSubService = name;
      }
      continue;
    }

    // Leaf usage line
    let description = tok.description;
    if (pendingDesc) {
      description = `${pendingDesc} ${description}`.trim();
      pendingDesc = "";
    }
    const serviceName = currentService || currentSubService || "Unknown Service";
    const category = classifyService(serviceName, currentSubService, description);
    const descPrefix =
      currentSubService && !description.startsWith(currentSubService)
        ? `${currentSubService} — `
        : "";
    const item: BomLineItem = {
      region: currentRegion || "Global",
      serviceCategory: category,
      serviceName,
      description: `${descPrefix}${description}`,
      quantity: tok.quantity,
      uom: normalizeUom(tok.uom),
      costUsd: tok.costUsd,
      needsEnrichment: category === "",
    };
    items.push(item);
    lastItem = item;
  }

  return { billingPeriod, accountId, grandTotalUsd, items };
}
