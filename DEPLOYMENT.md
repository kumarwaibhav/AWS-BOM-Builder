# Deployment guide

Everything here reflects what the code actually does — no Manus/Forge proxy, no OAuth, direct Cloudflare R2.

## Prerequisites

- Node.js 22+, pnpm 10+
- A MySQL/TiDB database (production)
- A Cloudflare R2 bucket + API token (free — 10GB storage, zero egress fees, no time limit)
- GitHub repository
- Vercel account (or any Node host — Docker instructions are below too)
- (Optional) Gemini API key for AI enrichment

## 1. Database

```bash
mysql -u root -p -e "CREATE DATABASE aws_bom_builder CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
```

```bash
export DATABASE_URL="mysql://user:password@host:3306/aws_bom_builder"
pnpm drizzle-kit migrate
```

This applies `drizzle/0000_good_meltdown.sql`, creating the `bills` and `bom_items` tables. There is no `users` table — this app has no accounts.

## 2. Cloudflare R2

R2 speaks the S3 API, so the app talks to it with the same `@aws-sdk/client-s3`
client AWS S3 would use — just pointed at R2's endpoint with R2 credentials.
Free tier: 10GB storage, zero egress fees, no time limit, no pause behavior.

1. [Cloudflare Dashboard](https://dash.cloudflare.com) → R2 Object Storage → Create bucket.
   Note the bucket name and your **Account ID** (shown in the R2 overview page).
2. R2 → Manage API Tokens → Create API Token → scope it to this bucket with
   Object Read & Write permissions. Save the **Access Key ID** and **Secret
   Access Key** it gives you (shown once).

That's it — no separate IAM user/policy step like AWS. Downloads go through
the app's own presigned-URL endpoint (`bills.downloadExcel` / `bills.downloadPdf`),
not a public bucket, so the bucket itself stays private.

## 3. (Optional) Gemini API key

Free, no credit card: [aistudio.google.com/apikey](https://aistudio.google.com/apikey). If you skip this, AI enrichment of ambiguous line items is silently disabled — parsing, consolidation, reconciliation, and Excel export all still work.

## 4. Deploy to Vercel

1. Push this repo to GitHub.
2. [Vercel Dashboard](https://vercel.com/dashboard) → Add New → Project → Import `kumarwaibhav/AWS-BOM-Builder`.
3. Set environment variables (Project Settings → Environment Variables):

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | MySQL/TiDB connection string |
| `R2_ACCOUNT_ID` | yes | Cloudflare account ID (from the R2 overview page) |
| `R2_ACCESS_KEY_ID` | yes | R2 API token access key |
| `R2_SECRET_ACCESS_KEY` | yes | R2 API token secret key |
| `R2_BUCKET` | yes | bucket name |
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

## 5. Docker (alternative to Vercel)

```bash
docker build -t aws-bom-builder .
docker run -p 3000:3000 \
  -e DATABASE_URL="mysql://..." \
  -e R2_ACCOUNT_ID="..." \
  -e R2_ACCESS_KEY_ID="..." \
  -e R2_SECRET_ACCESS_KEY="..." \
  -e R2_BUCKET="..." \
  aws-bom-builder
```

(No `Dockerfile` is committed yet — add one with a standard multi-stage Node build if you go this route.)

## Rate limiting & security

Already wired into the server (`server/_core/index.ts`), not something you need to add:
- `helmet` security headers
- `express-rate-limit`: 100 requests / 15 minutes per IP on `/api/trpc`
- Graceful shutdown on `SIGTERM`/`SIGINT`
- Structured JSON logs via `server/_core/logger.ts`

## Troubleshooting

**"Database connection failed"** — check `DATABASE_URL`, confirm the host allows connections from your deploy platform's IPs, hit `system.health` to confirm.

**"Storage not configured" / downloads fail** — verify `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` are set, the API token has Object Read & Write on the bucket, and `R2_BUCKET` matches the bucket name exactly.

**"PDF upload fails with 413"** — the app accepts up to 25 MB PDFs (checked in `server/routers/bills.ts`) with a 50 MB body-parser limit to cover base64 inflation. If your host has its own smaller request-size limit (some serverless platforms cap around 4.5 MB), you'll need a direct-to-R2 upload flow instead of base64-over-tRPC — not implemented here yet.

**AI enrichment silently not running** — expected if `GEMINI_API_KEY` is unset; check server logs for "AI enrichment is disabled" only if you expected it to run.

## Rollback

```bash
vercel rollback
# or, via Git:
git revert HEAD && git push origin main
```

---

**Last updated:** to match the codebase as of this rebuild — no Manus runtime, direct Cloudflare R2, optional Gemini enrichment, no authentication.
