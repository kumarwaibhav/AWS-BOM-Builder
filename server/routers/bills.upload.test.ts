/**
 * Upload failure surface.
 *
 * Found by live testing on the deployed preview, not by any local gate: every
 * error escaping the upload pipeline was handed to the customer verbatim AND
 * written into the bill record, which the History archive renders. A PDF whose
 * cross-reference table pdf.js disliked produced the customer-facing message:
 *
 *     bad XRef entry
 *
 * That is meaningless to a salesperson, gives no next step, and persisted in
 * the archive. The same leak covered Supabase, database, enrichment and
 * spreadsheet failures, since all of them reached the same catch.
 *
 * Extraction was also observed to be nondeterministic: a byte-identical PDF
 * with correct xref offsets, correct startxref and a valid trailer - read
 * without complaint by an independent parser and delivered to the server
 * intact - was accepted once and then rejected four consecutive times.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const pdfParse = vi.fn();
vi.mock("pdf-parse/lib/pdf-parse.js", () => ({ default: (b: unknown) => pdfParse(b) }));

const updateBill = vi.fn();
const createBill = vi.fn();
vi.mock("../db", () => ({
  getBillById: vi.fn(), getBomItemsByBill: vi.fn(), getDb: vi.fn(),
  createBill: (...a: unknown[]) => createBill(...a),
  updateBill: (...a: unknown[]) => updateBill(...a),
  listBillsBySession: vi.fn(), hasBillsForSession: vi.fn(),
  insertBomItems: vi.fn(), deleteBill: vi.fn(),
}));
vi.mock("../storage", () => ({ storagePut: vi.fn(), storageGet: vi.fn() }));
vi.mock("../enrichment", () => ({ enrichItems: vi.fn() }));
vi.mock("../excel", () => ({ generateBomExcel: vi.fn() }));

const PDF_B64 = Buffer.from("%PDF-1.4\n" + "0".repeat(400)).toString("base64");

async function upload() {
  const { appRouter } = await import("../routers");
  const caller = appRouter.createCaller({
    req: {} as never, res: {} as never, sessionId: "s1",
  });
  return caller.bills.uploadAndParse({ fileName: "acme.pdf", base64: PDF_B64 });
}

/** The message the customer sees, and the message stored for the archive. */
async function failureMessages() {
  const thrown = await upload().catch((e: Error) => e.message);
  const stored = updateBill.mock.calls
    .map(c => c[1] as { status?: string; errorMessage?: string })
    .find(p => p.status === "failed")?.errorMessage;
  return { thrown, stored };
}

beforeEach(() => {
  pdfParse.mockReset(); updateBill.mockReset(); createBill.mockReset();
  createBill.mockResolvedValue(4242);
});

describe("a PDF the reader rejects", () => {
  beforeEach(() => pdfParse.mockRejectedValue(new Error("bad XRef entry")));

  it("is retried once before the upload is failed", async () => {
    await upload().catch(() => {});
    expect(pdfParse).toHaveBeenCalledTimes(2);
  });

  it("never shows the customer the library's own words", async () => {
    const { thrown, stored } = await failureMessages();
    for (const m of [thrown, stored]) {
      expect(m).toBeDefined();
      expect(m).not.toContain("XRef");
      expect(m).not.toMatch(/\.js:\d+|at Object\.|TypeError|undefined/);
    }
  });

  it("tells the customer what to actually do about it", async () => {
    const { thrown, stored } = await failureMessages();
    expect(thrown).toMatch(/Billing and Cost Management/);
    expect(thrown).toMatch(/Save as PDF/);
    expect(stored).toBe(thrown);
  });

  it("succeeds if the retry succeeds, because extraction is not deterministic", async () => {
    pdfParse.mockReset();
    pdfParse
      .mockRejectedValueOnce(new Error("bad XRef entry"))
      .mockResolvedValueOnce({ text: "" });
    // Reaches the parser rather than failing on extraction: the parse of empty
    // text then fails with the deliberate summary-only message.
    const msg = await upload().catch((e: Error) => e.message);
    expect(pdfParse).toHaveBeenCalledTimes(2);
    expect(msg).toMatch(/bill summary page|Charges by service/);
    expect(msg).not.toContain("XRef");
  });
});

describe("a failure inside the pipeline", () => {
  it("does not leak a driver or schema error to the customer", async () => {
    pdfParse.mockResolvedValue({ text: "DescriptionUsage QuantityAmount in USD" });
    const { enrichItems } = await import("../enrichment");
    (enrichItems as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('relation "bills" does not exist: select "id", "sessionId", "pdfKey"')
    );
    const { thrown, stored } = await failureMessages();
    for (const m of [thrown, stored]) {
      expect(m).not.toContain("sessionId");
      expect(m).not.toContain("relation");
      expect(m).not.toContain("select");
    }
    expect(thrown).toMatch(/try uploading it again/i);
  });

  it("keeps a reference the customer can quote to support", async () => {
    pdfParse.mockResolvedValue({ text: "DescriptionUsage QuantityAmount in USD" });
    const { enrichItems } = await import("../enrichment");
    (enrichItems as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));
    const { thrown } = await failureMessages();
    expect(thrown).toContain("4242");
  });
});

describe("a failure BEFORE the bill record exists", () => {
  // storagePut and createBill run outside the pipeline's catch. Unguarded, a
  // Supabase outage surfaced a raw driver message and left no failure record,
  // so the upload appeared to evaporate with nothing in the archive.
  it("reports a problem on our side rather than a driver message", async () => {
    const { storagePut } = await import("../storage");
    (storagePut as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('getaddrinfo ENOTFOUND xyz.supabase.co')
    );
    const thrown = await upload().catch((e: Error) => e.message);
    expect(thrown).not.toContain("supabase");
    expect(thrown).not.toContain("ENOTFOUND");
    expect(thrown).toMatch(/could not be saved/);
    expect(thrown).toMatch(/not with your file/);
  });

  it("does not attempt to parse a bill it could not store", async () => {
    const { storagePut } = await import("../storage");
    (storagePut as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("down"));
    await upload().catch(() => {});
    expect(pdfParse).not.toHaveBeenCalled();
  });
});

describe("deliberate, already-human messages survive untouched", () => {
  it("keeps the summary-only guidance for a bill with no itemised charges", async () => {
    pdfParse.mockResolvedValue({ text: "AWS estimated bill summary\nEstimated grand total: USD 871.66" });
    const { thrown } = await failureMessages();
    expect(thrown).toMatch(/only a grand total/);
    expect(thrown).toMatch(/Charges by service/);
  });

  it("keeps the different guidance for a charges table that would not parse", async () => {
    pdfParse.mockResolvedValue({ text: "DescriptionUsage QuantityAmount in USD\nnothing parseable here" });
    const { thrown } = await failureMessages();
    expect(thrown).toMatch(/appears to contain a charges table/);
  });
});

describe("a bill that is not denominated in USD", () => {
  // Verified live: an INR bill extracts cleanly and parses to zero line items,
  // because every amount pattern requires the literal "USD". The old message
  // blamed the file and told the customer to contact support.
  it("names the currency instead of blaming the file", async () => {
    pdfParse.mockResolvedValue({
      text: "Charges by service\nDescriptionUsage QuantityAmount in INR\n"
          + "Rs. 20.75 per On Demand Linux m6i.large Instance Hour2,000 HrsINR 41,500.00",
    });
    const { thrown } = await failureMessages();
    expect(thrown).toContain("INR");
    expect(thrown).not.toMatch(/share this file with support/);
  });

  it("refuses to convert rather than inventing an exchange rate", async () => {
    pdfParse.mockResolvedValue({
      text: "Charges by service\nDescriptionUsage QuantityAmount in EUR\nEUR 1.234,56",
    });
    const { thrown } = await failureMessages();
    expect(thrown).toMatch(/will not convert/i);
    expect(thrown).toMatch(/exchange rate/i);
  });

  it("still gives the summary-only guidance for a USD bill with no charges table", async () => {
    // The currency branch must not swallow the two existing diagnoses.
    pdfParse.mockResolvedValue({ text: "AWS estimated bill summary\nTotal in USD\nUSD 871.66" });
    const { thrown } = await failureMessages();
    expect(thrown).toMatch(/only a grand total/);
    expect(thrown).not.toContain("denominated");
  });

  it("does not claim a currency problem when the bill states none", async () => {
    pdfParse.mockResolvedValue({ text: "Charges by service\nnothing parseable" });
    const { thrown } = await failureMessages();
    expect(thrown).not.toContain("denominated");
    expect(thrown).toMatch(/charges table/);
  });
});
