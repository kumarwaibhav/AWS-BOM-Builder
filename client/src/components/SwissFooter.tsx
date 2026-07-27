/**
 * Shared site footer. Extracted from a page-local copy so all three routes
 * (Home, History, BillDetail) render an identical footer and pick up fixes
 * (chevron mark, dark mode, no em dashes) in one place.
 */
import ChevronMark from "./ChevronMark";

export default function SwissFooter() {
  return (
    <footer className="glass-nav mt-auto">
      <div className="mx-auto max-w-7xl px-4 sm:px-8 py-6 flex items-center justify-between">
        <span className="inline-flex items-center gap-2 text-xs font-mono uppercase tracking-widest text-muted-foreground">
          AWS Bill <ChevronMark size={11} /> BOM Converter
        </span>
        <ChevronMark size={14} />
      </div>
    </footer>
  );
}
