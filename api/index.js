// server/_core/vercelHandler.ts
import "dotenv/config";

// server/_core/app.ts
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { createExpressMiddleware } from "@trpc/server/adapters/express";

// server/_core/systemRouter.ts
import { z } from "zod";

// server/db.ts
import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

// drizzle/schema.ts
import {
  integer,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  varchar
} from "drizzle-orm/pg-core";
var billStatusEnum = pgEnum("bill_status", [
  "processing",
  "completed",
  "failed"
]);
var bills = pgTable("bills", {
  id: serial("id").primaryKey(),
  /** Session ID for anonymous tracking (no authentication required) */
  sessionId: varchar("sessionId", { length: 128 }).notNull(),
  /** Original uploaded file name */
  fileName: varchar("fileName", { length: 512 }).notNull(),
  /** Supabase Storage object key of the uploaded PDF */
  pdfKey: varchar("pdfKey", { length: 1024 }).notNull(),
  /** Supabase Storage object key of the generated Excel BOM (set after generation) */
  excelKey: varchar("excelKey", { length: 1024 }),
  /** Billing period string extracted from the bill, e.g. "Jun 1 - Jun 30, 2026" */
  billingPeriod: varchar("billingPeriod", { length: 128 }),
  /** AWS Account ID extracted from the bill */
  accountId: varchar("accountId", { length: 64 }),
  /** Grand total in USD extracted from the bill summary */
  grandTotalUsd: numeric("grandTotalUsd", { precision: 14, scale: 2 }),
  /** Calculated total from sum of line items (for reconciliation) */
  calculatedTotalUsd: numeric("calculatedTotalUsd", { precision: 14, scale: 2 }),
  /** Number of BOM line items extracted */
  itemCount: integer("itemCount").default(0).notNull(),
  /** Processing lifecycle status */
  status: billStatusEnum("status").default("processing").notNull(),
  /** Error message when status = failed */
  errorMessage: text("errorMessage"),
  createdAt: timestamp("createdAt").defaultNow().notNull()
});
var bomItems = pgTable("bom_items", {
  id: serial("id").primaryKey(),
  billId: integer("billId").notNull(),
  /** S.No. — 1-based order within the bill */
  serialNo: integer("serialNo").notNull(),
  /** AWS Region, e.g. "Asia Pacific (Mumbai)" or "Global" */
  region: varchar("region", { length: 128 }).notNull(),
  /** AWS Service Category, e.g. "Compute", "Database", "Networking" */
  serviceCategory: varchar("serviceCategory", { length: 128 }).notNull(),
  /** AWS Service Name, e.g. "Elastic Compute Cloud" */
  serviceName: varchar("serviceName", { length: 256 }).notNull(),
  /** AWS Service Description / Config — the detailed rate/usage line */
  description: text("description").notNull(),
  /** AWS Qty — usage quantity (stored as string to preserve precision/format) */
  quantity: numeric("quantity", { precision: 20, scale: 6 }),
  /** AWS UOM — unit of measure, e.g. "Hrs", "GB-Mo", "Requests" */
  uom: varchar("uom", { length: 64 }),
  /** AWS Billed Cost USD (negative for savings-plan credits) */
  costUsd: numeric("costUsd", { precision: 14, scale: 2 }).notNull(),
  /** Whether the LLM enriched/classified this row */
  llmEnriched: integer("llmEnriched").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull()
});

// server/_core/env.ts
var ENV = {
  // DATABASE_URL is the app-native name (used by .env.example, Docker, local
  // dev). POSTGRES_URL is what Supabase's native Vercel integration syncs
  // automatically on every deploy (including password rotations) — preferred
  // when present so Vercel deployments never need a manually-copied secret.
  databaseUrl: process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? "",
  isProduction: process.env.NODE_ENV === "production",
  supabase: {
    url: process.env.SUPABASE_URL ?? "",
    // Server-only secret — bypasses Row Level Security entirely, so it must
    // never be sent to the client or logged. Only imported by server/ code.
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    bucket: process.env.SUPABASE_STORAGE_BUCKET ?? ""
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY ?? "",
    // gemini-2.0-flash was shut down by Google on 2026-06-01. Confirmed
    // against Google's own pricing page (2026-07-27) that gemini-3.6-flash is
    // their current newest stable Flash model and is free-tier eligible.
    model: process.env.GEMINI_MODEL ?? "gemini-3.6-flash"
  }
};

// server/_core/logger.ts
function emit(level, message, context) {
  const entry = {
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    level,
    message,
    ...context ? { context } : {}
  };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
var logger = {
  info: (message, context) => emit("info", message, context),
  warn: (message, context) => emit("warn", message, context),
  error: (message, context) => emit("error", message, context)
};

// server/db.ts
var _db = null;
async function getDb() {
  if (!_db && ENV.databaseUrl) {
    try {
      const client2 = postgres(ENV.databaseUrl, { prepare: false });
      _db = drizzle(client2);
    } catch (error) {
      logger.warn("Database connection failed", { message: error instanceof Error ? error.message : String(error) });
      _db = null;
    }
  }
  return _db;
}
async function createBill(bill) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [inserted] = await db.insert(bills).values(bill).returning({ id: bills.id });
  return inserted.id;
}
async function updateBill(id, patch) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(bills).set(patch).where(eq(bills.id, id));
}
async function getBillById(id) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db.select().from(bills).where(eq(bills.id, id)).limit(1);
  return rows[0];
}
async function listBillsBySession(sessionId) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.select().from(bills).where(eq(bills.sessionId, sessionId)).orderBy(desc(bills.createdAt));
}
async function hasBillsForSession(sessionId) {
  const db = await getDb();
  if (!db) return false;
  const rows = await db.select({ id: bills.id }).from(bills).where(eq(bills.sessionId, sessionId)).limit(1);
  return rows.length > 0;
}
async function insertBomItems(itemsToInsert) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const CHUNK = 100;
  for (let i = 0; i < itemsToInsert.length; i += CHUNK) {
    await db.insert(bomItems).values(itemsToInsert.slice(i, i + CHUNK));
  }
}
async function getBomItemsByBill(billId) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.select().from(bomItems).where(eq(bomItems.billId, billId)).orderBy(bomItems.serialNo);
}
async function deleteBill(id) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.delete(bomItems).where(eq(bomItems.billId, id));
  await db.delete(bills).where(eq(bills.id, id));
}

// server/_core/trpc.ts
import { initTRPC } from "@trpc/server";
import superjson from "superjson";
var t = initTRPC.context().create({
  transformer: superjson
});
var router = t.router;
var publicProcedure = t.procedure;

// server/_core/systemRouter.ts
var systemRouter = router({
  /** Liveness + readiness: reports whether the DB pool is reachable. */
  health: publicProcedure.input(
    z.object({
      timestamp: z.number().min(0, "timestamp cannot be negative")
    })
  ).query(async () => {
    const db = await getDb();
    return {
      ok: true,
      database: db ? "connected" : "unavailable"
    };
  })
});

// server/routers/bills.ts
import { TRPCError } from "@trpc/server";
import { nanoid } from "nanoid";
import { z as z2 } from "zod";
import pdfParse from "pdf-parse/lib/pdf-parse.js";

// server/billParser.ts
var CATEGORY_RULES = [
  { pattern: /marketplace|openvpn|sold by/i, category: "AWS Marketplace" },
  { pattern: /nat ?gateway|virtual private cloud|vpc|cloudfront|route ?53|direct connect|elastic load balancing|api gateway|global accelerator|transit gateway|data transfer|app mesh|cloud map|vpn|registrar|domain/i, category: "Networking & Content Delivery" },
  { pattern: /elastic compute cloud|\bec2\b|lambda|lightsail|\bbatch\b|elastic beanstalk|app runner|fargate|savings plan/i, category: "Compute" },
  { pattern: /simple storage service|\bs3\b|glacier|elastic file system|\befs\b|\bfsx\b|storage gateway|\bbackup\b|\bebs\b/i, category: "Storage" },
  { pattern: /relational database|\brds\b|dynamodb|elasticache|redshift|documentdb|neptune|timestream|memorydb|aurora|keyspaces/i, category: "Database" },
  { pattern: /athena|elastic mapreduce|\bemr\b|kinesis|\bglue\b|quicksight|opensearch|elasticsearch|\bmsk\b|managed streaming|lake formation|data pipeline|firehose/i, category: "Analytics" },
  { pattern: /cloudwatch|cloudtrail|\bconfig\b|systems manager|cloudformation|organizations|control tower|service catalog|trusted advisor|license manager|managed grafana|managed prometheus|auto ?scaling/i, category: "Management & Governance" },
  { pattern: /identity and access|\biam\b|key management|\bkms\b|secrets manager|certificate manager|guardduty|inspector|macie|\bwaf\b|shield|cognito|security hub|directory service|firewall/i, category: "Security, Identity & Compliance" },
  { pattern: /simple notification|\bsns\b|simple queue|\bsqs\b|step functions|eventbridge|\bmq\b|appflow|simple workflow/i, category: "Application Integration" },
  { pattern: /sagemaker|comprehend|rekognition|polly|transcribe|translate|textract|\blex\b|bedrock|forecast|personalize|kendra/i, category: "Machine Learning & AI" },
  { pattern: /codebuild|codecommit|codedeploy|codepipeline|codeartifact|cloud9|x-ray|codestar/i, category: "Developer Tools" },
  { pattern: /elastic container|\becs\b|\beks\b|kubernetes|container registry|\becr\b/i, category: "Containers" },
  { pattern: /workspaces|appstream|worklink/i, category: "End User Computing" },
  { pattern: /simple email|\bses\b|workmail|\bchime\b|pinpoint/i, category: "Business Applications" },
  { pattern: /database migration|\bdms\b|migration hub|datasync|snowball|transfer family/i, category: "Migration & Transfer" },
  { pattern: /elemental|mediaconvert|medialive|mediapackage|\bivs\b|interactive video/i, category: "Media Services" },
  { pattern: /\biot\b/i, category: "Internet of Things" },
  { pattern: /support/i, category: "Support" }
];
function classifyService(serviceName, subService = "") {
  const haystack = `${serviceName} ${subService}`;
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(haystack)) return rule.category;
  }
  return "";
}
var REGION_NAMES = [
  "Global",
  "Any",
  "US East (N. Virginia)",
  "US East (Northern Virginia)",
  "US East (Ohio)",
  "US West (N. California)",
  "US West (Northern California)",
  "US West (Oregon)",
  "Africa (Cape Town)",
  "Asia Pacific (Hong Kong)",
  "Asia Pacific (Hyderabad)",
  "Asia Pacific (Jakarta)",
  "Asia Pacific (Melbourne)",
  "Asia Pacific (Mumbai)",
  "Asia Pacific (Osaka)",
  "Asia Pacific (Seoul)",
  "Asia Pacific (Singapore)",
  "Asia Pacific (Sydney)",
  "Asia Pacific (Tokyo)",
  "Asia Pacific (Malaysia)",
  "Asia Pacific (Thailand)",
  "Canada (Central)",
  "Canada West (Calgary)",
  "Europe (Frankfurt)",
  "Europe (Ireland)",
  "Europe (London)",
  "Europe (Milan)",
  "Europe (Paris)",
  "Europe (Spain)",
  "Europe (Stockholm)",
  "Europe (Zurich)",
  "EU (Frankfurt)",
  "EU (Ireland)",
  "EU (London)",
  "EU (Milan)",
  "EU (Paris)",
  "EU (Spain)",
  "EU (Stockholm)",
  "EU (Zurich)",
  "Israel (Tel Aviv)",
  "Middle East (Bahrain)",
  "Middle East (UAE)",
  "South America (Sao Paulo)",
  "South America (S\xE3o Paulo)",
  "AWS GovCloud (US-East)",
  "AWS GovCloud (US-West)",
  "No Region"
];
var REGION_SET = new Set(REGION_NAMES.map((r) => r.toLowerCase()));
function isRegionName(name) {
  return REGION_SET.has(name.trim().toLowerCase());
}
function parseUsd(raw) {
  const m = raw.trim().match(/^\(?\s*-?\s*USD\s*(-?[\d,]+(?:\.\d+)?)\s*\)?$/i);
  if (!m) return null;
  const negative = raw.trim().startsWith("(") || m[1].startsWith("-");
  const val = parseFloat(m[1].replace(/,/g, "").replace(/^-/, ""));
  if (Number.isNaN(val)) return null;
  return negative ? -val : val;
}
var TRAILING_AMOUNT_RE = /(\((?:USD)\s?-?[\d,]+(?:\.\d+)?\)|(?<!\()USD\s?-?[\d,]+(?:\.\d+)?)\s*$/;
var QTY_UOM_TAIL_RE = /(\d[\d,]*(?:\.\d+)?)[ \u00a0]+([A-Za-z][A-Za-z0-9/()\-]*(?:[ \u00a0][A-Za-z][A-Za-z0-9/()\-]*){0,2})$/;
var GLUED_QTY_UOM_TAIL_RE = /(?<=[a-z)\]%.])(\d[\d,]*(?:\.\d+)?)[ \u00a0]+([A-Za-z][A-Za-z0-9/()\-]*(?:[ \u00a0][A-Za-z][A-Za-z0-9/()\-]*){0,2})$/;
var UOM_WHITELIST_RE = new RegExp(
  "^(" + [
    "Hrs",
    "Hours?",
    "Hourly",
    "GB",
    "GB-Mo",
    "GB-Month",
    "GB-Hours?",
    "GB-Second(s)?",
    "TB",
    "MB",
    "Months?",
    "Days?",
    "Minutes?",
    "Seconds?",
    "Second",
    "Requests?",
    "IA-Requests?",
    "Queries",
    "Query",
    "API Calls?",
    "Calls?",
    "vCPU-Hours?",
    "ACU-Hrs",
    "ACU-hours?",
    "LCU-Hrs",
    "LCU-hours?",
    "ReadCapacityUnit-Hrs",
    "WriteCapacityUnit-Hrs",
    "Unit-Hrs",
    "Units?",
    "HostedZones?",
    "HostedZone",
    "Config RuleEvaluations",
    "RuleEvaluations",
    "Alarms?",
    "Metrics?",
    "Events?",
    "Objects?",
    "Keys?",
    "Secrets?",
    "Findings?",
    "Instances?",
    "Certificates?",
    "Rules?",
    "WebACLs?",
    "ACLs?",
    "Checks?",
    "Messages?",
    "Notifications?",
    "Emails?",
    "Dashboards?",
    "Snapshots?",
    "Volumes?",
    "Gateways?",
    "Endpoints?",
    "Zones?",
    "Assessments?",
    "Scans?",
    "Evaluations?",
    "Executions?",
    "Invocations?",
    "Transitions?",
    "Deliveries",
    "Records?",
    "Streams?",
    "Shards?",
    "Signals?",
    "Observations?",
    "Fees?",
    "IPs?",
    "vCPU-Hours?",
    "GB-mos?",
    "Finding Ingestion Events?",
    "Security Checks?",
    "ConfigurationItemRecorded",
    "Lambda-GB-Second(s)?",
    "Build-Mins?",
    "build minutes?",
    "IOPS-Mo",
    "IOs?",
    "Ops?",
    "Operations?",
    "Transactions?",
    "Devices?",
    "Connections?",
    "Sessions?",
    "Users?",
    "Licenses?",
    "Domains?",
    "Tokens?",
    "Pieces?",
    "Items?",
    "Resources?",
    "Rotations?",
    "traces?",
    "GetRecords?",
    "Puts?",
    "Gets?",
    // AWS Config kerned artifacts (e.g. "APS3-Config urationItemRecorded")
    "APS\\d+-?Config ?urationItemRecorded",
    "Config ?urationItemRecorded",
    "Config ?RuleEvaluations",
    // Confirmed via real-bill verification (scripts/verify-bills.ts):
    // these were silently dropping genuine leaf charges because the unit
    // wasn't recognized, forcing the line to fall through to the
    // "no quantity found" default of isGroupLine: true.
    "Accelerator-Hours?",
    "Dollars?",
    "Activit(?:y|ies)",
    "Faces?-Mo"
  ].join("|") + ")$",
  "i"
);
var UOM_COMPOUND_SUFFIX_RE = /-(Hours?|Hrs|Mo|Month|Sec|Seconds?)$/i;
var RATE_PREFIX_RE = /^(\$|USD ?\d|Rs\.? ?\d|€|£)/;
var CREDIT_LINE_RE = /(covered by|free of charge|free tier|under .*free|savings? plans?|credit applied|applied credit|aws credits?\b|promotional credits?|\bfree\b|reserved instance applied|per month .*free|instance usage under|usage under .*plan)/i;
function isPlausibleUom(phrase) {
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
function tokenizeLine(line) {
  const amountMatch = line.match(TRAILING_AMOUNT_RE);
  if (!amountMatch) return null;
  const costUsd = parseUsd(amountMatch[1]);
  if (costUsd === null) return null;
  let rest = line.slice(0, amountMatch.index).trimEnd();
  const wholeLine0 = rest.match(/^(\d[\d,]*(?:\.\d+)?)[ \u00a0]+(.{1,40}?)$/);
  if (wholeLine0 && isPlausibleUom(wholeLine0[2])) {
    const quantity = parseFloat(wholeLine0[1].replace(/,/g, ""));
    if (!Number.isNaN(quantity)) {
      return { description: "", quantity, uom: wholeLine0[2].trim(), costUsd, isGroupLine: false };
    }
  }
  const glued = rest.match(GLUED_QTY_UOM_TAIL_RE);
  if (glued) {
    const quantity = parseFloat(glued[1].replace(/,/g, ""));
    const uom = glued[2].trim();
    const before = rest.slice(0, glued.index ?? 0).trim();
    const plausible = isPlausibleUom(uom) || RATE_PREFIX_RE.test(before) || CREDIT_LINE_RE.test(before);
    if (!Number.isNaN(quantity) && before.length > 0 && plausible) {
      return { description: before, quantity, uom, costUsd, isGroupLine: false };
    }
  }
  const spaced = rest.match(QTY_UOM_TAIL_RE);
  if (spaced) {
    const quantity = parseFloat(spaced[1].replace(/,/g, ""));
    const uom = spaced[2].trim();
    const before = rest.slice(0, spaced.index ?? 0).trim();
    const acceptable = isPlausibleUom(uom) && (before.length === 0 || RATE_PREFIX_RE.test(before) || CREDIT_LINE_RE.test(before));
    if (!Number.isNaN(quantity) && acceptable) {
      return { description: before, quantity, uom, costUsd, isGroupLine: false };
    }
  }
  const restTrim = rest.trim();
  const BARE_SAVINGS_PLAN_HEADER_RE = /^(?:[A-Za-z0-9]+\s+){0,3}Savings Plans$|^Savings Plans for AWS [A-Za-z]+(?:\s+[A-Za-z]+)? usage$/i;
  if (BARE_SAVINGS_PLAN_HEADER_RE.test(restTrim)) {
    return { description: restTrim, quantity: null, uom: null, costUsd, isGroupLine: true };
  }
  if (RATE_PREFIX_RE.test(restTrim) || CREDIT_LINE_RE.test(restTrim)) {
    return { description: restTrim, quantity: null, uom: null, costUsd, isGroupLine: false };
  }
  return { description: rest.trim(), quantity: null, uom: null, costUsd, isGroupLine: true };
}
var SECTION_END_RE = /^(Charges by account|Invoices$|Tax Invoices|Savings ?\(|Taxes by service)/i;
var PROVIDER_RE = /^(.+?)\(\d+\)Total (?:pre-tax|tax)USD\s?[\d,.]+$/i;
var TABLE_HEADER_RE = /^DescriptionUsage QuantityAmount in USD$/i;
var TOTAL_TAX_RE = /^Total taxUSD/i;
var PAGE_ARTIFACT_RE = /^(Page \d+ of \d+|Billing period|Account ID|Date printed)/i;
function parseAwsBill(text2) {
  const lines = text2.replace(/\u00ad/g, "").split(/\r?\n/).map((l) => l.replace(/\u00a0/g, " ").trimEnd());
  let billingPeriod = null;
  let accountId = null;
  let grandTotalUsd = null;
  for (let i = 0; i < Math.min(lines.length, 60); i++) {
    const l = lines[i].trim();
    if (!billingPeriod) {
      const bp = l.match(/^([A-Z][a-z]{2}\s+\d{1,2}\s*-\s*[A-Z][a-z]{2}\s+\d{1,2},\s*\d{4})$/);
      if (bp) billingPeriod = bp[1];
    }
    if (!accountId && /^\d{12}$/.test(l)) accountId = l;
    if (grandTotalUsd === null) {
      const gt = l.match(/(?:Estimated\s+)?grand total:\s*USD\s?([\d,.]+)/i);
      if (gt) grandTotalUsd = parseFloat(gt[1].replace(/,/g, ""));
    }
  }
  let start = lines.findIndex((l) => /^Charges by service$/i.test(l.trim()));
  if (start === -1) start = 0;
  const items = [];
  let currentService = "";
  let currentRegion = "";
  let currentSubService = "";
  let lastItem = null;
  let pendingDesc = "";
  const rows = [];
  for (let i = start + 1; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    if (SECTION_END_RE.test(raw)) break;
    if (TABLE_HEADER_RE.test(raw) || PAGE_ARTIFACT_RE.test(raw)) continue;
    if (TOTAL_TAX_RE.test(raw)) {
      rows.push({ raw, tok: null });
      continue;
    }
    rows.push({ raw, tok: tokenizeLine(raw) });
  }
  const PURE_AMOUNT_RE = /^\(?USD\s?-?[\d,]+(?:\.\d+)?\)?$/i;
  const nextGroupIsRegion = (idx) => {
    for (let j = idx + 1; j < rows.length; j++) {
      const r = rows[j];
      if (!r.tok) continue;
      if (r.tok.isGroupLine) return isRegionName(r.tok.description);
      return false;
    }
    return false;
  };
  for (let i = 0; i < rows.length; i++) {
    const { raw, tok } = rows[i];
    if (TOTAL_TAX_RE.test(raw)) {
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
      pendingDesc = pendingDesc ? `${pendingDesc} ${raw}` : raw;
      continue;
    }
    if (pendingDesc && PURE_AMOUNT_RE.test(raw)) {
      const joined = `${pendingDesc}${raw}`;
      const jt = tokenizeLine(joined);
      pendingDesc = "";
      if (jt) {
        const serviceName0 = currentService || currentSubService || "Unknown Service";
        const category0 = classifyService(serviceName0, currentSubService);
        const desc0 = jt.description;
        const prefix0 = currentSubService && !desc0.startsWith(currentSubService) ? `${currentSubService} \u2014 ` : "";
        const item0 = {
          region: currentRegion || "Global",
          serviceCategory: category0,
          serviceName: serviceName0,
          description: `${prefix0}${desc0}`,
          quantity: jt.quantity,
          uom: jt.uom,
          costUsd: jt.costUsd,
          needsEnrichment: category0 === ""
        };
        items.push(item0);
        lastItem = item0;
      }
      continue;
    }
    if (tok.isGroupLine) {
      pendingDesc = "";
      lastItem = null;
      const name = tok.description;
      if (isRegionName(name)) {
        currentRegion = name;
        currentSubService = "";
      } else if (!currentService || nextGroupIsRegion(i)) {
        currentService = name;
        currentRegion = "";
        currentSubService = "";
      } else {
        currentSubService = name;
      }
      continue;
    }
    let description = tok.description;
    if (pendingDesc) {
      description = `${pendingDesc} ${description}`.trim();
      pendingDesc = "";
    }
    const serviceName = currentService || currentSubService || "Unknown Service";
    const category = classifyService(serviceName, currentSubService);
    const descPrefix = currentSubService && !description.startsWith(currentSubService) ? `${currentSubService} \u2014 ` : "";
    const item = {
      region: currentRegion || "Global",
      serviceCategory: category,
      serviceName,
      description: `${descPrefix}${description}`,
      quantity: tok.quantity,
      uom: tok.uom,
      costUsd: tok.costUsd,
      needsEnrichment: category === ""
    };
    items.push(item);
    lastItem = item;
  }
  return { billingPeriod, accountId, grandTotalUsd, items };
}

// server/_core/llm.ts
function toGeminiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (schema && typeof schema === "object") {
    const out = {};
    for (const [key, value] of Object.entries(schema)) {
      if (key === "additionalProperties") continue;
      out[key] = toGeminiSchema(value);
    }
    return out;
  }
  return schema;
}
async function invokeLLM(params) {
  if (!ENV.gemini.apiKey) {
    throw new Error("GEMINI_API_KEY is not configured: AI enrichment is disabled");
  }
  const systemInstruction = params.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const contents = params.messages.filter((m) => m.role !== "system").map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }]
  }));
  const generationConfig = {};
  if (params.response_format?.type === "json_schema") {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = toGeminiSchema(
      params.response_format.json_schema.schema
    );
  }
  if (params.max_tokens) {
    generationConfig.maxOutputTokens = params.max_tokens;
  }
  const model = params.model ?? ENV.gemini.model;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${ENV.gemini.apiKey}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents,
      ...systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {},
      generationConfig
    })
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`Gemini request failed (${resp.status}): ${detail}`);
  }
  const data = await resp.json();
  const text2 = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? null;
  return { choices: [{ message: { content: text2 } }] };
}

// server/enrichment.ts
var VALID_CATEGORIES = [
  "Compute",
  "Storage",
  "Database",
  "Networking & Content Delivery",
  "Analytics",
  "Management & Governance",
  "Security, Identity & Compliance",
  "Application Integration",
  "Machine Learning & AI",
  "Developer Tools",
  "Containers",
  "End User Computing",
  "Business Applications",
  "Migration & Transfer",
  "Media Services",
  "Internet of Things",
  "AWS Marketplace",
  "Support",
  "Other"
];
var BATCH_SIZE = 40;
async function enrichItems(items) {
  const targets = items.map((item, index) => ({ item, index })).filter(({ item }) => item.needsEnrichment || !item.serviceCategory);
  if (targets.length === 0) return items;
  const out = items.map((i) => ({ ...i }));
  for (let b = 0; b < targets.length; b += BATCH_SIZE) {
    const batch = targets.slice(b, b + BATCH_SIZE);
    const payload = batch.map(({ item, index }) => ({
      index,
      serviceName: item.serviceName,
      description: item.description.slice(0, 300)
    }));
    try {
      const response = await invokeLLM({
        messages: [
          {
            role: "system",
            content: `You are an AWS billing expert. For each line item, assign the correct AWS Service Category from this exact list: ${VALID_CATEGORIES.join("; ")}. If a description is cryptic (e.g. raw usage-type codes like "APS3-TimedStorage-ByteHrs"), provide a short human-readable improvedDescription that keeps the original meaning; otherwise omit it. Never invent quantities or costs.`
          },
          { role: "user", content: JSON.stringify(payload) }
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "enrichment_results",
            strict: true,
            schema: {
              type: "object",
              properties: {
                results: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      index: { type: "number" },
                      category: { type: "string", enum: [...VALID_CATEGORIES] },
                      improvedDescription: {
                        type: ["string", "null"],
                        description: "Only when the raw description is cryptic; otherwise null"
                      }
                    },
                    required: ["index", "category", "improvedDescription"],
                    additionalProperties: false
                  }
                }
              },
              required: ["results"],
              additionalProperties: false
            }
          }
        }
      });
      const content = response.choices?.[0]?.message?.content;
      if (!content) continue;
      const parsed = JSON.parse(
        typeof content === "string" ? content : JSON.stringify(content)
      );
      for (const r of parsed.results ?? []) {
        const target = out[r.index];
        if (!target) continue;
        if (r.category && VALID_CATEGORIES.includes(r.category)) {
          target.serviceCategory = r.category;
        }
        if (r.improvedDescription && r.improvedDescription.length > 3 && // keep raw data where already clear — only replace terse/cryptic text
        target.description.length < 60) {
          target.description = `${target.description} (${r.improvedDescription})`;
        }
        target.needsEnrichment = false;
      }
    } catch (err) {
      logger.warn("Enrichment LLM batch failed, falling back to 'Other'", { message: err instanceof Error ? err.message : String(err) });
    }
  }
  for (const item of out) {
    if (!item.serviceCategory) item.serviceCategory = "Other";
    item.needsEnrichment = false;
  }
  return out;
}

// server/excel.ts
import ExcelJS from "exceljs";
async function generateBomExcel(rows, meta) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "AWS Bill to BOM Converter";
  wb.created = /* @__PURE__ */ new Date();
  const ws = wb.addWorksheet("AWS BOM", {
    views: [{ state: "frozen", ySplit: 1 }]
  });
  ws.columns = [
    { header: "S.No.", key: "sno", width: 8 },
    { header: "AWS Region", key: "region", width: 26 },
    { header: "AWS Service Category", key: "serviceCategory", width: 32 },
    { header: "AWS Service Name", key: "serviceName", width: 34 },
    { header: "AWS Service Description/ Config", key: "description", width: 80 },
    { header: "AWS Qty", key: "quantity", width: 16 },
    { header: "AWS UOM", key: "uom", width: 18 },
    { header: "AWS Billed Cost USD", key: "costUsd", width: 20 }
  ];
  const headerRow = ws.getRow(1);
  headerRow.height = 28;
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11, name: "Arial" };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF000000" } };
    cell.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
    cell.border = {
      top: { style: "thin" },
      bottom: { style: "medium" },
      left: { style: "thin" },
      right: { style: "thin" }
    };
  });
  for (const row of rows) {
    const r = ws.addRow({
      sno: row.sno,
      region: row.region,
      serviceCategory: row.serviceCategory,
      serviceName: row.serviceName,
      description: row.description,
      quantity: row.quantity,
      uom: row.uom ?? "",
      costUsd: row.costUsd
    });
    r.eachCell({ includeEmpty: true }, (cell, col) => {
      cell.font = { size: 10, name: "Arial" };
      cell.alignment = { vertical: "top", wrapText: col === 5 };
      cell.border = {
        top: { style: "hair" },
        bottom: { style: "hair" },
        left: { style: "thin" },
        right: { style: "thin" }
      };
    });
    r.getCell(6).numFmt = "#,##0.000";
    r.getCell(8).numFmt = "#,##0.00";
  }
  const totalCost = rows.reduce((s, r) => s + r.costUsd, 0);
  const totalRow = ws.addRow({
    sno: "",
    region: "",
    serviceCategory: "",
    serviceName: "",
    description: "TOTAL",
    quantity: null,
    uom: "",
    costUsd: Math.round(totalCost * 100) / 100
  });
  totalRow.eachCell({ includeEmpty: true }, (cell) => {
    cell.font = { bold: true, size: 11, name: "Arial" };
    cell.border = { top: { style: "medium" }, bottom: { style: "medium" } };
  });
  totalRow.getCell(8).numFmt = '"$"#,##0.00';
  const info = wb.addWorksheet("Bill Info");
  info.columns = [
    { header: "Field", key: "f", width: 30 },
    { header: "Value", key: "v", width: 60 }
  ];
  info.getRow(1).font = { bold: true };
  info.addRow({ f: "Source File", v: meta.fileName });
  info.addRow({ f: "Billing Period", v: meta.billingPeriod ?? "N/A" });
  info.addRow({ f: "Account ID", v: meta.accountId ?? "N/A" });
  const grandTotalInfoRow = info.addRow({
    f: "Estimated Grand Total (USD, incl. tax)",
    v: meta.grandTotalUsd ?? "N/A"
  });
  if (meta.grandTotalUsd !== null) grandTotalInfoRow.getCell(2).numFmt = '"$"#,##0.00';
  info.addRow({ f: "Line Items", v: rows.length });
  const preTaxTotalInfoRow = info.addRow({
    f: "Pre-tax Line-Item Total (USD)",
    v: Math.round(totalCost * 100) / 100
  });
  preTaxTotalInfoRow.getCell(2).numFmt = '"$"#,##0.00';
  info.addRow({ f: "Generated", v: (/* @__PURE__ */ new Date()).toISOString() });
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

// server/storage.ts
import { createClient } from "@supabase/supabase-js";
var SIGNED_URL_TTL_SECONDS = 60 * 60;
var client = null;
function getClient() {
  if (client) return client;
  if (!ENV.supabase.url || !ENV.supabase.serviceRoleKey) {
    throw new Error(
      "Storage not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY"
    );
  }
  client = createClient(ENV.supabase.url, ENV.supabase.serviceRoleKey, {
    auth: {
      // Backend-only usage in a stateless serverless function — there is no
      // session to persist and no storage (localStorage/cookies) to persist
      // it to.
      persistSession: false,
      autoRefreshToken: false
    }
  });
  return client;
}
function getBucket() {
  if (!ENV.supabase.bucket) {
    throw new Error("Storage not configured: set SUPABASE_STORAGE_BUCKET");
  }
  return ENV.supabase.bucket;
}
function normalizeKey(relKey) {
  return relKey.replace(/^\/+/, "");
}
async function storagePut(relKey, data, contentType = "application/octet-stream") {
  const key = normalizeKey(relKey);
  const { error } = await getClient().storage.from(getBucket()).upload(key, data, {
    contentType,
    // Matches the prior S3/R2 PutObject semantics: always succeeds, even
    // if an object at this key already exists. Collisions are practically
    // impossible anyway since keys embed a random nanoid segment.
    upsert: true
  });
  if (error) {
    throw new Error(`Storage upload failed: ${error.message}`);
  }
  return { key };
}
async function storageGet(relKey) {
  const key = normalizeKey(relKey);
  const { data, error } = await getClient().storage.from(getBucket()).createSignedUrl(key, SIGNED_URL_TTL_SECONDS);
  if (error || !data) {
    throw new Error(`Storage signed URL failed: ${error?.message ?? "unknown error"}`);
  }
  return { key, url: data.signedUrl };
}

// server/routers/bills.ts
var MAX_PDF_BYTES = 25 * 1024 * 1024;
var billsRouter = router({
  /** Upload a PDF (base64), parse it, enrich, persist everything. */
  uploadAndParse: publicProcedure.input(
    z2.object({
      fileName: z2.string().min(1).max(500),
      base64: z2.string().min(100)
    })
  ).mutation(async ({ input, ctx }) => {
    const buffer = Buffer.from(input.base64, "base64");
    if (buffer.length > MAX_PDF_BYTES) {
      throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "PDF exceeds 25 MB limit" });
    }
    if (!buffer.subarray(0, 5).toString("latin1").startsWith("%PDF")) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "File is not a valid PDF" });
    }
    const safeName = input.fileName.replace(/[^\w.\-]+/g, "_");
    const pdfKey = `bills/${ctx.sessionId}/${nanoid(10)}-${safeName}`;
    await storagePut(pdfKey, buffer, "application/pdf");
    const billId = await createBill({
      sessionId: ctx.sessionId,
      fileName: input.fileName,
      pdfKey,
      status: "processing"
    });
    try {
      const pdfData = await pdfParse(buffer);
      const parsed = parseAwsBill(pdfData.text);
      if (parsed.items.length === 0) {
        throw new Error(
          "No billing line items found. Please upload a complete AWS 'Bills' PDF export (Billing and Cost Management \u2192 Bills \u2192 Print/Save as PDF)."
        );
      }
      const enrichedFlags = parsed.items.map((i) => i.needsEnrichment || !i.serviceCategory);
      const enriched = await enrichItems(parsed.items);
      const calculatedTotal = enriched.reduce((sum, item) => sum + item.costUsd, 0);
      await insertBomItems(
        enriched.map((item, idx) => ({
          billId,
          serialNo: idx + 1,
          region: item.region,
          serviceCategory: item.serviceCategory,
          serviceName: item.serviceName,
          description: item.description,
          quantity: item.quantity === null ? null : String(item.quantity),
          uom: item.uom,
          costUsd: item.costUsd.toFixed(2),
          llmEnriched: enrichedFlags[idx] ? 1 : 0
        }))
      );
      const excelBuffer = await generateBomExcel(
        enriched.map((item, idx) => ({
          sno: idx + 1,
          region: item.region,
          serviceCategory: item.serviceCategory,
          serviceName: item.serviceName,
          description: item.description,
          quantity: item.quantity,
          uom: item.uom,
          costUsd: item.costUsd
        })),
        {
          fileName: input.fileName,
          billingPeriod: parsed.billingPeriod,
          accountId: parsed.accountId,
          grandTotalUsd: parsed.grandTotalUsd,
          calculatedTotalUsd: calculatedTotal
        }
      );
      const excelKey = `bom/${ctx.sessionId}/${nanoid(10)}-${safeName.replace(/\.pdf$/i, "")}-BOM.xlsx`;
      await storagePut(
        excelKey,
        excelBuffer,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      await updateBill(billId, {
        status: "completed",
        excelKey,
        billingPeriod: parsed.billingPeriod,
        accountId: parsed.accountId,
        grandTotalUsd: parsed.grandTotalUsd === null ? null : parsed.grandTotalUsd.toFixed(2),
        calculatedTotalUsd: calculatedTotal.toFixed(2),
        itemCount: enriched.length
      });
      return { billId, itemCount: enriched.length };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to parse PDF";
      await updateBill(billId, { status: "failed", errorMessage: message });
      throw new TRPCError({ code: "UNPROCESSABLE_CONTENT", message });
    }
  }),
  /** Upload history for the current session. */
  list: publicProcedure.query(async ({ ctx }) => {
    return listBillsBySession(ctx.sessionId);
  }),
  /** A single bill + its BOM items (table preview). */
  get: publicProcedure.input(z2.object({ billId: z2.number().int().positive() })).query(async ({ input, ctx }) => {
    const bill = await getBillById(input.billId);
    if (!bill || bill.sessionId !== ctx.sessionId) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Bill not found" });
    }
    const items = await getBomItemsByBill(bill.id);
    return { bill, items };
  }),
  /** Signed Supabase Storage URL for the generated Excel BOM (re-download anytime). */
  downloadExcel: publicProcedure.input(z2.object({ billId: z2.number().int().positive() })).mutation(async ({ input, ctx }) => {
    const bill = await getBillById(input.billId);
    if (!bill || bill.sessionId !== ctx.sessionId) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Bill not found" });
    }
    if (!bill.excelKey) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Excel file not generated for this bill" });
    }
    const { url } = await storageGet(bill.excelKey);
    return { url, fileName: bill.fileName.replace(/\.pdf$/i, "") + "-BOM.xlsx" };
  }),
  /** Signed Supabase Storage URL for the original uploaded PDF. */
  downloadPdf: publicProcedure.input(z2.object({ billId: z2.number().int().positive() })).mutation(async ({ input, ctx }) => {
    const bill = await getBillById(input.billId);
    if (!bill || bill.sessionId !== ctx.sessionId) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Bill not found" });
    }
    const { url } = await storageGet(bill.pdfKey);
    return { url, fileName: bill.fileName };
  }),
  /** Delete a bill and its items from history. */
  remove: publicProcedure.input(z2.object({ billId: z2.number().int().positive() })).mutation(async ({ input, ctx }) => {
    const bill = await getBillById(input.billId);
    if (!bill || bill.sessionId !== ctx.sessionId) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Bill not found" });
    }
    await deleteBill(bill.id);
    return { success: true };
  })
});

// server/routers.ts
var appRouter = router({
  system: systemRouter,
  bills: billsRouter
});

// server/_core/context.ts
async function createContext(opts) {
  return {
    req: opts.req,
    res: opts.res,
    // Populated by createSessionMiddleware in app.ts, which always runs
    // before this on the /api/trpc path -- never undefined in practice.
    sessionId: opts.req.sessionId ?? ""
  };
}

// server/_core/sessionCookie.ts
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
var SESSION_COOKIE_NAME = "bom_sid";
var SESSION_MAX_AGE_MS = 1e3 * 60 * 60 * 24 * 180;
var LEGACY_SESSION_ID_RE = /^session-\d{10,14}-[a-z0-9]{6,12}$/i;
var RAW_ID_RE = /^[A-Za-z0-9_-]{6,128}$/;
var cachedSecret = null;
var warnedMissingSecret = false;
function getSessionSecret() {
  if (cachedSecret) return cachedSecret;
  const configured = process.env.SESSION_SECRET;
  if (configured) {
    cachedSecret = configured;
    return cachedSecret;
  }
  if (!warnedMissingSecret) {
    logger.warn(
      "SESSION_SECRET is not set -- deriving a fallback signing key from SUPABASE_SERVICE_ROLE_KEY/DATABASE_URL. Sessions still work and stay stable across restarts, but set a dedicated SESSION_SECRET env var for proper secret separation."
    );
    warnedMissingSecret = true;
  }
  const basis = ENV.supabase.serviceRoleKey || ENV.databaseUrl || "aws-bom-builder-insecure-dev-fallback";
  cachedSecret = createHash("sha256").update(`aws-bom-session-v1:${basis}`).digest("hex");
  return cachedSecret;
}
function signSessionId(id) {
  const sig = createHmac("sha256", getSessionSecret()).update(id).digest("base64url");
  return `${id}.${sig}`;
}
function verifySignedSessionId(token) {
  if (!token) return null;
  const idx = token.lastIndexOf(".");
  if (idx <= 0 || idx === token.length - 1) return null;
  const id = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  if (!RAW_ID_RE.test(id)) return null;
  const expected = createHmac("sha256", getSessionSecret()).update(id).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;
  return id;
}
function parseCookieHeader(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq2 = part.indexOf("=");
    if (eq2 === -1) continue;
    const key = part.slice(0, eq2).trim();
    if (!key) continue;
    const value = part.slice(eq2 + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}
async function resolveIncomingSessionId(params) {
  const cookies = parseCookieHeader(params.cookieHeader);
  const fromCookie = verifySignedSessionId(cookies[SESSION_COOKIE_NAME]);
  if (fromCookie) return fromCookie;
  if (params.legacyHeader && LEGACY_SESSION_ID_RE.test(params.legacyHeader)) {
    const exists = await params.hasLegacyHistory(params.legacyHeader).catch(() => false);
    if (exists) return params.legacyHeader;
  }
  return randomBytes(32).toString("base64url");
}
function setSessionCookie(res, sessionId) {
  res.cookie(SESSION_COOKIE_NAME, signSessionId(sessionId), {
    httpOnly: true,
    secure: ENV.isProduction,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_MS
  });
}
function firstHeaderValue(v) {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v.length > 0) return v[0];
  return null;
}
function createSessionMiddleware(deps) {
  return function sessionMiddleware(req, res, next) {
    resolveIncomingSessionId({
      cookieHeader: req.headers.cookie,
      legacyHeader: firstHeaderValue(req.headers["x-legacy-session-id"]),
      hasLegacyHistory: deps.hasLegacyHistory
    }).then((sessionId) => {
      req.sessionId = sessionId;
      setSessionCookie(res, sessionId);
      next();
    }).catch(next);
  };
}

// server/_core/app.ts
function createApiApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1e3,
    limit: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later." }
  });
  app.use("/api/trpc", apiLimiter);
  app.use("/api/trpc", createSessionMiddleware({ hasLegacyHistory: hasBillsForSession }));
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
      onError({ error, path }) {
        logger.error("tRPC error", { path, code: error.code, message: error.message });
      }
    })
  );
  return app;
}

// server/_core/vercelHandler.ts
var vercelHandler_default = createApiApp();
export {
  vercelHandler_default as default
};
