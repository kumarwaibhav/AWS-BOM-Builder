import { defineConfig } from "drizzle-kit";

// `generate` only diffs schema.ts locally and never opens a connection, so it
// doesn't need a real DATABASE_URL — only `migrate`/`push` do. Fall back to a
// placeholder so `pnpm drizzle-kit generate` works on a fresh clone with no DB
// configured yet.
const connectionString = process.env.DATABASE_URL ?? "mysql://placeholder/placeholder";

export default defineConfig({
  schema: "./drizzle/schema.ts",
  out: "./drizzle",
  dialect: "mysql",
  dbCredentials: {
    url: connectionString,
  },
});
