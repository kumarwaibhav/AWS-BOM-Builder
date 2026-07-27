/**
 * Home: upload an AWS billing PDF and convert it to an Excel BOM.
 * Swiss-glass: International Typographic Style grid/type discipline,
 * rendered through red/white frosted-glass panels. No authentication,
 * anonymous access via a client-generated sessionId.
 */
import { useCallback, useRef, useState } from "react";
import { useLocation } from "wouter";
import { FileText, Loader2, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import SwissHeader from "@/components/SwissHeader";
import SwissFooter from "@/components/SwissFooter";
import ChevronMark from "@/components/ChevronMark";
import { trpc } from "@/lib/trpc";
import { useSessionId } from "@/hooks/useSessionId";

const STEPS = [
  { n: "01", t: "Upload", d: "Drop your AWS Bills PDF export (Billing & Cost Management, Bills)." },
  { n: "02", t: "Parse", d: "Every service, region, and usage line is extracted: EC2, RDS, S3, NAT Gateway, Marketplace, and more." },
  { n: "03", t: "Enrich", d: "AI classifies ambiguous items and completes missing service categories." },
  { n: "04", t: "Download", d: "A structured Excel BOM with your exact 8 columns, stored for re-download anytime." },
];

const BOM_COLUMNS = ["S.No.", "Region", "Category", "Service", "Config", "Qty", "UOM", "Cost USD"];

export default function Home() {
  const sessionId = useSessionId();
  const [, navigate] = useLocation();
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [phase, setPhase] = useState<"idle" | "processing">("idle");
  const inputRef = useRef<HTMLInputElement>(null);

  const upload = trpc.bills.uploadAndParse.useMutation();
  const utils = trpc.useUtils();

  const acceptFile = useCallback((f: File | undefined | null) => {
    if (!f) return;
    if (!f.name.toLowerCase().endsWith(".pdf") && f.type !== "application/pdf") {
      toast.error("Please select a PDF file");
      return;
    }
    if (f.size > 25 * 1024 * 1024) {
      toast.error("PDF exceeds the 25 MB limit");
      return;
    }
    setFile(f);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      acceptFile(e.dataTransfer.files?.[0]);
    },
    [acceptFile]
  );

  const convert = async () => {
    if (!file || !sessionId) return;
    setPhase("processing");
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const res = await upload.mutateAsync({ fileName: file.name, base64, sessionId });
      utils.bills.list.invalidate();
      toast.success(`Extracted ${res.itemCount} line items`);
      navigate(`/bill/${res.billId}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Conversion failed");
      setPhase("idle");
    }
  };

  return (
    <div className="min-h-screen flex flex-col">
      <div className="app-backdrop" aria-hidden="true" />
      <SwissHeader />

      <main className="flex-1">
        {/* Hero: asymmetric grid, glass panels floating over the backdrop */}
        <section className="mx-auto max-w-7xl px-4 sm:px-8 py-10 sm:py-16 grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-7 glass p-8 sm:p-12">
            <div className="flex items-center gap-2 mb-8">
              <span className="inline-flex items-center gap-2 text-xs font-mono uppercase tracking-[0.25em] text-muted-foreground">
                Billing <ChevronMark size={11} /> Bill of Materials
              </span>
            </div>
            <h1 className="text-4xl sm:text-6xl font-black tracking-tighter leading-[0.95] uppercase">
              AWS Bill
              <br />
              <span className="text-primary">to Excel BOM.</span>
            </h1>
            <p className="mt-8 max-w-lg text-base sm:text-lg text-neutral-600 dark:text-neutral-400 leading-relaxed">
              Upload any AWS consumption bill PDF. Every billed line item is
              parsed, classified, and structured into a precise Excel Bill of
              Materials: region, service, configuration, quantity, unit, and
              cost.
            </p>
            <div className="mt-10 grid grid-cols-4 gap-px bg-[var(--glass-border-strong)] border border-[var(--glass-border-strong)] max-w-md rounded-[var(--radius-glass)] overflow-hidden">
              {BOM_COLUMNS.map(c => (
                <div key={c} className="bg-white/70 dark:bg-black/30 px-2 py-2 text-[10px] font-mono uppercase tracking-wider text-center">
                  {c}
                </div>
              ))}
            </div>
          </div>

          {/* Upload panel */}
          <div className="lg:col-span-5 glass p-8 sm:p-10 flex flex-col">
            <div className="text-xs font-mono uppercase tracking-[0.25em] text-muted-foreground mb-4">
              Input / PDF
            </div>
            <div
              role="button"
              tabIndex={0}
              aria-label="Upload AWS bill PDF"
              onClick={() => inputRef.current?.click()}
              onKeyDown={e => e.key === "Enter" && inputRef.current?.click()}
              onDragOver={e => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              className={`relative border-2 border-dashed rounded-[var(--radius-glass)] p-10 sm:p-12 text-center transition-colors duration-200 ${
                dragOver ? "glass-red border-primary" : "border-[var(--glass-border-strong)] hover:bg-white/40 dark:hover:bg-white/5"
              }`}>
              <input
                ref={inputRef}
                type="file"
                accept=".pdf,application/pdf"
                className="hidden"
                onChange={e => acceptFile(e.target.files?.[0])}
              />
              {file ? (
                <div className="flex flex-col items-center gap-3">
                  <FileText className="w-10 h-10 text-primary" strokeWidth={1.5} />
                  <div className="font-semibold text-sm break-all">{file.name}</div>
                  <div className="text-xs font-mono text-muted-foreground">
                    {(file.size / 1024 / 1024).toFixed(2)} MB
                  </div>
                  <button
                    className="inline-flex items-center gap-1 text-xs uppercase tracking-widest text-muted-foreground hover:text-primary"
                    onClick={e => {
                      e.stopPropagation();
                      setFile(null);
                    }}>
                    <X className="w-3 h-3" /> Remove
                  </button>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-4">
                  <Upload className="w-10 h-10" strokeWidth={1.25} />
                  <div className="font-semibold text-sm uppercase tracking-widest">
                    Drop AWS bill PDF here
                  </div>
                  <div className="text-xs text-muted-foreground">or click to browse, max 25 MB</div>
                </div>
              )}
            </div>

            <Button
              disabled={!file || phase === "processing" || !sessionId}
              onClick={convert}
              className="mt-6 w-full rounded-none h-14 bg-black text-white hover:bg-primary dark:bg-white dark:text-black dark:hover:bg-primary dark:hover:text-white text-sm font-bold uppercase tracking-[0.2em] transition-colors duration-200 shadow-[0_12px_24px_-8px_rgba(0,0,0,0.35)]">
              {phase === "processing" ? (
                <span className="flex items-center gap-3">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Parsing, Enriching, Generating...
                </span>
              ) : (
                "Convert to Excel BOM"
              )}
            </Button>
            {phase === "processing" && (
              <p className="mt-3 text-xs text-muted-foreground font-mono text-center">
                Large bills take up to a minute. AI enrichment in progress.
              </p>
            )}
            <p className="mt-3 text-xs text-muted-foreground text-center">
              Your bills are processed securely and stored temporarily for re-download.
            </p>
          </div>
        </section>

        {/* Process steps */}
        <section className="mx-auto max-w-7xl px-4 sm:px-8 pb-16">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {STEPS.map(s => (
              <div key={s.n} className="glass p-6 min-h-[180px] flex flex-col">
                <div className="flex items-center justify-between mb-6">
                  <span className="font-mono text-xs text-muted-foreground">{s.n}</span>
                  <ChevronMark size={13} />
                </div>
                <h3 className="font-black uppercase tracking-tight text-lg">{s.t}</h3>
                <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400 leading-relaxed">{s.d}</p>
              </div>
            ))}
          </div>
        </section>
      </main>

      <SwissFooter />
    </div>
  );
}
