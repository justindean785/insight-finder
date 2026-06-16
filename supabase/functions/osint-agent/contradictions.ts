// Contradiction detection engine.
// Compares artifacts for hard conflicts (different location for same name,
// different employer, username collision among different people).
// Surfaced as REDUCERS in the final report.

import { type ArtifactStatus, deriveStatus, isConfirmedStatus } from "./confidence.ts";
import type { SourceClass } from "./artifact_types.ts";

export type ContradictionSeverity = "low" | "medium" | "high" | "critical";

export interface ContradictionFinding {
  kind: "location_conflict" | "name_conflict" | "employer_conflict" | "social_collision" | "stale_data" | "other";
  severity: ContradictionSeverity;
  detail: string;
  involved: string[]; // artifact values involved
}

/** Patterns that indicate a subject is a criminal offender / suspect. */
export const OFFENDER_KINDS = new Set<string>([
  "criminal_case_event",
  "court_case",
  "case",
  "legal_record",
]);

export function isOffenderKind(kind: string | null | undefined): boolean {
  return OFFENDER_KINDS.has(String(kind ?? "").toLowerCase());
}

/**
 * Detect conflicts in the artifact set.
 * High severity location conflicts among name artifacts are the primary signal
 * for "frankentelling" (merging two different people).
 */
export function detectContradictions(
  artifacts: Array<{ kind: string; value: string; metadata?: Record<string, unknown> | null; source?: string | null }>,
): ContradictionFinding[] {
  const findings: ContradictionFinding[] = [];
  const byKind = new Map<string, typeof artifacts>();
  for (const a of artifacts) {
    const k = a.kind.toLowerCase();
    const arr = byKind.get(k) ?? [];
    arr.push(a);
    byKind.set(k, arr);
  }

  // 1. Location conflict for the same name/identity
  const names = byKind.get("name") ?? byKind.get("person") ?? [];
  const bios = byKind.get("bio") ?? [];
  const locs = byKind.get("location") ?? byKind.get("address") ?? byKind.get("geo") ?? [];

  if (names.length > 0 && locs.length > 1) {
    const states = new Set<string>();
    for (const l of locs) {
      const s = extractState(l.value);
      if (s) states.add(s);
    }
    if (states.size > 1) {
      findings.push({
        kind: "location_conflict",
        severity: names.length > 1 ? "high" : "medium",
        detail: `Subject identity spans ${states.size} different US states (${Array.from(states).join(", ")}). Possible same-name collision.`,
        involved: locs.map((l) => l.value),
      });
    }
  }

  // 2. Employer conflict
  const employers = byKind.get("employer") ?? byKind.get("organization") ?? [];
  if (employers.length > 1) {
    const distinct = new Set(employers.map((e) => e.value.toLowerCase().trim()));
    if (distinct.size > 1) {
      findings.push({
        kind: "employer_conflict",
        severity: "medium",
        detail: `Multiple conflicting primary employers/organizations observed (${Array.from(distinct).join(", ")}).`,
        involved: employers.map((e) => e.value),
      });
    }
  }

  // 3. Social handle collision (same handle, different platform, different inferred identities)
  const handles = byKind.get("username") ?? byKind.get("handle") ?? byKind.get("social") ?? [];
  if (handles.length > 1) {
    const byHandle = new Map<string, string[]>();
    for (const h of handles) {
      const v = h.value.toLowerCase().trim();
      const plats = byHandle.get(v) ?? [];
      const p = (h.metadata?.platform as string) ?? h.source ?? "unknown";
      plats.push(p);
      byHandle.set(v, plats);
    }
    for (const [handle, platforms] of byHandle) {
      if (platforms.length > 1) {
        findings.push({
          kind: "social_collision",
          severity: "low",
          detail: `Handle '${handle}' observed on ${platforms.length} platforms. Verify identity ownership across ${platforms.join(", ")}.`,
          involved: [handle],
        });
      }
    }
  }

  return findings;
}

function extractState(val: string): string | null {
  const v = val.toUpperCase();
  const states = ["AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY"];
  for (const s of states) {
    if (new RegExp(`\\b${s}\\b`).test(v)) return s;
  }
  return null;
}

export function detectIdentityMisattribution(
  finding: string,
  artifacts: Array<{ kind: string; value: string }>,
): string[] {
  const issues: string[] = [];
  const offender = isOffenderKind(finding);
  if (offender) {
    const locConflicts = artifacts.filter((a) => a.kind === "location" || a.kind === "address");
    if (locConflicts.length > 1) {
      issues.push("Multiple locations for a criminal attribution finding — high risk of same-name collision.");
    }
  }
  return issues;
}

// ──────────────────────────────────────────────────────────────────────────
// T-H2 — contradiction write-back logic.
// ──────────────────────────────────────────────────────────────────────────

export interface PenaltyDecision {
  status: ArtifactStatus;
  confidence: number;
  totalPenalty: number;
  appliedSig: string;          // unique signature for this penalty
  confirmedBlocked: boolean;   // true if confirmed status is hard-blocked
}

/**
 * Unique signature for a penalty: `${finding.kind}:${involved_values_hash}`.
 * Prevents double-penalizing the same artifact for the same conflict.
 */
export function getPenaltySignature(f: ContradictionFinding): string {
  const sorted = [...f.involved].sort().join("|");
  return `${f.kind}:${sorted}`;
}

export interface PenaltyInput {
  finding: ContradictionFinding;
  kind: string;
  rawStatus: string | null | undefined;
  confidence: number;
  classes: SourceClass[];
  verificationStatus?: string | null;
  alreadyApplied: string[];    // sigs already in metadata.contra_penalties_applied
  priorPenalty: number;        // metadata.contradiction_penalty
}

/**
 * Decide how to penalize an artifact implicated in a contradiction.
 * High-severity location conflicts among crime kinds hard-block confirmed status.
 */
export function computeContradictionPenalty(input: PenaltyInput): PenaltyDecision | null {
  const sig = getPenaltySignature(input.finding);
  if (input.alreadyApplied.includes(sig)) return null;

  const sev = input.finding.severity;
  let penalty = 0;
  if (sev === "critical") penalty = 40;
  else if (sev === "high") penalty = 25;
  else if (sev === "medium") penalty = 12;
  else penalty = 5;

  const totalPenalty = input.priorPenalty + penalty;
  const confidence = Math.max(0, input.confidence - penalty);

  // Decide status via the shared authority, but with the reduced confidence
  // and a simulated cap.
  const crime = isCrimeKind(input.kind);
  const locationConflict = input.finding.kind === "location_conflict";
  const confirmedBlocked = crime && locationConflict && (sev === "high" || sev === "critical");

  const derived = deriveStatus({
    cap: confidence, // use current confidence as the cap for this pass
    rawStatus: input.rawStatus,
    classes: input.classes,
    kind: input.kind,
    verificationStatus: input.verificationStatus,
  });

  let status = derived.status;
  // If we're hard-blocking confirmed status, force a review status even if
  // deriveStatus wanted to allow it.
  if (confirmedBlocked && isConfirmedStatus(status)) {
    status = crime ? "manual_review_required" : "needs_review";
  }

  return {
    status,
    confidence,
    totalPenalty,
    appliedSig: sig,
    confirmedBlocked,
  };
}
