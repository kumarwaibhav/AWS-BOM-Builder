/**
 * Guards the Consumption Insights colour system against silent regression.
 *
 * Parses the REAL client/src/index.css rather than a copy, so a token
 * renamed, dropped, duplicated or darkened in the stylesheet fails here.
 *
 * Two rules the whole scheme depends on:
 *   1. one hue per service category, distinct within each mode, legible
 *      against that mode's own background;
 *   2. pricing status never shares a hue with a category, so a green bar can
 *      only ever mean "a discount applies" and never "this is Analytics".
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const CSS = fs.readFileSync(path.resolve(__dirname, "index.css"), "utf8");

/** The 19 values of VALID_CATEGORIES in server/enrichment.ts. */
const CATEGORY_TOKENS = [
  "cat-compute", "cat-database", "cat-storage", "cat-analytics", "cat-containers",
  "cat-networking", "cat-management", "cat-appint", "cat-marketplace", "cat-security",
  "cat-ml", "cat-devtools", "cat-euc", "cat-bizapps", "cat-media",
  "cat-iot", "cat-migration", "cat-support", "cat-other",
];
const STATUS_TOKENS = ["st-committed", "st-committed-2", "st-spot"];

function block(selector: ":root" | ".dark"): string {
  const re = new RegExp(`\\n${selector.replace(".", "\\.")} \\{([\\s\\S]*?)\\n\\}`);
  const m = CSS.match(re);
  if (!m) throw new Error(`could not find the ${selector} block`);
  return m[1];
}
function hexOf(sel: ":root" | ".dark", token: string): string | null {
  const m = block(sel).match(new RegExp(`--${token}:\\s*(#[0-9A-Fa-f]{6})`));
  return m ? m[1].toUpperCase() : null;
}

/* --- WCAG relative luminance / contrast ------------------------------- */
const srgb = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map(i => srgb(parseInt(hex.substr(i, 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/* --- oklch -> sRGB, so the test reads the REAL --background ------------ */
function oklchToHex(L: number, C: number, hDeg: number): string {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h), bb = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * bb;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * bb;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * bb;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const lin = [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
  return "#" + lin.map(v => {
    const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, "0");
  }).join("").toUpperCase();
}
function backgroundOf(sel: ":root" | ".dark"): string {
  const m = block(sel).match(/--background:\s*oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)/);
  if (!m) throw new Error(`no --background in ${sel}`);
  return oklchToHex(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
}

describe("category tokens are complete", () => {
  it.each([":root", ".dark"] as const)("%s defines all 19 categories", sel => {
    const missing = CATEGORY_TOKENS.filter(t => hexOf(sel, t) === null);
    expect(missing).toEqual([]);
  });

  it.each([":root", ".dark"] as const)("%s defines the status scale", sel => {
    const missing = STATUS_TOKENS.filter(t => hexOf(sel, t) === null);
    expect(missing).toEqual([]);
  });
});

describe("every category is visually distinct", () => {
  it.each([":root", ".dark"] as const)("%s has no duplicate hex values", sel => {
    const hexes = CATEGORY_TOKENS.map(t => hexOf(sel, t)!);
    const dupes = hexes.filter((h, i) => hexes.indexOf(h) !== i);
    expect(dupes).toEqual([]);
  });

  it("light and dark are genuinely different palettes", () => {
    // A token identical in both modes means one of the two was never tuned.
    const same = CATEGORY_TOKENS.filter(t => hexOf(":root", t) === hexOf(".dark", t));
    expect(same).toEqual([]);
  });
});

describe("every category fill is legible on its own background", () => {
  // 3:1 is the WCAG floor for large graphical objects, which is what a chart
  // fill is. Below this a slice stops being distinguishable from the surface.
  it.each([":root", ".dark"] as const)("%s meets 3:1 against --background", sel => {
    const bg = backgroundOf(sel);
    const failures = CATEGORY_TOKENS
      .map(t => ({ t, hex: hexOf(sel, t)!, ratio: contrast(hexOf(sel, t)!, bg) }))
      .filter(x => x.ratio < 3.0);
    expect(failures.map(f => `${f.t} ${f.hex} = ${f.ratio.toFixed(2)}:1`)).toEqual([]);
  });

  it.each([":root", ".dark"] as const)("%s status colours meet 3:1 too", sel => {
    const bg = backgroundOf(sel);
    const failures = STATUS_TOKENS
      .map(t => ({ t, ratio: contrast(hexOf(sel, t)!, bg) }))
      .filter(x => x.ratio < 3.0);
    expect(failures.map(f => f.t)).toEqual([]);
  });
});

describe("status and category scales never collide", () => {
  it.each([":root", ".dark"] as const)("%s shares no hex between the scales", sel => {
    const cats = new Set(CATEGORY_TOKENS.map(t => hexOf(sel, t)!));
    const clashes = STATUS_TOKENS.filter(t => cats.has(hexOf(sel, t)!));
    expect(clashes).toEqual([]);
  });

  it("no category is green, so green can only ever mean 'discounted'", () => {
    // Emerald is reserved for commitment status. Analytics is lime (~80deg),
    // Containers is teal (~175deg); neither sits in the emerald band.
    const emerald = { min: 140, max: 165 };
    const hueOf = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.substr(i, 2), 16) / 255);
      const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
      if (d === 0) return 0;
      const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return (h * 60 + 360) % 360;
    };
    (([":root", ".dark"] as const)).forEach(sel => {
      const inBand = CATEGORY_TOKENS
        .map(t => ({ t, h: hueOf(hexOf(sel, t)!) }))
        .filter(x => x.h >= emerald.min && x.h <= emerald.max);
      expect(inBand.map(x => `${sel} ${x.t} hue ${x.h.toFixed(0)}`)).toEqual([]);
    });
  });
});
