import type { Artifact } from "@/hooks/useThreadArtifacts";
import {
  labelForArtifact,
  buildIdentityClusters,
  isBreachSource,
  isUsernameSweepSource,
  type ReviewAdjustment,
} from "@/lib/intel";
import { isCollisionArtifact } from "@/lib/report-hygiene";

/**
 * Confidence-dimension transform — PURE and DETERMINISTIC (pass `nowMs` to keep
 * recency deterministic in tests).
 *
 * Produces a small set of evidence-signal axes for the radar chart. This is an
 * HONEST SUMMARY OF AVAILABLE SIGNALS, not a scientific score: every axis has a
 * plain `reason`, thin data yields low/neutral values with `sufficient: false`
 * ("insufficient data") rather than fake precision, and the conflict axis is
 * inverted to "Conflict-free" so a larger shape always reads as stronger.
 *
 * It reuses existing confidence/label/cluster helpers READ-ONLY — it changes no
 * backend math, clustering, or artifact semantics.
 */

export interface ConfidenceDimension {
  key: string;
  label: string;
  value: number; // 0-100 — larger = stronger evidence on this axis
  sufficient: boolean; // false → not enough data; render as "insufficient"
  reason: string; // how this value was derived (shown in the accessible list)
}

/**
 * Plain-language definition of what each confidence axis MEASURES (keyed by the
 * dimension `key` below). Distinct from a dimension's per-case `reason`, which
 * explains how the current value was derived — these explain the axis itself so
 * a label like "Report readiness" or "Conflict-free" is never unexplained.
 */
export const DIMENSION_DEFINITIONS: Record<string, string> = {
  identity: "How strongly the evidence converges on one real-world identity — the confidence of the strongest identity cluster.",
  selectors: "Coverage of strong, pivotable selectors (email, phone, handle, domain, address, wallet). More distinct types = a firmer base.",
  corroboration: "Share of findings backed by ≥2 independent source classes rather than a single source.",
  diversity: "How many distinct source families contributed — breadth guards against one source skewing the picture.",
  recency: "Freshness of the newest evidence. Older data is more likely to be stale or superseded.",
  conflictFree: "Absence of conflicts, collisions, and unverified breach indicators. Higher = fewer contradictions to resolve.",
  readiness: "Share of findings that are verified or corroborated (report-safe). Low means most findings still need review before reporting.",
};

export interface ConfidenceProfile {
  dimensions: ConfidenceDimension[];
  overall: number; // 0-100, mean of the axes
  artifactCount: number;
  conflictCount: number;
  reportReady: boolean;
  /** Too little evidence for a meaningful chart at all. */
  limited: boolean;
}

const REPORT_SAFE_LABELS = new Set(["CONFIRMED", "CORRELATED"]);
const IDENTITY_KINDS = new Set(["name", "person", "email", "phone"]);
const DAY = 24 * 60 * 60 * 1000;
const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/** Distinct source CLASSES backing an artifact (breach/sweep collapsed, others
 * keyed by their first token) — mirrors the corroboration logic used elsewhere. */
function sourceClasses(a: Artifact): Set<string> {
  const meta = (a.metadata ?? {}) as Record<string, unknown>;
  const metaSources = Array.isArray(meta.sources) ? (meta.sources as string[]) : [];
  const all = [a.source, ...metaSources].filter(Boolean) as string[];
  return new Set(
    all.map((s) => (isBreachSource(s) ? "breach" : isUsernameSweepSource(s) ? "sweep" : s.toLowerCase().split(/[_:.]/)[0])),
  );
}

/** Which strong selector TYPE (if any) an artifact contributes. */
function selectorType(a: Artifact): string | null {
  const k = a.kind.toLowerCase();
  const meta = (a.metadata ?? {}) as Record<string, unknown>;
  if (k === "email") return "email";
  if (k === "phone") return "phone";
  if (k === "username" || k === "handle" || k === "social" || (typeof meta.handle === "string" && meta.handle.trim())) return "handle";
  if (k === "domain" || k === "subdomain") return "domain";
  if (k === "address") return "address";
  if (k === "wallet" || k === "crypto_wallet" || k === "crypto") return "wallet";
  return null;
}

function isConflicted(a: Artifact): boolean {
  const m = (a.metadata ?? {}) as Record<string, unknown>;
  const k = a.kind.toLowerCase();
  return isCollisionArtifact(a) || m.conflict === true || m.collision === true || m.false_positive === true || k === "breach" || k.endsWith("_conflict");
}

export function buildConfidenceProfile(input: {
  artifacts: Artifact[];
  seedValue: string | null;
  reviews?: Record<string, ReviewAdjustment>;
  nowMs?: number;
}): ConfidenceProfile {
  const { artifacts, seedValue } = input;
  const reviews = input.reviews ?? {};
  const nowMs = input.nowMs ?? Date.now();
  const total = artifacts.length;
  const rev = (a: Artifact): ReviewAdjustment => reviews[a.id];

  const conflicts = artifacts.filter(isConflicted);
  const conflictCount = conflicts.length;
  const live = artifacts.filter((a) => !isConflicted(a));

  // ── Identity ─────────────────────────────────────────────────────────
  const clusters = buildIdentityClusters(artifacts, seedValue).clusters;
  const topCluster = clusters.reduce((m, c) => Math.max(m, c.confidence), 0);
  const identityBearing = artifacts.filter((a) => IDENTITY_KINDS.has(a.kind.toLowerCase())).length;
  const identity: ConfidenceDimension = clusters.length
    ? { key: "identity", label: "Identity", value: clamp(topCluster), sufficient: true, reason: `Strongest identity cluster at ${Math.round(topCluster)}% (${clusters.length} cluster${clusters.length === 1 ? "" : "s"})` }
    : identityBearing > 0
      ? { key: "identity", label: "Identity", value: clamp(20 + Math.min(20, identityBearing * 5)), sufficient: false, reason: `${identityBearing} identity finding${identityBearing === 1 ? "" : "s"}, none corroborated into a cluster yet` }
      : { key: "identity", label: "Identity", value: 0, sufficient: false, reason: "No identity evidence yet" };

  // ── Selectors ────────────────────────────────────────────────────────
  const selTypes = new Set<string>();
  for (const a of live) { const t = selectorType(a); if (t) selTypes.add(t); }
  const SELECTOR_SCORE = [0, 35, 55, 70, 82, 92, 100];
  const selectors: ConfidenceDimension = {
    key: "selectors",
    label: "Selectors",
    value: SELECTOR_SCORE[Math.min(selTypes.size, 6)],
    sufficient: selTypes.size > 0,
    reason: selTypes.size ? `${selTypes.size} selector type${selTypes.size === 1 ? "" : "s"}: ${[...selTypes].join(", ")}` : "No strong selectors (email / phone / handle / domain / address / wallet) yet",
  };

  // ── Corroboration (≥2 independent source classes) ────────────────────
  const multiSource = live.filter((a) => sourceClasses(a).size >= 2).length;
  const corroboration: ConfidenceDimension = {
    key: "corroboration",
    label: "Corroboration",
    value: live.length ? clamp((multiSource / live.length) * 100) : 0,
    sufficient: live.length >= 2,
    reason: live.length ? `${multiSource} of ${live.length} findings backed by ≥2 independent source classes` : "Too few findings to assess corroboration",
  };

  // ── Source diversity (distinct source families) ──────────────────────
  const families = new Set<string>();
  for (const a of live) for (const c of sourceClasses(a)) families.add(c);
  const diversity: ConfidenceDimension = {
    key: "diversity",
    label: "Source diversity",
    value: clamp(Math.min(6, families.size) * (100 / 6)),
    sufficient: families.size > 0,
    reason: families.size ? `${families.size} distinct source famil${families.size === 1 ? "y" : "ies"} contributed` : "No source families recorded",
  };

  // ── Recency (freshness of the newest evidence) ───────────────────────
  const ages = artifacts
    .map((a) => Date.parse(a.created_at))
    .filter((t) => Number.isFinite(t))
    .map((t) => (nowMs - t) / DAY);
  const newest = ages.length ? Math.min(...ages) : null;
  const recencyScore = (days: number) => (days <= 2 ? 100 : days <= 7 ? 85 : days <= 30 ? 65 : days <= 90 ? 45 : days <= 365 ? 25 : 10);
  const recency: ConfidenceDimension = newest == null
    ? { key: "recency", label: "Recency", value: 30, sufficient: false, reason: "No timestamps available to assess freshness" }
    : { key: "recency", label: "Recency", value: recencyScore(newest), sufficient: true, reason: `Most recent evidence ${newest < 1 ? "under a day" : `${Math.round(newest)} day${Math.round(newest) === 1 ? "" : "s"}`} old` };

  // ── Conflict-free (inverted conflict risk) ───────────────────────────
  const conflictFree: ConfidenceDimension = {
    key: "conflictFree",
    label: "Conflict-free",
    value: total ? clamp((1 - conflictCount / total) * 100) : 100,
    sufficient: total > 0,
    reason: conflictCount ? `${conflictCount} conflict / collision / breach indicator${conflictCount === 1 ? "" : "s"} among ${total} findings` : "No conflicts or collisions detected",
  };

  // ── Report readiness (verified / corroborated share) ─────────────────
  const reportSafe = artifacts.filter((a) => {
    const r = rev(a);
    if (r === "confirmed" || r === "key") return true;
    return REPORT_SAFE_LABELS.has(labelForArtifact(a, r));
  }).length;
  const readinessValue = total ? clamp((reportSafe / total) * 100) : 0;
  const readiness: ConfidenceDimension = {
    key: "readiness",
    label: "Report readiness",
    value: readinessValue,
    sufficient: total >= 1,
    reason: total ? `${reportSafe} of ${total} findings verified or corroborated (report-safe)` : "No findings to report yet",
  };

  const dimensions = [identity, selectors, corroboration, diversity, recency, conflictFree, readiness];
  const overall = clamp(dimensions.reduce((s, d) => s + d.value, 0) / dimensions.length);
  // Report-ready = a real verified/corroborated base AND conflicts under control.
  const reportReady = readinessValue >= 60 && conflictFree.value >= 60 && identity.sufficient;

  return {
    dimensions,
    overall,
    artifactCount: total,
    conflictCount,
    reportReady,
    limited: total < 3,
  };
}
