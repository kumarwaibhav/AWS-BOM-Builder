import { defineConfig } from "drizzle-kit";

// `generate` only diffs schema.ts locally and never opens a connection, so it
// doesn't need a real connection string — only `migrate`/`push` do. Fall back
// to a placeholder so `pnpm drizzle-kit generate` works on a fresh clone with
// no DB configured yet.
//
// DIRECT_URL (not the pooled DATABASE_URL) is used here on purpose: Supabase's
// Supavisor pooler runs in transaction mode by default, which doesn't support
// the session-level features drizzle-kit needs for DDL (CREATE TABLE, etc.).
// Falls back to DATABASE_URL for non-Supabase Postgres hosts that only hand
// out one connection string.
const connectionString =
  process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? "postgresql://placeholder/placeholder";

export default defineConfig({
  schema: "./drizzle/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: connectionString,
  },
});
