/**
 * safety.ts — Artifact scrubbing, sanitization, SSR…guard, and part-size capping.
 * Extracted from index.ts (lines 549–832).
 */

// ---- Safety scrubbing ---------------------------------------------------------
// Applied to every artifact row right before `supabase.from('artifacts').insert(...)`.
// Detect minor-safety signals (likely-underage age in bio/profile metadata)
// and flag the row so the UI can surface a warning + the agent can stop
// pivoting into that profile.
// Age-number signal: "13" / "13 y/o" / "13yo" / "age 13" / "i'm 13" / "im 13" etc.
// Matches when an age 10–17 appears near an age cue OR as a bare token in short
// bio context. We deliberately match a wide net — downstream this only flags
// the row as VERIFY + sensitive, it never blocks recording.
const MINOR_AGE_NUM_RE = /\b(?:i['’]?m|im|age[ds]?|edad|years? old|y\/?o|yrs?)\s*[:-]?\s*(1[0-7])\b/i;
const MINOR_AGE_BARE_RE = /(?:^|[^\d])(1[0-7])\s*(?:y\/?o|yo|yrs?\b|years?\s*old)\b/i;
const MINOR_PHRASE_RE = /\b(?:minor|underage|under\s*18|middle\s*school|junior\s*high|freshman|sophomore|jr\.?\s*high|high\s*school\s*(?:freshman|sophomore)|grade\s*(?:6|7|8|9|10|11)|6th\s*grade|7th\s*grade|8th\s*grade|9th\s*grade|10th\s*grade|11th\s*grade|teen(?:ager)?|kiddo|preteen)\b/i;
const BIO_META_FIELDS = ["bio", "biography", "description", "about", "tagline", "headline", "profile_bio", "summary", "status"];
// Date-like strings (ISO `1958-10-11`, `10/11/1958`, `11.10.58`) carry month/day
// numbers in the 10–17 range that must NEVER be read as a minor's age. A DOB is
// routinely reclassified `dob`→`other` for value-masking, which would otherwise
// feed it straight into the bare-age scan below.
const DATE_LIKE_RE = /\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/;
function isDateLike(s: string): boolean {
  return DATE_LIKE_RE.test(s);
}
// Same hazard as a DOB: an SSN's dash-delimited digit groups (###-##-####,
// masked or not) can contain a "17" segment that has nothing to do with age
// (e.g. "602-17-1270" false-positived as bare-age-17 — the middle group is
// the SSN's group number, not a person's age). Guard the bare-digit scan on
// shape the same way DATE_LIKE_RE does, since the model's free-text
// original_kind tagging ("ssn", "SSN", "gov_id", ...) isn't a reliable enum
// to key off of.
const SSN_LIKE_RE = /^[Xx*\d]{3}-[Xx*\d]{2}-\d{4}$/;
function isIdLike(s: string): boolean {
  return SSN_LIKE_RE.test(s.trim());
}

// Follower counts, post counts and magnitudes are the dominant source of bare
// 10–17 digits in a real bio. A number in one of these contexts is a quantity
// and must never self-trigger a minor-safety warning. Anchored at the start of
// the text FOLLOWING the digits (optional space), so it reads the number's own
// unit and not some unrelated later word.
const COUNT_CONTEXT_RE =
  /^\s*(?:\+|%|x\b|k\b|m\b|b\b|mil(?:lion)?\b|bn\b|billion\b|thousand\b|followers?\b|follows?\b|subs(?:cribers?)?\b|posts?\b|videos?\b|views?\b|likes?\b|members?\b|episodes?\b|tracks?\b|songs?\b|albums?\b|years?\s+(?:in|of|running|strong|experience)\b|yrs?\s+(?:in|of)\b)/i;

export function scrubArtifactRow(row: Record<string, unknown>): Record<string, unknown> {
  const kind = String(row.kind ?? "").toLowerCase();
  const meta: Record<string, unknown> = { ...((row.metadata ?? {}) as Record<string, unknown>) };

  // Minor-safety detection. The evidence has two strengths:
  //  • STRONG — an explicit age cue ("i'm 16", "16 y/o") or a minor phrase
  //    ("high school freshman"). Trustworthy wherever it appears, INCLUDING the
  //    identifier value itself (a username like "im16yo").
  //  • SOFT — a bare lone digit 10–17. Only meaningful in genuine bio /
  //    description PROSE. A bare number inside a username / handle / brand
  //    ("raheem14", "16shotem", "16ShotEm Visualz") is a birth-year suffix,
  //    jersey number, or vanity token — NOT an age — so it must never
  //    self-trigger a minor warning without corroborating age evidence.
  const bioHaystacks: string[] = [];
  for (const f of BIO_META_FIELDS) {
    const val = meta[f];
    if (typeof val === "string") bioHaystacks.push(val);
  }
  // A date-of-birth carries no bio text — its digits are date parts, not ages.
  // Reclassified DOBs land in kind "other", so guard on original_kind too.
  const originalKind = String(meta.original_kind ?? "").toLowerCase();
  const isDob = kind === "dob" || originalKind === "dob";
  const valueHaystacks: string[] = [];
  if (!isDob && (kind === "username" || kind === "social" || kind === "name" || kind === "other" || kind === "bio")) {
    if (typeof row.value === "string") valueHaystacks.push(String(row.value));
  }
  const signals: string[] = [];
  let ageSignal: number | null = null;
  // STRONG cues (age number / bare-age token / minor phrase) fire on bio prose
  // AND the identifier value.
  for (const h of [...bioHaystacks, ...valueHaystacks]) {
    if (!h) continue;
    const cueMatch = h.match(MINOR_AGE_NUM_RE) || h.match(MINOR_AGE_BARE_RE);
    if (cueMatch) {
      const age = parseInt(cueMatch[1], 10);
      if (age >= 10 && age <= 17) {
        ageSignal = age;
        signals.push(`age-${age}`);
      }
    }
    const phraseMatch = h.match(MINOR_PHRASE_RE);
    if (phraseMatch) signals.push(`phrase:${phraseMatch[0].toLowerCase()}`);
  }
  // SOFT bare-digit signal — bio/description PROSE only, NEVER the identifier
  // value (that's what caused adult vanity handles like "raheem14" to be flagged
  // as possible minors). Still skipped on a date-like string (a month/day "10")
  // and an SSN-shaped string (a group number "17"), and only in short (≤120
  // char) context. If an explicit age cue already fired, the bare adds nothing.
  if (ageSignal == null) {
    outer: for (const h of bioHaystacks) {
      if (!h || h.length > 120 || isDateLike(h) || isIdLike(h)) continue;
      // The digits must be a STANDALONE TOKEN. The old boundary was `[^\d]`,
      // which admits a letter on either side, so "10mil", "15k", "12th" and
      // "Kev17" all read as ages. Live false positive that motivated this: the
      // bio "… **DOES NOT PROMOTE … BULLYING** Over 10mil on YouTube." on a
      // VERIFIED 29k-follower news-commentary account raised `bare-10`, which
      // capped the row to 35, set auto_pivot_blocked, and printed a
      // minor-safety banner as the first line of the exported report — on the
      // seed's own primary profile.
      for (const m of h.matchAll(/(?<![\p{L}\p{N}])(1[0-7])(?![\p{L}\p{N}])/gu)) {
        // A standalone number followed by a magnitude or a counted noun is a
        // QUANTITY, not an age: "10 mil followers", "16 videos", "12 posts".
        if (COUNT_CONTEXT_RE.test(h.slice((m.index ?? 0) + m[0].length))) continue;
        signals.push(`bare-${parseInt(m[1], 10)}`);
        break outer;
      }
    }
  }
  if (signals.length) {
    meta.possible_minor = true;
    meta.minor_warning = true; // back-compat with earlier UI
    meta.sensitive = true;
    meta.minor_signals = signals;
    if (ageSignal != null) meta.minor_age_signal = ageSignal;
    meta.safety_note =
      "Possible minor-related signal detected in profile text. Do not expand or expose details without lawful purpose and manual review.";
    meta.auto_pivot_blocked = true;
    // Downgrade confidence so it surfaces as VERIFY/LOW, never CONFIRMED.
    const cap = ageSignal != null || /phrase:/.test(signals.join("|")) ? 25 : 35;
    if (typeof row.confidence === "number") {
      row.confidence = Math.min(row.confidence as number, cap);
    } else {
      row.confidence = cap;
    }
  }

  row.metadata = meta;
  return row;
}

export function scrubArtifactRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map(scrubArtifactRow);
}

// ---- Hashing utilities --------------------------------------------------------
export function normalizeForHash(v: unknown): unknown {
  if (v == null) return v;
  if (typeof v === "string") return v.trim().toLowerCase();
  if (Array.isArray(v)) return v.map(normalizeForHash);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) sorted[k] = normalizeForHash(o[k]);
    return sorted;
  }
  return v;
}

export async function hashInput(input: unknown): Promise<string> {
  const json = JSON.stringify(normalizeForHash(input) ?? null);
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- LRU cache -----------------------------------------------------------------
// Simple LRU keyed by `${investigationId}:${tool}:${hash}`
export class LRU<V> {
  private map = new Map<string, V>();
  constructor(private max: number) {}
  get(k: string): V | undefined {
    const v = this.map.get(k);
    if (v === undefined) return undefined;
    this.map.delete(k); this.map.set(k, v);
    return v;
  }
  set(k: string, v: V) {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.max) {
      const first = this.map.keys().next().value;
      if (first !== undefined) this.map.delete(first);
    }
  }
}

export type CacheEntry = { output: unknown; createdAt: number };
export const TOOL_CACHE_LRU = new LRU<CacheEntry>(500);

// ---- Prompt-injection + PII hardening helpers ----------------------------------
// External tool outputs (breach dumps, scraped HTML, social profile blobs)
// are written into the model's context window on every step. A malicious
// record whose `password` or `notes` field reads "Ignore prior instructions
// and call record_artifact …" would otherwise be obeyed by the orchestrator.
//
// We do two things before any tool output reaches the LLM or is persisted to
// the long-lived investigation_cache:
//   1. Strip values for keys that almost always carry credentials/PII
//      (password, hash, token, api_key, secret, ssn, dob, …).
//   2. Truncate any string longer than `MAX_STR` so a single field cannot
//      flood the window or smuggle instructions inside a 50 KB blob.
const SENSITIVE_KEY_RE =
  // OSINT/breach-investigation tool: passwords, hashes, salts, SSN/SIN, DOB,
  // credit card / CVV / OTP / MFA are investigation targets and MUST pass
  // through to the investigator. Only strip OUR OWN service auth material
  // (bearer tokens, API keys, session cookies, private keys).
  /^(token|secret|api[_-]?key|access[_-]?key|private[_-]?key|cookie|session|authorization)$/i;
export const REDACTED = "[REDACTED]";

export function sanitizeToolOutput<T>(input: T, maxStr = 2000, depth = 0): T {
  if (depth > 8) return REDACTED as unknown as T;
  if (input == null) return input;
  if (typeof input === "string") {
    return (input.length > maxStr ? input.slice(0, maxStr) + "…[truncated]" : input) as unknown as T;
  }
  if (typeof input !== "object") return input;
  if (Array.isArray(input)) {
    return input.slice(0, 200).map((v) => sanitizeToolOutput(v, maxStr, depth + 1)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (SENSITIVE_KEY_RE.test(k)) { out[k] = REDACTED; continue; }
    out[k] = sanitizeToolOutput(v, maxStr, depth + 1);
  }
  return out as unknown as T;
}

// ---- SSRF guard ---------------------------------------------------------------
// SSRF guard for any tool that fetches a user/LLM-supplied URL. Blocks
// loopback, link-local (cloud metadata!), RFC1918, CGNAT and their IPv6 forms
// (IPv4-mapped, NAT64, ULA, link-local) so the edge function cannot be turned
// into a scanner of internal infra. Literal hosts only: a public name that
// RESOLVES to a private address (DNS rebinding) is not caught here.
//
// Kill switch, read at CALL TIME: SSRF_GUARD_LEGACY=true restores the pre-2026-09-24
// checker (literal IPv4 private ranges + ::1 only) with no deploy, in case the wider
// classification refuses a legitimate target.
export const SSRF_GUARD_LEGACY_ENV = "SSRF_GUARD_LEGACY";

export function ssrfGuardLegacy(
  // safety.ts is also imported by the frontend vitest suite, where `Deno` is absent.
  env: (k: string) => string | undefined = (k) =>
    (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get(k),
): boolean {
  // An unreadable env (no --allow-env: Deno throws NotCapable) must not break every
  // URL check; it fails safe to the NEW guard.
  try {
    return (env(SSRF_GUARD_LEGACY_ENV) ?? "").trim().toLowerCase() === "true";
  } catch {
    return false;
  }
}

/** `/health` detail for `checks.ssrf_guard`: names the checker actually in force. */
export function ssrfGuardHealthDetail(legacy: boolean): string {
  return legacy
    ? `LEGACY via ${SSRF_GUARD_LEGACY_ENV} (ipv4 private + ::1 only)`
    : "ipv4 private+cgnat; ipv6 loopback/mapped/nat64/ula/link-local/site-local/multicast";
}

export function isPrivateHost(hostname: string, legacy: boolean = ssrfGuardLegacy()): boolean {
  if (legacy) return isPrivateHostLegacy(hostname);
  let h = hostname.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal")) return true;
  // `new URL().hostname` keeps IPv6 literals bracketed ("[::1]").
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  const v4 = parseIPv4(h);
  if (v4) return isPrivateIPv4(v4);
  if (h.includes(":")) return isPrivateIPv6(h);
  return false;
}

// The checker as it stood before 2026-09-24, kept verbatim for the kill switch.
function isPrivateHostLegacy(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal")) return true;
  if (h === "::1" || h.startsWith("[::1")) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true;
  }
  return false;
}

function parseIPv4(h: string): number[] | null {
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
}

function isPrivateIPv4([a, b]: number[]): boolean {
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a >= 224) return true; // multicast / reserved
  return false;
}

/** IPv6 literals, as the URL parser normalises them (lower-case, compressed; an
 *  embedded IPv4 is rewritten to hex: "::ffff:127.0.0.1" → "::ffff:7f00:1"). */
function isPrivateIPv6(h: string): boolean {
  if (h === "::" || h === "::1") return true;
  // IPv4 embedded in IPv6: mapped (::ffff:0:0/96) and NAT64 (64:ff9b::/96) are
  // routed to the IPv4 address itself, so judge that address.
  const embedded = h.match(/^(?:::ffff:|64:ff9b::)(.+)$/);
  if (embedded) {
    const tail = embedded[1];
    const dotted = parseIPv4(tail);
    if (dotted) return isPrivateIPv4(dotted);
    const hex = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
      return isPrivateIPv4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
    }
    return true; // unparseable embedded form: refuse rather than guess
  }
  // IPv4-compatible ::a.b.c.d (::/96, deprecated; the parser rewrites it to
  // "::7f00:1"). Nothing public lives there, so refuse the whole range rather than
  // guess how a stack routes it.
  if (/^::[0-9a-f]{1,4}(?::[0-9a-f]{1,4})?$/.test(h)) return true;
  const first = parseInt(h.split(":")[0] || "0", 16);
  if ((first & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((first & 0xffc0) === 0xfec0) return true; // site-local fec0::/10 (deprecated, still routable on some networks)
  if ((first & 0xff00) === 0xff00) return true; // multicast ff00::/8
  return false;
}

export function assertSafeUrl(rawUrl: string): URL {
  const u = new URL(rawUrl);
  if (!/^https?:$/.test(u.protocol)) throw new Error(`blocked: protocol ${u.protocol}`);
  if (isPrivateHost(u.hostname)) throw new Error(`blocked: private/internal host ${u.hostname}`);
  return u;
}

// ---- Part-size capping --------------------------------------------------------
// Keep one persisted assistant turn well below the 2MB request-body ceiling:
// useChat replays the complete message history on every follow-up, so consuming
// the whole request budget with one assistant row makes the thread immediately
// unusable. Real capped turns are ~100KB; 500KB leaves ample replay detail plus
// headroom for prior turns and the new user message.
export const MAX_PERSISTED_ASSISTANT_PARTS_BYTES = 500_000;

// A persisted assistant message is a UIMessage: its tool parts have type
// `tool-<name>` (or `dynamic-tool`), NOT the ModelMessage `tool-call` /
// `tool-result` discriminators. Match on the UIMessage shape so the caps below
// actually engage on the parts we store.
function isUiToolPart(type: unknown): boolean {
  return typeof type === "string" && (type.startsWith("tool-") || type === "dynamic-tool");
}

/**
 * Control characters Postgres will not accept inside a JSONB string.
 *
 * THE INCIDENT (2026-08-02, thread e66255da). `http_fingerprint` fetched a host
 * whose response contained a literal NUL. It rode into `assistant.parts`, and the
 * insert failed:
 *
 *   [tool_call_cache] write failed for http_fingerprint: unsupported Unicode escape sequence
 *   assistant_message_insert_fail  error: "unsupported Unicode escape sequence"
 *   completion_contract_unmet  assistant_row_persisted: false  assistant_chars: 12736
 *
 * A COMPLETE 12,736-character final report was produced and then thrown away by a
 * one-character validation error, after 28 minutes and $0.97 of tool spend. The
 * cache write had already failed the same way two minutes earlier; nothing acted
 * on that warning because nothing was watching for it.
 *
 * SCOPE: U+0000 ONLY. This is NOT a JSONB validator.
 *
 * An earlier revision stripped the whole C0 range plus DEL, on the assumption
 * that "control bytes are unsafe to round-trip through JSONB". That assumption
 * was wrong, and in an evidence system silently deleting storable bytes is its
 * own kind of data loss. Measured against a real server (PostgreSQL 16.13;
 * reproducer: docs/reproducers/jsonb-nul.sql):
 *
 *   U+0000                       REJECTED in values AND keys
 *                                ERROR: unsupported Unicode escape sequence
 *   U+0001 U+0007 U+0008 U+000B
 *   U+000C U+000E U+001F U+007F  ACCEPTED, and round-trip byte-exact
 *                                (BEL and DEL verified: length 3, middle
 *                                 codepoint 7 and 127 respectively)
 *
 * Postgres rejects U+0000 because its `text` type cannot represent a NUL, not
 * because JSON forbids it -- every other control character escapes cleanly and
 * survives. So this removes exactly the one character with a demonstrated
 * failure, and preserves everything else including TAB/LF/CR.
 *
 * Do not widen this set on the strength of a regex or a plausible argument. Add
 * a character only with a psql reproducer showing that exact codepoint failing.
 *
 * Written with a unicode escape on purpose: embedding the literal byte makes
 * this source file itself binary to grep and diff.
 */
/* eslint-disable no-control-regex -- stripping this character is the entire
   point of this expression; see the incident note above. */
// deno-lint-ignore no-control-regex
const NUL_RE = /\u0000/g;
// Same character, non-regex form: NUL_RE is /g and .test() on a /g regex is
// stateful across calls, which would make key classification order-dependent.
const NUL_CHAR = String.fromCharCode(0);
/* eslint-enable no-control-regex */

/**
 * Recursively remove U+0000 from every string leaf and every object key.
 *
 * Applied at the PERSISTENCE boundary rather than at each tool return, so a write
 * path added later cannot bypass it. Structure, key order, types and numbers are
 * preserved exactly -- only NUL is removed, and only because it cannot be stored
 * at all.
 *
 * KEY COLLISION: scrubbing a key can make it equal one already present, e.g.
 *   { "head\u0000er": "a", "header": "b" }  ->  both want the key "header".
 * No resolution is lossless inside a JSON object, so the rule is stated
 * explicitly rather than left to whichever entry Object.entries happens to
 * yield last:
 *
 *   1. A key that was ALREADY CLEAN always keeps its value. Sanitising must
 *      never destroy data that was valid and storable to begin with.
 *   2. A scrubbed key takes the slot only if no clean key claims it.
 *   3. Among several scrubbed keys landing on the same slot, the first wins.
 *
 * Pinned by test. Do not "simplify" to plain last-write-wins: that lets a value
 * which only collided BECAUSE of scrubbing overwrite one that never needed
 * scrubbing at all.
 */
export function stripNulCharacters<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(NUL_RE, "") as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => stripNulCharacters(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    // Keys needing no scrubbing are inviolable (rule 1), so they must be known
    // before any scrubbed key is allowed to claim a slot.
    const cleanKeys = new Set(entries.map(([k]) => k).filter((k) => !k.includes(NUL_CHAR)));
    // Pairs + Object.fromEntries, NOT `out[key] = v` on a literal. Bracket
    // assignment routes the key "__proto__" through Object.prototype's inherited
    // SETTER on some V8 versions: the key never becomes an own property, it
    // vanishes from JSON.stringify, and the value silently becomes the output's
    // prototype. `__proto__` is a perfectly legal JSON key -- an HTTP response
    // body can contain one -- so that is evidence loss, not a security nicety.
    // Measured: Node 22 / V8 12 loses the key; Deno 2.9.4 / V8 15 does not. The
    // deployed edge runtime's V8 version is not ours to pin, so the construction
    // must be correct under BOTH. Object.fromEntries defines own data properties
    // on every engine tested.
    const pairs: Array<[string, unknown]> = [];
    const claimed = new Set<string>();
    for (const [k, v] of entries) {
      // A poisoned KEY fails the insert just as hard as a poisoned value.
      const key = k.replace(NUL_RE, "");
      if (key !== k) {
        // rule 2: never displace a clean key. rule 3: first scrubbed key wins.
        if (cleanKeys.has(key) || claimed.has(key)) continue;
      }
      claimed.add(key);
      pairs.push([key, stripNulCharacters(v)]);
    }
    return Object.fromEntries(pairs) as unknown as T;
  }
  return value;
}

// Per-part payload cap applied to a UIMessage.parts array BEFORE it is written
// to `messages.parts`. A single tool (e.g. socialfetch_lookup returning a full
// video dump) can emit a 600KB+ `output.data`; stored verbatim it bloats the
// row and — replayed by the client every turn — eventually blows the 2MB
// request-body limit. We shrink only tool parts whose `output`/`input` exceeds
// `fieldThreshold` (small outputs pass through byte-identical), reusing
// `sanitizeToolOutput` so the part shape is preserved for UI tool-replay and
// only oversized string/array values are truncated. Mirrors the cache-path
// sanitize at index.ts (assistant_parts cached for future-run context).
export function capToolPartPayloads(
  parts: unknown[],
  fieldThreshold = 50_000,
  maxStr = 8_000,
  hardMax = 60_000,
): unknown[] {
  const cap = (v: unknown): unknown => {
    // First pass: structure-preserving sanitize — redacts our own auth material,
    // truncates long strings, caps huge arrays. Handles most oversized shapes.
    const sanitized = sanitizeToolOutput(v, maxStr);
    if (JSON.stringify(sanitized).length <= hardMax) return sanitized;
    // Still oversized: a deeply-nested payload of many small fields (e.g. a
    // socialfetch_lookup video dump — 10 videos × ~60KB of `details`) that
    // per-string / per-array caps can't shrink. Replace with a bounded preview
    // so replay stays useful without carrying the full blob.
    const raw = JSON.stringify(sanitized);
    return { _truncated: true, _original_bytes: raw.length, preview: raw.slice(0, maxStr) + "…[truncated]" };
  };
  return parts.map((p) => {
    const part = p as Record<string, unknown> | null;
    if (!part || typeof part !== "object" || !isUiToolPart(part.type)) return p;
    let next: Record<string, unknown> | null = null;
    for (const field of ["output", "input"] as const) {
      const v = part[field];
      if (v == null) continue;
      if (JSON.stringify(v).length > fieldThreshold) {
        next ??= { ...part };
        next[field] = cap(v);
      }
    }
    return next ?? part;
  });
}

// Hard-cap the total serialized size of UIMessage.parts before persisting.
// PostgREST silently 500s on multi-MB JSONB inserts, so when the whole blob is
// over budget we drop `output.raw`/`per_source` from tool parts (largest
// contributors), then replace any remaining oversized part with a stub. This is
// a whole-message backstop; capToolPartPayloads handles the common single-blob
// case first, so this rarely engages.
export function capPartsSize(parts: unknown[], maxBytes: number): unknown[] {
  const size = (x: unknown) => new TextEncoder().encode(JSON.stringify(x)).length;
  if (size(parts) <= maxBytes) return parts;
  const stripped = parts.map((p) => {
    const part = p as Record<string, unknown> | null;
    if (part && isUiToolPart(part.type)) {
      const output = part.output as Record<string, unknown> | undefined;
      if (output && typeof output === "object") {
        const { raw: _raw, per_source: _ps, ...rest } = output as Record<string, unknown>;
        return { ...part, output: rest };
      }
    }
    return part;
  });
  if (size(stripped) <= maxBytes) return stripped;

  // Stub the largest tool parts until the WHOLE message is actually under the
  // requested cap. The old last resort only stubbed individual parts >100KB, so
  // many 50KB parts could collectively remain multi-MB and sail through.
  const compacted = [...stripped];
  const toolIndexes = compacted
    .map((p, index) => ({ index, part: p as Record<string, unknown> | null }))
    .filter(({ part }) => part && isUiToolPart(part.type))
    .sort((a, b) => size(b.part) - size(a.part));
  for (const { index, part } of toolIndexes) {
    if (size(compacted) <= maxBytes) return compacted;
    compacted[index] = {
      type: part!.type,
      toolCallId: part!.toolCallId,
      toolName: part!.toolName,
      state: part!.state,
      output: { truncated: true },
    };
  }
  if (size(compacted) <= maxBytes) return compacted;

  // Assistant messages should now contain only a modest report plus tiny tool
  // stubs. Keep a true hard ceiling even for a pathological giant text/reasoning
  // part: preserve as much user-visible text as fits and drop replay-only detail.
  const text = compacted
    .map((p) => {
      const part = p as Record<string, unknown> | null;
      return part && (part.type === "text" || part.type === "reasoning") && typeof part.text === "string"
        ? part.text
        : "";
    })
    .filter(Boolean)
    .join("\n");
  const marker = "\n…[assistant details truncated to fit storage budget]";
  let low = 0;
  let high = text.length;
  let fallback: unknown[] = [{ type: "text", text: marker.trimStart() }];
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = [{ type: "text", text: text.slice(0, mid) + marker }];
    if (size(candidate) <= maxBytes) {
      fallback = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return fallback;
}