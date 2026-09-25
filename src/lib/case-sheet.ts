import type { Artifact } from "@/hooks/useThreadArtifacts";
import type { ReviewState } from "@/lib/analyst-decisions";
import {
  authorityFor, LEDGER_SORT_RANK, AUTHORITY_DISTRIBUTION,
  type AuthorityState, type AuthorityView,
} from "@/lib/authority";
import { pickSubjectName } from "@/lib/report-hygiene";

/**
 * The case sheet: the right-hand column of the 3a "Case desk" layout, shown
 * beside the transcript and the report.
 *
 * IT COMPUTES NOTHING NEW. Every figure is `authorityFor` / the snapshot's
 * `tallyAuthority` over the same rows the Evidence ledger renders, and the
 * subject is picked by `pickSubjectName` — the rule behind the report's
 * "Real name" field. If the sheet disagrees with the ledger or the report, that
 * is a bug here, not a second opinion.
 */

/**
 * The two questions a row can put to the analyst, which are DIFFERENT
 * decisions and must never share one button:
 *   linkage — "whose is this?"  answered by releasing a quarantine
 *   review  — "is this real?"   answered by a review verdict
 * Keyed on the caveat's PREDICATE (`caveatKind`), not the winning `state`,
 * for the same reason `AuthorityView` does: a contradicted row that is also
 * quarantined still has a linkage question, and a plain conflict does not.
 */
export type CaseSheetAsk = "linkage" | "review";

export const ASK_LABEL: Record<CaseSheetAsk, string> = {
  linkage: "Linkage · whose is this?",
  review: "Review · is this real?",
};

export interface CaseSheetSubject {
  artifact: Artifact;
  view: AuthorityView;
  initials: string;
}

export interface CaseSheetQueueItem {
  artifact: Artifact;
  view: AuthorityView;
  ask: CaseSheetAsk;
}

export interface CaseSheetModel {
  subject: CaseSheetSubject | null;
  total: number;
  distribution: { state: AuthorityState; short: string; n: number }[];
  queue: CaseSheetQueueItem[];
  /** Every row that needs a call, not just the ones listed. */
  queueTotal: number;
}

export const CASE_SHEET_QUEUE_LIMIT = 5;

const NEEDS_CALL: ReadonlySet<AuthorityState> = new Set<AuthorityState>(["conflict", "quarantined"]);

export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (words.length === 0) return "?";
  const first = words[0][0] ?? "";
  const last = words.length > 1 ? words[words.length - 1][0] ?? "" : "";
  return (first + last).toUpperCase();
}

export function buildCaseSheet(
  items: readonly Artifact[],
  reviewMap: Readonly<Record<string, ReviewState>>,
  tally: Record<AuthorityState, number>,
): CaseSheetModel {
  const reviewOf = (id: string): ReviewState => reviewMap[id] ?? "new";

  const named = pickSubjectName(items as Artifact[], reviewMap);
  const subject = named
    ? { artifact: named, view: authorityFor(named, reviewOf(named.id)), initials: initialsOf(named.value) }
    : null;

  const distribution = AUTHORITY_DISTRIBUTION
    .map((d) => ({ ...d, n: tally[d.state] ?? 0 }))
    .filter((d) => d.n > 0);
  const total = distribution.reduce((n, d) => n + d.n, 0);

  const needing = items
    .map((a) => ({ artifact: a, view: authorityFor(a, reviewOf(a.id)) }))
    .filter((x) => NEEDS_CALL.has(x.view.state))
    .sort((x, y) => LEDGER_SORT_RANK[x.view.state] - LEDGER_SORT_RANK[y.view.state]);

  const queue = needing.slice(0, CASE_SHEET_QUEUE_LIMIT).map((x) => ({
    ...x,
    ask: (x.view.caveatKind === "linkage" ? "linkage" : "review") as CaseSheetAsk,
  }));

  return { subject, total, distribution, queue, queueTotal: needing.length };
}
