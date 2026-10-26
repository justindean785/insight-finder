import { Info } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { explainConfidence } from "@/lib/confidence";
import { displayConfidence } from "@/lib/display-confidence";
import { machineScoreText } from "@/lib/analyst-confirmed";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import type { ReviewState } from "@/lib/review";
import { cn } from "@/lib/utils";

/** Recorded score/cap disclosure beside the evidence's authority state. */
export function ConfidenceExplain({
  artifact, review, className, onOpenChange,
}: {
  artifact: Artifact;
  review?: ReviewState;
  className?: string;
  /** Lets a host that owns another overlay (the Evidence row's peek card) yield
   *  while this one is open, so Escape always dismisses what the analyst sees. */
  onOpenChange?: (open: boolean) => void;
}) {
  const exp = explainConfidence(artifact, review);
  const shown = displayConfidence(artifact);
  // Ink, not hue — a third by-value ladder (80/50) lived here and rendered
  // inline beside every ledger numeral, so the row showed two different
  // opinions about the same score. Authority carries the verdict.
  const verdictColor = "text-foreground";

  return (
    <Popover onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={shown.effective === null ? "Why is this score unknown?" : `Why is this score ${shown.effective}/100?`}
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
        className="w-80 max-w-[calc(100vw-2rem)] max-h-[var(--radix-popover-content-available-height)] p-0 overflow-y-auto border-border-subtle"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-3 py-2 border-b border-border-subtle flex items-baseline justify-between gap-2">
          <div className="text-eyebrow uppercase tracking-[0.12em] text-muted-foreground">Why this score?</div>
          <div className="flex items-baseline gap-1">
            <span className={cn("font-mono text-lg tabular-nums leading-none", verdictColor)} data-score-headline>{shown.effective ?? "—"}</span>
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
        <p className="px-3 py-2 text-data text-muted-foreground">
          Machine assessment · uncalibrated. This score is not a probability of identity. A point-by-point calculation is unavailable in this record view.
        </p>
        <ul className="py-1">
          {exp.components.map((c, i) => (
            <li key={i} className="px-3 py-1.5 grid grid-cols-[1fr_auto] gap-2 items-start">
              <div className="min-w-0">
                <div className="text-data text-foreground">{c.label}</div>
                <div className="text-data text-muted-foreground leading-snug break-words">{c.why}</div>
              </div>
              {c.value && (
                <span className="font-mono text-data tabular-nums shrink-0 mt-0.5 text-foreground">{c.value}</span>
              )}
            </li>
          ))}
        </ul>
        {shown.stored != null && shown.stored !== shown.effective && (
          <div className="px-3 py-2 border-t border-border-subtle text-data text-muted-foreground">
            Stored by the server: <span className="font-mono text-foreground">{shown.stored}</span>, capped to <span className="font-mono text-foreground">{shown.effective}</span>{shown.capReason ? ` — ${shown.capReason}` : ""}.
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
