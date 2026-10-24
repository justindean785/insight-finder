// lib/analyst-authority-keys.ts — A1: a model cannot write the analyst's keys.
//
// THE DEFECT. The readers treat three persisted metadata keys as ANALYST authority:
//   • `reviewed === true`           → an analyst attestation (src/lib/intel.ts labelForArtifact,
//                                      src/lib/evidence-status.ts) → ATTESTED / "verified"
//   • `linkage_confirmed === true`  → an analyst release of a subject_unlinked quarantine
//                                      (src/lib/quarantine.ts, reviews.ts, lib/dispatch-quarantine.ts)
//   • `false_positive === true`     → an analyst dismissal → FAILED / "Excluded from findings"
//   • `user_provided === true` /
//     `analyst_provided === true` → "this name came from the analyst" (src/lib/name-conflict.ts
//                                      isAnalystSupplied): the ANCHOR every other name is compared
//                                      against, so a model could pick which name the conflict
//                                      banner treats as the analyst's. Banner impact, not confidence.
// The record tools build a row's metadata as `{ ...modelMetadata, <server-derived fields> }`, so
// every key the server does not itself overwrite was persisted exactly as the model wrote it.
// `record_evidence` writes the model's metadata to `evidence_log._metadata` the same way; nothing
// reads these keys there today, so it is stripped for defense in depth, not for a reproduced defect.
// Reproduced 2026-10-13 on main 32f5ddb: a single-source BREACH email recorded with
// `metadata.reviewed = true` rendered as "Analyst-confirmed · single-source · breach".
//
// WHO REALLY WRITES THEM. The analyst's decisions live in `artifact_reviews` (written by the
// browser; this function only reads it) and in the release patch the browser writes
// (`src/lib/quarantine-release.ts`). The edge function writes neither, so a `reviewed` /
// `linkage_confirmed` arriving through a MODEL tool call is by construction not an analyst's.
//
// THE RULE. Metadata the MODEL supplies is disclosure, never authority (the same rule
// recording_source_policy_runtime_test.ts already pins for source and confidence). Those keys
// are removed from model-supplied metadata before anything else reads it. The removal is
// DISCLOSED, not silent: the row records which key NAMES were dropped (never the values), so
// chain of custody keeps an audit of the attempt.
//
// WHAT THIS DELIBERATELY DOES NOT DO.
//   • It never RAISES a row's authority and never touches a value, so breach-data reveal
//     (REVEAL_BREACH_DATA) and every stored value are unaffected. One honest caveat
//     (independent review, 2026-10-13): stripping `false_positive` means a model can no
//     longer SELF-dismiss a row, so a row it tried to hide now stays visible at the
//     authority the server derived. That is intended — a dismissal is the analyst's — and
//     the model keeps every legitimate way to lower a row (`conflict`, `collision`,
//     `excluded_collision`, `subject_unlinked`, `possible_minor`, `contradictions`).
//   • It does not touch server-derived fields (status, source_category, confidence caps) or the
//     protective flags a model may still set to LOWER authority (subject_unlinked,
//     possible_minor, conflict, collision, excluded_collision).
//   • It does not rewrite rows already stored, and it does not change how any reader interprets
//     `reviewed` — those are separate decisions.
//   • Only TOP-LEVEL keys: every reader reads them at the top level of `metadata`.
//
// Kill switch, read at call time: ANALYST_AUTHORITY_STRIP_DISABLED=true restores the legacy
// pass-through on the running build with no deploy.

/** Keys reserved for the analyst. Three are READ as authority today; the rest are impersonation
 *  spellings no reader consults yet — reserved now so a future reader cannot inherit the hole. */
export const RESERVED_ANALYST_AUTHORITY_KEYS: readonly string[] = [
  "reviewed",
  "linkage_confirmed",
  "linkage_confirmed_at",
  "false_positive",
  "review_state",
  "analyst_confirmed",
  "analyst_review",
  "attested",
  "human_verified",
  // "whose is this name?" — read by src/lib/name-conflict.ts as the analyst's anchor (#827 review, finding 3).
  // No writer exists in the product (0 rows in production on 2026-10-23); reserved so none can be forged.
  "user_provided",
  "analyst_provided",
];

/** The audit key this module writes. It is reserved too, so a model cannot forge its own record. */
export const ANALYST_AUTHORITY_DISCLOSURE_KEY = "analyst_authority_stripped";

const RESERVED = new Set<string>([...RESERVED_ANALYST_AUTHORITY_KEYS, ANALYST_AUTHORITY_DISCLOSURE_KEY]);

type EnvGet = (k: string) => string | undefined;

function readEnvSafe(k: string): string | undefined {
  try {
    return (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get(k);
  } catch {
    return undefined;
  }
}

export function analystAuthorityStripDisabled(env: EnvGet = readEnvSafe): boolean {
  return (env("ANALYST_AUTHORITY_STRIP_DISABLED") ?? "").trim().toLowerCase() === "true";
}

export interface StrippedMetadata<T> {
  metadata: T;
  /** Canonical reserved key names that were removed, sorted and de-duplicated. Names only. */
  stripped: string[];
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Remove analyst-reserved keys from MODEL-supplied artifact metadata.
 *
 * Pure: never mutates its input, and returns the SAME object when nothing was removed. When
 * something was removed the result carries `analyst_authority_stripped` — the key NAMES, sorted.
 * Absent or non-record metadata passes through untouched.
 */
export function stripAnalystAuthorityKeys<T>(
  metadata: T,
  env: EnvGet = readEnvSafe,
): StrippedMetadata<T> {
  if (analystAuthorityStripDisabled(env) || !isPlainRecord(metadata)) return { metadata, stripped: [] };
  const hit = new Set<string>();
  const kept: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(metadata)) {
    const canonical = k.trim().toLowerCase();
    if (RESERVED.has(canonical)) hit.add(canonical);
    else kept[k] = v;
  }
  if (hit.size === 0) return { metadata, stripped: [] };
  const stripped = [...hit].sort();
  kept[ANALYST_AUTHORITY_DISCLOSURE_KEY] = stripped;
  return { metadata: kept as T, stripped };
}

/** The sentence returned to the model when a call carried reserved keys: told, not hidden. */
export const ANALYST_AUTHORITY_NOTE =
  "Some metadata keys are reserved for the analyst (reviewed, linkage_confirmed, false_positive, user_provided and similar) and were ignored. " +
  "A model cannot record an analyst review, confirmation, release or dismissal — the analyst does that in the UI. " +
  "Express your own confidence through `confidence` and `source`, and doubts through `contradictions` / `reason_not_confirmed`.";

/**
 * /health self-test. What it PROVES: the build carrying this module (and this reserved list) is the one
 * serving `/health`, and the pure strip behaves. What it does NOT prove: that the three model entry points
 * (`record_artifacts`, `record_artifact`, `record_evidence`) still call it — that wiring is pinned by
 * analyst_authority_boundary_test.ts in CI, not by this probe (#827 independent review, finding 2). The
 * detail says so, and names the reserved-key count so a widened list reads as a new build.
 */
export function analystAuthorityBoundarySelfTest(): { ok: boolean; detail: string } {
  if (analystAuthorityStripDisabled()) return { ok: true, detail: "LEGACY via ANALYST_AUTHORITY_STRIP_DISABLED" };
  const probe = stripAnalystAuthorityKeys({
    reviewed: true, linkage_confirmed: true, false_positive: true, user_provided: true, analyst_provided: true, note: "x",
  });
  const clean = stripAnalystAuthorityKeys({ note: "x" });
  const m = probe.metadata as Record<string, unknown>;
  const ok = !("reviewed" in m) && !("linkage_confirmed" in m) && !("false_positive" in m) &&
    !("user_provided" in m) && !("analyst_provided" in m) &&
    m.note === "x" && probe.stripped.length === 5 && clean.stripped.length === 0;
  return ok
    ? {
      ok: true,
      detail: `strip module present, ${RESERVED_ANALYST_AUTHORITY_KEYS.length} reserved keys (pure probe: analyst review/release/dismissal/provenance keys removed and disclosed by name); ` +
        "the record_artifacts/record_artifact/record_evidence wiring is pinned by CI (analyst_authority_boundary_test.ts), not by this probe",
    }
    : { ok: false, detail: "analyst-authority boundary misbehaving" };
}
