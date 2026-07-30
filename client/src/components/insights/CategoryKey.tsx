/**
 * Teaches the colour code once, up front. Without it the palette is
 * decoration; with it every fill on the page is readable at a glance.
 * Only categories actually present on this bill are shown.
 */
import type { Breakdown } from "../../../../server/insights";
import { categoryColor, fmtPct } from "./tokens";

export default function CategoryKey({ categories }: { categories: Breakdown[] }) {
  if (!categories.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {categories.map(c => (
        <span
          key={c.key}
          className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-[11.5px] font-semibold"
        >
          <i className="h-2.5 w-2.5 flex-none rounded-[3px]" style={{ background: categoryColor(c.key) }} />
          {c.key}
          <em className="font-mono text-[10.5px] font-normal not-italic text-muted-foreground">{fmtPct(c.share)}</em>
        </span>
      ))}
    </div>
  );
}
