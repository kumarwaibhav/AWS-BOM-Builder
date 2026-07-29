/**
 * Bill composition: categories ranked by spend, expandable to the services
 * inside each one.
 *
 * Replaced a treemap. Measured on the real data, the treemap rendered only
 * 6 of 17 services legibly and hid 18.6% of the bill in unreadable slivers -
 * and it degrades further as a bill gains categories. Rows stay readable at
 * any count, and every service is listed rather than implied.
 */
import { useState } from "react";
import type { Breakdown } from "../../../../server/insights";
import { categoryColor, fmtUsd, fmtPct, barWidth } from "./tokens";

export default function CompositionAccordion({
  categories, servicesFor, total,
}: {
  categories: Breakdown[];
  /** Services inside a category, already ranked. */
  servicesFor: (category: string) => Breakdown[];
  total: number;
}) {
  const [open, setOpen] = useState<Set<string>>(
    () => new Set(categories.length ? [categories[0].key] : []),
  );
  const toggle = (k: string) =>
    setOpen(prev => {
      const next = new Set(prev);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });

  if (!categories.length) {
    return <p className="text-sm text-muted-foreground py-4">This bill has no categorised spend.</p>;
  }

  const maxCat = Math.max(...categories.map(c => Math.abs(c.costUsd)));
  const SERVICE_LIMIT = 10;

  return (
    <div>
      {categories.map(cat => {
        const isOpen = open.has(cat.key);
        const services = isOpen ? servicesFor(cat.key) : [];
        const shown = services.slice(0, SERVICE_LIMIT);
        const rest = services.slice(SERVICE_LIMIT);
        const restSum = rest.reduce((s, r) => s + r.costUsd, 0);
        const maxSvc = Math.max(...shown.map(s => Math.abs(s.costUsd)), 0);

        return (
          <div key={cat.key} className="border-b border-border/50 last:border-b-0">
            <button
              type="button"
              onClick={() => toggle(cat.key)}
              aria-expanded={isOpen}
              className="grid w-full grid-cols-[16px_1fr_minmax(80px,200px)_130px] items-center gap-3 py-3 text-left hover:bg-muted/40"
            >
              <span
                className="inline-block text-[10px] text-muted-foreground transition-transform"
                style={{ transform: isOpen ? "rotate(90deg)" : undefined }}
                aria-hidden
              >
                ▶
              </span>
              <span className="truncate text-[13.5px] font-bold">
                {cat.key}
                <span className="ml-2 text-[11.5px] font-normal text-muted-foreground">
                  {cat.lineCount} line{cat.lineCount === 1 ? "" : "s"}
                </span>
              </span>
              <span className="h-2.5 overflow-hidden rounded-full bg-muted">
                <span
                  className="block h-full rounded-full transition-[width] duration-500"
                  style={{ width: barWidth(cat.costUsd, maxCat), background: categoryColor(cat.key) }}
                />
              </span>
              <span className="text-right font-mono text-[12.5px] font-bold tabular-nums whitespace-nowrap">
                {fmtUsd(cat.costUsd)}
                <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                  {fmtPct(total === 0 ? 0 : Math.abs(cat.costUsd) / Math.abs(total))}
                </span>
              </span>
            </button>

            {isOpen && (
              <div className="pb-3 pl-7">
                {shown.map(s => (
                  <div key={s.key} className="grid grid-cols-[1fr_minmax(80px,200px)_130px] items-center gap-3 py-1.5">
                    <span className="truncate text-[12.5px] text-muted-foreground" title={s.key}>{s.key}</span>
                    <span className="h-2 overflow-hidden rounded-full bg-muted">
                      <span
                        className="block h-full rounded-full opacity-70"
                        style={{ width: barWidth(s.costUsd, maxSvc), background: categoryColor(cat.key) }}
                      />
                    </span>
                    <span className="text-right font-mono text-[11.5px] tabular-nums whitespace-nowrap">
                      {fmtUsd(s.costUsd)}
                      <span className="ml-2 text-[10.5px] text-muted-foreground">
                        {fmtPct(cat.costUsd === 0 ? 0 : Math.abs(s.costUsd) / Math.abs(cat.costUsd))}
                      </span>
                    </span>
                  </div>
                ))}
                {rest.length > 0 && (
                  <p className="pt-1.5 font-mono text-[10.5px] text-muted-foreground">
                    + {rest.length} more service{rest.length === 1 ? "" : "s"} · {fmtUsd(restSum)}
                  </p>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
