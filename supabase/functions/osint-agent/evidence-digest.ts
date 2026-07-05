/**
 * evidence-digest.ts — compact artifact summary for the planner prompt.
 *
 * When an investigation accumulates many artifacts, JSON.stringify(artifacts)
 * blows the planner user prompt. buildEvidenceDigest keeps the highest-signal
 * rows (kind, confidence, truncated value) within a fixed item budget.
 */

export type EvidenceDigestArtifact = {
  kind: string;
  value: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
};

function suppressedFromMetadata(metadata: Record<string, unknown> | undefined): number | null {
  if (!metadata || typeof metadata !== "object") return null;
  for (const key of ["suppressed", "suppressed_count", "artifacts_suppressed"] as const) {
    const v = metadata[key];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v);
  }
  return null;
}

function formatConfidence(confidence: number | undefined): string {
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return "?";
  return confidence.toFixed(2);
}

/**
 * Build a compact, line-oriented digest of artifacts for the planner LLM.
 * Sorted by confidence descending; capped at `maxItems` rows.
 */
export function buildEvidenceDigest(
  artifacts: EvidenceDigestArtifact[],
  maxItems = 15,
): string {
  if (!artifacts.length) return "(none)";

  const ranked = [...artifacts].sort((a, b) => {
    const ca = typeof a.confidence === "number" ? a.confidence : -1;
    const cb = typeof b.confidence === "number" ? b.confidence : -1;
    return cb - ca;
  });

  const shown = ranked.slice(0, maxItems);
  const lines: string[] = [];
  let aggregateSuppressed = 0;

  for (const a of shown) {
    const val = String(a.value ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    const kind = String(a.kind ?? "unknown");
    const suppressed = suppressedFromMetadata(a.metadata);
    if (suppressed != null) aggregateSuppressed += suppressed;
    const suffix = suppressed != null ? ` (+${suppressed} suppressed)` : "";
    lines.push(`- [${kind}:${formatConfidence(a.confidence)}] ${val}${suffix}`);
  }

  const omitted = artifacts.length - shown.length;
  const footer: string[] = [];
  if (omitted > 0) {
    footer.push(`(${omitted} more artifacts omitted — retrieve via memory_recall)`);
  }
  if (aggregateSuppressed > 0 && !lines.some((l) => l.includes("suppressed"))) {
    footer.push(`(${aggregateSuppressed} low-relevance artifact(s) suppressed during harvest)`);
  }

  return footer.length ? `${lines.join("\n")}\n${footer.join("\n")}` : lines.join("\n");
}
