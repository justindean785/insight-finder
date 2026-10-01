import { Info } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { explainConfidence } from "@/lib/confidence";
import { displayConfidence } from "@/lib/display-confidence";
import { machineScoreText } from "@/lib/analyst-confirmed";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import type { ReviewState } from "@/lib/review";
import { cn } from "@/lib/utils";

/**
 * Compact "i" button that opens a popover explaining how a confidence score
 * was assembled (base × corroboration × recency × analyst). Use anywhere an
 * artifact's confidence is rendered — keeps every score audit-defensible.
 */
export function ConfidenceExplain({
  artifact, review, className,
}: {
  artifact: Artifact;
  review?: ReviewState;
  className?: string;
}) {
  const exp = explainConfidence(artifact, review);
  // THE HEADLINE IS THE CANONICAL NUMBER. `explainConfidence(...).final` is a full
  // re-derivation from source tier, corroboration and recency that never reads
  // `a.confidence` at all — a fifth pipeline, and this popover is mounted on every
  // Evidence board row, so it rendered its own opinion inches from the row's
  // figure. The DECOMPOSITION below is genuinely useful and stays; what it may not
  // do is disagree about the total.
  const shown = displayConfidence(artifact);
  // Ink, not hue — a third by-value ladder (80/50) lived here and rendered
  // inline beside every ledger numeral, so the row showed two different
  // opinions about the same score. Authority carries the verdict.
  const verdictColor = "text-foreground";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Why is this ${shown.effective ?? 0}%?`}
          className={cn(
            "inline-grid place-items-center w-4 h-4 rounded-full text-muted-foreground/60 hover:text-foreground hover:bg-surface-3 transition-colors",
            className,
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <Info className="w-3 h-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="left"
        align="start"
        className="w-80 p-0 overflow-hidden border-border-subtle"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-3 py-2 border-b border-border-subtle flex items-baseline justify-between gap-2">
          <div className="text-eyebrow uppercase tracking-[0.12em] text-muted-foreground">Why this score?</div>
          <div className="flex items-baseline gap-1">
            <span className={cn("font-mono text-lg tabular-nums leading-none", verdictColor)}>{exp.final}</span>
            <span className="font-mono text-data text-muted-foreground">/100</span>
          </div>
        </header>
        {/* The machine score, NAMED. An analyst-confirmed row shows the words
            "Analyst-confirmed" where its figure would sit (AnalystConfirmedMark),
            so this popover is where that row's number lives on screen — the same
            `displayConfidence(a).effective` the board renders for every other
            row, with the server's recorded cap beside it when there is one. */}
        <div className="px-3 py-1.5 border-b border-border-subtle text-data text-foreground" data-machine-score>
          {machineScoreText(shown)}
        </div>
        <ul className="py-1">
          {exp.components.map((c, i) => (
            <li key={i} className="px-3 py-1.5 grid grid-cols-[1fr_auto] gap-2 items-start">
              <div className="min-w-0">
                <div className="text-data text-foreground">{c.label}</div>
                <div className="text-data text-muted-foreground leading-snug">{c.why}</div>
              </div>
              <span
                className={cn(
                  "font-mono text-data tabular-nums shrink-0 mt-0.5",
                  c.delta > 0 ? "text-[hsl(var(--confidence-high))]" :
                  c.delta < 0 ? "text-[hsl(var(--confidence-low))]" :
                  "text-muted-foreground",
                )}
              >
                {c.delta > 0 ? "+" : ""}{c.delta}
              </span>
            </li>
          ))}
        </ul>
        {shown.stored != null && shown.stored !== shown.effective && (
          <div className="px-3 py-2 border-t border-border-subtle text-data text-muted-foreground">
            Stored by the server: <span className="font-mono text-foreground">{shown.stored}</span>, capped to <span className="font-mono text-foreground">{shown.effective}</span>{shown.capReason ? ` — ${shown.capReason}` : ""}. The breakdown above decomposes the signals behind it.
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}