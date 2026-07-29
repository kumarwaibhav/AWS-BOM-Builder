/**
 * The Consumption Insights tab.
 *
 * Assembles the panels in the order a presales conversation actually runs:
 * what the bill is -> what you pay for -> what's running -> where it runs ->
 * how it's priced -> what stands out. Pricing sits late deliberately; it is
 * the sharpest section and lands better once the composition is understood.
 *
 * Every panel degrades to a sentence rather than an empty chart. Nine of the
 * twelve reference bills are partial in some way, so that path is the normal
 * one, not the exception.
 */
import type { BillInsights } from "../../../../server/insights";
import { categoryColor, fmtUsd, fmtPct } from "./tokens";
import CategoryKey from "./CategoryKey";
import CompositionAccordion from "./CompositionAccordion";
import RankedList from "./RankedList";
import CoverageBar from "./CoverageBar";
import RateTable from "./RateTable";
import RegionCategoryMatrix from "./RegionCategoryMatrix";
import DataNotes from "./DataNotes";

function Section({
  n, title, blurb, children,
}: { n: string; title: string; blurb: string; children: React.ReactNode }) {
  return (
    <section className="mb-12">
      <div className="mb-4">
        <div className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-primary">Section {n}</div>
        <h2 className="mt-1.5 text-xl font-bold tracking-tight">{title}</h2>
        <p className="mt-1.5 max-w-3xl text-[13px] leading-relaxed text-muted-foreground">{blurb}</p>
      </div>
      {children}
    </section>
  );
}

function Panel({ title, blurb, children }: { title: string; blurb?: string; children: React.ReactNode }) {
  return (
    <div className="glass rounded-[var(--radius-glass)] p-5">
      <h3 className="text-[13px] font-bold uppercase tracking-wider">{title}</h3>
      {blurb && <p className="mb-4 mt-1 text-xs leading-relaxed text-muted-foreground">{blurb}</p>}
      {!blurb && <div className="mb-4" />}
      {children}
    </div>
  );
}

function Kpi({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent: string }) {
  return (
    <div className="glass rounded-[var(--radius-glass)] p-4" style={{ borderTop: `3px solid ${accent}` }}>
      <div className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-muted-foreground">{label}</div>
      <div className="mt-2 text-2xl font-black leading-none tracking-tight" style={{ color: accent }}>{value}</div>
      {sub && <div className="mt-2 text-xs leading-relaxed text-muted-foreground">{sub}</div>}
    </div>
  );
}

export default function InsightsPanel({ insights }: { insights: BillInsights }) {
  const ins = insights;

  if (ins.lineCount === 0) {
    return (
      <div className="glass rounded-[var(--radius-glass)] p-8 text-center">
        <p className="text-sm text-muted-foreground">
          This bill has no line items, so there is nothing to analyse. The reconciliation notice
          above explains why.
        </p>
      </div>
    );
  }

  const topCat = ins.byCategory[0];
  const topRegion = ins.byRegion[0];
  const c = ins.commitment;
  const instanceTotal = ins.byInstanceType.reduce((s, r) => s + r.costUsd, 0);

  return (
    <div>
      {/* 01 --------------------------------------------------------------- */}
      <Section
        n="01"
        title="The numbers that matter"
        blurb="Everything below is calculated from the line items of this bill. Nothing is estimated, benchmarked or extrapolated."
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Kpi
            label="Total consumption"
            value={fmtUsd(ins.totalUsd, { compact: true })}
            sub={`${ins.lineCount.toLocaleString()} line items across ${ins.categoryCount} categories and ${ins.regionCount} regions.`}
            accent="var(--primary)"
          />
          {topCat && (
            <Kpi
              label="Biggest cost driver"
              value={fmtPct(topCat.share)}
              sub={`${topCat.key} is ${fmtUsd(topCat.costUsd, { compact: true })} — the largest category on this bill.`}
              accent={categoryColor(topCat.key)}
            />
          )}
          {topRegion && (
            <Kpi
              label="Largest region"
              value={fmtPct(topRegion.share)}
              sub={`${topRegion.key} carries ${fmtUsd(topRegion.costUsd, { compact: true })}.`}
              accent="var(--cat-management)"
            />
          )}
          <Kpi
            label={c.hasNoCommitment ? "Commitment coverage" : "On-demand usage covered"}
            value={c.grossOnDemandUsd === 0 ? "N/A" : fmtPct(c.coverageOfOnDemand)}
            sub={
              c.hasNoCommitment
                ? "No Savings Plan, Reserved Instance or Spot usage on this bill."
                : `${fmtUsd(c.savingsPlanCreditsUsd, { compact: true })} of ${fmtUsd(c.grossOnDemandUsd, { compact: true })} on-demand-priced usage carries a discount.`
            }
            accent={c.hasNoCommitment ? "var(--muted-foreground)" : "var(--st-committed)"}
          />
        </div>

        {ins.creditsUsd > 0 && (
          <p className="mt-4 font-mono text-[11px] text-muted-foreground">
            {fmtUsd(ins.grossChargesUsd)} of charges less {fmtUsd(ins.creditsUsd)} of credits ={" "}
            {fmtUsd(ins.totalUsd)} net.
          </p>
        )}
      </Section>

      {/* 02 --------------------------------------------------------------- */}
      <Section
        n="02"
        title="What are you paying for?"
        blurb="Every dollar grouped by service category, then by the services inside it. Each category has its own colour, and that colour identifies it everywhere else on this page."
      >
        <div className="mb-4"><CategoryKey categories={ins.byCategory} /></div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.5fr_1fr]">
          <Panel title="Bill composition" blurb="Click a category to see the services inside it. Every service is listed.">
            <CompositionAccordion
              categories={ins.byCategory}
              servicesFor={cat => ins.servicesByCategory[cat] ?? []}
              total={ins.totalUsd}
            />
          </Panel>
          <Panel title="Biggest single charges" blurb="The individual line items costing the most.">
            <RankedList
              limit={10}
              rows={ins.topLineItems.map(i => ({
                key: i.serviceName.replace(/^Amazon |^AWS /, ""),
                sub: i.region,
                costUsd: i.costUsd,
                share: i.share,
                color: categoryColor(i.serviceCategory),
              }))}
            />
          </Panel>
        </div>
      </Section>

      {/* 03 --------------------------------------------------------------- */}
      <Section
        n="03"
        title="What's actually running?"
        blurb="The inventory behind the bill. Each panel is filled in its own category colour, so you always know which part of the spend you are looking at. Hardware generation is a badge, never a bar colour."
      >
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Panel title="Machine types" blurb="Instance spend by type.">
            <RankedList
              hue="var(--cat-compute)"
              rows={ins.byInstanceType.map(r => ({
                key: r.key,
                costUsd: r.costUsd,
                share: r.share,
                badge: (ins.machineRates.find(m => m.instanceType === r.key)?.generation) as
                  "Current" | "Previous" | "Legacy" | undefined,
              }))}
              emptyMessage="This bill has no named machine types — its charges are all usage-based."
            />
          </Panel>
          <Panel title="Storage classes" blurb="Storage spend by volume or tier type.">
            <RankedList
              hue="var(--cat-storage)"
              rows={ins.byStorageClass}
              emptyMessage="No storage charges appear on this bill."
            />
          </Panel>
          <Panel title="Database engines" blurb="Database spend by engine.">
            <RankedList
              hue="var(--cat-database)"
              rows={ins.byDbEngine}
              emptyMessage="No managed database charges appear on this bill."
            />
          </Panel>
        </div>
        <div className="mt-4"><DataNotes notes={ins.notes} topic="machines" /></div>
      </Section>

      {/* 04 --------------------------------------------------------------- */}
      <Section
        n="04"
        title="Where does it all run?"
        blurb="Region and category together. This grid is the direct input for apples-to-apples pricing against another cloud, since target rates differ by region."
      >
        <Panel title="Region × category">
          <RegionCategoryMatrix insights={ins} />
        </Panel>
        <div className="mt-4"><DataNotes notes={ins.notes} topic="regions" /></div>
      </Section>

      {/* 05 --------------------------------------------------------------- */}
      <Section
        n="05"
        title="How is this consumption priced?"
        blurb="Read directly off the bill: observed rates and observed splits. No projections, no benchmarks, no recommendations."
      >
        <div className="mb-4">
          <Panel
            title="Pricing model coverage"
            blurb="How much on-demand-priced usage carries a discount. AWS bills covered usage at full price and credits it back separately, so coverage is measured against gross on-demand usage, not net spend."
          >
            <CoverageBar commitment={c} />
            <div className="mt-4"><DataNotes notes={ins.notes} topic="commitment" /></div>
          </Panel>
        </div>
        <Panel
          title="Observed rate per machine, per region"
          blurb="Effective hourly rate actually paid — total cost divided by total hours. Where a machine was billed under more than one pricing model, each model's own observed rate is shown beside the blend."
        >
          <RateTable rates={ins.machineRates} />
        </Panel>
      </Section>

      {/* 06 --------------------------------------------------------------- */}
      <Section
        n="06"
        title="What this bill can and cannot tell you"
        blurb="Bills are routinely partial — customers export whatever their console gives them. These notes state plainly what is visible here and what is not."
      >
        <DataNotes notes={ins.notes} />
        {ins.notes.length === 0 && (
          <p className="text-sm text-muted-foreground">
            This bill is complete: every figure on this page is derived from itemised charges with
            nothing missing.
          </p>
        )}
        <p className="mt-6 font-mono text-[10px] leading-relaxed text-muted-foreground">
          {ins.lineCount.toLocaleString()} line items · {ins.categoryCount} categories ·{" "}
          {ins.regionCount} regions · {ins.machineRates.length} machine/region rates ·{" "}
          {instanceTotal > 0 && ins.totalUsd > 0
            ? `named machine types are ${fmtPct(instanceTotal / ins.totalUsd)} of this bill · `
            : ""}
          every panel above reconciles to {fmtUsd(ins.totalUsd)}
        </p>
      </Section>
    </div>
  );
}
