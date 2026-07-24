# Deployment guide

Everything here reflects what the code actually does — no Manus/Forge proxy, no OAuth, direct AWS S3.

## Prerequisites

- Node.js 22+, pnpm 10+
- A MySQL/TiDB database (production)
- An AWS S3 bucket + IAM user with S3 access
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

## 2. AWS S3

```bash
aws s3 mb s3://aws-bom-builder-storage --region us-east-1
```

Create an IAM user scoped to just this bucket (avoid `AmazonS3FullAccess` in production — scope the policy to the specific bucket ARN):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject"],
      "Resource": "arn:aws:s3:::aws-bom-builder-storage/*"
    }
  ]
}
```

```bash
aws iam create-user --user-name aws-bom-builder-app
aws iam put-user-policy --user-name aws-bom-builder-app --policy-name s3-bucket-access --policy-document file://policy.json
aws iam create-access-key --user-name aws-bom-builder-app
```

Downloads go through the app's own presigned-URL endpoint (`bills.downloadExcel` / `bills.downloadPdf`), not a public bucket policy — the bucket itself can (and should) stay private.

## 3. (Optional) Gemini API key

Free, no credit card: [aistudio.google.com/apikey](https://aistudio.google.com/apikey). If you skip this, AI enrichment of ambiguous line items is silently disabled — parsing, consolidation, reconciliation, and Excel export all still work.

## 4. Deploy to Vercel

1. Push this repo to GitHub.
2. [Vercel Dashboard](https://vercel.com/dashboard) → Add New → Project → Import `kumarwaibhav/AWS-BOM-Builder`.
3. Set environment variables (Project Settings → Environment Variables):

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | MySQL/TiDB connection string |
| `AWS_REGION` | yes | e.g. `us-east-1` |
| `AWS_ACCESS_KEY_ID` | yes | IAM user access key |
| `AWS_SECRET_ACCESS_KEY` | yes | IAM user secret key |
| `AWS_S3_BUCKET` | yes | bucket name |
| `GEMINI_API_KEY` | no | enables AI enrichment |
| `VITE_APP_TITLE` | no | defaults to "AWS Bill to BOM" |

4. Deploy. Vercel runs `pnpm run build` (vite build + esbuild server bundle).
5. Verify: `curl https://your-domain.vercel.app/api/trpc/system.health` should return `{"result":{"data":{"ok":true,"database":"connected"}}}`.

## 5. Docker (alternative to Vercel)

```bash
docker build -t aws-bom-builder .
docker run -p 3000:3000 \
  -e DATABASE_URL="mysql://..." \
  -e AWS_REGION="us-east-1" \
  -e AWS_ACCESS_KEY_ID="..." \
  -e AWS_SECRET_ACCESS_KEY="..." \
  -e AWS_S3_BUCKET="..." \
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

**"S3 access denied" / downloads fail** — verify the IAM policy grants `GetObject`/`PutObject` on the exact bucket ARN, and that `AWS_S3_BUCKET` matches.

**"PDF upload fails with 413"** — the app accepts up to 25 MB PDFs (checked in `server/routers/bills.ts`) with a 50 MB body-parser limit to cover base64 inflation. If your host has its own smaller request-size limit (some serverless platforms cap around 4.5 MB), you'll need a direct-to-S3 upload flow instead of base64-over-tRPC — not implemented here yet.

**AI enrichment silently not running** — expected if `GEMINI_API_KEY` is unset; check server logs for "AI enrichment is disabled" only if you expected it to run.

## Rollback

```bash
vercel rollback
# or, via Git:
git revert HEAD && git push origin main
```

---

**Last updated:** to match the codebase as of this rebuild — no Manus runtime, direct S3, optional Gemini enrichment, no authentication.
