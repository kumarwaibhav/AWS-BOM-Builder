/**
 * Observed hourly rate per machine type per region.
 *
 * This is the direct input for rate-by-rate comparison against another cloud,
 * so it must never present a number the bill does not support. Where a
 * machine was billed under more than one pricing model the effective rate is
 * a BLEND, and the printed component rates are always shown beside it -
 * verified on PSBA, where c6a.4xlarge blends 1,439 on-demand hours at $0.374
 * with 720 RI-covered hours at $0.00 to give $0.3319, a rate that appears
 * nowhere in the bill.
 */
import type { MachineRate } from "../../../../server/insights";
import { fmtUsd, fmtRate, fmtQty, MODEL_FILL, MODEL_INK, GENERATION_STYLE } from "./tokens";

export default function RateTable({ rates, limit = 15 }: { rates: MachineRate[]; limit?: number }) {
  if (!rates.length) {
    return (
      <p className="text-sm text-muted-foreground py-4">
        This bill has no hourly instance charges, so there are no per-machine rates to compare.
      </p>
    );
  }

  const shown = rates.slice(0, limit);
  const hidden = rates.slice(limit);
  const hiddenSum = hidden.reduce((s, r) => s + r.costUsd, 0);

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[12.5px]">
          <thead>
            <tr className="border-b border-border">
              {["Machine type", "Region", "Pricing observed", "Hours", "Cost", "Effective rate"].map((h, i) => (
                <th
                  key={h}
                  className={`px-2.5 pb-2.5 font-mono text-[9.5px] font-semibold uppercase tracking-wider text-muted-foreground ${i < 3 ? "text-left" : "text-right"}`}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map(r => (
              <tr key={`${r.instanceType}|${r.region}`} className="border-b border-border/40 last:border-b-0">
                <td className="px-2.5 py-2.5 font-semibold">
                  {r.instanceType}
                  <span
                    className="ml-2 rounded-[3px] px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider"
                    style={GENERATION_STYLE[r.generation]}
                  >
                    {r.generation}
                  </span>
                </td>
                <td className="px-2.5 py-2.5 text-muted-foreground">{r.region}</td>
                <td className="px-2.5 py-2.5">
                  {r.byModel.map(m => (
                    <span
                      key={m.model}
                      className="mr-1.5 mb-1 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold"
                      style={{
                        background: `color-mix(in srgb, ${MODEL_INK[m.model] ?? "var(--muted-foreground)"} 13%, transparent)`,
                        color: MODEL_INK[m.model] ?? "var(--muted-foreground)",
                      }}
                    >
                      <i
                        className="h-1.5 w-1.5 flex-none rounded-full"
                        style={{
                          background: MODEL_FILL[m.model] ?? "var(--cov-empty)",
                          boxShadow: m.model === "On-Demand" ? "inset 0 0 0 1px var(--border)" : undefined,
                        }}
                      />
                      {m.model} {fmtRate(m.rateUsd)}
                    </span>
                  ))}
                </td>
                <td className="px-2.5 py-2.5 text-right font-mono tabular-nums">{fmtQty(r.hours)}</td>
                <td className="px-2.5 py-2.5 text-right font-mono tabular-nums">{fmtUsd(r.costUsd)}</td>
                <td className="px-2.5 py-2.5 text-right font-mono tabular-nums">
                  <b>{fmtRate(r.effectiveRateUsd)}</b>/hr
                  {r.isBlended && (
                    <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">blended</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-3 border-t border-border/50 pt-2.5 font-mono text-[10px] leading-relaxed text-muted-foreground">
        {rates.length} machine/region combination{rates.length === 1 ? "" : "s"}
        {hidden.length > 0 && <> · showing the top {shown.length} by cost, {hidden.length} more not shown ({fmtUsd(hiddenSum)})</>}
        {" "}· rates are effective rates observed in this bill (cost ÷ hours), not published list prices
      </p>
    </div>
  );
}
