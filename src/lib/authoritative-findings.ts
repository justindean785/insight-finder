/**
 * authoritative-findings.ts — #499. The single source of truth for what the
 * ENGINE actually adjudicated, for every analyst-facing Report producer.
 *
 * WHY THIS EXISTS. The deterministic Report had no concept of an adjudicated
 * finding: "Key Findings" is built from `labelForArtifact(a) === "CONFIRMED"`
 * over ALL artifacts — a source-tier label. On a run where `record_finding`
 * never fired, the Report still presented a populated Key Findings section, and
 * nothing told the analyst the engine had adjudicated nothing. Measured in
 * production: 49 artifacts, 0 of `kind='finding'`, deterministic UI 0 Confirmed
 * / 47 Leads, while the stored model prose claimed 90–95% CONFIRMED.
 *
 * This module answers one question — *what did the engine adjudicate, and can we
 * trust the answer?* — and both live producers (`intel.ts:buildReportMarkdown`
 * and `CaseReport.tsx`) render from it. One selector, two presentations: that is
 * what stops the Report growing a second confidence vocabulary.
 *
 * THE CONTRACT, settled in #479 and preserved verbatim here:
 *
 *   - population is `kind='finding'` ONLY. A high-confidence `name` or
 *     `breach_exposure` row is not a finding; this block is about RECORDED
 *     FINDINGS, not best artifacts.
 *   - the number is `min(confidence, metadata.confidence_cap_applied)` and
 *     nothing else.
 *   - the tier is the 90/75/55/35 ladder (`confidence-tier.ts`).
 *   - `metadata.label` / `metadata.status` and model prose are NEVER authority.
 *   - `dismissed` / `wrong` findings are never authoritative.
 *   - an unreadable input is never rendered as a confident negative.
 *
 * DELIBERATELY NOT `adjustedConfidence`. That applies review deltas and a
 * corroboration bonus; both are legitimate for the evidence surface and wrong
 * here, because an analyst attestation must not silently raise the number the
 * engine computed. Same reasoning as #498 choosing `dropRejectedArtifacts` over
 * `applyReviewsToArtifacts` on the backend.
 */
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { tierOf, type ConfidenceTier } from "./confidence-tier";
import { isRejectedReview } from "./review";

/**
 * What we know about the population this answer was computed over.
 *
 * Three of the four are failure or partial states, and they exist because the
 * alternative — rendering "the engine adjudicated nothing" when we simply could
 * not read — is a false integrity claim in the dangerous direction. It reads as
 * the engine having looked and found nothing.
 */
export type AuthorityState =
  /** The artifact read succeeded and returned the whole population. */
  | "complete"
  /** The read succeeded but filled its row limit; findings may sit below it. */
  | "ceiling_hit"
  /** The artifact read failed. Nothing about the run is knowable. */
  | "retrieval_unavailable"
  /** Verdicts were unreadable, so a rejected finding might be in the population. */
  | "reviews_unavailable";

export interface AuthoritativeFinding {
  id: string;
  value: string;
  /** Effective confidence: min(stored, recorded cap). null when unusable. */
  confidence: number | null;
  tier: ConfidenceTier;
}

export interface AuthoritativeFindings {
  state: AuthorityState;
  /** Empty on any unavailable state — never a partial answer presented as whole. */
  findings: AuthoritativeFinding[];
  /** Findings the analyst rejected, so "none remain after review" is sayable. */
  rejectedCount: number;
  /** Artifacts considered, for the zero-findings statement. */
  totalArtifacts: number;
}

export interface AuthorityInputs {
  /** The artifact fetch filled its row limit (`useThreadArtifacts` hasMore). */
  ceilingHit: boolean;
  /** The artifact fetch errored (`useThreadArtifacts` error). */
  retrievalFailed: boolean;
  /** Analyst verdicts were readable (`useReviewStates` availability === "ok"). */
  reviewsAvailable: boolean;
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * A usable 0–100 score, or null.
 *
 * Out-of-range is treated as unusable rather than clamped: a stored 101 is
 * corrupt, and `tierOf(101)` returns "confirmed", so passing it through would let
 * corruption publish the highest tier on the authoritative surface.
 */
function usableScore(x: unknown): number | null {
  if (typeof x !== "number" || !Number.isFinite(x)) return null;
  if (x < 0 || x > 100) return null;
  return x;
}

/**
 * The ceiling the server recorded for a row, if any.
 *
 * `record_finding` persists `confidence: axes.case` UNCAPPED and carries the
 * ceiling separately in `metadata.confidence_cap_applied` (#481), so anything
 * printing the raw column publishes above the cap. Owned here and imported by
 * `intel.ts` so there is exactly ONE reader of this key on the frontend.
 */
export function recordedConfidenceCap(meta: Record<string, unknown>): number | null {
  return usableScore(meta?.confidence_cap_applied);
}

/** min(stored, recorded cap). An unusable cap is ignored, not trusted — it can
 *  only ever LOWER a number, so ignoring it fails safe in the wrong direction
 *  only if we trusted garbage, which we do not. */
export function effectiveFindingConfidence(a: unknown): number | null {
  if (!isRecord(a)) return null;
  const base = usableScore(a.confidence);
  if (base === null) return null;
  const cap = recordedConfidenceCap(isRecord(a.metadata) ? a.metadata : {});
  return cap === null ? base : Math.min(base, cap);
}

/** The population predicate. Exported so callers count with the same definition
 *  of "finding" this module selects by. */
export function isFindingArtifact(a: unknown): boolean {
  return isRecord(a) && typeof a.kind === "string" && a.kind.trim().toLowerCase() === "finding";
}

export function selectAuthoritativeFindings(
  artifacts: Artifact[] | null | undefined,
  reviews: Record<string, string> | null | undefined,
  inputs: AuthorityInputs,
): AuthoritativeFindings {
  const rows = Array.isArray(artifacts) ? artifacts : [];
  const verdicts = isRecord(reviews) ? reviews : {};

  // Ordered by severity: an unreadable population cannot be described at all, so
  // it outranks a ceiling. Neither may present as an answer about the run.
  if (inputs?.retrievalFailed) {
    return { state: "retrieval_unavailable", findings: [], rejectedCount: 0, totalArtifacts: 0 };
  }
  // Verdicts unreadable ⇒ a rejected finding may be sitting in this population,
  // and republishing one under an authoritative heading is worse than silence.
  // Fails closed, matching review.ts (#500) and the backend (#498).
  if (!inputs?.reviewsAvailable) {
    return { state: "reviews_unavailable", findings: [], rejectedCount: 0, totalArtifacts: rows.length };
  }

  const all = rows.filter(isFindingArtifact);
  const kept = all.filter((a) => !isRejectedReview(verdicts[(a as { id?: string }).id ?? ""]));

  const findings = kept
    .map((a) => {
      const confidence = effectiveFindingConfidence(a);
      return {
        id: typeof a.id === "string" ? a.id : "",
        value: typeof a.value === "string" ? a.value : "",
        confidence,
        // Only a usable score reaches the ladder, so a corrupt 101 lands on
        // "unverified" rather than "confirmed".
        tier: tierOf(confidence),
      };
    })
    // Strongest first; id breaks ties so the same rows render identically in any
    // fetch order. Unusable scores sort last.
    .sort((x, y) => (y.confidence ?? -1) - (x.confidence ?? -1) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

  return {
    state: inputs?.ceilingHit ? "ceiling_hit" : "complete",
    findings,
    rejectedCount: all.length - kept.length,
    totalArtifacts: rows.length,
  };
}

/** Heading both producers use, so the section is findable by one name. */
export const AUTHORITY_HEADING = "Engine-adjudicated findings";

/**
 * The one-sentence status line, owned here so the markdown export and the
 * rendered Report cannot drift into saying different things about the same run.
 *
 * The distinctions are the whole point: "we could not read" is not "there were
 * none", and "the analyst rejected them all" is not "the engine adjudicated
 * nothing" — those two blame opposite parties.
 */
export function authorityStatement(a: AuthoritativeFindings): string {
  if (!a || typeof a !== "object") {
    return "Authoritative finding state unavailable.";
  }
  if (a.state === "retrieval_unavailable") {
    return "Authoritative finding state unavailable: stored artifacts could not be read, so nothing here describes this investigation.";
  }
  if (a.state === "reviews_unavailable") {
    return "Authoritative finding state unavailable: analyst review state could not be read, so recorded findings are withheld rather than risk republishing a rejected one.";
  }
  const ceiling = a.state === "ceiling_hit"
    ? " Artifact retrieval hit its limit, so this may be incomplete."
    : "";
  const n = a.findings?.length ?? 0;
  const rejected = a.rejectedCount ?? 0;
  const total = a.totalArtifacts ?? 0;

  if (n > 0) {
    const excluded = rejected > 0
      ? ` ${rejected} further recorded finding${rejected === 1 ? " was" : "s were"} excluded by analyst review.`
      : "";
    return `The scoring engine adjudicated ${n} finding${n === 1 ? "" : "s"} on this case.${excluded}${ceiling}`;
  }
  if (rejected > 0) {
    return `No adjudicated findings remain after analyst review: ${rejected} recorded finding${rejected === 1 ? " was" : "s were"} dismissed or marked wrong.${ceiling}`;
  }
  return `The scoring engine adjudicated no findings on this case. ${total} artifact${total === 1 ? " was" : "s were"} collected; everything below is a lead, not an adjudicated finding.${ceiling}`;
}
