import { useMemo } from "react";
import { useCaseSnapshot } from "@/hooks/useCaseSnapshot";
import { useReviewStates } from "@/lib/review";
import { buildCaseSheet, type CaseSheetModel } from "@/lib/case-sheet";

/**
 * The case sheet's model, for anything that shows one of its figures. The
 * Evidence tab's number is `queueTotal` from HERE, so the tab and the sheet's
 * "Needs your call" can never disagree.
 */
export function useCaseSheetModel(threadId: string): {
  model: CaseSheetModel;
  hydrated: boolean;
  reviewsUnavailable: boolean;
} {
  const { snapshot } = useCaseSnapshot();
  const review = useReviewStates(threadId);
  const items = snapshot?.items;
  const tally = snapshot?.authority;
  const model = useMemo(
    () => buildCaseSheet(items ?? [], review.map, tally ?? {
      verified: 0, infrastructure: 0, probable: 0, review: 0, weak: 0, quarantined: 0, conflict: 0, failed: 0,
    }),
    // `review.revision` bumps on every verdict change, including a rollback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, tally, review.map, review.revision],
  );
  return {
    model,
    hydrated: Boolean(snapshot?.hydrated) && review.availability !== "unknown",
    reviewsUnavailable: review.availability === "unavailable",
  };
}
