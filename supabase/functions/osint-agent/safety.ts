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
const DATE_LIKE_RE = /\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b/;
function isDateLike(s: string): boolean {
  return DATE_LIKE_RE.test(s);
}

export function scrubArtifactRow(row: Record<string, unknown>): Record<string, unknown> {
  const kind = String(row.kind ?? "").toLowerCase();
  const meta: Record<string, unknown> = { ...((row.metadata ?? {}) as Record<string, unknown>) };

  // Minor-safety detection — scan bio/description metadata fields and the
  // value itself (for name/social/username artifacts that carry a bio context).
  const haystacks: string[] = [];
  for (const f of BIO_META_FIELDS) {
    const val = meta[f];
    if (typeof val === "string") haystacks.push(val);
  }
  // A date-of-birth carries no bio text — its digits are date parts, not ages.
  // Reclassified DOBs land in kind "other", so guard on original_kind too.
  const originalKind = String(meta.original_kind ?? "").toLowerCase();
  const isDob = kind === "dob" || originalKind === "dob";
  if (!isDob && (kind === "username" || kind === "social" || kind === "name" || kind === "other" || kind === "bio")) {
    if (typeof row.value === "string") haystacks.push(String(row.value));
  }
  const signals: string[] = [];
  let ageSignal: number | null = null;
  for (const h of haystacks) {
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
    // Bare digit 10–17 in a short bio (≤120 chars) is a soft signal — but never
    // on a date-like string, whose month/day (e.g. "1958-10-11" → "10") is not
    // an age. Explicit age cues ("i'm 16", "16 y/o") still match above.
    if (!cueMatch && h.length <= 120 && !isDateLike(h)) {
      const bare = h.match(/(?:^|[^\d])(1[0-7])(?:[^\d]|$)/);
      if (bare) {
        const age = parseInt(bare[1], 10);
        if (age >= 10 && age <= 17 && !ageSignal) {
          signals.push(`bare-${age}`);
        }
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
// loopback, link-local (cloud metadata!), and RFC1918 private ranges so the
// edge function cannot be turned into a scanner of internal infra.
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal")) return true;
  if (h === "::1" || h.startsWith("[::1")) return true;
  // IPv4
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true; // multicast / reserved
  }
  return false;
}

export function assertSafeUrl(rawUrl: string): URL {
  const u = new URL(rawUrl);
  if (!/^https?:$/.test(u.protocol)) throw new Error(`blocked: protocol ${u.protocol}`);
  if (isPrivateHost(u.hostname)) throw new Error(`blocked: private/internal host ${u.hostname}`);
  return u;
}

// ---- Part-size capping --------------------------------------------------------
// Hard-cap the serialized size of UIMessage.parts before persisting. PostgREST
// silently 500s on multi-MB JSONB inserts, so we drop `output.raw` blobs from
// tool-result parts (largest contributors) when over budget, then replace any
// remaining oversized parts with a stub.
export function capPartsSize(parts: unknown[], maxBytes: number): unknown[] {
  const size = (x: unknown) => JSON.stringify(x).length;
  if (size(parts) <= maxBytes) return parts;
  const stripped = parts.map((p) => {
    const part = p as Record<string, unknown> | null;
    if (part && (part.type === "tool-result" || part.type === "tool-call")) {
      const output = part.output as Record<string, unknown> | undefined;
      if (output && typeof output === "object") {
        const { raw: _raw, per_source: _ps, ...rest } = output as Record<string, unknown>;
        return { ...part, output: rest };
      }
    }
    return part;
  });
  if (size(stripped) <= maxBytes) return stripped;
  // Last resort: stub oversized tool-results
  return stripped.map((p) => {
    const part = p as Record<string, unknown> | null;
    if (part && part.type === "tool-result" && size(part) > 100_000) {
      return { type: "tool-result", toolCallId: part.toolCallId, toolName: part.toolName, output: { truncated: true } };
    }
    return part;
  });
}