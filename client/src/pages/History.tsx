/**
 * History: all previously converted bills with re-download from S3.
 * No user accounts -- access is scoped by a server-issued signed httpOnly
 * session cookie (see server/_core/sessionCookie.ts), checked server-side.
 */
import { useState } from "react";
import { Link } from "wouter";
import { Download, FileText, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import SwissHeader from "@/components/SwissHeader";
import SwissFooter from "@/components/SwissFooter";
import { trpc } from "@/lib/trpc";

export default function History() {
  const { data: bills, isLoading } = trpc.bills.list.useQuery();
  const utils = trpc.useUtils();
  const downloadExcel = trpc.bills.downloadExcel.useMutation();
  const downloadPdfMut = trpc.bills.downloadPdf.useMutation();
  const remove = trpc.bills.remove.useMutation({
    onMutate: async ({ billId }) => {
      await utils.bills.list.cancel();
      const prev = utils.bills.list.getData();
      utils.bills.list.setData(undefined, old => old?.filter(b => b.id !== billId));
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      utils.bills.list.setData(undefined, ctx?.prev);
      toast.error("Failed to delete");
    },
    onSettled: () => utils.bills.list.invalidate(),
  });


  const download = async (billId: number) => {
    try {
      const { url } = await downloadExcel.mutateAsync({ billId });
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

  const downloadPdf = async (billId: number) => {
    try {
      const { url } = await downloadPdfMut.mutateAsync({ billId });
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

  return (
    <div className="min-h-screen flex flex-col">
      <div className="app-backdrop" aria-hidden="true" />
      <SwissHeader />
      <main className="flex-1">
        <div className="mx-auto max-w-7xl px-4 sm:px-8 py-10">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-xs font-mono uppercase tracking-[0.25em] text-muted-foreground">
              Archive
            </span>
          </div>
          <h1 className="text-3xl sm:text-5xl font-black tracking-tighter uppercase mb-10">
            Upload History
          </h1>

          {isLoading ? (
            <div className="flex items-center gap-3 py-24 justify-center text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin" />
              <span className="text-sm font-mono">Loading history...</span>
            </div>
          ) : !bills || bills.length === 0 ? (
            <div className="glass p-16 text-center">
              <FileText className="w-10 h-10 mx-auto mb-4" strokeWidth={1.25} />
              <p className="text-sm text-muted-foreground mb-6">
                No bills converted yet. Upload your first AWS bill PDF.
              </p>
              <Link href="/">
                <Button className="rounded-none bg-black text-white hover:bg-primary dark:bg-white dark:text-black uppercase tracking-widest text-xs font-bold">
                  Convert a bill
                </Button>
              </Link>
            </div>
          ) : (
            <div className="glass divide-y divide-[var(--glass-border)] overflow-hidden">
              {bills.map(bill => (
                <div
                  key={bill.id}
                  className="grid grid-cols-1 md:grid-cols-12 gap-4 p-5 items-center hover:bg-white/40 dark:hover:bg-white/5 transition-colors">
                  <div className="md:col-span-5 min-w-0">
                    {bill.status === "completed" ? (
                      <Link
                        href={`/bill/${bill.id}`}
                        className="font-bold text-sm hover:text-primary break-all">
                        {bill.fileName}
                      </Link>
                    ) : (
                      <span className="font-bold text-sm break-all">{bill.fileName}</span>
                    )}
                    <div className="text-xs font-mono text-muted-foreground mt-1">
                      {new Date(bill.createdAt).toLocaleString()} · {bill.billingPeriod || "N/A"}
                    </div>
                    {bill.status === "failed" && (
                      <div className="text-xs text-primary mt-1">{bill.errorMessage}</div>
                    )}
                  </div>
                  <div className="md:col-span-2 text-xs font-mono">
                    {bill.status === "completed" ? (
                      <span>{bill.itemCount} items</span>
                    ) : (
                      <span className="uppercase tracking-widest text-primary font-bold">{bill.status}</span>
                    )}
                  </div>
                  <div className="md:col-span-2 text-sm font-mono">
                    {bill.grandTotalUsd
                      ? `USD ${Number(bill.grandTotalUsd).toLocaleString("en-US", { minimumFractionDigits: 2 })}`
                      : "N/A"}
                  </div>
                  <div className="md:col-span-3 flex gap-2 md:justify-end">
                    {bill.status === "completed" && (
                      <>
                        <Link href={`/bill/${bill.id}`}>
                          <Button
                            variant="outline"
                            size="sm"
                            className="rounded-none border-black text-xs uppercase tracking-widest font-semibold">
                            View
                          </Button>
                        </Link>
                        <Button
                          size="sm"
                          onClick={() => download(bill.id)}
                          className="rounded-none bg-primary text-white hover:bg-black text-xs uppercase tracking-widest font-semibold">
                          <Download className="w-3.5 h-3.5" /> Excel
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => downloadPdf(bill.id)}
                          className="rounded-none border-black text-xs uppercase tracking-widest font-semibold hover:bg-black hover:text-white">
                          PDF
                        </Button>
                      </>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => remove.mutate({ billId: bill.id })}
                      className="rounded-none border-black text-xs hover:bg-primary hover:text-white hover:border-primary"
                      aria-label="Delete bill">
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
      <SwissFooter />
    </div>
  );
}
