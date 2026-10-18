/**
 * decision-queue.ts — what the Overview's "Needs a decision" panel shows.
 *
 * The panel exists to ask the analyst to DO something. It used to list every
 * quarantined or conflicting row, first five wins — and on a breach-heavy case
 * all five slots went to rows the pipeline had already settled: strangers lifted
 * from the same breach corpus as the subject. Measured on the Caraotta case
 * (2026-10-15): 11 quarantined rows, all 11 "co-tenant row in a breach corpus",
 * which buried every real conflict below the fold.
 *
 * Two quarantine reasons describe DATASET MEMBERSHIP, not a possible subject
 * link — the record's own field says it is someone else (co-tenant), or the
 * lookup returned a whole population (bulk corpus). Those are held back into a
 * single counted line. A name-only collision stays in the queue: that row might
 * really be the subject, which is exactly the call the analyst has to make.
 *
 * DISCLOSURE, NOT DELETION. Held-back rows stay quarantined, stay on the
 * Evidence board with their reason, and are still counted here — only their
 * claim on the five decision slots is withdrawn.
 */
import { quarantineReason } from "@/lib/quarantine";

/** Reason prefixes the edge writes (`auto-persist-findings.ts`) for rows that
 *  belong to other people in the same dataset. Prefix match: the edge appends
 *  case-specific detail to the bulk-corpus sentence. */
const DATASET_STRANGER_REASONS = [
  "co-tenant row in a breach corpus",
  "harvested from a bulk corpus return",
] as const;

/** True when this row was quarantined because it belongs to someone else in the
 *  same dataset, not because its link to the subject is merely unproven. */
export function isDatasetStranger(metadata: unknown): boolean {
  const reason = quarantineReason(metadata);
  if (!reason) return false;
  const r = reason.toLowerCase();
  return DATASET_STRANGER_REASONS.some((p) => r.startsWith(p));
}

export type DecisionCandidate<T> = {
  item: T;
  state: "quarantined" | "conflict";
  metadata: unknown;
  confidence: number;
};

export type DecisionQueue<T> = {
  shown: T[];
  /** Actionable rows beyond the visible slots. */
  more: number;
  /** Dataset-stranger rows withdrawn from the slots, still quarantined. */
  heldBack: number;
};

export const DECISION_SLOTS = 5;

/** Conflicts first (an actively disputed claim outranks an unattributable one),
 *  then by confidence, then held-back strangers counted rather than listed. */
export function buildDecisionQueue<T>(
  candidates: DecisionCandidate<T>[],
  slots: number = DECISION_SLOTS,
): DecisionQueue<T> {
  let heldBack = 0;
  const actionable: DecisionCandidate<T>[] = [];
  for (const c of candidates) {
    if (c.state === "quarantined" && isDatasetStranger(c.metadata)) heldBack += 1;
    else actionable.push(c);
  }
  actionable.sort((x, y) => {
    if (x.state !== y.state) return x.state === "conflict" ? -1 : 1;
    return y.confidence - x.confidence;
  });
  return {
    shown: actionable.slice(0, slots).map((c) => c.item),
    more: Math.max(0, actionable.length - slots),
    heldBack,
  };
}
