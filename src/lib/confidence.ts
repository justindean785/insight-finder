import type { Artifact } from "@/hooks/useThreadArtifacts";
import type { ReviewState } from "@/lib/review";
import { extractSourceInfo } from "@/lib/intel";

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

type StoredConfidenceBreakdown = {
  raw?: number;
  after_cap?: number;
  ceiling?: number;
  after_relevance?: number;
  geography_penalty?: number;
  contradiction_penalty?: number;
  review_delta?: number;
  final?: number;
};

function isStoredBreakdown(v: unknown): v is StoredConfidenceBreakdown {
  return !!v && typeof v === "object" && typeof (v as StoredConfidenceBreakdown).final === "number";
}

function explainFromStoredBreakdown(
  a: Artifact,
  breakdown: StoredConfidenceBreakdown,
  review?: ReviewState,
): ConfidenceExplanation {
  const components: ConfidenceComponent[] = [];

  if (breakdown.raw != null) {
    components.push({
      label: "Raw score",
      delta: breakdown.raw,
      why: "Tool-reported confidence before server-side caps.",
    });
  }
  if (breakdown.after_cap != null && breakdown.ceiling != null) {
    components.push({
      label: `Source-class cap (${breakdown.ceiling})`,
      delta: breakdown.after_cap - (breakdown.raw ?? breakdown.after_cap),
      why: `Capped to ${breakdown.after_cap} by evidence-class rules (ceiling ${breakdown.ceiling}).`,
    });
  }
  if (breakdown.after_relevance != null) {
    components.push({
      label: "Relevance scale",
      delta: breakdown.after_relevance - (breakdown.after_cap ?? breakdown.after_relevance),
      why: "Scaled by dork/document relevance against the class ceiling.",
    });
  }
  if (breakdown.geography_penalty != null && breakdown.geography_penalty > 0) {
    components.push({
      label: "Geography mismatch",
      delta: -breakdown.geography_penalty,
      why: "Selector resolves in a different geography than the seed cluster.",
    });
  }
  if (breakdown.contradiction_penalty != null && breakdown.contradiction_penalty > 0) {
    components.push({
      label: "Contradiction",
      delta: -breakdown.contradiction_penalty,
      why: "Graph or cluster contradiction lowered confidence.",
    });
  }
  if (breakdown.review_delta != null && breakdown.review_delta !== 0) {
    components.push({
      label: breakdown.review_delta > 0 ? "Analyst review boost" : "Analyst review penalty",
      delta: breakdown.review_delta,
      why: "Applied from your artifact review mark (server-side scoring).",
    });
  } else if (review && review !== "new") {
    // Live review not yet reflected in stored breakdown — show UI delta for transparency.
    if (review === "confirmed") {
      components.push({ label: "Analyst confirmed", delta: 15, why: "Confirm review adds +15." });
    } else if (review === "key") {
      components.push({ label: "Marked key", delta: 18, why: "Promoting an artifact as Key adds +18." });
    } else if (review === "recheck") {
      components.push({ label: "Needs recheck", delta: -12, why: "Recheck flag pulls confidence down until re-verified." });
    } else if (review === "dismissed" || review === "wrong") {
      components.push({ label: "Dismissed", delta: -40, why: "Analyst dismissed/marked false — exclude from conclusions." });
    }
  }

  const final = Math.max(0, Math.min(100, breakdown.final ?? a.confidence ?? 0));
  const src = extractSourceInfo(a);
  return { raw: a.confidence ?? 0, final, components, badges: badgesFor(a, src, review) };
}

/**
 * Decompose a stored artifact confidence into its analyst-readable inputs.
 * This is deterministic — no model call — so it can power "Why this is 60%"
 * popovers without an additional round-trip.
 */
export function explainConfidence(a: Artifact, review?: ReviewState): ConfidenceExplanation {
  const meta = (a.metadata ?? {}) as Record<string, unknown>;
  const stored = meta.confidence_breakdown;
  if (isStoredBreakdown(stored)) {
    return explainFromStoredBreakdown(a, stored, review);
  }

  const src = extractSourceInfo(a);
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

  // 4) Analyst confirmation
  if (review === "confirmed") {
    components.push({ label: "Analyst confirmed", delta: 15, why: "Confirm review adds +15." });
  } else if (review === "key") {
    components.push({ label: "Marked key", delta: 18, why: "Promoting an artifact as Key adds +18 and upgrades the label." });
  } else if (review === "recheck") {
    components.push({ label: "Needs recheck", delta: -12, why: "Recheck flag pulls confidence down until re-verified." });
  } else if (review === "dismissed" || review === "wrong") {
    components.push({ label: "Dismissed", delta: -40, why: "Analyst dismissed/marked false — exclude from conclusions." });
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
  if (src.all.length >= 2) {
    out.push({ key: "multi-source", label: "Multi-source corroborated", tone: "high",
      hint: `Observed across ${src.all.length} sources.` });
  } else {
    out.push({ key: "single-source", label: "Single-source", tone: "mid",
      hint: "Only one source so far — promote after corroboration." });
  }

  if (a.created_at && a.kind.toLowerCase() === "breach") {
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