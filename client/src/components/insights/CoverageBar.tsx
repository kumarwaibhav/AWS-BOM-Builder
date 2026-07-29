/**
 * Pricing-model coverage.
 *
 * The bar reads left-to-right as "how much of this spend carries a discount".
 * On-Demand is deliberately UNFILLED: the coloured fraction is the discounted
 * fraction, so the chart answers the question without needing a legend.
 *
 * Measured against GROSS on-demand-priced usage, not net spend. AWS bills
 * covered usage at full price and credits it back on a separate line, so the
 * pair nets to zero - dividing by net would report 0% coverage on a fully
 * covered account. See server/insights.ts for the full explanation.
 */
import type { CommitmentPosture } from "../../../../server/insights";
import { fmtUsd, fmtPct } from "./tokens";

interface Segment { label: string; usd: number; fill: string; note: string; neutral?: boolean }

export default function CoverageBar({ commitment }: { commitment: CommitmentPosture }) {
  const c = commitment;

  // Everything here is measured against gross on-demand usage. Reserved and
  // Spot are real charges, so they are shown for context but do not inflate
  // the coverage denominator.
  const segments: Segment[] = [
    { label: "Savings Plan", usd: c.savingsPlanCreditsUsd, fill: "var(--st-committed)", note: "discount applied" },
    { label: "Spot", usd: c.spotUsd, fill: "var(--st-spot)", note: "interruptible" },
    { label: "On-Demand", usd: Math.max(0, c.grossOnDemandUsd - c.savingsPlanCreditsUsd),
      fill: "var(--cov-empty)", note: "no discount applied", neutral: true },
  ].filter(s => s.usd > 0);

  const total = segments.reduce((s, x) => s + x.usd, 0);

  if (total === 0) {
    return (
      <p className="text-sm text-muted-foreground py-4">
        This bill has no on-demand-priced usage to measure coverage against.
      </p>
    );
  }

  return (
    <div>
      <div className="flex h-16 rounded-md overflow-hidden">
        {segments.map(s => {
          const share = s.usd / total;
          return (
            <div
              key={s.label}
              title={`${s.label} — ${fmtUsd(s.usd)}`}
              className="flex flex-col items-center justify-center overflow-hidden px-1.5 transition-[flex] duration-500"
              style={{
                flex: `${share} 0 0`,
                background: s.fill,
                color: s.neutral ? "var(--foreground)" : "var(--primary-foreground)",
                boxShadow: s.neutral ? "inset 0 0 0 1px var(--border)" : undefined,
              }}
            >
              <span className="text-lg font-black leading-none tabular-nums">{fmtPct(share)}</span>
              {share >= 0.11 && (
                <span className="mt-1 font-mono text-[9.5px] font-semibold uppercase tracking-wider truncate max-w-full">
                  {s.label}
                </span>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap gap-4 text-xs">
        {segments.map(s => (
          <span key={s.label} className="flex items-center gap-2 text-muted-foreground">
            <i
              className="h-2.5 w-2.5 flex-none rounded-[3px]"
              style={{ background: s.fill, boxShadow: s.neutral ? "inset 0 0 0 1px var(--border)" : undefined }}
            />
            {s.label}{" "}
            <b className="font-mono text-[11.5px] font-bold text-foreground">{fmtUsd(s.usd)}</b> · {s.note}
          </span>
        ))}
      </div>

      {(c.reservedUsd > 0 || c.savingsPlanFeesUsd > 0) && (
        <p className="mt-3 font-mono text-[10.5px] text-muted-foreground">
          {c.reservedUsd > 0 && <>Reserved Instance charges {fmtUsd(c.reservedUsd)}. </>}
          {c.savingsPlanFeesUsd > 0 && <>Savings Plan commitment fee {fmtUsd(c.savingsPlanFeesUsd)}. </>}
          These are separate charges, not part of the coverage split above.
        </p>
      )}
    </div>
  );
}
