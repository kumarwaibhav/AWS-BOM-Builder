/**
 * Shared foundation for the Consumption Insights components.
 *
 * The colour contract, in one place so no component can invent its own:
 *
 *   SCALE A - identity. One fixed CSS token per service category, used for
 *             every FILL representing that category, everywhere.
 *   SCALE B - status. Pricing model and hardware generation only. Never used
 *             to identify a category.
 *
 * The tokens themselves live in client/src/index.css and are guarded by
 * client/src/insightTokens.test.ts (presence, uniqueness, 3:1 contrast in
 * both modes, and no overlap between the two scales).
 */

/** Keys are the exact 19 values of VALID_CATEGORIES in server/enrichment.ts. */
const CATEGORY_TOKEN: Record<string, string> = {
  "compute": "--cat-compute",
  "storage": "--cat-storage",
  "database": "--cat-database",
  "networking & content delivery": "--cat-networking",
  "analytics": "--cat-analytics",
  "management & governance": "--cat-management",
  "security, identity & compliance": "--cat-security",
  "application integration": "--cat-appint",
  "machine learning & ai": "--cat-ml",
  "developer tools": "--cat-devtools",
  "containers": "--cat-containers",
  "end user computing": "--cat-euc",
  "business applications": "--cat-bizapps",
  "migration & transfer": "--cat-migration",
  "media services": "--cat-media",
  "internet of things": "--cat-iot",
  "aws marketplace": "--cat-marketplace",
  "support": "--cat-support",
  "other": "--cat-other",
};

/**
 * CSS variable for a category. The enum is closed and the parser falls back
 * to "Other", so this is total - an unknown string still gets a real colour
 * rather than rendering as transparent.
 */
export function categoryToken(category: string): string {
  return CATEGORY_TOKEN[String(category ?? "").trim().toLowerCase()] ?? "--cat-other";
}

export const categoryColor = (category: string) => `var(${categoryToken(category)})`;

/** Scale B. On-Demand is deliberately colourless: it is the unfilled bar. */
export const MODEL_FILL: Record<string, string> = {
  "On-Demand": "var(--cov-empty)",
  "Savings Plan credit": "var(--st-committed)",
  "Savings Plan fee": "var(--st-committed-2)",
  "Reserved": "var(--st-committed-2)",
  "Spot": "var(--st-spot)",
  "Free tier": "var(--cov-empty)",
  "Usage-based": "var(--cov-empty)",
};

export const MODEL_INK: Record<string, string> = {
  "On-Demand": "var(--muted-foreground)",
  "Savings Plan credit": "var(--st-committed)",
  "Savings Plan fee": "var(--st-committed-2)",
  "Reserved": "var(--st-committed-2)",
  "Spot": "var(--st-spot)",
  "Free tier": "var(--muted-foreground)",
  "Usage-based": "var(--muted-foreground)",
};

/** Generation badges use weight, not a competing hue. */
export const GENERATION_STYLE: Record<string, React.CSSProperties> = {
  Current: { background: "color-mix(in srgb, var(--st-committed) 14%, transparent)", color: "var(--st-committed)" },
  Previous: { background: "var(--muted)", color: "var(--muted-foreground)" },
  Legacy: { background: "var(--foreground)", color: "var(--background)" },
};

/* ---- formatting: one implementation, so no two panels disagree -------- */

export function fmtUsd(n: number, opts: { compact?: boolean } = {}): string {
  if (!Number.isFinite(n)) return "N/A";
  if (opts.compact && Math.abs(n) >= 1000) {
    return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  }
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** A share is already a 0-1 fraction; never multiply one twice. */
export function fmtPct(share: number, dp = 1): string {
  if (!Number.isFinite(share)) return "N/A";
  return (share * 100).toFixed(dp) + "%";
}

export function fmtQty(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "N/A";
  return n.toLocaleString("en-US", { maximumFractionDigits: 3 });
}

export function fmtRate(n: number): string {
  if (!Number.isFinite(n)) return "N/A";
  return "$" + n.toFixed(4);
}

/**
 * Bar width as a percentage of the largest value in a set. Guards the two
 * ways this goes wrong: a zero maximum (every bar full-width) and negative
 * values (a bar extending the wrong way).
 */
export function barWidth(value: number, max: number): string {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return "0%";
  const pct = (Math.abs(value) / max) * 100;
  return Math.min(100, Math.max(0, pct)).toFixed(1) + "%";
}
