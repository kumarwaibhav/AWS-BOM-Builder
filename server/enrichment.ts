/**
 * LLM-powered enrichment for BOM line items the rule-based parser could not
 * confidently classify. Targets ONLY ambiguous items (needsEnrichment=true):
 *  - infers the missing AWS Service Category
 *  - optionally clarifies terse Service Description/Config text
 * Raw parsed data is never replaced where it is already clear.
 */
import { invokeLLM } from "./_core/llm";
import { logger } from "./_core/logger";
import type { BomLineItem } from "./billParser";

const VALID_CATEGORIES = [
  "Compute", "Storage", "Database", "Networking & Content Delivery",
  "Analytics", "Management & Governance", "Security, Identity & Compliance",
  "Application Integration", "Machine Learning & AI", "Developer Tools",
  "Containers", "End User Computing", "Business Applications",
  "Migration & Transfer", "Media Services", "Internet of Things",
  "AWS Marketplace", "Support", "Other",
] as const;

interface EnrichmentResult {
  index: number;
  category: string;
  improvedDescription?: string;
}

const BATCH_SIZE = 40;

export async function enrichItems(items: BomLineItem[]): Promise<BomLineItem[]> {
  const targets = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.needsEnrichment || !item.serviceCategory);
  if (targets.length === 0) return items;

  const out = items.map(i => ({ ...i }));

  for (let b = 0; b < targets.length; b += BATCH_SIZE) {
    const batch = targets.slice(b, b + BATCH_SIZE);
    const payload = batch.map(({ item, index }) => ({
      index,
      serviceName: item.serviceName,
      description: item.description.slice(0, 300),
    }));

    try {
      const response = await invokeLLM({
        messages: [
          {
            role: "system",
            content:
              `You are an AWS billing expert. For each line item, assign the correct AWS Service Category from this exact list: ${VALID_CATEGORIES.join("; ")}. ` +
              `If a description is cryptic (e.g. raw usage-type codes like "APS3-TimedStorage-ByteHrs"), provide a short human-readable improvedDescription that keeps the original meaning; otherwise omit it. Never invent quantities or costs.`,
          },
          { role: "user", content: JSON.stringify(payload) },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "enrichment_results",
            strict: true,
            schema: {
              type: "object",
              properties: {
                results: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      index: { type: "number" },
                      category: { type: "string", enum: [...VALID_CATEGORIES] },
                      improvedDescription: {
                        type: ["string", "null"],
                        description: "Only when the raw description is cryptic; otherwise null",
                      },
                    },
                    required: ["index", "category", "improvedDescription"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["results"],
              additionalProperties: false,
            },
          },
        },
      });

      const content = response.choices?.[0]?.message?.content;
      if (!content) continue;
      const parsed = JSON.parse(
        typeof content === "string" ? content : JSON.stringify(content)
      ) as { results: EnrichmentResult[] };

      for (const r of parsed.results ?? []) {
        const target = out[r.index];
        if (!target) continue;
        if (r.category && VALID_CATEGORIES.includes(r.category as never)) {
          target.serviceCategory = r.category;
        }
        if (
          r.improvedDescription &&
          r.improvedDescription.length > 3 &&
          // keep raw data where already clear — only replace terse/cryptic text
          target.description.length < 60
        ) {
          target.description = `${target.description} (${r.improvedDescription})`;
        }
        target.needsEnrichment = false;
      }
    } catch (err) {
      logger.warn("Enrichment LLM batch failed, falling back to 'Other'", { message: err instanceof Error ? err.message : String(err) });
    }
  }

  // Anything still unclassified falls back to "Other"
  for (const item of out) {
    if (!item.serviceCategory) item.serviceCategory = "Other";
    item.needsEnrichment = false;
  }
  return out;
}
