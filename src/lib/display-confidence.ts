/**
 * display-confidence.ts — THE one number an analyst reads.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Artifact confidence reached the screen through FIVE mutually inconsistent
 * pipelines, mapped on 21c3403:
 *
 *   1. raw `a.confidence`                    Evidence board figure + rule + peek +
 *                                            drawer + citation, Timeline, Overview,
 *                                            Graph node numeral + meter, cluster and
 *                                            band ranges, AnalysisTab
 *   2. `adjustedConfidence(a, review)`       EvidenceMatrixTab, unconditionally
 *   3. `review ? adjustedConfidence : raw`   CaseReport `confOf`, intel.ts:1195
 *   4. `min(stored, cap)`                    `effectiveFindingConfidence`, engine
 *                                            findings only
 *   5. `explainConfidence(a).final`          a full re-derivation from source tier,
 *                                            corroboration and recency that never
 *                                            reads `a.confidence` at all — rendered
 *                                            as the headline of the ConfidenceExplain
 *                                            popover, which is mounted on every board
 *                                            row, inches from pipeline 1's number
 *
 * The visible consequence: `j.harker@northgate-logistics.com` read 88 on the
 * Evidence board and 93 on the Evidence table, in one session, with no analyst
 * action — and inside a single EvidenceMatrixTab tile the bar width came from
 * pipeline 1 while the numeral beside it came from pipeline 2. A workspace that
 * reports three different numbers for one row cannot be trusted about any of them.
 *
 * THE CONTRACT (operator-approved 2026-08-31)
 * -------------------------------------------
 *   effective = cap === null ? stored : min(stored, cap)
 *
 * and nothing else. No bonuses. No review deltas. `confidence_cap_applied` is
 * the server's own statement about what this row's evidence can support — it is
 * computed once, server-side, by `countIndependentClasses` over the authoritative
 * source taxonomy — so the client's job is to render it, not to have a second
 * opinion about it.
 *
 * WHY NOT A NEW FUNCTION. This is `effectiveFindingConfidence`
 * (authoritative-findings.ts:138) generalised from `kind='finding'` rows to every
 * row. That function was already correct, already tested, already handled a cap
 * of 0 — and had zero callers. The change is promoting it, not inventing.
 *
 * A CAP OF 0 IS LEGITIMATE AND IS HONOURED. `usableScore` type-checks and
 * range-checks rather than testing truthiness, and every comparison here is
 * `=== null`. Rewriting any of them as `cap ? … : …` or `cap ?? stored` silently
 * un-caps every 0-capped row and breaks exactly one test.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 *   - It never mutates or writes back `a.confidence`. `stored` is reported
 *     alongside `effective` precisely so the inspector can show both.
 *   - It does not fold in the quarantine or possible-minor ceilings. Those are
 *     reported in `ceilings` so the inspector can disclose them, but authority is
 *     carried by the authority CHIP (`authorityFor` -> `isClusterIneligible`) and
 *     by the LABEL (`labelForArtifact`, which still applies both ceilings). A
 *     number is evidence; authority is a state. Conflating them is how a
 *     quarantined row ended up with a confident-looking figure in the first place.
 *   - It does not apply analyst review deltas. A confirmation is a decision, not
 *     new evidence, and folding +20 into the figure is exactly the laundering the
 *     calibration milestone warns against: it makes review labels useless as
 *     ground truth. Review remains a state chip.
 */
import { recordedConfidenceCap } from "@/lib/authoritative-findings";
import { isQuarantined } from "@/lib/quarantine";

/** The structural shape this module reads. `Artifact` is assignable. */
export type ConfidenceInput = {
  confidence?: number | null;
  metadata?: Record<string, unknown> | null;
};

export type CeilingKind = "recorded" | "quarantine" | "possible_minor";

export type ConfidenceCeiling = {
  kind: CeilingKind;
  value: number;
  /** Why this ceiling applies, in words the inspector can render verbatim. */
  reason: string;
};

export type DisplayConfidence = {
  /** The value as persisted. Never mutated, and always available for disclosure. */
  stored: number | null;
  /** `metadata.confidence_cap_applied`, when it is a usable 0-100 number. */
  cap: number | null;
  /** The server's recorded justification for the cap, when it wrote one. */
  capReason: string | null;
  /** EVERY ceiling that applies to this row, for the inspector. See the note above
   *  on why only `recorded` participates in `effective`. */
  ceilings: ConfidenceCeiling[];
  /** THE number. Every surface renders this and nothing else. */
  effective: number | null;
  /** True when the cap actually lowered the displayed value. */
  clamped: boolean;
};

const QUARANTINE_DISPLAY_CEILING = 55;
const POSSIBLE_MINOR_DISPLAY_CEILING = 55;

function usable(x: unknown): number | null {
  if (typeof x !== "number" || !Number.isFinite(x)) return null;
  if (x < 0 || x > 100) return null;
  return x;
}

function readString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * The full disclosure record for one artifact's confidence.
 *
 * Total by construction: unreadable metadata yields `cap: null` and falls back to
 * the stored value, and an unreadable stored value yields `effective: null` so a
 * surface can render an em dash instead of a fabricated zero.
 */
export function displayConfidence(a: ConfidenceInput | null | undefined): DisplayConfidence {
  const meta = (a?.metadata ?? {}) as Record<string, unknown>;
  const stored = usable(a?.confidence);
  const cap = recordedConfidenceCap(meta);
  const capReason = readString(meta.reason_for_confidence);

  const ceilings: ConfidenceCeiling[] = [];
  if (cap !== null) {
    ceilings.push({
      kind: "recorded",
      value: cap,
      reason: capReason ?? "the server capped this row's source classes",
    });
  }
  // Disclosed, never applied — see the module note. Both are authority states,
  // and both are already enforced on the LABEL by `labelForArtifact`.
  if (isQuarantined(meta)) {
    ceilings.push({
      kind: "quarantine",
      value: QUARANTINE_DISPLAY_CEILING,
      reason:
        readString(meta.subject_unlinked_reason) ??
        "harvested from a name-only query — linkage to the subject is unproven",
    });
  }
  if (meta.possible_minor === true) {
    ceilings.push({
      kind: "possible_minor",
      value: POSSIBLE_MINOR_DISPLAY_CEILING,
      reason: "possible-minor signal — this row can never auto-promote",
    });
  }

  // THE FORMULA. `=== null`, never truthiness: a recorded cap of 0 is a real
  // statement and must clamp to 0.
  const effective = stored === null ? null : cap === null ? stored : Math.min(stored, cap);

  return {
    stored,
    cap,
    capReason,
    ceilings,
    effective,
    clamped: stored !== null && effective !== null && effective < stored,
  };
}

/**
 * The number, for the common case where a surface needs nothing else.
 *
 * Returns `null` for an unreadable stored value so callers can render an em dash.
 * Use `displayConfidenceOrZero` only where the surrounding layout genuinely
 * cannot express "unknown" (a meter width, a sort key).
 */
export function effectiveConfidence(a: ConfidenceInput | null | undefined): number | null {
  return displayConfidence(a).effective;
}

/** `effectiveConfidence`, floored to 0 — for meter widths and sort comparators,
 *  which need a number and for which "unknown" and "zero" sort the same way. */
export function effectiveConfidenceOrZero(a: ConfidenceInput | null | undefined): number {
  return effectiveConfidence(a) ?? 0;
}
