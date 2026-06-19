/**
 * report-hygiene.ts — pure, deterministic helpers for OSINT report rendering.
 *
 * These live at the PRESENTATION layer only. They never change a finding's
 * canonical confidence, status, or integrity label (`labelForArtifact`,
 * `applyEvidenceCaps`, `deriveStatus`). They make the rendered report
 * deterministic, ASCII-safe, internally consistent, and conservative about
 * weak/uncorroborated signals — without promoting anything.
 */

import type { Artifact } from "@/hooks/useThreadArtifacts";
import { isUsernameSweepSource } from "@/lib/intel";

// ---------------------------------------------------------------------------
// #1 — Deterministic, ASCII-safe cluster IDs.
//
// Root cause of the corrupted IDs ("Cluster ^", "Cluster {", blank glyphs):
// labels were built with String.fromCharCode(65 + idx). Past idx=25 ('Z')
// this walks into punctuation (`[ \ ] ^ _ \``), then a–z, then `{ | } ~`,
// then DEL (127) and non-printable control characters — exactly the garbage
// seen once an investigation produced >26 clusters.
// ---------------------------------------------------------------------------

/** Stable, zero-padded, ASCII-only cluster id: 0 -> "C001", 25 -> "C026". */
export function clusterDisplayId(idx: number): string {
  const n = Number.isFinite(idx) && idx >= 0 ? Math.floor(idx) : 0;
  return `C${String(n + 1).padStart(3, "0")}`;
}

/** True if a string contains only printable ASCII (space..~). Used by tests. */
export function isAsciiSafe(s: string): boolean {
  return /^[\x20-\x7E]*$/.test(s);
}

// ---------------------------------------------------------------------------
// #3 — Strip promotional "CONFIRMED" wording from a rendered artifact VALUE
// when the backend integrity label is NOT actually CONFIRMED. The model
// sometimes writes "… — CONFIRMED via two independent classes" into the value
// string itself; that must not read as a confirmation when the row is VERIFY.
// Render-only: the underlying artifact is untouched (audit trail preserved).
// ---------------------------------------------------------------------------

const CONFIRMED_WORDING_RE = /\s*[—–\-:|(]*\s*\bCONFIRMED\b[^.;|]*/gi;

export function sanitizeValueForLabel(value: string, isConfirmed: boolean): string {
  if (isConfirmed) return value;
  if (!/\bCONFIRMED\b/i.test(value)) return value;
  const cleaned = value.replace(CONFIRMED_WORDING_RE, " ").replace(/\s{2,}/g, " ").replace(/\s*[—–\-:|]\s*$/, "").trim();
  return cleaned.length ? cleaned : value.replace(/\bCONFIRMED\b/gi, "reported").trim();
}

// ---------------------------------------------------------------------------
// #6 — Collision quarantine. Artifacts the pipeline already flagged as a
// namesake/unrelated-entity collision must not seed or strengthen the main
// subject network; they belong in a separate "Collision / likely unrelated"
// section.
// ---------------------------------------------------------------------------

export function isCollisionArtifact(a: Artifact): boolean {
  const kind = (a.kind ?? "").toLowerCase();
  if (kind === "excluded_collision") return true;
  const m = (a.metadata ?? {}) as Record<string, unknown>;
  return m.excluded_collision === true || m.collision === true || m.possible_collision === true;
}

// ---------------------------------------------------------------------------
// #7 — Reserved / fictional phone numbers (e.g. NANPA 555-01xx). The backend
// already flags them with metadata.reserved_number; render-level we mark them
// non-actionable and annotate the value. We do NOT change canonical status and
// do NOT delete the artifact (audit trail preserved).
// ---------------------------------------------------------------------------

export function isReservedNumber(a: Artifact): boolean {
  const m = (a.metadata ?? {}) as Record<string, unknown>;
  return m.reserved_number === true;
}

export function reservedNumberAnnotation(a: Artifact): string | null {
  if (!isReservedNumber(a)) return null;
  const m = (a.metadata ?? {}) as Record<string, unknown>;
  const reason = typeof m.reserved_reason === "string" ? m.reserved_reason : "reserved/example range — no real subscriber";
  return `⚠ non-actionable: ${reason}`;
}

// ---------------------------------------------------------------------------
// #8 — Source/claim discrepancies mis-kinded as legal_record. A row like
// "Bond: $2,500 (Local 10) vs 'to be set' (TMZ) — discrepancy noted" is a
// SOURCE conflict, not a criminal/legal record. We override the DISPLAY kind
// to "source_conflict" at render only (backend kind untouched). Harm-bearing
// legal records keep their kind and conservative language.
// ---------------------------------------------------------------------------

const DISCREPANCY_RE = /\b(discrepanc(y|ies)|conflict(ing)?)\b|\bvs\.?\b|\bversus\b/i;

/** True when a legal_record value is actually a reporting/source discrepancy. */
export function isSourceDiscrepancy(a: Artifact): boolean {
  const kind = (a.kind ?? "").toLowerCase();
  if (kind !== "legal_record") return false;
  const m = (a.metadata ?? {}) as Record<string, unknown>;
  if (m.discrepancy === true || m.source_conflict === true) return true;
  return DISCREPANCY_RE.test(a.value ?? "");
}

/** Display kind for the report. Reclassifies source discrepancies away from
 *  legal_record so a reporting disagreement isn't presented as a criminal
 *  record. All other kinds pass through unchanged. */
export function reportDisplayKind(a: Artifact): string {
  if (isSourceDiscrepancy(a)) return "source_conflict";
  return a.kind;
}

// ---------------------------------------------------------------------------
// #2 — Cluster-explosion guard. A single-artifact bucket should only be shown
// as a candidate IDENTITY cluster when it is anchored by a durable selector.
// Weak singletons (account-existence checks, breach rows, "other" notes, lone
// sweep-only handles) stay in the Artifact Table but do not each spawn a
// cluster. Multi-artifact buckets (merged on a real signal) always qualify.
// ---------------------------------------------------------------------------

const NAME_KINDS = new Set(["name", "person"]);

/**
 * Whether a bucket should appear as a standalone candidate IDENTITY cluster.
 *
 * Qualification is driven by the bucket's STRONG-SELECTOR keys (the same keys
 * the clustering engine uses to merge: email/phone/handle/address/ip/parent),
 * NOT by a hardcoded kind list — so a `social_profile` carrying
 * `metadata.handle` still counts, while an `account_id` existence-check that
 * carries no selector does not.
 *
 * Rules:
 *  - merged bucket (≥2 artifacts)            → qualifies (real hypothesis)
 *  - lone name/person                        → qualifies (identity anchor)
 *  - lone artifact with no strong key        → suppressed (account checks, breach
 *                                              rows, "other" notes, …)
 *  - lone handle-only hit from username_sweep → suppressed unless corroborated
 *  - lone artifact with email/phone/address/ip/non-sweep handle → qualifies
 */
export function bucketQualifiesAsCluster(group: Artifact[], strongKeys?: Set<string>): boolean {
  if (group.length === 0) return false;
  if (group.length >= 2) return true;
  const a = group[0];
  if (NAME_KINDS.has((a.kind ?? "").toLowerCase())) return true;
  const keys = strongKeys ?? new Set<string>();
  if (keys.size === 0) return false; // no durable selector → not a cluster
  // A lone handle is not enough on its own when it's a sweep-only existence hit.
  const onlyHandleKeys = Array.from(keys).every((k) => k.startsWith("handle:"));
  if (onlyHandleKeys && isUsernameSweepSource(a.source)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// #5 (classification only — NOT wired to canonical labels; see report).
// Source-quality of a username_sweep account hit, for future renderer use.
// Promotion to CORRELATED would loosen the sweep-only VERIFY clamp and is
// intentionally NOT applied here pending sign-off.
// ---------------------------------------------------------------------------

export type SweepRouteQuality = "route_only" | "exists" | "content";

export function sweepRouteQuality(a: Artifact): SweepRouteQuality {
  const m = (a.metadata ?? {}) as Record<string, unknown>;
  const text = `${a.value ?? ""} ${String(m.note ?? "")} ${a.source ?? ""}`.toLowerCase();
  // "HTTP 200 but no content retrieved" / 404-behind-200 / 202 → route only.
  if (/no content retrieved|profile returned 404|\b202\b|ad tracker only|empty\/abandoned/.test(text)) {
    return "route_only";
  }
  if (m.profile_content === true || /profile|bio|avatar/.test(text)) return "content";
  return "exists";
}
