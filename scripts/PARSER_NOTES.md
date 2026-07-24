# AWS Bill Parser — Findings & Remaining Bugs

## Sample bill facts (Bills_BillingandCostManagement_Global.pdf, 18 pages)
- Billing period: Jun 1 - Jun 30, 2026 | Account ID: 672180732953 | Grand total USD 5,511.36
- Providers: "Amazon Web Services, Inc. - Marketplace (2) Total pre-tax USD 380.64",
  "Amazon Web Services India Private Limited (39) Total pre-tax USD 5,130.72"
- Hierarchy: Service (L0, e.g. "Elastic Compute CloudUSD 1,703.20") → Region (L1,
  "Asia Pacific (Hyderabad)USD 130.57") → Sub-service (L2, "Amazon EC2 NatGatewayUSD 121.04")
  → Leaf usage lines (L3, "$0.056 per NAT gateway Hour2,160 HrsUSD 120.96").
- pdf-parse output GLUES columns together with no spacing; long descriptions wrap
  across lines, sometimes qty+amount land alone on a following line ("93.387 GB-MoUSD 8.52").
- Section ends at: Charges by account / Invoices / Tax Invoices / Savings ( / Taxes by service.
- "Total taxUSD 0.00" marks the end of a provider block.
- Expected per-service totals (from layout text): EC2 1703.20, RDS 494.39, Redshift 483.94,
  CloudWatch 391.01, VPC 270.71, ELB 288.93, Config 244.98, Data Transfer 188.37,
  Route 53 187.81, Security Hub 125.08.

## Bugs found in first parser version (sum was 5700.56 vs expected ~5511)
1. QTY_UOM_TAIL_RE wrongly splits SUB-SERVICE header lines that end in digits+word,
   e.g. "Amazon Virtual Private Cloud Public IPv4 AddressesUSD 32.42" → parsed as leaf
   qty=4 uom="Addresses". Same for "Amazon Route 53 DNS-QueriesUSD 187.31" → qty=53.
   FIX: require the number to be preceded by whitespace/glued AND the group-line detection
   should win when the "qty" number is glued directly to a letter (no space before number)?
   Actually in real leaf lines qty is glued to description: "...Hour2,160 Hrs". In headers
   "IPv4 Addresses" the number 4 is part of a word (preceded by letters "IPv"), and
   "Route 53 DNS-Queries" has space before 53 but 53 is mid-description.
   Distinguishing rule: LEAF lines always start with "$", "USD", or are savings-plan/credit/
   free-tier lines. Sub-service headers produce dup subtotals → causes double counting.
   Better rule: treat a line as leaf ONLY if qty+uom immediately precede the amount AND
   (line starts with $ or USD0 or the extracted uom is a known unit pattern like
   Hrs|GB|GB-Mo|Requests|Queries|Months|API Calls|vCPU-Hours|LCU-Hrs|...) — else group line.
   ALSO: headers like "HostedZone" (qty=1 "HostedZone" glued: "25 Hosted Zones1 HostedZone")
   come from wrapped header "$0.50 per Hosted Zone for the first 25 Hosted Zones1 HostedZoneUSD 0.50"
   — actually that's a leaf with qty=1 uom=HostedZone. Complex.
2. Sub-service context wrongly persists: VPC "Public IPv4 Addresses" header got parsed as
   leaf, so following leaves kept older sub-service "APS3-VpcPeering-Out-Bytes" prefix.
3. Config section: "AWS Config  APS5-Config urationItemRecordedUSD 7.88" has odd spaces
   (kerning artifacts: "Config uration", "fir st"). Qty can wrap onto its own line:
   "2,625 APS3-\nConfig urationItemRecorded\nUSD 7.88" — qty line separated from amount line!
4. Double counting = header subtotals counted as leaves (VPC sum 503 vs 270; Route53 375 vs 187).

## Key UOM whitelist observed in bill
Hrs, GB, GB-Mo, GB-Month, Months, Requests, Queries, API Calls, vCPU-Hours, LCU-Hrs,
ReadCapacityUnit-Hrs, WriteCapacityUnit-Hrs, HostedZone, Config RuleEvaluations,
APS3-Config urationItemRecorded, Alarms, Metrics, Events, Objects, Keys, Secrets,
IA-Requests, Findings, Instances, Certificates, Rules, WebACLs, Checks, Messages,
Notifications, Emails, Function-GB-Second(?), Lambda-GB-Second, Second(s), Minutes, Units, Unit-Hrs

## Strategy decided
- Leaf detection: line must have trailing amount AND a qty+uom tail whose UOM matches
  a units whitelist regex OR line starts with rate markers ($x.xx per..., USD0.x per...).
- Group/header lines: description+amount only.
- Region detection via REGION_SET whitelist (includes "Any", "Global", "No Region").
- Service vs sub-service: service header is followed by region header (lookahead nextGroupIsRegion).
- LLM enrichment for rows with empty category via invokeLLM json_schema batch.
- Validation: sum of positive+negative leaf costs per provider ≈ Total pre-tax; grand total check.

## Files
- server/billParser.ts — parser (rewrite tokenizeLine leaf detection)
- scripts/_reconcile.mts, scripts/_debug.mts — dev-only test scripts (delete before checkpoint)
- /tmp/pdfparse_text.txt — raw pdf-parse text of sample bill
- /home/ubuntu/bill_full.txt — pdftotext -layout version (indented, human readable)

## Round 2 findings (current state: 562 items, sum 5163.29 vs 5511.36)
Remaining gap ≈ 348 = mostly Security Hub (125.08 expected vs 9.51 parsed), Config
(244.98 expected vs ~16 parsed), plus EC2 over by 13 (1716.53 vs 1703.20) and
CloudWatch under by 15 (375.50 vs 391.01).

### Wrapped multi-line pattern (Security Hub / Config sections):
```
AWS Security Hub APS3-FreeFindingsIngestion-CrossRegionUSD 0.00     ← sub-service header
USD0.0 per Finding Ingestion Events for FreeFindingsIngestion-CrossRegion in Asia Pacific  ← desc part 1 (no amount)
(Mumbai)                                                            ← desc part 2
83,338 Finding Ingestion                                            ← qty + partial uom (no amount!)
Events                                                              ← uom continuation
USD 0.00                                                            ← amount ALONE on its own line
```
Also: "77,315 Security ChecksUSD 61.85" (qty line + amount glued) after a 2-line desc.
And: "First 10,000 ... are free7,180 Finding Ingestion\nEvents\nUSD 0.00".
FIX NEEDED: when a line has NO trailing USD amount, buffer it (pendingDesc). When a
line is ONLY "USD x.xx" (pure amount), combine with buffered fragments: search the
buffer for a trailing "<number> <unit words...>" group = qty/uom, remainder = desc.
Buffered fragment lines can also END with qty+partial-uom that continues next line.
Approach: accumulate fragment lines until an amount appears (either glued at end of a
fragment or standalone "USD x.xx" line), then tokenize the JOINED text as one line.
This joined-line approach replaces per-line tokenization for leaves.
CAUTION: group headers (service/region/sub-service) always have amount on SAME line,
so joining only happens for the no-amount fragments.

### EC2 over-count +13.33: likely the "EBSUSD 9.53" sub-header lines or dup?
EBS appears as sub-service "EBSUSD 9.53" — group line, fine. Check savings-plan credits
with "(USD x)" parens negative parsing. 1716.53-1703.20=13.33. Investigate later.

### Note: pure-amount lines "USD 0.00" currently probably parsed as group line w/ empty
desc or dropped; ensure handling.

## Round 3 status (after multi-word UOM + whole-line-qty-first rules)
- tokenizeLine rule order: 0) whole-line qty "2.755 GBUSD 0.55" (line starts with number,
  isPlausibleUom); 1) glued qty (lookbehind [a-z)]%.]); 2) spaced qty (before must be
  empty/rate/credit); 3) rate/credit leaf w/o qty; else group line.
- isPlausibleUom: whole phrase or last word in UOM_WHITELIST_RE (multi-word units:
  "Security Checks", "Finding Ingestion Events").
- CAUTION: adding generic nouns (Addresses) to whitelist breaks sub-service headers like
  "...Public IPv4 AddressesUSD 32.42" ("4 Addresses" glued-match). DO NOT whitelist Addresses.
- Remaining diffs: EC2 +13.33 (1716.53 vs 1703.20), Lambda −0.01, Config +0.01 (rounding).
  EC2: likely a savings-plan credit "(USD x)" not parsed negative, or dup leaf. Bill region
  totals: Hyderabad 130.57 OK, Mumbai expected 1572.63 vs parsed 1585.96 → +13.33 in Mumbai.
- Expected per-service totals are in scripts/_diff.mts (Lambda corrected to 1.55).
- Grand total incl tax = 5891.99? NO — "Estimated grand total: USD 5,511.36" wait actually
  includes 380.64 tax? Charges-by-service sums to pre-tax ≈ 5511.29 (per _diff expected).

## FINAL: parser validated (Round 4)
- Parsed total 5511.26 vs expected 5511.29 — remaining ±0.01 diffs (CloudWatch, Config,
  Lambda) are the BILL's own rounding (leaf lines sum to 1.17 while its header prints 1.18).
- Fix that clinched it: CREDIT_LINE_RE tightened — no bare "credit" (was matching the
  "T4GCPUCredits" usage-type header); negative savings-plan leaves parse via leading "-".
- 4 zero-cost services (CloudFormation, CloudWatch Events, DynamoDB, Service Catalog)
  appear as EXTRA because expected map only listed non-zero services. They are correct.

## billParser.ts public API (for routers/enrichment/excel)
- `parseAwsBill(text: string): ParsedBill` — main entry; feed pdf-parse's data.text.
- `ParsedBill = { billingPeriod, accountId, grandTotalUsd, items: BomLineItem[] }`
- `BomLineItem = { region, serviceCategory, serviceName, description, quantity: number|null, uom: string|null, costUsd: number, needsEnrichment: boolean }`
- `classifyService(serviceName, subService=""): string` — "" when unknown → needsEnrichment.
- pdf-parse import style: `import pdfParse from "pdf-parse/lib/pdf-parse.js";` (avoids the
  package's index.js debug-mode file read). Works under tsx/vitest.

## Remaining build steps (todo.md tracks status)
1. server/enrichment.ts — LLM batch enrichment for items with needsEnrichment (invokeLLM
   from server/_core/llm.ts; JSON-schema structured output; skill: webdev-llm-integration:
   use `import { invokeLLM } from "./_core/llm"`, messages array, responseFormat json_schema).
2. server/excel.ts — exceljs workbook: headers exactly: S.No. | AWS Region | AWS Service
   Category | AWS Service Name | AWS Service Description/ Config | AWS Qty | AWS UOM |
   AWS Billed Cost USD. Style: bold white-on-black header row, borders, totals row.
3. server/routers.ts — bills router: upload (base64 → storagePut pdf), parse, list, get,
   downloadExcel (generate → storagePut → presigned url via storageGet). DB helpers in db.ts.
   Schema already migrated: bills + bom_items tables exist (drizzle/schema.ts).
4. Frontend: Home.tsx = upload + table + download; History page. Swiss/International
   Typographic Style: white bg, red (#E30613) square accents, black text, Helvetica-like
   (Inter/Neue Haas), grid lines, asymmetric layout.
5. Vitest: server/billParser.test.ts with real sample PDF at
   /home/ubuntu/upload/Bills_BillingandCostManagement_Global.pdf (expected totals in _diff.mts).
- storage helpers: `import { storagePut, storageGet } from "./storage"` (server/storage.ts).
- DB tables: bills(id, userId, fileName, fileKey, fileUrl, billingPeriod, accountId,
  grandTotalUsd, itemCount, totalCostUsd, excelKey, excelUrl, status, createdAt);
- bom_items(id, billId, sno, region, serviceCategory, serviceName, description, quantity
  double, uom, costUsd double, enriched boolean).

## FINAL E2E STATUS (validated Jul 22, 2026)
- Full pipeline validated locally: PDF → pdf-parse → parseAwsBill → enrichItems (LLM) → generateBomExcel.
- Sample bill: 576 items; meta "Jun 1 - Jun 30, 2026", acct 672180732953, grand total 5511.36;
  leaf sum 5511.26 vs pre-tax 5511.29 (bill's own penny rounding). Enrichment: 1 item, 1.5s.
- Excel verified via openpyxl: sheet "AWS BOM", exact 8 headers on row 1, 576 data rows +
  TOTAL row (5511.26). Sample saved at /home/ubuntu/sample-BOM.xlsx.
- Fixed enrichment strict json_schema: improvedDescription must be type ["string","null"]
  and listed in required (strict mode requires all props in required).
- Vitest: 3 files, 9 tests pass. tsc clean.
- Remaining: browser E2E via UI (upload → table → download), todo.md updates, cleanup
  debug scripts, checkpoint, deliver.
