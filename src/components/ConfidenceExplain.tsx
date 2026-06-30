import { Info } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { explainConfidence } from "@/lib/confidence";
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
  const verdictColor =
    exp.final >= 80 ? "text-confidence-high" :
    exp.final >= 50 ? "text-confidence-mid" :
    "text-confidence-low";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Why is this ${exp.final}%?`}
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
                  c.delta > 0 ? "text-confidence-high" :
                  c.delta < 0 ? "text-confidence-low" :
                  "text-muted-foreground",
                )}
              >
                {c.delta > 0 ? "+" : ""}{c.delta}
              </span>
            </li>
          ))}
        </ul>
        {artifact.confidence != null && artifact.confidence !== exp.final && (
          <div className="px-3 py-2 border-t border-border-subtle text-data text-muted-foreground">
            Tool-reported raw: <span className="font-mono text-foreground">{artifact.confidence}</span>. The decomposed score above is the analyst-facing reconstruction.
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}