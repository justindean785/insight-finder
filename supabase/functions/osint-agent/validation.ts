/**
 * validation.ts — Seed detection, cache TTLs, and artifact validation.
 * Extracted from index.ts (lines 284–547).
 */

// ---- Seed normalization -------------------------------------------------------
// Must match src/lib/seed.ts so cache keys line up.
export type DetectedSeed = { kind: string; raw: string; normalized: string };

export function detectSeedServer(input: string): DetectedSeed | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const IP = /^(?:\d{1,3}\.){3}\d{1,3}$/;
  const URL_ = /^https?:\/\/\S+$/i;
  const DOMAIN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;
  const PHONE = /^\+?[\d\s\-().]{7,}$/;
  const ETH = /^0x[a-f0-9]{40}$/i;
  const BTC = /^(?:bc1|[13])[a-z0-9]{25,62}$/i;
  const USER = /^[a-z0-9_.-]{2,40}$/i;
  if (EMAIL.test(raw)) {
    const lower = raw.toLowerCase();
    const [localRaw, domain] = lower.split("@");
    const local = localRaw.split("+")[0];
    return { kind: "email", raw, normalized: `${local}@${domain}` };
  }
  if (URL_.test(raw)) {
    try {
      const u = new URL(raw);
      return { kind: "url", raw, normalized: `${u.protocol}//${u.hostname.toLowerCase()}${u.pathname.replace(/\/$/, "")}${u.search}` };
    } catch { /* fall through */ }
  }
  if (IP.test(raw)) return { kind: "ip", raw, normalized: raw };
  if (ETH.test(raw) || BTC.test(raw)) return { kind: "crypto", raw, normalized: raw.toLowerCase() };
  if (PHONE.test(raw)) return { kind: "phone", raw, normalized: raw.replace(/[^\d+]/g, "") };
  if (DOMAIN.test(raw)) return { kind: "domain", raw, normalized: raw.toLowerCase() };
  if (USER.test(raw)) return { kind: "username", raw, normalized: raw.toLowerCase() };
  // Person/name-location heuristic: multi-word, mostly letters, not a structured identifier.
  // Example: "josh gillman rocklin ca" → person seed (so the agent uses person fan-out
  // instead of treating it as a free-form `other` blob and running username_sweep on it).
  const PERSON = /^[a-z][a-z.'-]*(?:[\s,]+[a-z][a-z.'-]*){1,7}$/i;
  if (PERSON.test(raw)) {
    return { kind: "person", raw, normalized: raw.toLowerCase().replace(/[\s,]+/g, " ").trim() };
  }
  return { kind: "other", raw, normalized: raw.toLowerCase() };
}

// ---- Reserved / fiction / invalid phone detection ----------------------------
// NANPA reserves the 555-0100..555-0199 range for fiction/examples, and certain
// patterns (all-same digit, sequential, N11 service codes, invalid NANP area/
// exchange codes) can never belong to a real subscriber. A seed matching any of
// these should short-circuit to "no real owner" — otherwise reverse-lookup and
// breach aggregators happily return placeholder/junk records that the agent then
// mis-attributes to a real person.
export function isReservedOrInvalidPhone(raw: string): { reserved: boolean; reason?: string } {
  const digits = (raw ?? "").replace(/[^\d]/g, "");
  // Strip a leading US/Canada country code for NANP analysis.
  const nanp = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (nanp.length === 10) {
    const area = nanp.slice(0, 3);
    const exch = nanp.slice(3, 6);
    const line = nanp.slice(6);
    // 555-01xx fiction range.
    if (exch === "555" && line >= "0100" && line <= "0199") {
      return { reserved: true, reason: "555-01xx is the NANPA fiction/example range — no real subscriber" };
    }
    // Invalid NANP: area or exchange code cannot start with 0 or 1.
    if (/^[01]/.test(area) || /^[01]/.test(exch)) {
      return { reserved: true, reason: "invalid NANP area/exchange code (cannot start with 0 or 1)" };
    }
    // N11 service codes as exchange (211,311,411,511,611,711,811,911).
    if (/^[2-9]11$/.test(exch)) {
      return { reserved: true, reason: "N11 service-code exchange — not a subscriber line" };
    }
  }
  // All-same digit or trivially sequential (any length ≥7).
  if (digits.length >= 7) {
    if (/^(\d)\1+$/.test(digits)) return { reserved: true, reason: "all-identical-digit number — not a real line" };
    if (digits === "1234567890" || digits === "0123456789") return { reserved: true, reason: "sequential placeholder number" };
  }
  return { reserved: false };
}

// ---- Per-investigation tool-call cache TTLs ----------------------------------
// External data changes at different rates. Unknown provider tools use the
// conservative default instead of becoming effectively permanent.
export const TTL_6H_MS = 6 * 60 * 60 * 1000;
export const TTL_12H_MS = 12 * 60 * 60 * 1000;
export const TTL_24H_MS = 24 * 60 * 60 * 1000;
export const TTL_7D_MS = 7 * TTL_24H_MS;
export const DEFAULT_TOOL_TTL_MS = TTL_24H_MS;

export const TOOL_TTL_MS: Record<string, number> = {
  socialfetch_lookup: TTL_6H_MS,
  username_sweep: TTL_6H_MS,
  minimax_web_search: TTL_6H_MS,
  exa_search: TTL_6H_MS,
  jina_reader_scrape: TTL_6H_MS,
  emailrep_lookup: TTL_12H_MS,
  gravatar_lookup: TTL_12H_MS,
  leakcheck_lookup: TTL_12H_MS,
  oathnet_lookup: TTL_12H_MS,
  bosint_email_lookup: TTL_12H_MS,
  breach_check: TTL_12H_MS,
  whois_lookup: TTL_24H_MS,
  dns_records: TTL_24H_MS,
  shodan_internetdb: TTL_24H_MS,
  urlscan_search: TTL_24H_MS,
  wayback_snapshots: TTL_7D_MS,
};

// Tools that mutate state — never cache.
export const NO_CACHE_TOOLS = new Set<string>([
  "triage_seed",
  "record_artifact",
  "record_artifacts",
  "record_evidence",
]);

// ---- Artifact validation / reclassification ----------------------------------
// Server-side gatekeeper for `record_artifact(s)`. Catches malformed values,
// drops opaque blobs, and reclassifies obvious mismatches (e.g. "@handle" tagged
// as a `name`) so the resources panel stays clean.
export type ValidateResult =
  | { ok: true; kind: string; value: string; metaPatch?: Record<string, unknown> }
  | { ok: false; reason: string };

export function shannonEntropy(s: string): number {
  const freq: Record<string, number> = {};
  for (const c of s) freq[c] = (freq[c] ?? 0) + 1;
  const len = s.length || 1;
  let h = 0;
  for (const k of Object.keys(freq)) {
    const p = freq[k] / len;
    h -= p * Math.log2(p);
  }
  return h;
}

export const EMAIL_RE = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/;
export const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;
export const IPV4_RE = /^((25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(25[0-5]|2[0-4]\d|[01]?\d?\d)$/;
export const IPV6_RE = /^[0-9a-f:]+$/i;
export const NAME_RE = /^[\p{L}][\p{L}.\-' ]{1,79}$/u;
export const PHONE_RE = /^\+?[0-9\-\s().]{6,32}$/;

export function validateArtifact(kind: string, rawValue: string): ValidateResult {
  const value = (rawValue ?? "").trim();
  if (!value) return { ok: false, reason: "empty value" };
  if (value.length > 2000) return { ok: false, reason: "value too long (>2000 chars)" };

  // ---- New strict taxonomy passthroughs ---------------------------------
  // Accept new kinds with light length validation. Specific value formats
  // (email/domain/etc.) still fall through to the dedicated branches below.
  const STRICT_PASSTHROUGH = new Set([
    "alias", "social_profile", "law_enforcement_unit", "court_case",
    "criminal_case_event", "media_report", "music_profile", "account_id",
    "hash", "crypto_wallet", "breach_exposure", "contradiction",
    "weak_lead", "excluded_collision", "employer",
  ]);
  if (STRICT_PASSTHROUGH.has(kind)) {
    if (value.length > 500) return { ok: false, reason: `${kind} value too long (>500 chars) — put detail in metadata` };
    return { ok: true, kind, value };
  }

  // ---- Cross-kind auto-reclassification ---------------------------------
  // These run BEFORE the per-kind switch so a poorly-typed input (kind="other"
  // for a case caption, kind="name" for an organization) lands in the right
  // bucket. Each rule returns early when it fires.

  // Case captions: "United States v. ...", "People v. ...", "In re ..."
  if (/^(united\s+states|people|state|commonwealth|in\s+re|in\s+the\s+matter\s+of)\s+(v\.?|of)\s+/i.test(value)) {
    return { ok: true, kind: "case", value, metaPatch: kind !== "case" ? { reclassified_from: kind } : undefined };
  }
  // Subdomain shape: known prefix + valid hostname (e.g. crm.example.com).
  if (kind === "other" || kind === "subdomain" || kind === "domain") {
    const host = value.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (/^(www\.[a-z0-9-]+\.|crm\.|portal\.|ledger\.|staging\.|dev\.|api\.|admin\.|mail\.|webmail\.|vpn\.|cpanel\.|whm\.)/.test(host) && DOMAIN_RE.test(host)) {
      return { ok: true, kind: "subdomain", value: host, metaPatch: kind !== "subdomain" ? { reclassified_from: kind } : undefined };
    }
  }
  // Organization shape: 1-5 Title-Case words ending in a corporate suffix.
  if (kind === "other" || kind === "name" || kind === "organization") {
    if (/^([A-Z][A-Za-z0-9&'.-]*\s+){0,4}(Inc\.?|LLC|Ltd\.?|Limited|Corp\.?|Corporation|Company|Co\.?|GmbH|S\.?A\.?|N\.?V\.?|PLC|Ventures|Capital|Partners|Holdings|Group|Foundation|Trust|Labs|Studios|Foundation|Bank|Fund)$/.test(value)) {
      return { ok: true, kind: "organization", value, metaPatch: kind !== "organization" ? { reclassified_from: kind } : undefined };
    }
  }

  switch (kind) {
    case "email": {
      const v = value.toLowerCase();
      if (!EMAIL_RE.test(v)) return { ok: false, reason: "not a valid email address" };
      return { ok: true, kind, value: v };
    }
    case "domain": {
      const v = value.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      if (!DOMAIN_RE.test(v)) return { ok: false, reason: "not a valid hostname" };
      return { ok: true, kind, value: v };
    }
    case "ip": {
      if (!IPV4_RE.test(value) && !(value.includes(":") && IPV6_RE.test(value))) {
        return { ok: false, reason: "not a valid IP address" };
      }
      return { ok: true, kind, value };
    }
    case "username":
    case "social": {
      // Strip @-prefix, reject whitespace and obvious sentences.
      const v = value.replace(/^@+/, "").trim();
      if (/\s/.test(v)) return { ok: false, reason: "username must not contain whitespace" };
      if (v.length < 2 || v.length > 64) return { ok: false, reason: "username length out of range" };
      if (/[<>"'`]/.test(v)) return { ok: false, reason: "username contains illegal punctuation" };
      return { ok: true, kind: "username", value: v.toLowerCase() };
    }
    case "name": {
      // Reject things like "deantecarson on Instagram" — that's a social ref, not a name.
      if (/\bon\s+(instagram|twitter|tiktok|facebook|youtube|reddit|github|twitch)\b/i.test(value)) {
        // Auto-reclassify the handle portion as a username when possible.
        const handle = value.split(/\s+on\s+/i)[0]?.trim().replace(/^@+/, "");
        const platform = value.split(/\s+on\s+/i)[1]?.trim().toLowerCase();
        if (handle && !/\s/.test(handle)) {
          return {
            ok: true,
            kind: "username",
            value: handle.toLowerCase(),
            metaPatch: { platforms: platform ? [platform] : undefined, reclassified_from: "name" },
          };
        }
        return { ok: false, reason: "name looks like a social reference, not a person name" };
      }
      // Strip trailing parentheticals like "Prince (Twitter display name)" → "Prince",
      // recording the platform hint in metadata so it can be merged with the bare name.
      const paren = value.match(/^(.+?)\s*\(([^()]+)\)\s*$/);
      let nameValue = value;
      let metaPatch: Record<string, unknown> | undefined;
      if (paren) {
        nameValue = paren[1].trim();
        const hint = paren[2].trim().toLowerCase();
        const plat = hint.match(/(instagram|twitter|tiktok|facebook|youtube|reddit|github|twitch)/);
        metaPatch = { platforms: plat ? [plat[1]] : undefined, parenthetical: hint };
      }
      if (!NAME_RE.test(nameValue)) return { ok: false, reason: "not a plausible person name" };
      return { ok: true, kind, value: nameValue, metaPatch };
    }
    case "phone": {
      if (!PHONE_RE.test(value)) return { ok: false, reason: "not a valid phone number" };
      const reserved = isReservedOrInvalidPhone(value);
      if (reserved.reserved) {
        return { ok: true, kind, value, metaPatch: { reserved_number: true, reserved_reason: reserved.reason } };
      }
      return { ok: true, kind, value };
    }
    // ---- Expanded analyst taxonomy (free-form, length-capped) -----------
    // These don't need a strict regex — they're analyst-curated entity labels.
    // We trim + cap length so they don't explode the artifacts panel.
    case "person": {
      // Promote to existing `name` kind when it parses as a real name; else
      // keep as `source_person` (journalist/commentator) marker.
      if (NAME_RE.test(value)) return { ok: true, kind: "name", value };
      if (value.length > 200) return { ok: false, reason: "person value too long" };
      return { ok: true, kind: "source_person", value };
    }
    case "organization":
    case "subdomain":
    case "case":
    case "infrastructure":
    case "financial_claim":
    case "event":
    case "source_person":
    case "legal_record":
    case "risk_note": {
      if (value.length > 500) return { ok: false, reason: `${kind} value too long (>500 chars) — put detail in metadata` };
      return { ok: true, kind, value };
    }
    case "bio":
    case "biography":
    case "description": {
      // Profile bios are narrative by nature — keep them but cap length and
      // store under `other` with a hint so downstream filters know.
      const v = value.slice(0, 1000);
      return { ok: true, kind: "other", value: v, metaPatch: { kind_hint: "bio" } };
    }
    case "other": {
      // Auto-promote display-name patterns to `name` so the existing name
      // dedup can merge them with bare-name variants.
      const displayName = value.match(/^(.+?)\s*\((?:(instagram|twitter|tiktok|facebook|youtube|reddit|github|twitch)\s+)?(?:business\s+)?display\s+name\)\s*$/i);
      if (displayName) {
        const nameValue = displayName[1].trim();
        const platform = displayName[2]?.toLowerCase();
        if (NAME_RE.test(nameValue)) {
          return {
            ok: true,
            kind: "name",
            value: nameValue,
            metaPatch: {
              platforms: platform ? [platform] : undefined,
              reclassified_from: "other",
            },
          };
        }
      }
      // Drop opaque base64/hex blobs that escaped a tool's parser.
      if (value.length > 100 && shannonEntropy(value) > 4.5 && /^[A-Za-z0-9+/=_-]+$/.test(value)) {
        return { ok: false, reason: "looks like a raw/opaque blob (high entropy) — parse it first" };
      }
      // Reject narrative blobs masquerading as artifacts. Real "other" artifacts
      // are short identifiers/labels; analyst commentary belongs in the chat,
      // and structured fields belong in their typed kind (email/domain/etc.).
      if (value.length > 120) {
        return { ok: false, reason: "value too long for `other` — record analysis in chat, or split into typed artifacts (email/domain/username/etc.)" };
      }
      if (
        /[.!?]\s+[a-z]/.test(value) ||
        /^(Commercial|Sneaker|Streetwear|Instagram bio|Instagram display name|Bio:|Profile:|Analysis:|Identity:|Display name:)/i.test(value)
      ) {
        return { ok: false, reason: "looks like narrative text — record in chat instead, or extract typed artifacts (email/url/handle)" };
      }
      return { ok: true, kind, value };
    }
    default: {
      // Unknown kind from the model — coerce to `other` with a hint so the
      // batch isn't rejected. Address/avatar/breach pass through unchanged.
      const known = new Set(["address", "avatar", "breach"]);
      if (known.has(kind)) return { ok: true, kind, value };
      const v = value.slice(0, 1000);
      return { ok: true, kind: "other", value: v, metaPatch: { original_kind: kind } };
    }
  }
}
