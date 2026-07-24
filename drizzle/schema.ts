import {
  decimal,
  int,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";

/**
 * bills — one row per uploaded AWS billing PDF (upload history).
 * Stores S3 keys for both the source PDF and the generated Excel BOM
 * so users can re-download past outputs without re-uploading.
 * Anonymous access via sessionId (no userId required).
 */
export const bills = mysqlTable("bills", {
  id: int("id").autoincrement().primaryKey(),
  /** Session ID for anonymous tracking (no authentication required) */
  sessionId: varchar("sessionId", { length: 128 }).notNull(),
  /** Original uploaded file name */
  fileName: varchar("fileName", { length: 512 }).notNull(),
  /** S3 key of the uploaded PDF */
  pdfKey: varchar("pdfKey", { length: 1024 }).notNull(),
  /** S3 key of the generated Excel BOM (set after generation) */
  excelKey: varchar("excelKey", { length: 1024 }),
  /** Billing period string extracted from the bill, e.g. "Jun 1 - Jun 30, 2026" */
  billingPeriod: varchar("billingPeriod", { length: 128 }),
  /** AWS Account ID extracted from the bill */
  accountId: varchar("accountId", { length: 64 }),
  /** Grand total in USD extracted from the bill summary */
  grandTotalUsd: decimal("grandTotalUsd", { precision: 14, scale: 2 }),
  /** Calculated total from sum of line items (for reconciliation) */
  calculatedTotalUsd: decimal("calculatedTotalUsd", { precision: 14, scale: 2 }),
  /** Number of BOM line items extracted */
  itemCount: int("itemCount").default(0).notNull(),
  /** Processing lifecycle status */
  status: mysqlEnum("status", ["processing", "completed", "failed"])
    .default("processing")
    .notNull(),
  /** Error message when status = failed */
  errorMessage: text("errorMessage"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Bill = typeof bills.$inferSelect;
export type InsertBill = typeof bills.$inferInsert;

/**
 * bom_items — extracted line items for each bill, in exact BOM column order.
 * serialNo provides the stable S.No. ordering within a bill.
 */
export const bomItems = mysqlTable("bom_items", {
  id: int("id").autoincrement().primaryKey(),
  billId: int("billId").notNull(),
  /** S.No. — 1-based order within the bill */
  serialNo: int("serialNo").notNull(),
  /** AWS Region, e.g. "Asia Pacific (Mumbai)" or "Global" */
  region: varchar("region", { length: 128 }).notNull(),
  /** AWS Service Category, e.g. "Compute", "Database", "Networking" */
  serviceCategory: varchar("serviceCategory", { length: 128 }).notNull(),
  /** AWS Service Name, e.g. "Elastic Compute Cloud" */
  serviceName: varchar("serviceName", { length: 256 }).notNull(),
  /** AWS Service Description / Config — the detailed rate/usage line */
  description: text("description").notNull(),
  /** AWS Qty — usage quantity (stored as string to preserve precision/format) */
  quantity: decimal("quantity", { precision: 20, scale: 6 }),
  /** AWS UOM — unit of measure, e.g. "Hrs", "GB-Mo", "Requests" */
  uom: varchar("uom", { length: 64 }),
  /** AWS Billed Cost USD (negative for savings-plan credits) */
  costUsd: decimal("costUsd", { precision: 14, scale: 2 }).notNull(),
  /** Whether the LLM enriched/classified this row */
  llmEnriched: int("llmEnriched").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type BomItem = typeof bomItems.$inferSelect;
export type InsertBomItem = typeof bomItems.$inferInsert;
