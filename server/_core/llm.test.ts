import { describe, expect, it } from "vitest";
import { toGeminiSchema } from "./llm";

describe("toGeminiSchema", () => {
  it("passes plain scalar types through untouched", () => {
    expect(toGeminiSchema({ type: "string" })).toEqual({ type: "string" });
    expect(toGeminiSchema({ type: "number" })).toEqual({ type: "number" });
  });

  it("strips additionalProperties at any depth", () => {
    expect(toGeminiSchema({ type: "object", additionalProperties: false })).toEqual({
      type: "object",
    });
    expect(
      toGeminiSchema({
        type: "object",
        properties: { a: { type: "string", additionalProperties: false } },
      })
    ).toEqual({ type: "object", properties: { a: { type: "string" } } });
  });

  it("converts an OpenAI-style nullable union type to Gemini's nullable:true form", () => {
    // This is the exact shape that broke every enrichment batch in production:
    // Gemini's `type` is a single non-repeating enum field and rejects a JSON
    // array with a 400 ("Proto field is not repeating, cannot start list").
    expect(toGeminiSchema({ type: ["string", "null"] })).toEqual({
      type: "string",
      nullable: true,
    });
  });

  it("handles the null-first ordering too", () => {
    expect(toGeminiSchema({ type: ["null", "string"] })).toEqual({
      type: "string",
      nullable: true,
    });
  });

  it("preserves sibling keys (description, enum) alongside the converted type", () => {
    expect(
      toGeminiSchema({
        type: ["string", "null"],
        description: "Only when cryptic; otherwise null",
      })
    ).toEqual({
      type: "string",
      nullable: true,
      description: "Only when cryptic; otherwise null",
    });
  });

  it("recurses into nested object/array schemas (the real enrichment schema shape)", () => {
    const schema = {
      type: "object",
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              index: { type: "number" },
              category: { type: "string", enum: ["Compute", "Storage"] },
              improvedDescription: { type: ["string", "null"] },
            },
            required: ["index", "category", "improvedDescription"],
            additionalProperties: false,
          },
        },
      },
      required: ["results"],
      additionalProperties: false,
    };

    expect(toGeminiSchema(schema)).toEqual({
      type: "object",
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              index: { type: "number" },
              category: { type: "string", enum: ["Compute", "Storage"] },
              improvedDescription: { type: "string", nullable: true },
            },
            required: ["index", "category", "improvedDescription"],
          },
        },
      },
      required: ["results"],
    });
  });

  it("leaves non-schema scalars and null untouched", () => {
    expect(toGeminiSchema("hello")).toBe("hello");
    expect(toGeminiSchema(42)).toBe(42);
    expect(toGeminiSchema(null)).toBe(null);
  });
});
