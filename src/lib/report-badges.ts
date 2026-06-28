/**
 * report-badges.ts — pure, display-only helpers for report/evidence badges.
 *
 * These DO NOT compute or alter confidence, classification, or status — the
 * backend remains the sole authority. They only decide how an already-recorded
 * value is labelled/flagged in the UI. (Audit BUG-4 + the badge requests.)
 */

export type QualConfidence = "HIGH" | "MEDIUM" | "LOW";

/**
 * BUG-4: one mapping from a numeric confidence (0–100) to the HIGH/MEDIUM/LOW
 * vocabulary, so the summary box and the numeric table can never contradict
 * (a 65% row reading "HIGH" was the bug). Bands: ≥80 HIGH, 60–79 MEDIUM, <60 LOW.
 */
export function qualConfidence(score: number | null | undefined): QualConfidence {
  const n = typeof score === "number" && Number.isFinite(score) ? score : 0;
  if (n >= 80) return "HIGH";
  if (n >= 60) return "MEDIUM";
  return "LOW";
}

interface BadgeArtifactLike {
  kind?: string;
  value?: string;
  source?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** High-impact breaches whose exposure warrants a CRITICAL flag even before
 *  any per-record severity is set (financial/demographic full-profile leaks). */
const CRITICAL_BREACH_RE =
  /\b(experian|exactis|national public data|nationalpublicdata|\bnpd\b|equifax|first american|lexisnexis)\b/i;

export type BreachSeverity = "CRITICAL" | "HIGH" | null;

/** Severity badge for a breach_exposure artifact: explicit metadata.severity
 *  wins; otherwise infer CRITICAL from known full-profile breach names. */
export function breachSeverity(a: BadgeArtifactLike): BreachSeverity {
  const sev = String(a.metadata?.severity ?? "").toUpperCase();
  if (sev === "CRITICAL") return "CRITICAL";
  if (sev === "HIGH") return "HIGH";
  const hay = `${a.value ?? ""} ${a.source ?? ""}`;
  if (CRITICAL_BREACH_RE.test(hay)) return "CRITICAL";
  return null;
}

/** A DOB of January 1 (any year) is the classic placeholder/unknown-DOB tell.
 *  Matches ISO `YYYY-01-01`, `01/01[/yyyy]`, and "Jan(uary) 1". */
export function isDobPlaceholder(value: string | null | undefined): boolean {
  const v = (value ?? "").trim();
  if (!v) return false;
  if (/\bplaceholder\b/i.test(v)) return true;
  if (/\d{4}-01-01\b/.test(v)) return true;
  if (/\b01[/-]01([/-]\d{2,4})?\b/.test(v)) return true;
  if (/\bjan(uary)?\.?\s*0?1\b/i.test(v)) return true;
  return false;
}

/** Whether an artifact's provenance is AI-summarized rather than record-sourced. */
export function isAiSummaryArtifact(a: BadgeArtifactLike): boolean {
  const cats = a.metadata?.source_category;
  if (Array.isArray(cats) && cats.some((c) => String(c).toLowerCase() === "ai_summary")) return true;
  if (typeof cats === "string" && cats.toLowerCase() === "ai_summary") return true;
  // Fallback: explicit unverified provenance marker.
  if (String(a.metadata?.provenance ?? "").toLowerCase() === "llm_asserted_unverified") return true;
  return false;
}
