/**
 * BillDetail: BOM table preview + Excel/PDF download for one converted bill.
 * No authentication required, anonymous access via sessionId.
 */
import { useParams, Link } from "wouter";
import { ArrowLeft, AlertTriangle, CheckCircle2, Download, FileText, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import SwissHeader from "@/components/SwissHeader";
import SwissFooter from "@/components/SwissFooter";
import BomTable from "@/components/BomTable";
import { trpc } from "@/lib/trpc";
import { useSessionId } from "@/hooks/useSessionId";

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
  const sessionId = useSessionId();
  const params = useParams<{ id: string }>();
  const billId = Number(params.id);

  const { data, isLoading, error } = trpc.bills.get.useQuery(
    { billId, sessionId },
    { enabled: !!sessionId && Number.isFinite(billId) }
  );
  const downloadExcel = trpc.bills.downloadExcel.useMutation();
  const downloadPdf = trpc.bills.downloadPdf.useMutation();

  const triggerDownload = async (kind: "excel" | "pdf") => {
    try {
      const mut = kind === "excel" ? downloadExcel : downloadPdf;
      const { url } = await mut.mutateAsync({ billId, sessionId });
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
  const reconciles =
    grandTotal !== null && calculatedTotal !== null && Math.abs(grandTotal - calculatedTotal) < 0.01;

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
                  <h1 className="text-2xl sm:text-4xl font-black tracking-tighter uppercase break-all">
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
                <Stat label="Grand Total (USD)" value={grandTotal !== null ? usd(grandTotal) : "N/A"} />
              </div>

              {calculatedTotal !== null && (
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
              )}

              <div className="flex items-center gap-2 mb-3">
                <span className="text-xs font-mono uppercase tracking-[0.2em] text-muted-foreground">
                  {data.items.length} line items · chevron mark = AI-classified
                </span>
              </div>
              <BomTable items={data.items} />
            </>
          )}
        </div>
      </main>
      <SwissFooter />
    </div>
  );
}
