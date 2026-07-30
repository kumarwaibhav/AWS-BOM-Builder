/**
 * Ranked bar list - the workhorse of the insights tab.
 *
 * Two rules it enforces so a panel can never mislead:
 *   1. single-hue panels rank by bar LENGTH, not by a second colour. Rotating
 *      hues through a list encodes nothing and was what made the first
 *      mockup read as noise.
 *   2. anything hidden by the row cap is disclosed with a count and a dollar
 *      remainder. Silent truncation is the one thing a spend breakdown must
 *      never do.
 */
import { fmtUsd, fmtPct, barWidth, GENERATION_STYLE } from "./tokens";

export interface RankedRow {
  key: string;
  costUsd: number;
  share: number;
  /** Optional status badge (hardware generation). Never a category colour. */
  badge?: "Current" | "Previous" | "Legacy";
  /** Per-row colour, for lists that mix categories (e.g. biggest charges). */
  color?: string;
  /** Rendered under the label - region, instance family, etc. */
  sub?: string;
}

export default function RankedList({
  rows, hue, limit = 12, emptyMessage = "Nothing to show for this bill.",
}: {
  rows: RankedRow[];
  /** CSS colour for every bar in a single-category panel. */
  hue?: string;
  limit?: number;
  emptyMessage?: string;
}) {
  if (!rows.length) {
    return <p className="text-sm text-muted-foreground py-4">{emptyMessage}</p>;
  }

  const shown = rows.slice(0, limit);
  const hidden = rows.slice(limit);
  const hiddenSum = hidden.reduce((s, r) => s + r.costUsd, 0);
  const hiddenShare = hidden.reduce((s, r) => s + r.share, 0);
  const max = Math.max(...shown.map(r => Math.abs(r.costUsd)), 0);

  return (
    <div className="flex flex-col gap-3">
      {shown.map(r => (
        <div key={r.key} className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 items-baseline">
          <div className="text-[13px] font-semibold truncate" title={r.key}>
            {r.key}
            {r.badge && (
              <span
                className="ml-2 align-middle rounded-[3px] px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider"
                style={GENERATION_STYLE[r.badge]}
              >
                {r.badge}
              </span>
            )}
            {r.sub && <span className="ml-2 text-[11px] font-normal text-muted-foreground">{r.sub}</span>}
          </div>
          <div className="font-mono text-xs font-semibold whitespace-nowrap tabular-nums">
            {fmtUsd(r.costUsd)}
            <span className="ml-2 text-[11px] font-normal text-muted-foreground">{fmtPct(r.share)}</span>
          </div>
          <div className="col-span-2 h-2 rounded-full overflow-hidden bg-muted">
            <div
              className="h-full rounded-full transition-[width] duration-500"
              style={{
                width: barWidth(r.costUsd, max),
                background: r.color ?? hue ?? "var(--primary)",
                opacity: hue && !r.color ? 0.45 + 0.55 * (max ? Math.abs(r.costUsd) / max : 0) : 1,
              }}
            />
          </div>
        </div>
      ))}

      {hidden.length > 0 && (
        <p className="mt-1 border-t border-dashed border-border pt-2 font-mono text-[10.5px] text-muted-foreground">
          + {hidden.length} more not shown · {fmtUsd(hiddenSum)} · {fmtPct(hiddenShare)}
        </p>
      )}
    </div>
  );
}
