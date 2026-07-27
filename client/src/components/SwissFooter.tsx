/**
 * Shared site footer. Extracted from a page-local copy so all three routes
 * (Home, History, BillDetail) render an identical footer and pick up fixes
 * in one place. Kept plain (no repeated chevron mark) since the brand mark
 * already anchors the header -- repeating it in the footer read as clutter.
 */
export default function SwissFooter() {
  return (
    <footer className="glass-nav mt-auto">
      <div className="mx-auto max-w-7xl px-4 sm:px-8 py-6 flex items-center justify-between">
        <span className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
          AWS Bill to BOM Converter
        </span>
      </div>
    </footer>
  );
}
