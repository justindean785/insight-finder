import type { Artifact } from "@/hooks/useThreadArtifacts";
import type { ReviewState } from "@/lib/review";
import { evidenceStatus, type EvidenceDisplayStatus } from "@/lib/evidence-status";
import { isQuarantined, quarantineReason } from "@/lib/quarantine";

/**
 * authority.ts — the PRESENTATION projection of decisions already made.
 *
 * ⚠️ THIS FILE INVENTS NOTHING. Every value it returns is a re-labelling of
 * `evidenceStatus()` (which is itself derived from `labelForArtifact` and the
 * backend's `source_category` / `reason_not_confirmed`) plus `isQuarantined()`.
 * It has no thresholds, no scoring, no source counting, and it can only ever
 * move a row DOWN the authority ladder, never up. If you find yourself adding a
 * number here, the change belongs in `intel.ts` / `evidence-status.ts` instead.
 *
 * WHY IT EXISTS. Nine `EvidenceDisplayStatus` values is the right vocabulary for
 * a legend and the wrong vocabulary for a 300-row ledger: an analyst scanning a
 * dense case triages on far fewer buckets than they read on an individual row.
 * This collapses the nine into the eight ANALYST-FACING states the workspace
 * styles consistently (spine, chip, row tint) across Evidence, Graph, Clusters
 * and the Overview, so one glance means the same thing on every surface.
 *
 * WHY QUARANTINE IS ITS OWN STATE AND NOT A CONFIDENCE TIER. `subject_unlinked`
 * says "we do not know this belongs to the subject" — that is an absence of
 * authority, not a degree of it. Rendering it as amber/"needs review" puts it on
 * the same axis as a single-source finding that IS the subject's, which is the
 * exact confusion the promote boundary (#448) exists to prevent. It gets a
 * neutral hue and a hatch texture instead, so it is never read as a weaker
 * version of a real finding, and it always carries its recorded reason.
 */

export type AuthorityState =
  /** Corroborated across independent classes, or analyst-attested. */
  | "verified"
  /** Infrastructure corroborated — the asset resolves; ownership is NOT claimed. */
  | "infrastructure"
  /** Signals point together; no definitive proof. */
  | "probable"
  /** Reported but not independently corroborated, or review-only by class. */
  | "review"
  /** Low-confidence lead, or shared/CDN infrastructure. */
  | "weak"
  /** `subject_unlinked` — persisted and disclosed, but may not be promoted. */
  | "quarantined"
  /** Contradicts the seed or another cluster. */
  | "conflict"
  /** Marked a false positive / excluded from findings. */
  | "failed";

export interface AuthorityView {
  state: AuthorityState;
  /** Chip text, e.g. "Quarantined". */
  label: string;
  /** The status this row would carry if quarantine were not in play. Kept so a
   *  quarantined row can still SHOW its underlying evidence strength without
   *  that strength counting for anything. */
  underlying: EvidenceDisplayStatus;
  /** `underlying` as analyst-facing text, straight from `evidenceStatus` — so
   *  the strength axis is worded identically wherever it is shown. */
  underlyingLabel: string;
  /** One-line evidence basis from `evidenceStatus` (source count + class). */
  basis: string;
  /**
   * The reason this row is not stronger, in the pipeline's own words, when it
   * recorded one. Non-null whenever quarantine is ACTIVE — including when a
   * stronger warning won `state` — and for any row whose backend
   * `reason_not_confirmed` differs from the generic status hint.
   */
  caveat: string | null;
  /** Tooltip / screen-reader explanation. */
  hint: string;
  /**
   * True when the row may not seed or strengthen the subject's identity.
   *
   * Three conditions, and `state` is not one of them — a row can lose authority
   * for more than one reason at once and `state` only reports the loudest.
   * Mirrors what the engine already does: `isClusterIneligible` denies
   * clustering to quarantined and collision rows, and `confidence-dimensions.ts`
   * additionally drops `conflict === true` and `false_positive === true`. A
   * contradicted row does not become identity evidence just because "Conflict"
   * outranks "Quarantined" in the visual precedence below.
   */
  inert: boolean;
}

const LABEL: Record<AuthorityState, string> = {
  verified: "Verified",
  infrastructure: "Infrastructure",
  probable: "Probable",
  review: "Needs review",
  weak: "Lead",
  quarantined: "Quarantined",
  conflict: "Conflict",
  failed: "Excluded",
};

const QUARANTINE_HINT =
  "Flagged subject_unlinked: recorded and disclosed, but it may not seed identity clusters, graph identity edges, confidence, or the report. Confirm linkage to promote it.";

/** Where each display status lands on the analyst-facing ladder. */
const FROM_STATUS: Record<EvidenceDisplayStatus, AuthorityState> = {
  verified: "verified",
  verified_infrastructure: "infrastructure",
  probable: "probable",
  needs_corroboration: "review",
  manual_review: "review",
  lead: "weak",
  shared_infrastructure: "weak",
  contradicted: "conflict",
  rejected: "failed",
};

/**
 * Triage order, strongest WARNING first. Quarantine sits below the two states
 * that assert something is actively wrong: a row that both collides on a name
 * and contradicts the seed should read as a conflict, because that is the more
 * actionable statement. Everything else quarantine outranks — a quarantined row
 * must never present as "Probable" or "Verified".
 */
const OUTRANKS_QUARANTINE: ReadonlySet<AuthorityState> = new Set<AuthorityState>(["failed", "conflict"]);

/**
 * Project an artifact onto the analyst-facing authority ladder.
 *
 * `review` is the local analyst verdict, passed straight through to
 * `evidenceStatus` — this function never interprets it itself.
 */
export function authorityFor(a: Artifact, review?: ReviewState): AuthorityView {
  const status = evidenceStatus(a, review);
  const base = FROM_STATUS[status.status];
  const meta = (a.metadata ?? {}) as Record<string, unknown>;
  const quarantined = isQuarantined(meta);

  const state: AuthorityState = quarantined && !OUTRANKS_QUARANTINE.has(base) ? "quarantined" : base;

  // The pipeline's own words, when it recorded any. A quarantined row ALWAYS has
  // one (quarantineReason falls back to the canonical sentence), which is what
  // makes quarantine the only state on the board that always says why.
  let caveat: string | null = null;
  if (quarantined) {
    caveat = quarantineReason(meta);
  } else {
    const backend = typeof meta.reason_not_confirmed === "string" ? meta.reason_not_confirmed.trim() : "";
    caveat = backend && status.status !== "verified" ? backend : null;
  }

  return {
    state,
    label: LABEL[state],
    underlying: status.status,
    underlyingLabel: status.label,
    basis: status.basis,
    caveat,
    // Keyed on the PREDICATE, never on the winning `state`. Precedence decides
    // what the row is called; it must not delete a second authority condition
    // that is still true. A row that is both quarantined and contradicted reads
    // "Conflict" — and its tooltip still has to disclose the unproven linkage,
    // or the loudest warning silently swallows the other one.
    hint: quarantined ? `${QUARANTINE_HINT} ${status.hint}` : status.hint,
    inert: quarantined || state === "failed" || state === "conflict",
  };
}

/**
 * Ledger scan order — a SORT KEY, not a score.
 *
 * Named for what it is on purpose: the numbers order a dense list so an analyst
 * meets the strongest evidence first and the things that are wrong next. They
 * are not evidentiary strength and must never be used as one — `conflict` (4) is
 * not "stronger" than `quarantined` (5), and `failed` (7) is not weaker evidence
 * than `weak` (6); it is a row someone has already ruled out, so it sorts last.
 */
export const LEDGER_SORT_RANK: Record<AuthorityState, number> = {
  verified: 0,
  infrastructure: 1,
  probable: 2,
  review: 3,
  conflict: 4,
  quarantined: 5,
  weak: 6,
  failed: 7,
};

export interface AuthorityLegendEntry {
  state: AuthorityState;
  label: string;
  hint: string;
}

/** The canonical vocabulary, in ladder order, for every legend in the app. */
export const AUTHORITY_LEGEND: AuthorityLegendEntry[] = [
  { state: "verified", label: LABEL.verified, hint: "Corroborated by 2+ independent source classes, or analyst-confirmed." },
  { state: "infrastructure", label: LABEL.infrastructure, hint: "The asset exists and resolves. Says nothing about who owns or controls it." },
  { state: "probable", label: LABEL.probable, hint: "Several signals point together; no definitive proof yet." },
  { state: "review", label: LABEL.review, hint: "Reported but not independently corroborated, or review-only by class (breach, broker, reputation)." },
  { state: "conflict", label: LABEL.conflict, hint: "Contradicts the seed or another identity cluster." },
  { state: "quarantined", label: LABEL.quarantined, hint: QUARANTINE_HINT },
  { state: "weak", label: LABEL.weak, hint: "Low-confidence lead, or shared infrastructure. A starting point, not a finding." },
  { state: "failed", label: LABEL.failed, hint: "Marked a false positive or otherwise excluded from findings." },
];

/** Tally the ladder across a set of rows — used by the Overview and tab badges. */
export function tallyAuthority(
  artifacts: readonly Artifact[],
  review?: (id: string) => ReviewState,
): Record<AuthorityState, number> {
  const out: Record<AuthorityState, number> = {
    verified: 0, infrastructure: 0, probable: 0, review: 0,
    weak: 0, quarantined: 0, conflict: 0, failed: 0,
  };
  for (const a of artifacts) out[authorityFor(a, review?.(a.id)).state]++;
  return out;
}
