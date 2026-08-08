import type { Artifact } from "@/hooks/useThreadArtifacts";
import type { ReviewState } from "@/lib/review";
import { extractSourceInfo } from "@/lib/intel";
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
 * Read the SERVER-COMPUTED source-class ceiling off an artifact.
 *
 * `confidence_cap_applied` is written by `applyEvidenceCaps` on every write path
 * (record_artifacts, the auto-persist backstop, and the tool auto-insert shim) and
 * is the authoritative limit on what a given source class can support. The stored
 * `artifacts.confidence` already respects it — verified across a full production
 * run: 81 artifacts, zero rows where `confidence > confidence_cap_applied`.
 *
 * This decomposition did NOT respect it. It rebuilt a score client-side from its
 * own source tiers and deltas and clamped only to 0–100, so the number an analyst
 * READS could sit above the ceiling the server had already applied — e.g. a
 * breach-class row capped at 60 displaying 80 once confirmed. The stored evidence
 * was right and the surface was wrong, which is the worse way round: the analyst
 * only ever sees the surface.
 *
 * Returns null when the artifact carries no cap (older rows predating the field),
 * leaving those scores exactly as before.
 */
function serverConfidenceCap(meta: Record<string, unknown>): number | null {
  const raw = meta.confidence_cap_applied;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

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

  // 6) Source-class ceiling — the server's cap is authoritative and binds LAST.
  // Deliberately a ceiling, not a target: it can only pull a score down, so a
  // dismissal or false-positive penalty still lands below it. Pushed as a real
  // component with the exact shortfall as its delta, so the popover's arithmetic
  // still reconciles to the number in the header AND the analyst can see why
  // Confirm did not move the score — without this the button reads as broken.
  // The ceiling is the tighter of the 0–100 display range and the server's cap.
  // Both are applied as REAL components carrying the exact shortfall, so the
  // popover's list always reconciles to the number in its header. Previously the
  // 0–100 clamp was applied silently after the reduce, so a score that saturated
  // showed a component list that did not add up to the total on display.
  const rawSum = components.reduce((s, c) => s + c.delta, 0);
  const cap = serverConfidenceCap(meta);
  const ceiling = cap == null ? 100 : Math.min(100, cap);
  if (rawSum > ceiling) {
    components.push(
      cap != null && cap <= 100
        ? {
          label: `Source-class ceiling (${cap})`,
          delta: ceiling - rawSum,
          why:
            `This artifact's source class supports at most ${cap}/100. Corroboration from an ` +
            `INDEPENDENT source class is what lifts the ceiling — analyst review and recency cannot.`,
        }
        : {
          label: "Score ceiling (100)",
          delta: ceiling - rawSum,
          why: "Confidence is reported on a 0–100 scale.",
        },
    );
  } else if (rawSum < 0) {
    components.push({
      label: "Score floor (0)",
      delta: -rawSum,
      why: "Confidence is reported on a 0–100 scale.",
    });
  }
  const final = Math.max(0, Math.min(ceiling, rawSum));
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