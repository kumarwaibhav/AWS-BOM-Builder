/**
 * Region x category grid - the direct input for apples-to-apples pricing,
 * since target-cloud rates differ by region.
 *
 * Real bills reach 24 regions and 14 categories, which is 336 cells and
 * unreadable. Both axes are ranked and the tail is folded into an explicit
 * aggregate row and column, so the grid stays legible while still summing to
 * the whole bill. Nothing is dropped, and the fold is stated rather than
 * implied.
 *
 * Each column is shaded in ITS OWN category hue, so the colour code learned
 * elsewhere on the page carries into the grid.
 */
import type { BillInsights } from "../../../../server/insights";
import { categoryColor, fmtUsd, fmtPct } from "./tokens";

const MAX_ROWS = 8;
const MAX_COLS = 8;

export default function RegionCategoryMatrix({ insights }: { insights: BillInsights }) {
  const { regionCategoryMatrix: cells, byRegion, byCategory, totalUsd } = insights;
  if (!cells.length) {
    return <p className="text-sm text-muted-foreground py-4">No regional breakdown available for this bill.</p>;
  }

  const topRegions = byRegion.slice(0, MAX_ROWS).map(r => r.key);
  const restRegions = byRegion.slice(MAX_ROWS).map(r => r.key);
  const topCats = byCategory.slice(0, MAX_COLS).map(c => c.key);
  const restCats = byCategory.slice(MAX_COLS).map(c => c.key);

  const restRegionLabel = `${restRegions.length} other region${restRegions.length === 1 ? "" : "s"}`;
  const restCatLabel = `${restCats.length} other categor${restCats.length === 1 ? "y" : "ies"}`;

  const rowLabels = [...topRegions, ...(restRegions.length ? [restRegionLabel] : [])];
  const colLabels = [...topCats, ...(restCats.length ? [restCatLabel] : [])];

  const lookup = new Map(cells.map(c => [`${c.region}|${c.category}`, c.costUsd]));
  const valueAt = (rowLabel: string, colLabel: string) => {
    const rs = rowLabel === restRegionLabel ? restRegions : [rowLabel];
    const cs = colLabel === restCatLabel ? restCats : [colLabel];
    let sum = 0;
    for (const r of rs) for (const c of cs) sum += lookup.get(`${r}|${c}`) ?? 0;
    return sum;
  };

  const grid = rowLabels.map(r => colLabels.map(c => valueAt(r, c)));
  const maxCell = Math.max(...grid.flat().map(Math.abs), 0);
  const hueFor = (c: string) => (c === restCatLabel ? "var(--cat-other)" : categoryColor(c));
  const gridSum = grid.flat().reduce((s, v) => s + v, 0);

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-[3px] text-[12px]">
          <thead>
            <tr>
              <th className="px-2 pb-1.5 text-left font-mono text-[9.5px] font-semibold uppercase tracking-wider text-muted-foreground">
                Region
              </th>
              {colLabels.map(c => (
                <th key={c} className="px-2 pb-1.5 text-right font-mono text-[9.5px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <span className="mr-1.5 inline-block h-2 w-2 rounded-[2px] align-middle" style={{ background: hueFor(c) }} />
                  {c}
                </th>
              ))}
              <th className="px-2 pb-1.5 text-right font-mono text-[9.5px] font-semibold uppercase tracking-wider text-muted-foreground">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {rowLabels.map((rl, ri) => (
              <tr key={rl} style={rl === restRegionLabel ? { opacity: 0.72 } : undefined}>
                <td className="py-2 pr-2 text-[12.5px] font-semibold">{rl}</td>
                {grid[ri].map((v, ci) => {
                  const strength = maxCell === 0 ? 0 : Math.abs(v) / maxCell;
                  const strong = strength > 0.6;
                  return (
                    <td
                      key={colLabels[ci]}
                      className="rounded px-2.5 py-2 text-right font-mono text-[11.5px] tabular-nums"
                      style={{
                        background: v === 0 ? "transparent"
                          : `color-mix(in srgb, ${hueFor(colLabels[ci])} ${Math.round(8 + 84 * strength)}%, transparent)`,
                        color: strong ? "var(--primary-foreground)" : undefined,
                        fontWeight: strong ? 700 : undefined,
                      }}
                    >
                      {Math.abs(v) >= 0.005 ? fmtUsd(v, { compact: true }) : "—"}
                    </td>
                  );
                })}
                <td className="px-2.5 py-2 text-right font-mono text-[11.5px] font-bold tabular-nums">
                  {fmtUsd(grid[ri].reduce((s, v) => s + v, 0), { compact: true })}
                </td>
              </tr>
            ))}
            <tr>
              <td className="border-t border-border pt-2.5 text-[12.5px] font-bold">Total</td>
              {colLabels.map((_, ci) => (
                <td key={ci} className="border-t border-border px-2.5 pt-2.5 text-right font-mono text-[11px] font-bold tabular-nums">
                  {fmtUsd(rowLabels.reduce((s, _r, ri) => s + grid[ri][ci], 0), { compact: true })}
                </td>
              ))}
              <td className="border-t border-border px-2.5 pt-2.5 text-right font-mono text-[11px] font-bold tabular-nums">
                {fmtUsd(gridSum, { compact: true })}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className="mt-3 border-t border-border/50 pt-2.5 font-mono text-[10px] leading-relaxed text-muted-foreground">
        {byRegion.length} region{byRegion.length === 1 ? "" : "s"} × {byCategory.length} categor
        {byCategory.length === 1 ? "y" : "ies"} in this bill
        {(restRegions.length > 0 || restCats.length > 0) && (
          <> · top {topRegions.length} regions and top {topCats.length} categories shown individually, the remainder folded into the aggregate row and column so nothing is dropped</>
        )}
        {" "}· grid sums to {fmtUsd(gridSum)} ({fmtPct(totalUsd === 0 ? 0 : gridSum / totalUsd)} of the bill)
      </p>
    </div>
  );
}
