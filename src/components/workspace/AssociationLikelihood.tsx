import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Sparkles } from "lucide-react";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import type { ReviewAdjustment } from "@/lib/intel";
import {
  associationLabel,
  scoreAssociations,
  type AssociationScore,
} from "@/lib/association-score";
import { cn } from "@/lib/utils";

/**
 * Stage 1 of association likelihood: a READ-ONLY measurement display. Off by
 * default; `VITE_ASSOCIATION_LIKELIHOOD=1` turns it on. When off, nothing here
 * renders and `scoreAssociations` is never called.
 */
export const ASSOCIATION_LIKELIHOOD_ENABLED = import.meta.env.VITE_ASSOCIATION_LIKELIHOOD === "1";

const SCORED_LIMIT = 12;
const WITHHELD_LIMIT = 20;
const SHOWN_BANDS = new Set(["strong", "likely", "possible"]);

/**
 * The ASSOCIATION LIKELIHOOD register in Connections. Register (DESIGN.md): a
 * likelihood is something the system concluded, so it takes the inference axis
 * (Inference Violet, hollow dashed chip), never the filled authority chip a
 * Verified row wears. It never says "confirmed", and offers no action that
 * links, merges or promotes anything.
 */
export function AssociationLikelihood({
  items,
  seedValue,
  reviews,
}: {
  items: Artifact[];
  seedValue: string | null;
  reviews: Record<string, ReviewAdjustment>;
}) {
  const report = useMemo(() => scoreAssociations(items, seedValue, reviews), [items, seedValue, reviews]);
  const scored = report.pairs.filter((p) => p.score !== null && SHOWN_BANDS.has(p.band));
  const withheld = report.pairs.filter((p) => p.band === "withheld");
  const [showWithheld, setShowWithheld] = useState(false);

  return (
    <section aria-label="Association likelihood" className="border-t border-border-subtle px-3.5 py-3" data-association-likelihood>
      <h3 className="px-1.5 pb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-foreground">Association likelihood</h3>
      <p className="px-1.5 pb-2 font-mono text-[11px] tabular-nums text-muted-foreground" data-association-summary>
        {report.stats.scoredPairs} scored pair{report.stats.scoredPairs === 1 ? "" : "s"} · {report.stats.withheld} withheld · {report.stats.excluded} analyst-excluded
      </p>
      {scored.length === 0 ? (
        <p className="px-1.5 py-1 text-[12px] text-muted-foreground">No selector pair reaches the possible band yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5 px-1.5">
          {scored.slice(0, SCORED_LIMIT).map((p) => <PairRow key={`${p.a}|${p.b}`} pair={p} />)}
        </ul>
      )}
      {scored.length > SCORED_LIMIT && (
        <p className="px-1.5 pt-1 text-[11px] text-subtle-foreground">+{scored.length - SCORED_LIMIT} more scored pairs not shown.</p>
      )}

      {withheld.length > 0 && (
        <div className="px-1.5 pt-2">
          <button
            type="button"
            onClick={() => setShowWithheld((v) => !v)}
            aria-expanded={showWithheld}
            className="flex items-center gap-1 rounded text-[11px] text-subtle-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {showWithheld ? <ChevronDown className="h-3 w-3" aria-hidden /> : <ChevronRight className="h-3 w-3" aria-hidden />}
            Withheld — linkage unproven <span className="font-mono tabular-nums">{withheld.length}</span>
          </button>
          {showWithheld && (
            <ul className="mt-1 flex flex-col gap-0.5" data-association-withheld>
              {withheld.slice(0, WITHHELD_LIMIT).map((p) => (
                <li key={`${p.a}|${p.b}`} className="break-words font-mono text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
                  {p.aValue} · {p.bValue}
                </li>
              ))}
              {withheld.length > WITHHELD_LIMIT && (
                <li className="text-[11px] text-subtle-foreground">+{withheld.length - WITHHELD_LIMIT} more</li>
              )}
            </ul>
          )}
        </div>
      )}

      <p className="px-1.5 pt-2 text-[11px] leading-relaxed text-faint-foreground">
        A measurement from this case&apos;s own rows: selectors seen together, counted once per independent source class, with agreeing and conflicting attributes. It changes no review, readiness, quarantine or report.
      </p>
    </section>
  );
}

function PairRow({ pair }: { pair: AssociationScore }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-[5px] border border-border bg-surface-1/60 p-2 text-[12px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full min-w-0 flex-col items-start gap-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span
          className="inline-flex items-center gap-1 rounded-[4px] border border-dashed border-[hsl(var(--intel-violet)/0.7)] px-1.5 py-0.5 text-[11px] text-[hsl(var(--intel-violet))]"
          title="Measured from the case's own rows. Not an analyst decision."
          data-likelihood-band={pair.band}
        >
          <Sparkles className="h-3 w-3 shrink-0" aria-hidden />
          {associationLabel(pair)}
        </span>
        <span className="flex w-full min-w-0 items-baseline gap-1.5 font-mono text-foreground">
          <span className="min-w-0 break-words [overflow-wrap:anywhere]">{pair.aValue}</span>
          <span className="shrink-0 text-subtle-foreground" aria-hidden>↔</span>
          <span className="min-w-0 break-words [overflow-wrap:anywhere]">{pair.bValue}</span>
        </span>
      </button>
      {open && (
        <ul className={cn("mt-1.5 flex flex-col gap-0.5 border-t border-border-subtle pt-1.5 text-[11px] leading-snug")}>
          {pair.reasons.map((r) => <li key={r} className="text-muted-foreground">{r}</li>)}
          {pair.opposing.map((r) => <li key={r} className="text-[hsl(var(--warning))]">Against: {r}</li>)}
        </ul>
      )}
    </li>
  );
}

/** The Overview's compact "Likely links: N" chip. Render only behind the flag. */
export function LikelyLinksChip({
  items,
  seedValue,
  reviews,
}: {
  items: Artifact[];
  seedValue: string | null;
  reviews: Record<string, ReviewAdjustment>;
}) {
  const n = useMemo(
    () => scoreAssociations(items, seedValue, reviews).pairs.filter((p) => p.band === "likely" || p.band === "strong").length,
    [items, seedValue, reviews],
  );
  return (
    <span
      className="inline-flex items-center gap-1 rounded-[4px] border border-dashed border-[hsl(var(--intel-violet)/0.7)] px-1.5 py-0.5 text-[11px] text-[hsl(var(--intel-violet))]"
      title="Selector pairs measured in the likely or strong band. Not an analyst decision."
      data-likely-links={n}
    >
      <Sparkles className="h-3 w-3 shrink-0" aria-hidden />
      Likely links: <span className="font-mono tabular-nums text-foreground">{n}</span>
    </span>
  );
}
