import type { Artifact } from "@/hooks/useThreadArtifacts";
import type { ReviewState } from "@/lib/review";
import { evidenceStatus, type EvidenceDisplayStatus } from "@/lib/evidence-status";
import { isQuarantined, quarantineReason } from "@/lib/quarantine";
import { isClusterIneligible } from "@/lib/report-hygiene";

/**
 * authority.ts — the PRESENTATION projection of decisions already made.
 *
 * ⚠️ THIS FILE INVENTS NOTHING. It has no thresholds, no scoring, no source
 * counting, and it can only ever move a row DOWN the authority ladder, never up.
 * If you find yourself adding a number here, the change belongs in `intel.ts` /
 * `evidence-status.ts` instead.
 *
 * IT PROJECTS TWO INDEPENDENT DECISIONS, both made elsewhere:
 *
 *   STRENGTH     — `evidenceStatus()`, itself derived from `labelForArtifact`
 *                  and the backend's `source_category` / `reason_not_confirmed`.
 *                  "How good is this observation?"
 *   ELIGIBILITY  — `isClusterIneligible()` (active `subject_unlinked` quarantine
 *                  OR a flagged collision), plus the `conflict` / false-positive
 *                  states that arrive through `evidenceStatus`. "May it speak
 *                  for the subject?"
 *
 * Naming eligibility explicitly matters: while this file tested quarantine alone
 * and assumed the rest was covered, a `possible_collision` row with two source
 * classes projected as "Verified" here and as an unrelated namesake everywhere
 * in the engine. The projection now ASKS the engine's own predicate rather than
 * re-deriving a subset of it.
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
  /**
   * Authority withheld — persisted and disclosed, but may not be promoted.
   *
   * TWO predicates land here, both already enforced by the engine and unified
   * behind `isClusterIneligible`: an ACTIVE `subject_unlinked` quarantine, and a
   * flagged name collision (`possible_collision` / `collision` /
   * `excluded_collision` / `status: "excluded"`). They are one visual state
   * because they make the same statement to an analyst — *this row may not speak
   * for the subject* — and the row's own `caveat` names which one it is.
   */
  | "quarantined"
  /** Contradicts the seed or another cluster. */
  | "conflict"
  /** Marked a false positive / excluded from findings. */
  | "failed";

export type CaveatKind = "linkage" | "status" | null;

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
  /**
   * What KIND of statement `caveat` is, so the chrome around it can be honest.
   *
   * `"linkage"` — authority is withheld (quarantine or collision): the caveat is
   * a cordon, and renders with the neutral hue + unlink mark.
   * `"status"`  — the row simply is not stronger yet; the backend recorded why.
   *
   * Keyed on the PREDICATE, never on the winning `state`, for the same reason
   * `hint` is: a contradicted row explains a CONTRADICTION, and dressing that
   * explanation as an unproven-linkage cordon fights the Conflict chip and spine
   * sitting on the same row.
   */
  caveatKind: CaveatKind;
  /** Tooltip / screen-reader explanation. */
  hint: string;
  /**
   * True when the row may not seed or strengthen the subject's identity.
   *
   * Three conditions, and `state` is not one of them — a row can lose authority
   * for more than one reason at once and `state` only reports the loudest.
   * The first CALLS the engine rather than restating it: `isClusterIneligible`
   * is the same function that denies clustering to quarantined and collision
   * rows, so the two can never disagree. `confidence-dimensions.ts` additionally
   * drops `conflict === true` and `false_positive === true`, which is why the
   * other two conditions are here and not in that predicate. A
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

const COLLISION_HINT =
  "Flagged as a name collision: recorded and disclosed, but it may not seed identity clusters, graph identity edges, confidence, or the report.";

/** Canonical wording when a collision row carried no reason of its own. */
const COLLISION_REASON =
  "Flagged as a possible name collision — this may be a different person with the same name.";

/**
 * Backend `reason_not_confirmed` strings that RESTATE the status rather than
 * explaining it. These are hardcoded defaults, not observations — `confidence.ts`
 * writes the first one whenever a row simply lacks a second source class.
 *
 * WHY SUPPRESS THEM. Measured on a live 98-artifact case: 89 rows (91%) carried
 * the identical sentence "needs second independent class of evidence", under an
 * identical "Needs review" chip that already says exactly that. Nine rows carried
 * a reason that was actually specific to them — a same-digit phone collision, a
 * community attribution that is not a law-enforcement designation, an unclear
 * relationship. Rendering all 98 buries those nine in boilerplate, which is the
 * wall-of-identical-rows failure the ledger exists to prevent.
 *
 * This removes NO information: the chip carries the same statement, the tooltip
 * carries the full status hint, and the raw value stays in metadata. It removes
 * a REPETITION. Anything the backend wrote that is not on this list still renders
 * verbatim — the specific reasons are the whole point.
 */
const RESTATES_STATUS: ReadonlySet<string> = new Set([
  "needs second independent class of evidence",
  "needs a second independent class of evidence",
  "needs independent corroboration",
  "not yet corroborated",
]);

/** True when the backend reason only repeats what the status chip already says. */
function restatesStatus(reason: string): boolean {
  return RESTATES_STATUS.has(reason.trim().toLowerCase().replace(/[.]+$/, ""));
}

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

  // THE GATE IS THE ENGINE'S OWN PREDICATE, not a re-derivation of it.
  //
  // `isClusterIneligible` is what actually bars a row from identity clusters,
  // graph identity edges and confidence dimensions, and it is broader than
  // quarantine alone — it also covers the collision flags (`possible_collision`,
  // `collision`, `excluded_collision`, `status: "excluded"`). Calling it here,
  // rather than testing quarantine and hoping the rest is covered, is what makes
  // it impossible for the board to call a row Verified while clustering and the
  // report treat it as an unrelated namesake. That gap was real: `evidenceStatus`
  // consults none of the collision flags, so a two-source `possible_collision`
  // row reached "Verified" here, led the Overview's strongest findings, and
  // counted in the header's verified tally — while every engine surface rejected
  // it. Same defect shape as #448, one layer up. (Codex review, PR #462.)
  //
  // Widening this to any predicate the engine does NOT enforce would be inventing
  // policy in the presentation layer; deferring to that one function is the
  // opposite — the board cannot drift from the engine because it asks the engine.
  const ineligible = isClusterIneligible(a);

  const state: AuthorityState = ineligible && !OUTRANKS_QUARANTINE.has(base) ? "quarantined" : base;

  // The pipeline's own words, when it recorded any. A row whose authority is
  // withheld ALWAYS has a caveat (both branches fall back to a canonical
  // sentence), which is what makes this the only state on the board that always
  // says why.
  let caveat: string | null = null;
  let caveatKind: CaveatKind = null;
  if (quarantined) {
    caveat = quarantineReason(meta);
    caveatKind = "linkage";
  } else if (ineligible) {
    const backend = typeof meta.reason_not_confirmed === "string" ? meta.reason_not_confirmed.trim() : "";
    caveat = backend || COLLISION_REASON;
    caveatKind = "linkage";
  } else {
    const backend = typeof meta.reason_not_confirmed === "string" ? meta.reason_not_confirmed.trim() : "";
    // A caveat that repeats the chip beside it is noise, not disclosure — and at
    // 91% of rows it actively hides the reasons that ARE specific. See
    // RESTATES_STATUS. Quarantine and collision are unaffected: both branches
    // above always carry their reason, because there the chip does NOT say why.
    caveat = backend && status.status !== "verified" && !restatesStatus(backend) ? backend : null;
    caveatKind = caveat ? "status" : null;
  }

  return {
    state,
    label: LABEL[state],
    underlying: status.status,
    underlyingLabel: status.label,
    basis: status.basis,
    caveat,
    caveatKind,
    // Keyed on the PREDICATE, never on the winning `state`. Precedence decides
    // what the row is called; it must not delete a second authority condition
    // that is still true. A row that is both quarantined and contradicted reads
    // "Conflict" — and its tooltip still has to disclose the unproven linkage,
    // or the loudest warning silently swallows the other one.
    hint: ineligible
      ? `${quarantined ? QUARANTINE_HINT : COLLISION_HINT} ${status.hint}`
      : status.hint,
    inert: ineligible || state === "failed" || state === "conflict",
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
  {
    state: "quarantined",
    label: LABEL.quarantined,
    // The legend covers BOTH routes into this state, because an analyst reading
    // it is looking at a board where either may be the reason.
    hint: `${QUARANTINE_HINT} A flagged name collision is held the same way.`,
  },
  { state: "weak", label: LABEL.weak, hint: "Low-confidence lead, or shared infrastructure. A starting point, not a finding." },
  { state: "failed", label: LABEL.failed, hint: "Marked a false positive or otherwise excluded from findings." },
];

/**
 * Tally the ladder across a set of rows — used by the Overview, the case header
 * and tab badges.
 *
 * `review` IS REQUIRED, and deliberately has no default. Analyst verdicts are
 * not part of the artifact, so a caller that holds `items` already has
 * everything it needs to *look* correct while quietly disagreeing with every
 * other surface the moment someone confirms or dismisses a row. Making the
 * parameter mandatory turns "did this caller remember the verdicts?" from a
 * review question into a compile error — the workspace header shipped without
 * them and reported a dismissed row as Verified while the ledger beside it said
 * Excluded. Pass `() => undefined` only where reviews genuinely cannot exist.
 */
export function tallyAuthority(
  artifacts: readonly Artifact[],
  review: (id: string) => ReviewState,
): Record<AuthorityState, number> {
  const out: Record<AuthorityState, number> = {
    verified: 0, infrastructure: 0, probable: 0, review: 0,
    weak: 0, quarantined: 0, conflict: 0, failed: 0,
  };
  for (const a of artifacts) out[authorityFor(a, review(a.id)).state]++;
  return out;
}
