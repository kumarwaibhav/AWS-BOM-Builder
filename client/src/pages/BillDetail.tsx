/**
 * BillDetail: BOM table preview + Excel/PDF download for one converted bill.
 * No user accounts -- access is scoped by a server-issued signed httpOnly
 * session cookie (see server/_core/sessionCookie.ts), checked server-side.
 */
import { useState } from "react";
import { useParams, Link } from "wouter";
import { ArrowLeft, AlertTriangle, CheckCircle2, Download, FileText, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import SwissHeader from "@/components/SwissHeader";
import SwissFooter from "@/components/SwissFooter";
import BomTable from "@/components/BomTable";
import InsightsPanel from "@/components/insights/InsightsPanel";
import { trpc } from "@/lib/trpc";

type Tab = "items" | "insights";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white/70 dark:bg-black/30 p-4">
      <div className="text-[10px] font-mono uppercase tracking-[0.2em] text-muted-foreground">{label}</div>
      <div className="mt-1 font-bold text-sm sm:text-base break-all">{value}</div>
    </div>
  );
}

const usd = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2 });

export default function BillDetail() {
  const params = useParams<{ id: string }>();
  const billId = Number(params.id);

  const { data, isLoading, error } = trpc.bills.get.useQuery(
    { billId },
    { enabled: Number.isFinite(billId) }
  );
  const [tab, setTab] = useState<Tab>("items");

  // Only fetched once the tab is opened. The BOM table is what most visits
  // want, and there is no reason to make it wait on an aggregation it may
  // never display.
  const insightsQuery = trpc.bills.getInsights.useQuery(
    { billId },
    { enabled: tab === "insights" && Number.isFinite(billId) },
  );

  const downloadExcel = trpc.bills.downloadExcel.useMutation();
  const downloadPdf = trpc.bills.downloadPdf.useMutation();

  const triggerDownload = async (kind: "excel" | "pdf") => {
    try {
      const mut = kind === "excel" ? downloadExcel : downloadPdf;
      const { url } = await mut.mutateAsync({ billId });
      const a = document.createElement("a");
      a.href = url;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Download failed");
    }
  };

  const grandTotal = data?.bill.grandTotalUsd ? Number(data.bill.grandTotalUsd) : null;
  const calculatedTotal = data?.bill.calculatedTotalUsd ? Number(data.bill.calculatedTotalUsd) : null;
  // Summing hundreds of independently cent-rounded line items can drift a
  // few cents to a few dollars from AWS's own printed total on large bills
  // (AWS rounds internally at a different stage) -- verified against 10 real
  // bills via scripts/verify-bills.ts. A flat 1-cent tolerance flagged
  // completely correct bills as "worth a manual spot-check", so this uses
  // whichever is larger: 25 cents, or 0.05% of the bill.
  const reconcileTolerance = grandTotal !== null ? Math.max(0.25, grandTotal * 0.0005) : 0.01;
  const reconciles =
    grandTotal !== null &&
    calculatedTotal !== null &&
    Math.abs(grandTotal - calculatedTotal) < reconcileTolerance;

  return (
    <div className="min-h-screen flex flex-col">
      <div className="app-backdrop" aria-hidden="true" />
      <SwissHeader />
      <main className="flex-1">
        <div className="mx-auto max-w-7xl px-4 sm:px-8 py-10">
          <Link
            href="/history"
            className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-widest hover:text-primary mb-8">
            <ArrowLeft className="w-3.5 h-3.5" /> History
          </Link>

          {isLoading ? (
            <div className="flex items-center gap-3 py-24 justify-center text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin" />
              <span className="text-sm font-mono">Loading BOM...</span>
            </div>
          ) : error || !data ? (
            <div className="glass py-24 text-center text-sm text-muted-foreground">
              {error?.message || "Bill not found."}
            </div>
          ) : (
            <>
              <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-6 mb-8">
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-xs font-mono uppercase tracking-[0.25em] text-muted-foreground">
                      Bill of Materials
                    </span>
                  </div>
                  <h1 className="text-lg sm:text-2xl font-bold tracking-tight uppercase break-all">
                    {data.bill.fileName.replace(/\.pdf$/i, "")}
                  </h1>
                </div>
                <div className="flex gap-3 shrink-0">
                  <Button
                    variant="outline"
                    onClick={() => triggerDownload("pdf")}
                    disabled={downloadPdf.isPending}
                    className="rounded-none border-black uppercase tracking-widest text-xs font-bold h-12">
                    {downloadPdf.isPending ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <FileText className="w-4 h-4" />
                    )}
                    Original PDF
                  </Button>
                  <Button
                    onClick={() => triggerDownload("excel")}
                    disabled={downloadExcel.isPending || !data.bill.excelKey}
                    className="rounded-none bg-primary text-white hover:bg-black uppercase tracking-widest text-xs font-bold h-12 px-6">
                    {downloadExcel.isPending ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Download className="w-4 h-4" />
                    )}
                    Download Excel BOM
                  </Button>
                </div>
              </div>

              <div className="glass grid grid-cols-2 sm:grid-cols-4 gap-px overflow-hidden mb-6">
                <Stat label="Billing Period" value={data.bill.billingPeriod || "N/A"} />
                <Stat label="Account ID" value={data.bill.accountId || "N/A"} />
                <Stat label="Line Items" value={String(data.bill.itemCount)} />
                <Stat label="Grand Total (USD)" value={grandTotal !== null ? `$${usd(grandTotal)}` : "N/A"} />
              </div>

              {data.items.length === 0 && grandTotal !== null ? (
                <div className="mb-6 p-4 rounded-[var(--radius-glass)] border border-amber-600/40 bg-amber-50/60 dark:bg-amber-950/30">
                  <div className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
                    Reconciliation Check
                  </div>
                  <div className="mt-2 flex items-center gap-3">
                    <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                    <span className="text-sm font-semibold">
                      No line items found in this PDF.
                      <span className="font-normal text-muted-foreground">
                        {" "}
                        The bill states USD {usd(grandTotal)}, but this export has no itemized
                        "Charges by service" section to break down: often true of early
                        in-month estimate snapshots. Try re-exporting closer to month-end for
                        a fully itemized bill.
                      </span>
                    </span>
                  </div>
                </div>
              ) : (
                calculatedTotal !== null && (
                  <div
                    className={`mb-6 p-4 rounded-[var(--radius-glass)] border ${
                      reconciles
                        ? "border-emerald-600/30 bg-emerald-50/60 dark:bg-emerald-950/30"
                        : "border-amber-600/40 bg-amber-50/60 dark:bg-amber-950/30"
                    }`}>
                    <div className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
                      Reconciliation Check
                    </div>
                    <div className="mt-2 flex items-center gap-3">
                      {reconciles ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                      ) : (
                        <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                      )}
                      <span className="text-sm font-semibold">
                        Calculated Total: USD {usd(calculatedTotal)}
                        {grandTotal !== null && !reconciles && (
                          <span className="font-normal text-muted-foreground">
                            {" "}
                            (bill states USD {usd(grandTotal)}, diff USD {usd(Math.abs(grandTotal - calculatedTotal))}).
                            Parsing may have missed or misclassified a line: worth a manual spot-check.
                          </span>
                        )}
                      </span>
                    </div>
                  </div>
                )
              )}

              <div className="mb-5 flex border-b border-border">
                {([
                  ["items", "Line Items"],
                  ["insights", "Consumption Insights"],
                ] as const).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setTab(key)}
                    aria-selected={tab === key}
                    role="tab"
                    className={`mr-8 border-b-2 px-1 py-3.5 font-mono text-xs font-semibold uppercase tracking-[0.12em] transition-colors ${
                      tab === key
                        ? "border-primary text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground"
                    }`}>
                    {label}
                  </button>
                ))}
              </div>

              {tab === "items" ? (
                <>
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-xs font-mono uppercase tracking-[0.2em] text-muted-foreground">
                      {data.items.length} line items · chevron mark = AI-classified
                    </span>
                  </div>
                  <BomTable items={data.items} />
                </>
              ) : insightsQuery.isLoading ? (
                <div className="glass flex items-center justify-center gap-3 rounded-[var(--radius-glass)] p-12">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="text-sm text-muted-foreground">Analysing this bill…</span>
                </div>
              ) : insightsQuery.error ? (
                <div className="glass rounded-[var(--radius-glass)] p-8">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                    <div>
                      <p className="text-sm font-semibold">Could not analyse this bill.</p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {insightsQuery.error.message}
                      </p>
                      <Button
                        variant="outline"
                        onClick={() => insightsQuery.refetch()}
                        className="mt-4 h-10 rounded-none border-black text-xs font-bold uppercase tracking-widest">
                        Try again
                      </Button>
                    </div>
                  </div>
                </div>
              ) : insightsQuery.data ? (
                <InsightsPanel insights={insightsQuery.data.insights} />
              ) : null}
            </>
          )}
        </div>
      </main>
      <SwissFooter />
    </div>
  );
}
