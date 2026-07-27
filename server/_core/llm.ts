/**
 * Minimal LLM client for BOM enrichment, backed by Google Gemini's free tier
 * (generous no-cost daily quota, no credit card, native structured JSON output).
 *
 * Kept OpenAI-shaped (messages[] in, {choices:[{message:{content}}]} out) so
 * callers like server/enrichment.ts don't need to know which provider is behind
 * this. Swap providers by rewriting only this file.
 *
 * If GEMINI_API_KEY is not configured, invokeLLM throws — callers (see
 * enrichment.ts) already catch this and gracefully fall back to unenriched
 * data, so AI enrichment is a pure enhancement, never a hard requirement.
 */
import { ENV } from "./env";

type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

type JsonSchemaFormat = {
  type: "json_schema";
  json_schema: {
    name: string;
    strict?: boolean;
    schema: Record<string, unknown>;
  };
};

export type InvokeParams = {
  messages: ChatMessage[];
  response_format?: JsonSchemaFormat;
  model?: string;
  max_tokens?: number;
};

export type InvokeResult = {
  choices: Array<{ message: { content: string | null } }>;
};

/**
 * Gemini's structured-output schema is JSON Schema minus a couple of fields
 * OpenAI allows. Two differences matter here:
 *  - `additionalProperties` isn't recognised and must be stripped.
 *  - `type` is a single non-repeating enum field in Gemini's proto — it has
 *    no union-type support. OpenAI's Structured Outputs convention for a
 *    nullable field is `type: ["string", "null"]`; sending that array to
 *    Gemini fails every request with a 400 ("Proto field is not repeating,
 *    cannot start list"), which is exactly what production was hitting on
 *    every enrichment batch (confirmed via live runtime logs 2026-07-27).
 *    Gemini's equivalent is `type: "string", nullable: true`, so array-valued
 *    `type` is unwrapped into that form instead of being passed through.
 */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (schema && typeof schema === "object") {
    const input = schema as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (key === "additionalProperties") continue;
      if (key === "type") continue; // handled below, once, after the loop
      out[key] = toGeminiSchema(value);
    }
    if ("type" in input) {
      const t = input.type;
      if (Array.isArray(t)) {
        const nonNull = t.find(v => v !== "null");
        if (nonNull !== undefined) out.type = nonNull;
        if (t.includes("null")) out.nullable = true;
      } else {
        out.type = t;
      }
    }
    return out;
  }
  return schema;
}

export async function invokeLLM(params: InvokeParams): Promise<InvokeResult> {
  if (!ENV.gemini.apiKey) {
    throw new Error("GEMINI_API_KEY is not configured: AI enrichment is disabled");
  }

  const systemInstruction = params.messages
    .filter(m => m.role === "system")
    .map(m => m.content)
    .join("\n\n");

  const contents = params.messages
    .filter(m => m.role !== "system")
    .map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

  const generationConfig: Record<string, unknown> = {};
  if (params.response_format?.type === "json_schema") {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = toGeminiSchema(
      params.response_format.json_schema.schema
    );
  }
  if (params.max_tokens) {
    generationConfig.maxOutputTokens = params.max_tokens;
  }

  const model = params.model ?? ENV.gemini.model;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${ENV.gemini.apiKey}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents,
      ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
      generationConfig,
    }),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`Gemini request failed (${resp.status}): ${detail}`);
  }

  const data = (await resp.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text ?? "").join("") ?? null;

  return { choices: [{ message: { content: text } }] };
}
