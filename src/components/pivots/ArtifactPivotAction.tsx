import { useMemo, useState } from "react";
import { GitBranch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PivotPreview } from "@/components/pivots/PivotPreview";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { useOptionalCaseSnapshot } from "@/hooks/useCaseSnapshot";
import { useThreadQueriedTargets } from "@/hooks/useThreadQueriedTargets";
import { useReviewStates } from "@/lib/review";
import { hasPivotRunner } from "@/lib/pivot-runner";
import { pivotForArtifact } from "@/lib/artifact-pivot";
import type { RunnablePivot } from "@/lib/pivot-schema";

/**
 * "Pivot on this" for one evidence row, shown in the row's detail drawer.
 *
 * It opens the same preview every other pivot opens, and starts the run over the
 * same `proximity:run-pivot` event the Pivots view uses, so the preview, the
 * eligibility checks and the server-side dispatch guard are all unchanged. What
 * this adds is the way in: before, a selector in the Evidence list could only be
 * pivoted by retyping it into the composer.
 */
export function ArtifactPivotAction(props: {
  threadId: string;
  artifact: Artifact;
  artifacts: Artifact[];
  onStarted?: () => void;
}) {
  // One thread-log read and subscription per mounted action. A surface that shows many of these at once reads the
  // log itself and uses ArtifactPivotActionWith, so N actions do not mean N reads.
  const queriedSet = useThreadQueriedTargets(props.threadId);
  return <ArtifactPivotActionWith {...props} queriedSet={queriedSet} />;
}

export function ArtifactPivotActionWith({
  threadId,
  artifact,
  artifacts,
  queriedSet,
  onStarted,
}: {
  threadId: string;
  artifact: Artifact;
  artifacts: Artifact[];
  /** The thread's already-queried selectors, read ONCE by the caller. */
  queriedSet: Set<string>;
  onStarted?: () => void;
}) {
  const caseApi = useOptionalCaseSnapshot();
  const seedValue = caseApi?.snapshot ? caseApi.snapshot.seed.value : null;
  const review = useReviewStates(threadId);
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);

  const result = useMemo(
    () => pivotForArtifact(artifact, {
      artifacts,
      seedValue,
      queriedSet,
      reviews: review.map,
      reviewOf: (id) => review.map[id] ?? "new",
    }),
    [artifact, artifacts, seedValue, queriedSet, review.map],
  );

  const canRun = hasPivotRunner(threadId);

  const start = (p: RunnablePivot) => {
    window.dispatchEvent(new CustomEvent("proximity:run-pivot", {
      detail: { threadId, value: p.target, type: p.targetType, prompt: p.prompt },
    }));
    setOpen(false);
    setSent(true);
    onStarted?.();
  };

  if (result.available === false) {
    return <p className="text-data text-muted-foreground" data-testid="artifact-pivot-unavailable">{result.why}</p>;
  }
  if (!canRun) {
    return (
      <p className="text-data text-muted-foreground" data-testid="artifact-pivot-no-runner">
        Pivots run from the Investigate tab. Open this case in the workspace to pivot on {result.pivot.target}.
      </p>
    );
  }

  return (
    <div className="space-y-2" data-testid="artifact-pivot">
      <Button
        size="sm"
        variant="outline"
        className="w-full gap-1.5"
        aria-expanded={open}
        onClick={() => { setOpen((v) => !v); setSent(false); }}
      >
        <GitBranch className="h-3.5 w-3.5" aria-hidden /> Pivot on this
      </Button>
      {open && (
        <PivotPreview
          pivot={result.pivot}
          eligibility={result.eligibility}
          onStart={() => start(result.pivot)}
          onCancel={() => setOpen(false)}
        />
      )}
      <div role="status" aria-live="polite" className="text-data text-muted-foreground">
        {sent ? `Pivot on ${result.pivot.target} sent to the agent.` : ""}
      </div>
    </div>
  );
}
