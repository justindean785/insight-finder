import { useMemo } from "react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { AuthorityChip, AuthorityCaveat } from "@/components/ui/authority";
import { authorityFor } from "@/lib/authority";
import type { ReviewState } from "@/lib/review";
import { extractSourceInfo } from "@/lib/intel";
import { readableSourceLabel } from "@/lib/tool-display";
import { displayConfidence } from "@/lib/display-confidence";

/**
 * G-1: Compare Candidates — a reusable 2-candidate conflict modal.
 *
 * Driven by existing conflict detection: callers pass two artifacts the
 * engine has flagged as competing (same selector, different attribution, or
 * same attribution and different selectors). The dialog is a VIEW over
 * existing data — it does not re-adjudicate anything, does not change
 * review verdicts, and does not run a tool. The primary action focuses the
 * Workbench Next tab, where the ranked pivot for resolving the specific
 * contradiction already lives.
 *
 * Written as a single component instead of two card primitives + a layout
 * because the shape is tight (two sides, one header, one CTA) and reuse
 * across call sites comes from a single export rather than a composition
 * surface — simpler to keep honest.
 */

function CandidateCard({ artifact, reviewOf, label }: { artifact: Artifact; reviewOf: (id: string) => ReviewState; label: string }) {
  const view = useMemo(() => authorityFor(artifact, reviewOf(artifact.id)), [artifact, reviewOf]);
  const src = useMemo(() => extractSourceInfo(artifact), [artifact]);
  const shown = useMemo(() => displayConfidence(artifact), [artifact]);
  return (
    <section
      aria-label={label}
      data-candidate-card
      className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-surface-2/60 p-3"
    >
      <header className="flex items-start justify-between gap-2">
        <span className="font-mono text-eyebrow uppercase tracking-[0.14em] text-muted-foreground">{label}</span>
        <AuthorityChip view={view} />
      </header>
      <p className="min-w-0 break-words font-mono text-[13.5px] text-foreground [overflow-wrap:anywhere]" title={artifact.value}>
        {artifact.value}
      </p>
      <p className="text-[12px] text-muted-foreground">
        <span className="font-medium text-foreground/85">{artifact.kind}</span>
        {src.primary && (
          <>
            <span className="mx-1.5 text-faint-foreground">·</span>
            via {readableSourceLabel(src.primary)}
          </>
        )}
        {shown.effective != null && (
          <>
            <span className="mx-1.5 text-faint-foreground">·</span>
            confidence {shown.effective}
          </>
        )}
      </p>
      <AuthorityCaveat view={view} className="text-[12px] leading-snug line-clamp-3" />
    </section>
  );
}

export interface CompareCandidatesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  candidateA: Artifact | null;
  candidateB: Artifact | null;
  /** One-line reason the two are flagged as competing (from the engine's conflict detector). */
  reason: string;
  /** The engine's current review verdict map, so each card reads the same authority as everywhere else. */
  reviewOf: (id: string) => ReviewState;
  /** Primary action: focus the Workbench Next tab on the pivot ranked to resolve this contradiction. */
  onFocusNextPivots?: () => void;
}

export function CompareCandidatesDialog({
  open, onOpenChange, candidateA, candidateB, reason, reviewOf, onFocusNextPivots,
}: CompareCandidatesDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(96vw,560px)] overflow-hidden p-0">
        <DialogHeader className="border-b border-border-subtle px-5 py-4">
          <DialogTitle className="font-display text-[17px] font-semibold tracking-normal">
            Compare candidates
          </DialogTitle>
          <DialogDescription className="mt-1 text-[12.5px] leading-snug text-muted-foreground">
            {reason}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 px-5 py-4 sm:grid-cols-2">
          {candidateA ? (
            <CandidateCard artifact={candidateA} reviewOf={reviewOf} label="Candidate A" />
          ) : (
            <p className="rounded-lg border border-dashed border-border-subtle p-3 text-[12.5px] text-muted-foreground">Candidate A unavailable.</p>
          )}
          {candidateB ? (
            <CandidateCard artifact={candidateB} reviewOf={reviewOf} label="Candidate B" />
          ) : (
            <p className="rounded-lg border border-dashed border-border-subtle p-3 text-[12.5px] text-muted-foreground">
              The second candidate hasn’t surfaced yet. Open Next pivots to run a resolver.
            </p>
          )}
        </div>

        <DialogFooter className="border-t border-border-subtle px-5 py-3">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
          <Button
            type="button"
            disabled={!onFocusNextPivots}
            onClick={() => {
              onFocusNextPivots?.();
              onOpenChange(false);
            }}
          >
            Review the recommended pivot <ArrowRight className="ml-1 h-3.5 w-3.5" aria-hidden />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
