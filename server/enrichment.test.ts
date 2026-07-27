import { describe, expect, it, vi, beforeEach } from "vitest";
import type { BomLineItem } from "./billParser";

const { invokeLLM } = vi.hoisted(() => ({ invokeLLM: vi.fn() }));
vi.mock("./_core/llm", () => ({ invokeLLM }));

import { enrichItems } from "./enrichment";

function item(overrides: Partial<BomLineItem> = {}): BomLineItem {
  return {
    region: "us-east-1",
    serviceCategory: "",
    serviceName: "APS3-TimedStorage-ByteHrs",
    description: "APS3-TimedStorage-ByteHrs",
    quantity: 1,
    uom: "GB-Mo",
    costUsd: 1.23,
    needsEnrichment: true,
    ...overrides,
  };
}

function structuredResponse(results: unknown[]) {
  return { choices: [{ message: { content: JSON.stringify({ results }) } }] };
}

beforeEach(() => {
  invokeLLM.mockReset();
});

describe("enrichItems", () => {
  it("skips the LLM entirely when nothing needs enrichment", async () => {
    const items = [item({ needsEnrichment: false, serviceCategory: "Compute" })];
    const result = await enrichItems(items);
    expect(invokeLLM).not.toHaveBeenCalled();
    expect(result.llmSucceededIndices.size).toBe(0);
    expect(result.items).toEqual(items);
  });

  it("applies a successful classification and records it in llmSucceededIndices", async () => {
    invokeLLM.mockResolvedValueOnce(
      structuredResponse([{ index: 0, category: "Storage", improvedDescription: null }])
    );
    const { items, llmSucceededIndices } = await enrichItems([item()]);
    expect(items[0].serviceCategory).toBe("Storage");
    expect(llmSucceededIndices.has(0)).toBe(true);
  });

  it("does NOT mark an item as llm-succeeded when the batch call throws (the production bug)", async () => {
    // This reproduces exactly what was happening in production: every
    // enrichment batch failed with a Gemini 400 (bad response_schema), was
    // caught, logged, and skipped -- so every item fell through to the
    // "Other" default below. Before this fix, bills.ts still marked these
    // as llmEnriched=1 because it computed the flag from "was targeted"
    // rather than "did the LLM actually respond."
    invokeLLM.mockRejectedValueOnce(new Error("Gemini request failed (400): bad schema"));
    const { items, llmSucceededIndices } = await enrichItems([item(), item()]);
    expect(items[0].serviceCategory).toBe("Other");
    expect(items[1].serviceCategory).toBe("Other");
    expect(llmSucceededIndices.size).toBe(0);
  });

  it("does not mark an item as succeeded when the LLM returns an invalid/unknown category", async () => {
    invokeLLM.mockResolvedValueOnce(
      structuredResponse([{ index: 0, category: "Not A Real Category", improvedDescription: null }])
    );
    const { items, llmSucceededIndices } = await enrichItems([item()]);
    expect(items[0].serviceCategory).toBe("Other");
    expect(llmSucceededIndices.has(0)).toBe(false);
  });

  it("handles a mixed batch: some items succeed, others fall back", async () => {
    invokeLLM.mockResolvedValueOnce(
      structuredResponse([{ index: 0, category: "Networking & Content Delivery", improvedDescription: null }])
      // index 1 deliberately omitted from the LLM's results
    );
    const { items, llmSucceededIndices } = await enrichItems([item(), item()]);
    expect(items[0].serviceCategory).toBe("Networking & Content Delivery");
    expect(items[1].serviceCategory).toBe("Other");
    expect(llmSucceededIndices.has(0)).toBe(true);
    expect(llmSucceededIndices.has(1)).toBe(false);
  });

  it("only sends items that need enrichment, leaving already-confident items untouched", async () => {
    invokeLLM.mockResolvedValueOnce(
      // index 1: the ambiguous item is the only target, and enrichItems
      // preserves original-array indices (not batch-relative ones) when
      // building the payload, so the LLM must be told index 1, not 0.
      structuredResponse([{ index: 1, category: "Compute", improvedDescription: null }])
    );
    const confident = item({ needsEnrichment: false, serviceCategory: "Database", description: "RDS" });
    const ambiguous = item();
    const { items } = await enrichItems([confident, ambiguous]);
    expect(items[0].serviceCategory).toBe("Database"); // untouched
    expect(items[1].serviceCategory).toBe("Compute");
    const sentPayload = JSON.parse(invokeLLM.mock.calls[0][0].messages[1].content);
    expect(sentPayload).toHaveLength(1);
    expect(sentPayload[0].index).toBe(1);
  });

  it("splits more than BATCH_SIZE targets across multiple invokeLLM calls", async () => {
    invokeLLM.mockResolvedValue(structuredResponse([]));
    const items = Array.from({ length: 85 }, () => item());
    await enrichItems(items);
    // 85 targets / batch size 40 => 3 calls (40 + 40 + 5)
    expect(invokeLLM).toHaveBeenCalledTimes(3);
  });
});
