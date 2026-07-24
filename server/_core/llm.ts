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
 * OpenAI allows (e.g. `additionalProperties`, `const`). Strip what Gemini
 * rejects; nested objects/arrays/enums all pass through untouched.
 */
function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (schema && typeof schema === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
      if (key === "additionalProperties") continue;
      out[key] = toGeminiSchema(value);
    }
    return out;
  }
  return schema;
}

export async function invokeLLM(params: InvokeParams): Promise<InvokeResult> {
  if (!ENV.gemini.apiKey) {
    throw new Error("GEMINI_API_KEY is not configured — AI enrichment is disabled");
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
