import type { Artifact } from "@/hooks/useThreadArtifacts";
import type { ReviewState } from "@/lib/review";
import { extractSourceInfo, independentSourceClasses } from "@/lib/intel";
import { displayConfidence } from "@/lib/display-confidence";
import { authorityFor } from "@/lib/authority";
import { isDateableBreachKind } from "./breach-kinds";

/**
 * One line of the "Why this score?" disclosure. `value` is what the row
 * RECORDED (a stored score, a cap, a class count, an authority state) — never a
 * signed contribution. It is empty for a pure state disclosure such as an
 * analyst decision, which changes authority, not the number.
 */
export type ConfidenceComponent = {
  label: string;
  value: string;
  why: string;            // analyst-facing rationale
};

export type ConfidenceExplanation = {
  /** The stored score, or null when none usable was recorded. */
  raw: number | null;
  /** The canonical effective score (`displayConfidence(a).effective`). */
  final: number | null;
  components: ConfidenceComponent[];
  badges: TrustBadge[];   // matrix-style trust badges
};

export type TrustBadge = {
  key: "multi-source" | "single-source" | "stale-breach" | "fresh" | "analyst-confirmed" | "analyst-dismissed";
  label: string;
  tone: "high" | "mid" | "low" | "neutral";
  hint: string;
};

const DAY = 86_400_000;

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Disclose what a stored artifact confidence RECORDS. This is deterministic and
 * makes no model call, and it deliberately does not re-derive a score.
 *
 * The previous version rebuilt a total from a hardcoded provider-tier table,
 * +6/-8 corroboration arithmetic, recency deltas and a -50 false-positive
 * penalty. The server wrote none of those, so the popover could explain a number
 * the row did not carry (64 beside a stored 50, capped to 50). `final` is now the
 * canonical `displayConfidence(a).effective`, and every component is a fact the
 * row recorded or a state the product derives from it (authority).
 */
export function explainConfidence(a: Artifact, review?: ReviewState): ConfidenceExplanation {
  const src = extractSourceInfo(a);
  const meta = (a.metadata ?? {}) as Record<string, unknown>;
  const score = displayConfidence(a);
  const authority = authorityFor(a, review);

  // Source classes count only when the row RECORDED them. Without a recorded
  // `source_category`, `independentSourceClasses` falls back to a coarse split of
  // provider strings for legacy rows — and provider names do not establish
  // independence, so that fallback is not shown as a count.
  const category = meta.source_category;
  const hasRecordedClasses =
    typeof category === "string"
      ? Boolean(category.trim())
      : Array.isArray(category) && category.length > 0 && category.every((c) => typeof c === "string" && c.trim());
  const classes = hasRecordedClasses ? independentSourceClasses(a) : [];

  const rationale = text(meta.reason_for_confidence);
  const components: ConfidenceComponent[] = [
    {
      label: "Stored machine score",
      value: score.stored === null ? "Unknown" : `${score.stored}/100`,
      why: score.stored === null ? "A usable score was not recorded." : "The score persisted with this observation.",
    },
    {
      label: "Recorded cap",
      value: score.cap === null ? "Not recorded" : `${score.cap}/100`,
      why:
        score.cap === null
          ? "No usable numeric cap is recorded on this row."
          : score.capReason ?? "The row records this limit; its reason is not recorded.",
    },
    {
      label: "Independent source classes",
      value: hasRecordedClasses ? String(classes.length) : "Not recorded",
      why: !hasRecordedClasses
        ? "Source classes were not recorded. Provider names alone do not establish independence."
        : classes.length > 0
        ? `Classes: ${classes.join(", ")}. Providers repeating one class do not add independent support. This count does not establish identity.`
        : "No qualifying class was identified by the existing source taxonomy for this row.",
    },
    {
      label: "Subject authority",
      value: authority.label,
      why: authority.caveat ?? authority.hint,
    },
  ];

  // A cap already carries the server's reason on its own line; repeating it here
  // would print one sentence twice.
  if (rationale && score.cap === null) {
    components.push({ label: "Recorded rationale", value: "", why: rationale });
  }

  const conflictNote = text(meta.conflict_note);
  if (meta.conflict === true || conflictNote) {
    components.push({
      label: "Recorded contradiction",
      value: "",
      why: conflictNote ?? "This row is marked as conflicting; details were not recorded.",
    });
  }

  // Analyst decision — DISCLOSED, NEVER SCORED. A decision changes authority,
  // priority or workflow state; the number it sits beside is the evidence's.
  if (review === "confirmed") {
    components.push({
      label: "Analyst confirmed",
      value: "",
      why: "Analyst decision recorded. The machine score is unchanged; linkage restrictions still apply.",
    });
  } else if (review === "key") {
    components.push({
      label: "Marked key",
      value: "",
      why: "Prioritised by the analyst for the next run. The machine score is unchanged.",
    });
  } else if (review === "recheck") {
    components.push({
      label: "Recheck requested",
      value: "",
      why: "Verification requested for the next run. The machine score is unchanged.",
    });
  } else if (review === "dismissed" || review === "wrong") {
    components.push({
      label: "Rejected by analyst",
      value: "",
      why: "Excluded from subject conclusions. The original score is preserved.",
    });
  }

  return { raw: score.stored, final: score.effective, components, badges: badgesFor(a, src, review) };
}

function badgesFor(
  a: Artifact,
  src: ReturnType<typeof extractSourceInfo>,
  review?: ReviewState,
): TrustBadge[] {
  const out: TrustBadge[] = [];
  // Honest independence: distinct SOURCE CLASSES that can independently
  // corroborate, not provider count. Two breach aggregators mirroring one
  // underlying corpus count as ONE class; a cluster of ai_summary-only
  // sources counts as ZERO. See src/lib/intel.ts independentSourceClasses.
  // Previously `src.all.length` labelled "Multi-source corroborated" the
  // moment two providers echoed the same breach — which is not corroboration.
  const classes = independentSourceClasses(a);
  const providerCount = src.all.length;
  if (classes.length >= 2) {
    out.push({ key: "multi-source", label: `Independent sources: ${classes.length}`, tone: "high",
      hint: `${classes.length} distinct source classes corroborate independently (${classes.join(", ")}). Not simply ${providerCount} provider${providerCount === 1 ? "" : "s"} — providers mirroring one corpus count as one class.` });
  } else if (classes.length === 1 && providerCount >= 2) {
    out.push({ key: "single-source", label: "One source class", tone: "mid",
      hint: `${providerCount} providers reported this, but they share one source class (${classes[0]}). Mirrors of one corpus are not independent corroboration.` });
  } else {
    out.push({ key: "single-source", label: "Single-source", tone: "mid",
      hint: "Only one source class so far — promote after independent corroboration." });
  }

  // isDateableBreachKind, NOT isBreachKind: a collapsed breach_exposure row spans
  // many corpora with many dates, so ageing it as one record would assert
  // something the row does not know.
  if (a.created_at && isDateableBreachKind(a.kind)) {
    const age = Date.now() - new Date(a.created_at).getTime();
    if (age > 365 * DAY) {
      out.push({ key: "stale-breach", label: "Stale breach", tone: "low",
        hint: "Breach record older than 12 months — credentials may be rotated." });
    }
  }

  if (a.created_at && Date.now() - new Date(a.created_at).getTime() < DAY) {
    out.push({ key: "fresh", label: "Fresh", tone: "neutral", hint: "Captured in the last 24 hours." });
  }

  if (review === "confirmed" || review === "key") {
    out.push({ key: "analyst-confirmed", label: "Analyst confirmed", tone: "high",
      hint: "Reviewed and accepted by analyst." });
  } else if (review === "dismissed" || review === "wrong") {
    out.push({ key: "analyst-dismissed", label: "Analyst dismissed", tone: "low",
      hint: "Excluded from conclusions." });
  }

  return out;
}

export const BADGE_TONE_CLASS: Record<TrustBadge["tone"], string> = {
  high:    "text-[hsl(var(--confidence-high))] border-[hsl(var(--confidence-high))]/40 bg-[hsl(var(--confidence-high))]/10",
  mid:     "text-[hsl(var(--confidence-mid))] border-[hsl(var(--confidence-mid))]/40 bg-[hsl(var(--confidence-mid))]/10",
  low:     "text-[hsl(var(--confidence-low))] border-[hsl(var(--confidence-low))]/40 bg-[hsl(var(--confidence-low))]/10",
  neutral: "text-muted-foreground border-border-subtle bg-surface-2",
};