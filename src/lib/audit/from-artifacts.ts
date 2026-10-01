/**
 * Adapter: real investigation artifacts → the audit pipeline's input shapes.
 *
 * The audit libs (source-independence, confidence-linter) were written against
 * the ReportCardV2 preview's hand-authored fixtures. This bridges them to live
 * `artifacts` so the SHIPPING report gets honest, de-duplicated source counts.
 *
 * Faithfulness rules (these directly drive the numbers a user sees, so they are
 * deliberately conservative and unit-tested):
 *  - A breach/leak artifact's `origin` is its breach CORPUS (e.g. "Collection#1").
 *    Many fields lifted from one corpus are ONE source, not many — same origin
 *    collapses in computeEffectiveSourceCount.
 *  - A non-breach artifact's `origin` is its provider/source label, so repeat
 *    hits from the same provider (e.g. 5 minimax_web_search rows) collapse to one.
 *  - Known mirror/aggregator URLs are left to the audit lib's domain logic.
 */
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { buildIdentityClusters, displayKind, type ReviewAdjustment } from "@/lib/intel";
import { effectiveConfidenceOrZero } from "@/lib/display-confidence";
import { tierOf, type ClusterAudit, type ConfidenceFinding } from "./confidence-linter";
import type { IndependenceFinding, Source, SourceType } from "./source-independence";

function meta(a: Artifact): Record<string, unknown> {
  return a.metadata && typeof a.metadata === "object" && !Array.isArray(a.metadata)
    ? (a.metadata as Record<string, unknown>)
    : {};
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Independent source classes for an artifact (metadata.source_category). Mirrors
 *  the same field the report's radar/corroboration metrics read. */
function sourceClasses(a: Artifact): Set<string> {
  const cats = meta(a).source_category;
  const set = new Set<string>();
  if (Array.isArray(cats)) {
    for (const c of cats) if (typeof c === "string" && c.trim()) set.add(c.trim().toLowerCase());
  } else if (typeof cats === "string" && cats.trim()) {
    set.add(cats.trim().toLowerCase());
  }
  return set;
}

const BREACH_KINDS = new Set(["breach", "breach_exposure", "credential_exposure", "leak_paste"]);

export function isBreachArtifact(a: Artifact): boolean {
  if (BREACH_KINDS.has(a.kind.toLowerCase())) return true;
  const cls = sourceClasses(a);
  return cls.has("breach") || cls.has("threat_intel");
}

export function classifySourceType(a: Artifact): SourceType {
  const cls = sourceClasses(a);
  const label = (a.source ?? "").toLowerCase();
  const url = (urlOf(a) ?? "").toLowerCase();
  if (isBreachArtifact(a)) return "breach";
  if (cls.has("court_record") || label.includes("court")) return "court";
  if (cls.has("public_record") || label.includes("registry") || label.includes("opencorporates")) return "registry";
  if (cls.has("news")) return "news";
  if (cls.has("social_profile_passive") || cls.has("social")) return "social";
  if (url.includes("scribd")) return "scribd";
  if (url.includes("pastebin") || url.includes("ghostbin")) return "pastebin";
  if (label.includes("github") || url.includes("github.com")) return "github";
  return "unknown";
}

function urlOf(a: Artifact): string | undefined {
  const m = meta(a);
  return str(m.url) ?? str(m.link) ?? str(m.profile_url) ?? str(m.source_url);
}

/** The upstream source IDENTITY used to collapse duplicates. Breach corpus for
 *  breach artifacts (many fields from one leak = one source); provider/source
 *  label otherwise (repeat provider hits = one source). */
export function originOf(a: Artifact): string | undefined {
  const m = meta(a);
  if (isBreachArtifact(a)) {
    const corpus =
      str(m.breach_source) ?? str(m.breach) ?? str(m.database) ?? str(m.dataset) ?? str(m.breach_name);
    if (corpus) return `breach:${corpus.toLowerCase()}`;
  }
  const provider = str(a.source) ?? str(m.provider) ?? str(m.platform);
  return provider ? `src:${provider.toLowerCase()}` : undefined;
}

/** One Source per artifact; computeEffectiveSourceCount/checkIndependence then
 *  collapse by origin (corpus/provider), mirror-pool, and aggregator host. */
function isMinorFlagged(a: Artifact): boolean {
  const m = meta(a);
  return m.possible_minor === true || m.minor_warning === true || String(m.flag ?? "").toUpperCase() === "MINOR_SAFETY_FLAG";
}

export function artifactsToSources(artifacts: Artifact[]): Source[] {
  return artifacts.map((a) => ({
    id: a.id,
    // Message label only. A minor-flagged row never lends its value to a
    // guardrail line (minor-safety is absolute, whatever the reveal setting).
    label: isMinorFlagged(a) ? "(minor-safety redacted)" : str(a.value),
    type: classifySourceType(a),
    origin: originOf(a),
    url: urlOf(a),
    retrievedAt: a.created_at,
    // Effective, not raw: these Source rows feed CaseReport's audit panel and the
    // confidence linter, whose whole job is to compare a declared tier against
    // the evidence beneath it. Comparing a declared tier against UNCAPPED numbers
    // would let a capped row argue for a tier the server had already refused.
    confidence: effectiveConfidenceOrZero(a),
  }));
}

/** Build audit clusters from the report's identity clusters. A cluster's derived
 *  headline confidence is its "declared" tier; the linter flags when that tier
 *  outruns the mean of its evidence cells (honest over-statement / drift) and
 *  blocks "Verified" without ≥2 independent ≥85 sources. */
export function artifactsToClusterAudit(
  artifacts: Artifact[],
  seedValue: string | null,
  /** Analyst verdicts by artifact id. Without these the audit re-clustered rows
   *  the analyst had already dismissed and then linted the result, so a cluster
   *  could be graded — and its tier justified — on evidence that had been struck
   *  out. Optional to keep existing fixture-driven callers working. */
  reviews?: Record<string, ReviewAdjustment>,
): ClusterAudit[] {
  const { clusters } = buildIdentityClusters(artifacts, seedValue, reviews);
  return clusters
    .filter((c) => c.artifacts.length > 0)
    .map((c) => ({
      name: c.label,
      declaredTier: tierOf(c.confidence),
      cells: c.artifacts.map((a) => ({
        claim: displayKind(a),
        value: a.value,
        source: a.source ?? "unknown",
        confidence: effectiveConfidenceOrZero(a),
      })),
    }));
}

export type ReportVerdict = "clean" | "advisory" | "blocked";

/** Roll the confidence-linter + source-independence findings into one honest
 *  report verdict: any linter error → BLOCKED; any warning → ADVISORY; else CLEAN. */
export function reportVerdict(
  confidenceFindings: ConfidenceFinding[],
  independenceFindings: IndependenceFinding[],
): ReportVerdict {
  if (confidenceFindings.some((f) => f.severity === "error")) return "blocked";
  if (
    confidenceFindings.some((f) => f.severity === "warn") ||
    independenceFindings.some((f) => f.severity === "warn")
  ) {
    return "advisory";
  }
  return "clean";
}
