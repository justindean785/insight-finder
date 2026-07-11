// output-integrity.ts — pure, deterministic record-time integrity rules.
//
// These run in the record_artifacts gate (tool-registry.ts) alongside the existing
// collision / surname / listing-agent / bio-cross-link guards. Each is a pure
// predicate over an artifact's (kind, value, metadata) so it is unit-testable
// without a DB or the AI SDK. They NEVER delete a record — they relabel a kind,
// cap a confidence, or flag a row for the excluded/suppressed list, preserving the
// audit trail. Integrity primitives (applyEvidenceCaps, source classification,
// chain-of-custody) are untouched.

type Meta = Record<string, unknown> | null | undefined;

function metaText(meta: Meta, keys: string[]): string {
  const m = meta ?? {};
  const parts: string[] = [];
  for (const k of keys) {
    const v = (m as Record<string, unknown>)[k];
    if (typeof v === "string") parts.push(v);
  }
  return parts.join(" — ");
}

function toNum(x: unknown): number | null {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "string" && /^\d+$/.test(x.trim())) return parseInt(x, 10);
  return null;
}

function foldHandle(raw: string): string {
  return (raw ?? "").trim().toLowerCase().replace(/^@+/, "").replace(/\.+$/, "");
}

// ── WP2-#4: disproven-lead suppression ───────────────────────────────────────
// The system's OWN reason field sometimes records that a lead was disproved
// (e.g. "domain_similar_letters_not_same_entity",
// "single_source_collision_not_correlated"). confidence.ts UNRELATED_NOTE_RE is
// word-bounded (\b), so `\bcollision\b` never matches inside an underscore-joined
// token like `single_source_collision_not_correlated`, and those disproven leads
// slipped through as live weak_leads. This substring check catches them.
const DISPROVEN_REASON_RE = /not[_\s-]*same[_\s-]*entity|not[_\s-]*correlated|collision|not[_\s-]*the[_\s-]*same/i;

/** True when metadata's reason/disposition marks the lead as already disproved
 *  (not-same-entity / not-correlated / collision). */
export function isDisprovenReason(meta: Meta): boolean {
  const text = metaText(meta, ["reason", "reason_not_confirmed", "disposition", "relationship", "note", "notes"]);
  if (!text) return false;
  return DISPROVEN_REASON_RE.test(text);
}

// ── WP2-#5: zero-breach relabel ──────────────────────────────────────────────
// A breach_exposure whose own metadata says isBreached:false / totalBreaches:0 /
// totalPastes:0 is a NEGATIVE result, not an exposure. It must record as
// `no_breach_found` with confidence forced to 0 — never as breach_exposure conf 60.
/** True when a breach-kind artifact's metadata shows a zero/negative scan result. */
export function isZeroBreachExposure(kind: string | null | undefined, meta: Meta): boolean {
  const k = (kind ?? "").toLowerCase();
  if (k !== "breach_exposure" && k !== "breach") return false;
  const m = (meta ?? {}) as Record<string, unknown>;
  if (m.isBreached === true || m.is_breached === true) return false;
  const tb = toNum(m.totalBreaches ?? m.total_breaches ?? m.breach_count ?? m.breaches);
  const tp = toNum(m.totalPastes ?? m.total_pastes ?? m.pastes);
  if (tb === 0 && tp === 0) return true;
  // Explicit negative from the scanner even if only one count is present.
  if ((m.isBreached === false || m.is_breached === false) && (tb === 0 || tb === null)) return true;
  return false;
}

export const NO_BREACH_KIND = "no_breach_found";

// ── WP2-#6: cross-subject contact laundering ─────────────────────────────────
// A phone/email/address/geo lead extracted from a THIRD-PARTY account's bio must
// stay scoped to THAT account. It must never be laundered into a weak_lead ABOUT
// the seed subject unless an explicit link (mention/tag/DM/shared selector)
// connects them. Live case: barlozblendz's phone/geo turned into a "530 area code"
// lead about pjsmakka with note "pjsmakka appeared in search results near this
// geographic area" and source "barlozblendz Instagram bio" — a fabricated tie.
const CONTACT_KINDS = new Set(["phone", "email", "address", "weak_lead"]);
const EXPLICIT_LINK_RE =
  /\b(mention(?:ed|s)?|tag(?:ged|s)?|dm|direct\s+message|repl(?:y|ied)|comment(?:ed)?|collab(?:orat)?|shared\s+(?:phone|email|selector|handle|account|device|ip)|same\s+(?:phone|email|device|ip|selector))\b/i;
const SOURCE_PROFILE_RE = /^@?([a-z0-9._]{2,30})\s+(?:instagram|twitter|x|tiktok|facebook|threads)?\s*(?:bio|profile|account)/i;

/** The third-party account handle a contact artifact was scraped from, if any. */
export function sourceProfileHandle(meta: Meta): string | null {
  const m = (meta ?? {}) as Record<string, unknown>;
  for (const k of ["source_profile", "handle"]) {
    const v = m[k];
    if (typeof v === "string" && v.trim() && /^[a-z0-9._]{2,30}$/i.test(v.trim())) return foldHandle(v);
  }
  const s = typeof m.source === "string" ? m.source : "";
  const mm = s.match(SOURCE_PROFILE_RE);
  return mm ? foldHandle(mm[1]) : null;
}

/**
 * True when a contact/geo lead is scraped from a DIFFERENT account than the seed
 * and asserts a tie to the seed with NO explicit link — i.e. laundered contact.
 * `seedHandle` is the seed's folded handle (may be "").
 */
export function isCrossSubjectContactLaundering(
  kind: string | null | undefined,
  value: string,
  meta: Meta,
  seedHandle: string,
): boolean {
  if (!CONTACT_KINDS.has((kind ?? "").toLowerCase())) return false;
  const m = (meta ?? {}) as Record<string, unknown>;
  const src = sourceProfileHandle(m);
  if (!src) return false;
  const seed = foldHandle(seedHandle);
  if (!seed || src === seed) return false; // scoped to its own account — legitimate
  // Does the artifact attribute this contact to the seed subject?
  const noteText = [m.note, m.notes, value].filter((s) => typeof s === "string").join(" ").toLowerCase();
  const tiesToSeed = m.about_seed === true || m.about_subject === true || (!!seed && noteText.includes(seed));
  if (!tiesToSeed) return false; // it doesn't claim to be about the seed — leave it
  // An explicit link (mention/tag/DM/shared selector) WOULD justify the connection.
  const linkText = metaText(m, ["note", "notes", "relationship", "relationship_to_subject", "link_reason", "reason"]);
  if (EXPLICIT_LINK_RE.test(linkText)) return false;
  return true;
}

// ── WP2-#8: human-input provenance ───────────────────────────────────────────
// A fact originating from a user-typed correction ("Full name is Prestan Jackson
// try different variants") must be tagged human_input provenance and must NOT
// reach the Confirmed tier until an agent-found source independently corroborates
// it. Implemented as a metadata flag + a confidence cap below Confirmed (decision:
// no new SourceClass, so the integrity-critical taxonomy/CLASS_CAP is untouched).
const HUMAN_INPUT_RE =
  /\b(user[_\s-]*(?:correction|provided|typed|supplied|input|says?|stated)|human[_\s-]*(?:input|provided)|per\s+(?:the\s+)?user|from\s+(?:the\s+)?user|analyst[_\s-]*provided|operator[_\s-]*provided)\b/i;

/** Below-Confirmed cap for human-provided facts (Confirmed tier starts at 90). */
export const HUMAN_INPUT_CONFIDENCE_CAP = 50;

/** True when an artifact's provenance is a user-typed correction / human input. */
export function isHumanInputProvenance(meta: Meta): boolean {
  const m = (meta ?? {}) as Record<string, unknown>;
  if (m.human_input === true || m.user_provided === true) return true;
  const prov = typeof m.provenance === "string" ? m.provenance : "";
  if (/^human_input$/i.test(prov) || /^user_(?:provided|correction|input)$/i.test(prov)) return true;
  const text = metaText(m, ["derived_from", "handles_derived", "provenance", "source", "note", "notes", "reason"]);
  return HUMAN_INPUT_RE.test(text);
}
