/**
 * Confidence-scoring linter.
 *
 * Catches reports where the headline confidence of a cluster exceeds the
 * evidence underneath it. Run before report finalization; `error`-severity
 * findings should block (or auto-downgrade) a report.
 */

export type ConfidenceTier = "Low" | "Medium" | "High" | "Verified";

export const TIER_RANGES: Record<ConfidenceTier, [number, number]> = {
  Low: [0, 40],
  Medium: [41, 70],
  High: [71, 89],
  Verified: [90, 100],
};

export interface EvidenceCell {
  claim: string;
  value: string | number;
  source: string;
  confidence: number; // 0–100
}

export interface ClusterAudit {
  name: string;
  declaredTier: ConfidenceTier;
  cells: EvidenceCell[];
}

export interface ConfidenceFinding {
  severity: "info" | "warn" | "error";
  cluster: string;
  message: string;
  suggestion?: string;
}

export function tierOf(score: number): ConfidenceTier {
  // Lower-bound checks, descending — contiguous so non-integer scores
  // (e.g. a mean of 70.5) never fall through a gap. TIER_RANGES lower bounds
  // remain the single source for these thresholds.
  if (score >= TIER_RANGES.Verified[0]) return "Verified";
  if (score >= TIER_RANGES.High[0]) return "High";
  if (score >= TIER_RANGES.Medium[0]) return "Medium";
  return "Low";
}

const mean = (xs: number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

export function lintCluster(cluster: ClusterAudit): ConfidenceFinding[] {
  const findings: ConfidenceFinding[] = [];
  const scores = cluster.cells.map((c) => c.confidence);

  if (scores.length === 0) {
    findings.push({
      severity: "error",
      cluster: cluster.name,
      message: "Cluster has no evidence cells but declares a confidence tier.",
    });
    return findings;
  }

  const avg = mean(scores);
  const weakest = Math.min(...scores);
  const declaredTierMin = TIER_RANGES[cluster.declaredTier][0];

  // Rule 1 — declared tier exceeds the mean of its underlying cells.
  if (declaredTierMin > avg) {
    findings.push({
      severity: "error",
      cluster: cluster.name,
      message:
        `Declared "${cluster.declaredTier}" (≥${declaredTierMin}) ` +
        `exceeds mean evidence confidence (${avg.toFixed(1)}).`,
      suggestion: `Downgrade to "${tierOf(avg)}" or add corroborating evidence.`,
    });
  }

  // Rule 2 — weakest pillar sits below the declared tier (a claim is only as
  // strong as its weakest supporting cell).
  if (weakest < declaredTierMin) {
    findings.push({
      severity: "warn",
      cluster: cluster.name,
      message:
        `Weakest evidence cell (${weakest}) sits in "${tierOf(weakest)}" tier, ` +
        `below declared "${cluster.declaredTier}".`,
      suggestion: `Strengthen "${cluster.cells.find((c) => c.confidence === weakest)?.claim}" or downgrade.`,
    });
  }

  // Rule 3 — "Verified" requires ≥2 independent sources at ≥85 confidence.
  if (cluster.declaredTier === "Verified") {
    const strong = cluster.cells.filter((c) => c.confidence >= 85);
    const uniqueSources = new Set(strong.map((c) => normalizeSource(c.source)));
    if (uniqueSources.size < 2) {
      findings.push({
        severity: "error",
        cluster: cluster.name,
        message: `"Verified" requires ≥2 independent sources at ≥85 confidence. Found ${uniqueSources.size}.`,
      });
    }
  }

  return findings;
}

export function lintReport(clusters: ClusterAudit[]): ConfidenceFinding[] {
  return clusters.flatMap(lintCluster);
}

/** The tier the evidence actually supports (tier of the mean cell confidence). */
export function effectiveTier(cluster: ClusterAudit): ConfidenceTier {
  if (cluster.cells.length === 0) return "Low";
  return tierOf(mean(cluster.cells.map((c) => c.confidence)));
}

function normalizeSource(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}
