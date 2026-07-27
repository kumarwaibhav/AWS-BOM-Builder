/**
 * BOM preview table with the EXACT required column headers.
 */
import type { BomItem } from "../../../drizzle/schema";
import ChevronMark from "./ChevronMark";

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
  if (q === null || q === "") return "N/A";
  const n = Number(q);
  if (Number.isNaN(n)) return q ?? "N/A";
  return n.toLocaleString("en-US", { maximumFractionDigits: 3 });
}

function fmtCost(c: string): string {
  const n = Number(c);
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Fixed percentage widths so the table always fits its container -- no
// horizontal scroll needed to see the last column (AWS Billed Cost USD),
// which is exactly what "table-layout: auto" (the default) doesn't
// guarantee: it sizes each column to its widest content, and with 8
// columns of real bill data that total reliably exceeds the viewport,
// leaving the last column(s) cut off. table-fixed + these <col> widths
// pin the total to 100% instead; longer text wraps within its column
// rather than pushing the table wider.
const COLUMN_WIDTHS = ["4%", "10%", "13%", "12%", "37%", "7%", "6%", "11%"] as const;

export default function BomTable({ items }: { items: BomItem[] }) {
  const total = items.reduce((s, i) => s + Number(i.costUsd), 0);

  return (
    <div className="overflow-x-auto glass">
      <table className="w-full table-fixed text-left text-xs sm:text-[13px] border-collapse">
        <colgroup>
          {COLUMN_WIDTHS.map((w, i) => (
            <col key={i} style={{ width: w }} />
          ))}
        </colgroup>
        <thead>
          <tr className="bg-black text-white dark:bg-white dark:text-black">
            {HEADERS.map(h => (
              <th
                key={h}
                className="px-3 py-2.5 font-semibold uppercase tracking-wider border-r border-white/20 dark:border-black/20 last:border-r-0">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map(item => (
            <tr
              key={item.id}
              className="border-b border-neutral-200 dark:border-white/10 last:border-b-0 hover:bg-white/50 dark:hover:bg-white/5 align-top">
              <td className="px-3 py-2 font-mono text-muted-foreground border-r border-neutral-200 dark:border-white/10">
                {item.serialNo}
              </td>
              <td className="px-3 py-2 break-words border-r border-neutral-200 dark:border-white/10">{item.region}</td>
              <td className="px-3 py-2 break-words border-r border-neutral-200 dark:border-white/10">
                {item.serviceCategory}
                {item.llmEnriched === 1 && (
                  <ChevronMark
                    size={9}
                    className="ml-1.5 align-middle"
                    title="Classified by AI enrichment"
                  />
                )}
              </td>
              <td className="px-3 py-2 break-words border-r border-neutral-200 dark:border-white/10">{item.serviceName}</td>
              <td className="px-3 py-2 break-words border-r border-neutral-200 dark:border-white/10">{item.description}</td>
              <td className="px-3 py-2 text-right font-mono whitespace-nowrap border-r border-neutral-200 dark:border-white/10">
                {fmtQty(item.quantity)}
              </td>
              <td className="px-3 py-2 break-words border-r border-neutral-200 dark:border-white/10">{item.uom || "N/A"}</td>
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
          <tr className="border-t-2 border-black dark:border-white bg-white/60 dark:bg-black/40">
            <td colSpan={7} className="px-3 py-2.5 font-bold uppercase tracking-widest text-right">
              Total (pre-tax)
            </td>
            <td className="px-3 py-2.5 text-right font-mono font-bold">
              ${total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
