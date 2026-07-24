# Production checklist

Reflects what's actually implemented as of this rebuild — check items are only marked done where the code genuinely does it (verified by `tsc --noEmit`, `vite build`, and `vitest run` all passing).

## Code quality
- [x] TypeScript compiles clean (`pnpm exec tsc --noEmit`)
- [x] Production build succeeds (`pnpm run build`)
- [x] No Manus/third-party-platform dependency anywhere in the codebase
- [x] No authentication — fully anonymous, session-scoped
- [x] No hardcoded credentials in source (see Security section below)

## Database
- [ ] Production database created and reachable from your deploy platform
- [ ] `pnpm drizzle-kit migrate` applied against production `DATABASE_URL`
- [ ] Indexes on `bills.sessionId`, `bills.createdAt`, `bom_items.billId` (add via a migration if query volume grows — not auto-created by the base schema)
- [ ] Backup strategy in place (e.g. scheduled `mysqldump`, or your managed DB provider's snapshot feature)

## AWS S3
- [ ] Bucket created, private (no public bucket policy needed — the app uses presigned URLs)
- [ ] IAM user scoped to `PutObject`/`GetObject` on that bucket only
- [ ] `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_S3_BUCKET` set in your deploy environment

## Features (verified working end-to-end in this rebuild)
- [x] PDF upload + parsing
- [x] Excel BOM export with the exact 8-column schema
- [x] PDF re-download from S3
- [x] Compute Savings Plan consolidation
- [x] Grand total reconciliation — **now actually compares** calculated vs. stated total and shows a warning on mismatch (previously always showed green regardless)
- [x] Bill history persists per browser session
- [x] User-friendly error messages via tRPC error handling
- [ ] AI enrichment — works when `GEMINI_API_KEY` is set; untested against a live key in this environment (no key configured here)

## UI/UX
- [x] Swiss-glass design system (red/white, frosted glass panels, sharp-cornered controls)
- [x] Responsive layout (mobile/tablet/desktop grid breakpoints)
- [x] No third-party branding anywhere
- [x] Every page reachable without login

## Performance
- [ ] PDF parsing timing under real load — not benchmarked in this environment
- [x] Excel generation is synchronous and fast (ExcelJS, in-memory)
- [ ] Database query performance under real data volume — add indexes above once you have production traffic patterns to profile

## Security
- [x] HTTPS (Vercel default, or terminate TLS at your load balancer for Docker)
- [x] `helmet` security headers
- [x] Rate limiting: 100 req / 15 min per IP on `/api/trpc`
- [x] S3 presigned URLs expire after 1 hour
- [x] No authentication attack surface (nothing to brute-force — also means no per-user access control; anyone with a `billId` and matching `sessionId` can access a bill, which is the accepted tradeoff of an anonymous, no-account product)
- [x] Zod input validation on every tRPC procedure
- [ ] **Rotate any credentials that were ever committed to a previous version of this repo.** If you're migrating from an older repo where `.project-config.json` or similar was accidentally committed with real secrets, treat every one of those credentials as compromised — rotate the database password, JWT/session secrets, and any API keys, regardless of whether you've deleted the file. Git history retains deleted files; only rotation actually neutralizes a leak.

## Testing
- [x] `pnpm test` passes (billParser suite conditionally skips without a local sample PDF fixture — see README)
- [ ] Manual end-to-end test with a real AWS Bills PDF on the target deployment
- [ ] Cross-browser check (Chrome/Firefox/Safari)
- [ ] Mobile device check

## Deployment
- [ ] GitHub repository created
- [ ] Vercel project connected (or Docker image built)
- [ ] Environment variables set
- [ ] Build succeeds on the platform (not just locally)
- [ ] `system.health` returns `database: "connected"` on the live deployment

## Documentation
- [x] README.md matches actual features/architecture
- [x] DEPLOYMENT.md matches actual deployment steps
- [x] PRODUCTION_CHECKLIST.md (this file)
- [ ] User-facing guide (not written — this is currently a developer-facing README only)

## Monitoring
- [x] Structured JSON logs (`server/_core/logger.ts`) — pipe to your log aggregator of choice
- [ ] Error tracking service (Sentry, etc.) — not wired in
- [ ] Uptime monitoring — not wired in
- [ ] Scheduled S3 cleanup for old bills — not implemented (bills accumulate in S3 indefinitely; add a lifecycle rule on the bucket or a cron job if this matters for your cost profile)

---

**Deployment date:** _______________
**Deployed by:** _______________
**Live URL:** _______________
