# AWS BOM Builder

A production-grade web app that converts AWS billing PDFs into a structured Excel Bill of Materials (BOM) — no login required.

Upload an AWS "Bills" PDF export and it extracts every line item, reconciles the total against the bill's own stated grand total, optionally uses AI to classify ambiguous items, and gives you back a clean `.xlsx` with an exact 8-column schema.

This is the AWS converter in what will become a multi-cloud BOM toolset (GCP, Azure, OCI, Huawei Cloud are planned as separate converters sharing this same foundation).

## Features

- **No login required** — anonymous, session-scoped upload history (no accounts, no OAuth)
- **Accurate PDF parsing** — extracts region, service, description, quantity, unit, and cost for every billed line item
- **Compute Savings Plan consolidation** — merges On-Demand + Savings Plan credit pairs into one blended-rate line, so cross-provider cost comparisons aren't artificially doubled
- **Grand total reconciliation** — sums all line items and flags (visibly, in the UI) any mismatch against the bill's own stated total, instead of silently trusting the parse
- **Excel export** — exact column order: `S.No. | AWS Region | AWS Service Category | AWS Service Name | AWS Service Description/Config | AWS Qty | AWS UOM | AWS Billed Cost USD`
- **Optional AI enrichment** — classifies ambiguous service categories via Gemini's free tier; if no API key is configured, this step is skipped silently and everything else still works
- **Upload history** — re-download the original PDF or the generated Excel BOM anytime, per browser session
- **Swiss-glass design** — International Typographic Style grid/type discipline rendered through red/white frosted-glass surfaces

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 19, Tailwind CSS 4, shadcn/ui, wouter |
| Backend | Express 4, tRPC 11, Superjson |
| Database | Postgres (Supabase) via Drizzle ORM |
| Storage | Supabase Storage (signed URLs — `@supabase/supabase-js`) |
| PDF parsing | pdf-parse |
| Excel generation | ExcelJS |
| AI enrichment | Google Gemini (free tier), optional |
| Testing | Vitest |

## Architecture

Single Express server handles both the API and the client:
- In development, Vite runs in middleware mode inside the same process (HMR over the same port).
- In production, the server serves the pre-built static client bundle and falls back to `index.html` for client-side routing.
- The API is a single tRPC router (`server/routers.ts`) mounted at `/api/trpc`, rate-limited and behind `helmet` security headers.
- There is no authentication layer. Every bill is scoped by a random `sessionId` generated once per browser and stored in `localStorage` (see `client/src/hooks/useSessionId.ts`).

```
AWS-BOM-Builder/
├── client/                 # React frontend
│   └── src/
│       ├── pages/          # Home, History, BillDetail, NotFound
│       ├── components/     # SwissHeader, BomTable, shadcn/ui primitives
│       ├── hooks/          # useSessionId, useMobile, ...
│       └── main.tsx
├── server/
│   ├── _core/               # server bootstrap: logger, env, trpc, vite/static serving
│   ├── routers/bills.ts     # upload/parse/list/get/download/remove
│   ├── billParser.ts        # AWS Bills PDF → structured line items
│   ├── consolidation.ts     # Savings Plan pair merging
│   ├── enrichment.ts        # optional Gemini classification
│   ├── excel.ts             # BOM → .xlsx
│   ├── storage.ts           # Supabase Storage put/get + signed URLs
│   └── db.ts                # Drizzle query helpers
├── drizzle/                 # schema + migrations
└── shared/const.ts          # constants shared between client and server
```

## Getting started

### Prerequisites

- Node.js 22+
- pnpm 10+ (`corepack enable` will pick up the pinned version automatically)
- A Supabase project (free, no credit card) — provides both the Postgres database and file storage
- (Optional) A free Gemini API key from [aistudio.google.com](https://aistudio.google.com/apikey) — no credit card required

### Installation

```bash
git clone https://github.com/kumarwaibhav/AWS-BOM-Builder.git
cd AWS-BOM-Builder
pnpm install

cp .env.example .env
# fill in DATABASE_URL, DIRECT_URL, SUPABASE_*, and (optionally) GEMINI_API_KEY

pnpm drizzle-kit generate   # only needed if you change drizzle/schema.ts
pnpm drizzle-kit migrate    # applies drizzle/*.sql against DIRECT_URL

pnpm dev
```

The app runs at `http://localhost:3000`.

## API

All endpoints are public and use a client-generated `sessionId` for scoping — no auth headers required.

| Endpoint | Type | Description |
|---|---|---|
| `bills.uploadAndParse` | mutation | Upload a base64-encoded PDF, parse, enrich, store, return `{ billId, itemCount }` |
| `bills.list` | query | List bills for a `sessionId` |
| `bills.get` | query | Fetch one bill + its BOM line items |
| `bills.downloadExcel` | mutation | Signed Supabase Storage URL for the generated `.xlsx` |
| `bills.downloadPdf` | mutation | Signed Supabase Storage URL for the original PDF |
| `bills.remove` | mutation | Delete a bill and its line items |
| `system.health` | query | Liveness/readiness — reports DB connectivity |

## Testing

```bash
pnpm test              # run once
pnpm test --watch      # watch mode
pnpm test --coverage   # with coverage
```

`server/billParser.test.ts` skips its full-bill assertions unless a sample AWS Bills PDF is present locally (not committed, since it'd contain real billing data) — see the test file for the expected fixture path.

## Limitations

- Max PDF size: ~3 MB (Vercel serverless function request-body limit -- see DEPLOYMENT.md)
- Max line items per bill: 10,000
- Supports the AWS **Bills** PDF export only (Billing and Cost Management → Bills → Print/Save as PDF) — not Cost Explorer exports

## Security notes

- No accounts, no personal data collected — only AWS billing data, scoped by an anonymous session id
- Supabase Storage signed URLs expire after 1 hour
- API is rate-limited (100 requests / 15 min per IP) and served behind `helmet` security headers
- **Never commit `.env` or any file containing real credentials.** `.gitignore` excludes `.env*`; use `.env.example` as the template.

## Roadmap

This repo currently covers AWS only. Planned next: the same upload → parse → reconcile → Excel BOM pipeline for GCP, Azure, OCI, and Huawei Cloud billing exports, sharing this app's design system and architecture.

## License

MIT — see [LICENSE](./LICENSE).
