// Strict artifact type taxonomy. Replaces the loose freeform `kind` list.
// The orchestrator MUST pick a value from STRICT_KINDS — `other` is rejected.

export const STRICT_KINDS = [
  "person",
  "alias",
  "username",
  "social_profile",
  "email",
  "phone",
  "address",
  "domain",
  "subdomain",
  "ip",
  "organization",
  "employer",
  "law_enforcement_unit",
  "court_case",
  "criminal_case_event",
  "media_report",
  "music_profile",
  "account_id",
  "hash",
  "crypto_wallet",
  "breach_exposure",
  "threat_reputation",
  "reputation_signal",
  "contradiction",
  "weak_lead",
  "excluded_collision",
  // legacy compat — still accepted but discouraged
  "name",
  "social",
  "avatar",
  "case",
  "legal_record",
  "infrastructure",
  "event",
] as const;

export type StrictKind = typeof STRICT_KINDS[number];

const STRICT_SET = new Set<string>(STRICT_KINDS);

export function isStrictKind(k: string): k is StrictKind {
  return STRICT_SET.has(k);
}

/** Pattern-based inference: bump obvious mis-typed kinds into the right slot. */
export function inferKind(rawKind: string, value: string): { kind: string; reclassified_from?: string } {
  const v = value.trim();
  const k = (rawKind || "").toLowerCase();
  if (/^0x[a-fA-F0-9]{40}$/.test(v) || /^[13][a-km-zA-HJ-NP-Z0-9]{25,34}$/.test(v) || /^bc1[a-z0-9]{20,80}$/.test(v)) {
    return k === "crypto_wallet" ? { kind: "crypto_wallet" } : { kind: "crypto_wallet", reclassified_from: rawKind };
  }
  if (/\b(LAPD|NYPD|FBI|DEA|ATF|sheriff('s)? office|police dept|police department|robbery-?homicide)\b/i.test(v)) {
    return { kind: "law_enforcement_unit", reclassified_from: rawKind };
  }
  if (/^(People|United States|State|Commonwealth|In re)\s+v\.?\s+/i.test(v) || /\b(case no\.?|docket|b\d{6})\b/i.test(v)) {
    return { kind: "court_case", reclassified_from: rawKind };
  }
  if (/\b(compassionate release|sentencing|parole|arraign(ment|ed)|indict(ment|ed)|verdict|conviction|charged with)\b/i.test(v)) {
    return { kind: "criminal_case_event", reclassified_from: rawKind };
  }
  if (/spotify\.com\/artist|music\.apple\.com\/artist|soundcloud\.com|tidal\.com\/browse\/artist/i.test(v)) {
    return { kind: "music_profile", reclassified_from: rawKind };
  }
  // A "username" with whitespace is never a valid handle — it's almost always a
  // person name the model mis-kinded. Reclassify instead of hard-rejecting at
  // validation (the 2026-06-13 trace lost 3 record_artifact calls to
  // "username must not contain whitespace").
  if (k === "username" && /\s/.test(v)) {
    return { kind: "name", reclassified_from: "username" };
  }
  if (k === "other") return { kind: "weak_lead", reclassified_from: "other" };
  return { kind: rawKind };
}

// ── Source classification lives in source-classification.ts ──────────────────
// (the single source of truth — the recording paths and the confidence engine
// both consume it). Re-exported here so existing importers (`confidence.ts`,
// `index.ts`, tests that do `import { classifySource } from "./artifact_types.ts"`)
// are unaffected by the #16 architecture change. The re-exported `SourceClass`
// carries post-#56 main's SPLIT infra taxonomy (the integrity contract).
export type { SourceClass } from "./source-classification.ts";
export {
  classifySource,
  classifySourceLabel,
  classifySourceInput,
  normalizeSourceLabel,
  splitSourceLabels,
  isWrapperLabel,
  isInfraClass,
  isLlmAssertedDomainSource,
  LLM_ASSERTED_PROVENANCE,
  countIndependentClasses,
  hasOfficialClass,
  NON_CORROBORATING_CLASSES,
  OFFICIAL_CLASSES,
} from "./source-classification.ts";
