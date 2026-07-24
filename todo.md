# AWS BOM Builder — status & roadmap

## Done in this rebuild

- Removed the Manus app-builder runtime entirely: OAuth login flow, `users` table,
  `vite-plugin-manus-runtime`, and ~2,300 lines of unused scaffolding (dashboard/sidebar
  template, chat box, map, voice transcription, image generation) are gone.
- Storage now genuinely uses AWS S3 directly (`@aws-sdk/client-s3` + presigned URLs) —
  previously routed through a third-party hosted proxy despite docs claiming otherwise.
- AI enrichment calls Google Gemini's free tier directly; gracefully no-ops without a key.
- Fixed a real bug: the reconciliation check always showed green regardless of whether
  totals actually matched. It now compares calculated vs. stated total and warns on mismatch.
- Consolidated onto a single Swiss-glass design system (red/white, frosted-glass panels,
  sharp-cornered controls) applied across Home, History, BillDetail, and the BOM table.
- Production hardening: `helmet`, rate limiting, structured JSON logging, graceful shutdown,
  DB-aware health check.
- Removed dead weight: unused scratch scripts, a leftover component showcase page never
  routed to, a wouter patch that only fed Manus's own dev tooling.
- Rewrote README/DEPLOYMENT/PRODUCTION_CHECKLIST to describe what the code actually does.

## Known gaps (not yet done)

- [ ] No sample AWS bill PDF fixture is committed, so `billParser.test.ts`'s full assertions
      are skipped in CI/fresh clones. Add a redacted sample bill to unblock this.
- [ ] No direct-to-S3 upload path — large PDFs go base64-over-tRPC, which will hit request-size
      limits on some serverless hosts (see DEPLOYMENT.md troubleshooting).
- [ ] No error tracking (Sentry or similar) or uptime monitoring wired in.
- [ ] No scheduled S3 cleanup — old bill files accumulate indefinitely.
- [ ] No rate-limit-aware retry/backoff on the client for failed uploads.
- [ ] Dark mode theme toggle exists in scaffolding (`ThemeContext`) but isn't exposed in the UI.

## Next major phase: multi-cloud BOM converters

This repo is the AWS converter. Planned next, each as its own parser + consolidation logic
sharing this app's architecture and design system:

- [ ] GCP billing export → BOM
- [ ] Azure cost export → BOM
- [ ] OCI billing export → BOM
- [ ] Huawei Cloud billing export → BOM

These should share the `bills`/`bom_items`-style schema (with a `provider` column), the same
upload → parse → consolidate → reconcile → Excel pipeline, and the same Swiss-glass UI —
not a rewrite per provider.
