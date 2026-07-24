import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  bills, bomItems, InsertBill, InsertBomItem,
} from "../drizzle/schema";
import { logger } from "./_core/logger";

let _db: ReturnType<typeof drizzle> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      // `prepare: false` is required against Supabase's Supavisor pooler in
      // transaction mode (the default pooled connection string) — it doesn't
      // support prepared statements. Harmless against a direct connection too.
      const client = postgres(process.env.DATABASE_URL, { prepare: false });
      _db = drizzle(client);
    } catch (error) {
      logger.warn("Database connection failed", { message: error instanceof Error ? error.message : String(error) });
      _db = null;
    }
  }
  return _db;
}

/* ------------------------------------------------------------------ */
/* Bills & BOM items                                                   */
/* ------------------------------------------------------------------ */

export async function createBill(bill: InsertBill): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  // Postgres has no insertId equivalent to mysql2's result — use RETURNING.
  const [inserted] = await db.insert(bills).values(bill).returning({ id: bills.id });
  return inserted.id;
}

export async function updateBill(id: number, patch: Partial<InsertBill>): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(bills).set(patch).where(eq(bills.id, id));
}

export async function getBillById(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db.select().from(bills).where(eq(bills.id, id)).limit(1);
  return rows[0];
}

export async function listBillsBySession(sessionId: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.select().from(bills).where(eq(bills.sessionId, sessionId)).orderBy(desc(bills.createdAt));
}

export async function insertBomItems(itemsToInsert: InsertBomItem[]): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  // chunked insert to stay under packet limits
  const CHUNK = 100;
  for (let i = 0; i < itemsToInsert.length; i += CHUNK) {
    await db.insert(bomItems).values(itemsToInsert.slice(i, i + CHUNK));
  }
}

export async function getBomItemsByBill(billId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.select().from(bomItems).where(eq(bomItems.billId, billId)).orderBy(bomItems.serialNo);
}

export async function deleteBill(id: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.delete(bomItems).where(eq(bomItems.billId, id));
  await db.delete(bills).where(eq(bills.id, id));
}
