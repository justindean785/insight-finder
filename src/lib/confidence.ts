import type { Artifact } from "@/hooks/useThreadArtifacts";
import type { ReviewState } from "@/lib/review";
import { extractSourceInfo, independentSourceClasses } from "@/lib/intel";
import { isDateableBreachKind } from "./breach-kinds";

/**
 * Source-tier baseline. These map an OSINT source to a default reliability
 * score (0–100). Tuned against JD's working trust order: government &
 * breach corpora ≥ vendor APIs ≥ self-reported social ≥ inference.
 * Unknown sources fall back to 55 — neither trusted nor dismissed.
 */
const SOURCE_TIER: Record<string, number> = {
  // Breach / leak (verified corpora)
  breach_check: 92, leakcheck: 92, hibp: 92, dehashed: 90,
  // Vendor osint aggregators
  osint_industries: 88, deepfind: 85, oathnet: 84,
  intelbase: 80, parallax: 80, osintnova: 78, osint_navigator: 78, cordcat: 75,
  // Infrastructure / domain
  whois: 90, securitytrails: 88, virustotal: 86, urlscan: 84,
  // Email / phone verification
  hunter: 82,
  // Web fetch / scraping
  firecrawl: 70, jina: 68, exa: 72, perplexity: 70, http_fingerprint: 65,
  // Social
  socialfetch: 76, github: 88,
  // Geo
  ipgeolocation: 80,
  // Memory / inference
  memory: 55, inference: 50, agent: 50,
};

function baseFor(source: string | null | undefined): { score: number; label: string } {
  const key = (source ?? "").toLowerCase().replace(/[^a-z0-9_]/g, "_");
  for (const k of Object.keys(SOURCE_TIER)) {
    if (key.includes(k)) return { score: SOURCE_TIER[k], label: k };
  }
  return { score: 55, label: source || "unknown" };
}

export type ConfidenceComponent = {
  label: string;
  delta: number;          // signed contribution
  why: string;            // analyst-facing rationale
};

export type ConfidenceExplanation = {
  raw: number;            // tool-reported confidence as stored
  final: number;          // 0..100 after components, clamped
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

/**
 * Decompose a stored artifact confidence into its analyst-readable inputs.
 * This is deterministic — no model call — so it can power "Why this is 60%"
 * popovers without an additional round-trip.
 */
export function explainConfidence(a: Artifact, review?: ReviewState): ConfidenceExplanation {
  const src = extractSourceInfo(a);
  const meta = (a.metadata ?? {}) as Record<string, unknown>;
  const components: ConfidenceComponent[] = [];

  // 1) Base source reliability
  const base = baseFor(src.primary);
  components.push({
    label: `Source: ${base.label}`,
    delta: base.score,
    why: `Baseline reliability for ${base.label} sources (${base.score}/100).`,
  });

  // 2) Corroboration count — +6 per extra distinct source, cap +18
  const extraSources = Math.max(0, src.all.length - 1);
  if (extraSources > 0) {
    const corro = Math.min(18, extraSources * 6);
    components.push({
      label: `Corroboration ×${src.all.length}`,
      delta: corro,
      why: `Found across ${src.all.length} independent sources. Each additional source adds +6 (cap +18).`,
    });
  } else {
    components.push({
      label: "Single source",
      delta: -8,
      why: "Observed in only one source. Promote to high confidence only after independent corroboration.",
    });
  }

  // 3) Recency
  if (a.created_at) {
    const age = Date.now() - new Date(a.created_at).getTime();
    if (age < 1 * DAY) {
      components.push({ label: "Fresh (<24h)", delta: 4, why: "Captured in the last 24 hours." });
    } else if (age > 30 * DAY) {
      components.push({ label: "Stale (>30d)", delta: -10, why: "Captured more than 30 days ago — re-verify before relying on it." });
    } else if (age > 7 * DAY) {
      components.push({ label: "Aged (>7d)", delta: -4, why: "Captured over a week ago." });
    }
  }

  // 4) Analyst decision — DISCLOSED, NEVER SCORED. These used to carry +15 /
  //    +18 / −12 / −40, which told the analyst their click was a source. A
  //    decision changes authority, priority or workflow state; the number it is
  //    explaining is the evidence's, and stays exactly what the sources support.
  if (review === "confirmed") {
    components.push({ label: "Analyst confirmed", delta: 0, why: "Accepted by the analyst. Authority, not evidence — no score change." });
  } else if (review === "key") {
    components.push({ label: "Marked key", delta: 0, why: "Prioritised by the analyst for the next run. Priority, not confidence — no score change." });
  } else if (review === "recheck") {
    components.push({ label: "Recheck requested", delta: 0, why: "Verification task recorded for the agent's next run. Workflow state, not confidence — no score change." });
  } else if (review === "dismissed" || review === "wrong") {
    components.push({ label: "Rejected by analyst", delta: 0, why: "Excluded from pivots, dispatch, clusters and authoritative sections. The score is unchanged because the row is no longer used, not because it is weaker." });
  }

  // 5) False-positive flag in metadata
  if (meta.false_positive === true) {
    components.push({ label: "False positive", delta: -50, why: "Metadata flag false_positive=true." });
  }

  const final = Math.max(0, Math.min(100, components.reduce((s, c) => s + c.delta, 0)));
  return { raw: a.confidence ?? 0, final, components, badges: badgesFor(a, src, review) };
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