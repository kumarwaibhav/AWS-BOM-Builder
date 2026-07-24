/**
 * BOM preview table with the EXACT required column headers.
 */
import type { BomItem } from "../../../drizzle/schema";

const HEADERS = [
  "S.No.",
  "AWS Region",
  "AWS Service Category",
  "AWS Service Name",
  "AWS Service Description/ Config",
  "AWS Qty",
  "AWS UOM",
  "AWS Billed Cost USD",
] as const;

function fmtQty(q: string | null): string {
  if (q === null || q === "") return "—";
  const n = Number(q);
  if (Number.isNaN(n)) return q ?? "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: 3 });
}

function fmtCost(c: string): string {
  const n = Number(c);
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function BomTable({ items }: { items: BomItem[] }) {
  const total = items.reduce((s, i) => s + Number(i.costUsd), 0);

  return (
    <div className="overflow-x-auto glass">
      <table className="w-full text-left text-xs sm:text-[13px] border-collapse">
        <thead>
          <tr className="bg-black text-white">
            {HEADERS.map(h => (
              <th
                key={h}
                className="px-3 py-2.5 font-semibold uppercase tracking-wider whitespace-nowrap border-r border-white/20 last:border-r-0">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map(item => (
            <tr
              key={item.id}
              className="border-b border-neutral-200 last:border-b-0 hover:bg-white/50 align-top">
              <td className="px-3 py-2 font-mono text-muted-foreground border-r border-neutral-200">
                {item.serialNo}
              </td>
              <td className="px-3 py-2 whitespace-nowrap border-r border-neutral-200">{item.region}</td>
              <td className="px-3 py-2 whitespace-nowrap border-r border-neutral-200">
                {item.serviceCategory}
                {item.llmEnriched === 1 && (
                  <span
                    className="ml-1.5 inline-block w-2 h-2 bg-primary align-middle"
                    title="Classified by AI enrichment"
                  />
                )}
              </td>
              <td className="px-3 py-2 border-r border-neutral-200">{item.serviceName}</td>
              <td className="px-3 py-2 border-r border-neutral-200 max-w-[420px]">{item.description}</td>
              <td className="px-3 py-2 text-right font-mono whitespace-nowrap border-r border-neutral-200">
                {fmtQty(item.quantity)}
              </td>
              <td className="px-3 py-2 whitespace-nowrap border-r border-neutral-200">{item.uom || "—"}</td>
              <td
                className={`px-3 py-2 text-right font-mono whitespace-nowrap ${
                  Number(item.costUsd) < 0 ? "text-primary" : ""
                }`}>
                {fmtCost(item.costUsd)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-black bg-white/60">
            <td colSpan={7} className="px-3 py-2.5 font-bold uppercase tracking-widest text-right">
              Total (pre-tax)
            </td>
            <td className="px-3 py-2.5 text-right font-mono font-bold">
              {total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

