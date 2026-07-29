/**
 * "What this bill can and cannot tell you", in plain English.
 *
 * Customers export whatever their console gives them, so a bill is routinely
 * partial - 9 of the 12 reference bills carry a Savings Plan discount whose
 * commitment fee sits on a different account. The platform states that and
 * moves on, rather than rendering an empty panel or asking for a document
 * the customer may not be able to produce.
 *
 * Every message is written to be shown to a customer verbatim.
 */
import type { DataNote } from "../../../../server/insights";

const STYLE: Record<DataNote["kind"], { border: string; label: string }> = {
  absent:  { border: "var(--muted-foreground)", label: "Not in this bill" },
  partial: { border: "var(--st-committed-2)",   label: "Partial view" },
  context: { border: "var(--cat-management)",   label: "Worth knowing" },
};

export default function DataNotes({
  notes,
  topic,
  exclude,
}: {
  notes: DataNote[];
  topic?: DataNote["topic"];
  /**
   * Topics already rendered inline beside the figure they qualify. Section 06
   * passes these so the same caveat is not printed twice on one page.
   */
  exclude?: readonly DataNote["topic"][];
}) {
  const shown = topic
    ? notes.filter(n => n.topic === topic)
    : exclude
      ? notes.filter(n => !exclude.includes(n.topic))
      : notes;
  if (!shown.length) return null;

  return (
    <div className="flex flex-col gap-2">
      {shown.map((n, i) => (
        <div
          key={`${n.topic}-${i}`}
          className="rounded-md border border-border bg-muted/40 px-4 py-3"
          style={{ borderLeftWidth: 3, borderLeftColor: STYLE[n.kind].border }}
        >
          <span className="mb-1 block font-mono text-[9.5px] font-bold uppercase tracking-wider text-muted-foreground">
            {STYLE[n.kind].label}
          </span>
          <p className="m-0 text-[12.5px] leading-relaxed">{n.message}</p>
        </div>
      ))}
    </div>
  );
}
