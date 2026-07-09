/**
 * lib/evidence_classify.ts — EVIDENCE GRADING, DERIVED from the C-1 tier system
 * (audit C-3). Replaces the hardcoded `classification: "soft"` that every
 * evidence_log row used to carry, so an analyst can distinguish a court filing
 * (verified) from a single unverified breach mention (weak).
 *
 * TRACEABILITY: the grade is never invented here — it is a pure function of the
 * C-1 cluster tier (lib/cluster.ts `tierFor`/`applyClusteringToThread`, which
 * writes `confidence_tier` + `promoted_confidence` into each artifact's metadata)
 * plus the contradiction signal and (placeholder) user verdict. Ask "why is this
 * verified?" and the answer is "C-1 promoted it to Confirmed (≥90)".
 *
 * INTEGRITY: the grade is stored in a NON-hashed `classification_grade` column
 * (migration 20260709_evidence_classification_grade.sql). The hashed
 * `classification` (hard/soft) that feeds the tamper-evident chain of custody is
 * left untouched, so the end-of-cycle reclassification pass can update the grade
 * WITHOUT recomputing — or breaking — the chain.
 */
import { normEmail, TIERS, tierFor } from "./cluster.ts";

// ---- The enum -----------------------------------------------------------------
export const EVIDENCE_GRADES = [
  "verified", // C-1 tier Confirmed (≥90) OR user-verified
  "probable", // C-1 tier Likely (≥75)
  "weak", // C-1 tier Possible / Weak / Unverified (<75), and the procedural floor
  "contradicted", // contradiction / needs_review / excluded-collision / capped ≤40
  "rejected", // user explicitly rejected (placeholder — feedback loop not built yet)
  "unclassified", // no C-1 cluster result available yet (pre-clustering append)
] as const;
export type EvidenceGrade = (typeof EVIDENCE_GRADES)[number];

export function isEvidenceGrade(x: unknown): x is EvidenceGrade {
  return typeof x === "string" && (EVIDENCE_GRADES as readonly string[]).includes(x);
}

/** `[verified]`, `[contradicted]`, … — the tag rendered next to cited evidence. */
export function gradeTag(grade: EvidenceGrade): string {
  return `[${grade}]`;
}

// ---- Derivation ---------------------------------------------------------------
/** Map a C-1 tier label → grade. This is the ONE place the tier→grade table lives. */
export function gradeFromTier(tier: string | null | undefined): EvidenceGrade {
  switch (tier) {
    case "Confirmed":
      return "verified";
    case "Likely":
      return "probable";
    case "Possible":
    case "Weak":
    case "Unverified":
      return "weak";
    case "Excluded":
      // A collision-excluded artifact is a REJECTED linkage — it's signal ("not
      // this person"), so it surfaces as contradicted rather than being dropped.
      return "contradicted";
    default:
      return "unclassified";
  }
}

export interface GradeSignals {
  /** C-1 metadata.confidence_tier (authoritative when present). */
  confidenceTier?: string | null;
  /** C-1 metadata.promoted_confidence — used to derive a tier when the label is absent. */
  promotedConfidence?: number | null;
  /** contradiction / needs_review / excluded artifact. */
  contradiction?: boolean;
  /** user feedback loop (placeholder — enum values must exist now). */
  userVerified?: boolean;
  userRejected?: boolean;
}

/**
 * Precedence: explicit user verdict > contradiction signal > C-1 tier > derived
 * from promoted_confidence > unclassified. Contradiction beats the tier because
 * C-1 caps a contradicted member at ≤40, so its tier alone (Weak/Unverified)
 * can't be distinguished from a genuinely-weak-but-clean finding.
 */
export function gradeFromSignals(s: GradeSignals): EvidenceGrade {
  if (s.userRejected) return "rejected";
  if (s.userVerified) return "verified";
  if (s.contradiction) return "contradicted";
  if (s.confidenceTier) return gradeFromTier(s.confidenceTier);
  if (typeof s.promotedConfidence === "number" && Number.isFinite(s.promotedConfidence)) {
    return gradeFromTier(tierFor(s.promotedConfidence));
  }
  return "unclassified";
}

// ---- Artifact adapters --------------------------------------------------------
export interface ArtifactLike {
  id?: string;
  kind?: string | null;
  value?: string | null;
  confidence?: number | null;
  metadata?: Record<string, unknown> | null;
}

/** True when the artifact represents a contradiction / needs-review / exclusion. */
export function contradictionSignal(a: ArtifactLike): boolean {
  const kind = String(a.kind ?? "");
  if (kind === "contradiction" || kind === "excluded_collision") return true;
  const meta = a.metadata ?? {};
  if (meta.contradiction === true || meta.excluded_collision === true) return true;
  const status = String(meta.status ?? "").toLowerCase();
  return status === "needs_review" || status === "excluded";
}

/** Grade a single artifact from its C-1 metadata + contradiction/user signals. */
export function gradeForArtifact(a: ArtifactLike): EvidenceGrade {
  const meta = a.metadata ?? {};
  return gradeFromSignals({
    confidenceTier: typeof meta.confidence_tier === "string" ? meta.confidence_tier : null,
    promotedConfidence: typeof meta.promoted_confidence === "number" ? meta.promoted_confidence : null,
    contradiction: contradictionSignal(a),
    userVerified: meta.user_verified === true,
    userRejected: meta.user_rejected === true,
  });
}

// ---- Reclassification (pure core) ---------------------------------------------
export interface EvidenceRow {
  id: string;
  artifact_id?: string | null;
  kind?: string | null;
  value?: string | null;
}

/** Comparison key so a procedural tool_query row (artifact_id null) can inherit
 * the grade of the artifact its seed produced. Emails are canonicalized. */
function normValue(v: string | null | undefined): string {
  if (!v) return "";
  const s = String(v).trim().toLowerCase();
  return normEmail(s) ?? s;
}

// Strong-selector kinds may anchor a value→grade match; NAMES and prose never do.
// Matching a procedural row to an artifact by a shared *name* would re-introduce
// the exact cross-person bridge C-1's clustering deliberately refuses (two
// different "Hamza Shakoor"s). An email VALUE is a strong selector regardless of
// the artifact's declared kind.
const STRONG_SELECTOR_KINDS = new Set(["email", "phone", "username", "domain", "account_id"]);
function isStrongAnchor(a: ArtifactLike): boolean {
  const k = String(a.kind ?? "").toLowerCase();
  return STRONG_SELECTOR_KINDS.has(k) || normEmail(String(a.value ?? "")) !== null;
}

// Ascending strength for picking a representative grade when the SAME strong
// selector appears on multiple artifacts.
const STRENGTH: Record<EvidenceGrade, number> = {
  rejected: 0,
  unclassified: 1,
  contradicted: 2,
  weak: 3,
  probable: 4,
  verified: 5,
};
/** Integrity-conservative merge: an active contradiction/rejection on a selector
 * wins over any positive grade, so a procedural row can never claim [verified] on
 * a selector another artifact flags as contradicted. Otherwise the strongest
 * positive grade wins. */
function mergeGrade(prev: EvidenceGrade | undefined, next: EvidenceGrade): EvidenceGrade {
  if (!prev || prev === next) return next;
  for (const flag of ["rejected", "contradicted"] as const) {
    if (prev === flag || next === flag) return flag;
  }
  return STRENGTH[next] > STRENGTH[prev] ? next : prev;
}

/**
 * Pure end-of-cycle reclassification: given the thread's now-clustered artifacts
 * and the evidence rows still needing a grade, return `{id, grade}` for every row.
 * Rows resolve by artifact_id first, then by seed value; a procedural row with no
 * clustered artifact floors to `weak` — never `unclassified` — so a full run +
 * clustering leaves 0 unclassified rows (the C-3 acceptance criterion).
 */
export function computeReclassification(
  arts: ArtifactLike[],
  rows: EvidenceRow[],
): Array<{ id: string; grade: EvidenceGrade }> {
  const byId = new Map<string, EvidenceGrade>();
  const byValue = new Map<string, EvidenceGrade>();
  for (const a of arts) {
    const g = gradeForArtifact(a);
    if (a.id) byId.set(a.id, g);
    // Only STRONG selectors anchor a value match — never bare names (see isStrongAnchor).
    if (isStrongAnchor(a)) {
      const key = normValue(a.value);
      if (key) byValue.set(key, mergeGrade(byValue.get(key), g));
    }
  }
  return rows.map((r) => {
    let g: EvidenceGrade | undefined;
    if (r.artifact_id && byId.has(r.artifact_id)) g = byId.get(r.artifact_id);
    else {
      const key = normValue(r.value);
      if (key && byValue.has(key)) g = byValue.get(key);
    }
    return { id: r.id, grade: g ?? "weak" };
  });
}

// ---- Runtime apply ------------------------------------------------------------
// Minimal structural shape of the supabase client (mirrors lib/cluster.ts) — kept
// `any` on purpose so a precise PostgrestFilterBuilder generic doesn't trip
// TS2589 "excessively deep" at the index.ts call site, and so this stays
// unit-testable with a plain stub. Every value is re-validated at the field level.
// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = { from(table: string): any };

/**
 * Fetch the thread's artifacts + the evidence rows still lacking a grade, derive
 * grades from the (now-available) C-1 tiers, and UPDATE the NON-hashed
 * `classification_grade` column only. Chain-of-custody safe: `classification`,
 * `content_hash`, and `chain_hash` are never touched. Best-effort — a failure
 * here must never fail an otherwise-complete investigation, so callers swallow.
 */
export async function reclassifyThreadEvidence(
  admin: DbLike,
  threadId: string,
): Promise<{ reclassified: number; byGrade: Record<string, number> }> {
  const byGrade: Record<string, number> = {};
  const { data: artData, error: aErr } = await admin.from("artifacts")
    .select("id,kind,value,confidence,metadata").eq("thread_id", threadId);
  if (aErr) return { reclassified: 0, byGrade };

  // Re-grade the WHOLE thread off LIVE state every pass (the grade column is
  // non-hashed, so re-grading is chain-safe). Fetching only null/unclassified rows
  // would freeze a stale grade: a later-discovered contradiction could never DEMOTE
  // a row an earlier pass graded verified. We recompute all rows and write only the
  // ones whose grade actually changed, to avoid needless churn.
  const { data: rowData, error: rErr } = await admin.from("evidence_log")
    .select("id,artifact_id,kind,value,classification_grade")
    .eq("thread_id", threadId);
  if (rErr || !Array.isArray(rowData) || rowData.length === 0) return { reclassified: 0, byGrade };

  const arts: ArtifactLike[] = (Array.isArray(artData) ? artData : []).map((r) => {
    const row = r as { id: string; kind?: string; value?: string; confidence?: number; metadata?: unknown };
    return {
      id: row.id,
      kind: row.kind ?? null,
      value: row.value ?? null,
      confidence: typeof row.confidence === "number" ? row.confidence : null,
      metadata: (row.metadata && typeof row.metadata === "object") ? row.metadata as Record<string, unknown> : {},
    };
  });
  const currentById = new Map<string, string | null>();
  const rows: EvidenceRow[] = rowData.map((r) => {
    const row = r as { id: string; artifact_id?: string | null; kind?: string; value?: string; classification_grade?: string | null };
    currentById.set(row.id, row.classification_grade ?? null);
    return { id: row.id, artifact_id: row.artifact_id ?? null, kind: row.kind ?? null, value: row.value ?? null };
  });

  // Only rows whose derived grade differs from what's stored get written.
  const updates = computeReclassification(arts, rows).filter((u) => u.grade !== currentById.get(u.id));

  // One UPDATE per distinct grade (each carries a batch of ids) — chain-safe,
  // touches only classification_grade; thread_id guard is belt-and-suspenders.
  const idsByGrade = new Map<EvidenceGrade, string[]>();
  for (const u of updates) {
    (idsByGrade.get(u.grade) ?? idsByGrade.set(u.grade, []).get(u.grade)!).push(u.id);
  }
  let reclassified = 0;
  for (const [grade, ids] of idsByGrade) {
    const { error: uErr } = await admin.from("evidence_log")
      .update({ classification_grade: grade }).eq("thread_id", threadId).in("id", ids);
    if (!uErr) {
      reclassified += ids.length;
      byGrade[grade] = (byGrade[grade] ?? 0) + ids.length;
    }
  }
  return { reclassified, byGrade };
}

// Re-export the tier constants so callers can reference thresholds without a
// second import of lib/cluster.ts.
export { TIERS, tierFor };
