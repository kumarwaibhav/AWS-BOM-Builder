# Deployment guide

Everything here reflects what the code actually does — no Manus/Forge proxy, no OAuth, direct Supabase (Postgres + Storage).

## Prerequisites

- Node.js 22+, pnpm 10+
- A Supabase project (free, no credit card) — provides both the Postgres database and file storage
- GitHub repository
- Vercel account (or any Node host — Docker instructions are below too)
- (Optional) Gemini API key for AI enrichment

## 1. Supabase project

1. Sign up free at [supabase.com](https://supabase.com) (no card required) and create a new project.
2. **Database connection strings** — Project Settings → Database → Connection string:
   - **Pooler** (Supavisor, transaction mode): `postgres://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres?pgbouncer=true` — this is `DATABASE_URL`, used by the running app.
   - **Direct**: `postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres` — this is `DIRECT_URL`, used only for running migrations. The pooler's transaction mode doesn't support the session-level features DDL (`CREATE TABLE`, etc.) needs.
3. **Storage** — Storage → Create a new bucket (private is fine and recommended; the app only ever accesses it through its own signed-URL endpoints, never a public bucket policy). Note the bucket name — that's `SUPABASE_STORAGE_BUCKET`.
4. **API keys** — Project Settings → API:
   - `SUPABASE_URL` — the Project URL.
   - `SUPABASE_SERVICE_ROLE_KEY` — the `service_role` secret key (not the `anon` key). This bypasses Row Level Security entirely, which is correct here since the app has no per-user auth — ownership checks happen at the application layer (`sessionId` matching in `bills.ts`), not via RLS. **Never expose this key to the client** — it's only read by server-side code (`server/storage.ts`, `server/_core/env.ts`).

```bash
export DIRECT_URL="postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres"
pnpm drizzle-kit migrate
```

This applies `drizzle/0000_charming_monster_badoon.sql`, creating the `bills` and `bom_items` tables (plus the `bill_status` Postgres enum type). There is no `users` table — this app has no accounts.

**One free-tier caveat**: Supabase pauses a project automatically after 7 days with no database activity. It's a one-click unpause from the dashboard, but if you want the deployed app to never go to sleep, add a free scheduled ping (a GitHub Actions cron or an uptime monitor hitting `system.health` every few days) to keep it active.

## 2. (Optional) Gemini API key

Free, no credit card: [aistudio.google.com/apikey](https://aistudio.google.com/apikey). If you skip this, AI enrichment of ambiguous line items is silently disabled — parsing, consolidation, reconciliation, and Excel export all still work.

## 3. Deploy to Vercel

1. Push this repo to GitHub.
2. [Vercel Dashboard](https://vercel.com/dashboard) → Add New → Project → Import `kumarwaibhav/AWS-BOM-Builder`.
3. Set environment variables (Project Settings → Environment Variables):

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Supabase pooler connection string |
| `DIRECT_URL` | yes | Supabase direct connection string (only used by migrations, but harmless to always set) |
| `SUPABASE_URL` | yes | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | `service_role` secret key — server-only, never exposed to the client |
| `SUPABASE_STORAGE_BUCKET` | yes | bucket name |
| `GEMINI_API_KEY` | no | enables AI enrichment |

4. Deploy. Vercel's `buildCommand` (see `vercel.json`) runs `vite build` for
   the client (output: `dist/public`) and then `pnpm run build:vercel-api`,
   which esbuild-bundles `server/_core/vercelHandler.ts` into a single
   self-contained `api/index.js` — the actual deployed serverless function.
   That file is committed to the repo (not gitignored) because Vercel matches
   the `functions` pattern in `vercel.json` against the *source* tree before
   the build runs, so a placeholder has to exist there already; the build
   always overwrites it with a fresh bundle from current source before
   deploying, so the committed copy never goes stale in what actually ships.
   Bundling (rather than letting Vercel's own per-file TypeScript-to-function
   pipeline handle `server/_core/*` directly) avoids two failure modes seen
   during setup: its isolated type-check can reject code our own project
   tsconfig accepts, and it doesn't reliably inline cross-directory relative
   imports, which crashes at runtime with `ERR_MODULE_NOT_FOUND`. The API and
   the client are genuinely separate deployables here, not one long-running
   process. `server/_core/index.ts` (the traditional `app.listen()` server)
   is only used for local dev and Docker; Vercel never touches it.
5. Verify: `curl https://your-domain.vercel.app/api/trpc/system.health` should return `{"result":{"data":{"ok":true,"database":"connected"}}}`.

## 4. Docker (alternative to Vercel)

```bash
docker build -t aws-bom-builder .
docker run -p 3000:3000 \
  -e DATABASE_URL="postgres://..." \
  -e DIRECT_URL="postgresql://..." \
  -e SUPABASE_URL="https://<project-ref>.supabase.co" \
  -e SUPABASE_SERVICE_ROLE_KEY="..." \
  -e SUPABASE_STORAGE_BUCKET="..." \
  aws-bom-builder
```

(No `Dockerfile` is committed yet — add one with a standard multi-stage Node build if you go this route.)

## Rate limiting & security

Already wired into the server (`server/_core/app.ts`), not something you need to add:
- `helmet` security headers
- `express-rate-limit`: 100 requests / 15 minutes per IP on `/api/trpc`
- `trust proxy` set correctly for exactly one reverse-proxy hop (Vercel, or Docker behind nginx/ALB)
- Graceful shutdown on `SIGTERM`/`SIGINT`
- Structured JSON logs via `server/_core/logger.ts`

## Troubleshooting

**"Database connection failed"** — check `DATABASE_URL` is the *pooler* string (not the direct one — the app uses the pooler at runtime), confirm the project isn't paused (Supabase dashboard shows this clearly), hit `system.health` to confirm.

**"Storage not configured" / downloads fail** — verify `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set (the *service role* key specifically, not the `anon` key), and `SUPABASE_STORAGE_BUCKET` matches the bucket name exactly.

**Migrations fail with a connection error** — `drizzle-kit migrate` needs `DIRECT_URL`, not the pooled `DATABASE_URL`; the transaction-mode pooler doesn't support the session features DDL requires.

**"PDF upload fails with 413"** — the app accepts up to 25 MB PDFs (checked in `server/routers/bills.ts`) with a 50 MB body-parser limit to cover base64 inflation. If your host has its own smaller request-size limit (some serverless platforms cap around 4.5 MB), you'll need a direct-to-storage upload flow instead of base64-over-tRPC — not implemented here yet.

**AI enrichment silently not running** — expected if `GEMINI_API_KEY` is unset; check server logs for "AI enrichment is disabled" only if you expected it to run.

## Rollback

```bash
vercel rollback
# or, via Git:
git revert HEAD && git push origin main
```

---

**Last updated:** to match the codebase as of this rebuild — no Manus runtime, Supabase (Postgres + Storage), optional Gemini enrichment, no authentication.
