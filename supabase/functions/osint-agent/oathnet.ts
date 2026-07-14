/**
 * oathnet.ts — pure request builders, pooled-quota accounting, and PII/credential
 * redaction for the OathNet v2 surface (stealer, victims, subdomains, AI filter,
 * scanners). Live tool defs in tool-registry.ts call these; keeping the wire shape
 * and — critically — the redaction pure means it is unit-tested, not trusted.
 *
 * SAFETY CONTRACT (see CLAUDE.md "Evidence-integrity rules"): stealer logs and
 * victim files contain raw third-party credentials, cookies, and tokens. NOTHING
 * in a tool RETURN (which becomes model context) or an artifact may carry a raw
 * secret. Every trimmer here strips/masks secret-bearing fields; oathnet_test.ts
 * proves no plaintext password/cookie/token survives.
 *
 * OathNet base: https://oathnet.org/api — auth header MUST be lowercase x-api-key.
 * Quota is 500/day POOLED across the whole OathNet account (not per-endpoint); the
 * search endpoints echo the authoritative remaining count as _meta.lookups.left_today,
 * which we track so the whole oathnet_* family soft-disables before hitting a hard 429.
 */

const BASE = "https://oathnet.org/api";

// ---- Request builders (pure) --------------------------------------------------

/** Append repeated array params as `key[]=v` (OathNet's convention: dbname[], domain[]). */
function appendArray(params: URLSearchParams, key: string, values?: readonly string[]): void {
  for (const v of values ?? []) {
    const s = String(v ?? "").trim();
    if (s) params.append(`${key}[]`, s);
  }
}

/** v2 breach search. `dbnames` scopes to specific databases; `filter_id` reuses an
 * AI/manual filter. A name/email/username/phone all ride the free-text `q`. */
export function oathnetBreachSearchUrl(
  q: string,
  opts: { dbnames?: string[]; limit?: number; filter_id?: string } = {},
): string {
  const params = new URLSearchParams();
  params.set("q", q);
  params.set("limit", String(opts.limit ?? 50));
  appendArray(params, "dbname", opts.dbnames);
  if (opts.filter_id) params.set("filter_id", opts.filter_id);
  return `${BASE}/service/v2/breach/search?${params.toString()}`;
}

/** v2 stealer credential search. `has_log_id` restricts to rows that can pivot into
 * a victim log; `domains` scopes to captured hosts. */
export function oathnetStealerSearchUrl(
  q: string,
  opts: { hasLogId?: boolean; domains?: string[]; limit?: number; filter_id?: string } = {},
): string {
  const params = new URLSearchParams();
  params.set("q", q);
  params.set("limit", String(opts.limit ?? 50));
  if (opts.hasLogId) params.set("has_log_id", "true");
  appendArray(params, "domain", opts.domains);
  if (opts.filter_id) params.set("filter_id", opts.filter_id);
  return `${BASE}/service/v2/stealer/search?${params.toString()}`;
}

/** v2 victim summary search. `totalDocsMin` filters to logs with at least N documents. */
export function oathnetVictimsSearchUrl(
  q: string,
  opts: { totalDocsMin?: number; limit?: number; filter_id?: string } = {},
): string {
  const params = new URLSearchParams();
  params.set("q", q);
  params.set("limit", String(opts.limit ?? 25));
  if (typeof opts.totalDocsMin === "number") params.set("total_docs_min", String(opts.totalDocsMin));
  if (opts.filter_id) params.set("filter_id", opts.filter_id);
  return `${BASE}/service/v2/victims/search?${params.toString()}`;
}

/** Victim manifest (file tree). Raw JSON, not the standard envelope. */
export function oathnetVictimManifestUrl(logId: string): string {
  return `${BASE}/service/v2/victims/${encodeURIComponent(logId)}`;
}

/** Single victim file content. */
export function oathnetVictimFileUrl(logId: string, fileId: string): string {
  return `${BASE}/service/v2/victims/${encodeURIComponent(logId)}/files/${encodeURIComponent(fileId)}`;
}

/** Full victim log as a ZIP. Manual-consent only — never auto-called. */
export function oathnetVictimArchiveUrl(logId: string): string {
  return `${BASE}/service/v2/victims/${encodeURIComponent(logId)}/archive`;
}

/** Subdomains found in stealer records for one domain (not paginated). */
export function oathnetSubdomainUrl(domain: string): string {
  return `${BASE}/service/v2/stealer/subdomain?domain=${encodeURIComponent(domain)}`;
}

/** Breach DB-name autocomplete helper (for scoping dbname[]). */
export function oathnetDbnamesUrl(q: string): string {
  return `${BASE}/service/v2/breach/autocomplete/dbnames?q=${encodeURIComponent(q)}`;
}

/** AI filter creation (POST). Body: { index, query }. Returns a reusable filter_id. */
export const OATHNET_AI_FILTER_URL = `${BASE}/service/v2/ai/filter`;

/** Scanner management. */
export const OATHNET_SCANNER_URLS = {
  quota: `${BASE}/scanners/quota`,
  list: `${BASE}/scanners`,
  create: `${BASE}/scanners/create`,
} as const;

// ---- Pooled quota accounting --------------------------------------------------
// One shared daily pool (500/day) backs EVERY oathnet_* tool. The search endpoints
// echo the authoritative remaining count as _meta.lookups.left_today; we record the
// latest so all six tools read the same figure and the family soft-disables before a
// hard 429. Module-global mirrors the guard.ts pattern (one investigation per isolate).
let oathnetLeftToday: number | null = null;

/** Record the pooled quota echoed by a response. OathNet spells the remaining-count
 * differently per family — search: `_meta.lookups.left_today`; OSINT lookups: top-level
 * `lookups_left`; search-session init: `data.user.daily_lookups.remaining`. Read whichever
 * is present; no-op when none is (that response simply didn't echo the pool). */
export function noteOathnetQuota(payload: unknown): void {
  const p = payload as {
    _meta?: { lookups?: { left_today?: unknown } };
    lookups_left?: unknown;
    data?: { user?: { daily_lookups?: { remaining?: unknown } } };
  };
  const candidates = [
    p?._meta?.lookups?.left_today,
    p?.lookups_left,
    p?.data?.user?.daily_lookups?.remaining,
  ];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) {
      oathnetLeftToday = c;
      return;
    }
  }
}

/** Latest known remaining pooled calls, or null if no response has echoed it yet. */
export function oathnetQuotaLeft(): number | null {
  return oathnetLeftToday;
}

/** True once the pool is known-exhausted — gate every oathnet_* tool on this so a
 * depleted pool doesn't burn 8 tools each learning it via a separate 429. */
export function oathnetExhausted(): boolean {
  return oathnetLeftToday !== null && oathnetLeftToday <= 0;
}

/** Test-only reset of the module-global pool counter. */
export function resetOathnetQuota(): void {
  oathnetLeftToday = null;
}

// ---- Credential / PII redaction ----------------------------------------------

// Field names whose VALUES are raw secrets and must never reach model context or an
// artifact. Matched case-insensitively as a whole key or a key suffix (e.g. "password",
// "user_password", "cookie", "cookies", "auth_token").
const SECRET_KEY_RE =
  /(^|_)(password|passwd|pwd|pass|secret|token|cookie|cookies|auth|authorization|session|hash|ntlm|credit_card|card|cc|cvv|private_key|privkey|seed_phrase|mnemonic|otp|totp|refresh_token|access_token|bearer)s?$/i;

export const SECRET_REDACTION = "***REDACTED***";

/** Deep-clone `value`, replacing any secret-keyed field's value with a marker and
 * capping array lengths. Non-secret scalars pass through. Pure + recursion-bounded.
 * When `reveal` is true (account-authorized full breach reveal) the secret-key
 * redaction is skipped and raw values pass through — arrays are still capped so
 * model context stays bounded. */
export function stripSecrets(value: unknown, arrayCap = 40, depth = 0, reveal = false): unknown {
  if (depth > 6) return "[…]";
  if (Array.isArray(value)) {
    return value.slice(0, arrayCap).map((v) => stripSecrets(v, arrayCap, depth + 1, reveal));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (!reveal && SECRET_KEY_RE.test(k)) {
        out[k] = v == null ? v : SECRET_REDACTION;
      } else {
        out[k] = stripSecrets(v, arrayCap, depth + 1, reveal);
      }
    }
    return out;
  }
  return value;
}

/** Trim a stealer_search item list to identity/pivot fields, dropping raw credentials.
 * Keeps log_id (victim pivot), captured domains/subdomains/paths, the username/email
 * pivots, and dates — passwords/cookies/tokens are stripped. */
export function trimStealerItems(items: unknown, cap = 25, reveal = false): Record<string, unknown>[] {
  if (!Array.isArray(items)) return [];
  return items.slice(0, cap).map((raw) => {
    const it = (raw ?? {}) as Record<string, unknown>;
    const keep: Record<string, unknown> = {
      id: it.id,
      log_id: it.log_id,
      url_str: it.url_str,
      domain: Array.isArray(it.domain) ? it.domain.slice(0, 20) : it.domain,
      subdomain: Array.isArray(it.subdomain) ? it.subdomain.slice(0, 20) : it.subdomain,
      path: Array.isArray(it.path) ? it.path.slice(0, 20) : it.path,
      username: it.username,
      email: Array.isArray(it.email) ? it.email.slice(0, 10) : it.email,
      pwned_at: it.pwned_at,
      indexed_at: it.indexed_at,
      // A stealer row implies a captured credential existed; expose that as a boolean.
      credential_present: it.password != null && it.password !== "",
    };
    if (reveal) {
      // Account authorized full reveal — surface the raw secret-bearing fields the
      // row carried (password, cookies, tokens, hash, etc.) instead of stripping.
      for (const [k, v] of Object.entries(it)) {
        if (SECRET_KEY_RE.test(k) && v != null && v !== "") keep[k] = v;
      }
      return stripSecrets(keep, 40, 0, true) as Record<string, unknown>;
    }
    // Belt-and-suspenders: run the whole kept object through stripSecrets so any
    // secret-keyed field an upstream schema change adds is caught too.
    return stripSecrets(keep) as Record<string, unknown>;
  });
}

/** Trim a victims_search item list to device/identity metadata (the OSINT value),
 * which carries no raw credentials. Arrays capped. */
export function trimVictimItems(items: unknown, cap = 25): Record<string, unknown>[] {
  if (!Array.isArray(items)) return [];
  return items.slice(0, cap).map((raw) => {
    const it = (raw ?? {}) as Record<string, unknown>;
    const arr = (v: unknown, n: number) => (Array.isArray(v) ? v.slice(0, n) : v);
    const keep: Record<string, unknown> = {
      log_id: it.log_id,
      device_user_str: arr(it.device_user_str, 10),
      hwids_str: arr(it.hwids_str, 5),
      device_ips: arr(it.device_ips, 10),
      device_emails_str: arr(it.device_emails_str, 10),
      discord_ids: arr(it.discord_ids, 10),
      total_docs: it.total_docs,
      pwned_at: it.pwned_at,
      indexed_at: it.indexed_at,
    };
    return stripSecrets(keep) as Record<string, unknown>;
  });
}

/** Summarize a victim manifest (file tree) to names/types/sizes only — no file
 * contents are ever fetched here. Node count capped to keep context bounded. */
export function summarizeManifest(manifest: unknown, nodeCap = 200): Record<string, unknown> {
  const m = (manifest ?? {}) as Record<string, unknown>;
  let count = 0;
  const walk = (node: unknown): unknown => {
    if (count >= nodeCap || !node || typeof node !== "object") return undefined;
    const n = node as Record<string, unknown>;
    count++;
    const out: Record<string, unknown> = {
      id: n.id,
      name: n.name,
      type: n.type,
      size_bytes: n.size_bytes,
    };
    if (Array.isArray(n.children) && n.children.length) {
      out.children = n.children.map(walk).filter((c) => c !== undefined);
    }
    return out;
  };
  return {
    log_id: m.log_id,
    log_name: m.log_name,
    victim_tree: walk(m.victim_tree),
    truncated: count >= nodeCap,
    node_count: count,
  };
}

// Combolist / credential line shapes: url:user:pass, user:pass, email:pass, key=value,
// key: value. We mask the SECRET segment while keeping the identity segment (the OSINT
// pivot) visible. Aggressive by design — better to over-mask a preview than leak a cred.
const SECRET_LINE_RE =
  /((?:^|\s)(?:password|passwd|pwd|pass|secret|token|cookie|auth|session|api[_-]?key|bearer)\s*[:=]\s*)(\S+)/gi;

/** Mask secret material in a raw text blob (victim file preview). Handles key:value /
 * key=value secret lines and the trailing password of `a:b:pass` / `user:pass` combos.
 * Returns text safe to place in model context. */
export function maskSecrets(text: string, reveal = false): string {
  if (typeof text !== "string" || !text) return "";
  if (reveal) return text; // account-authorized full reveal — no masking
  return text
    .split(/\r?\n/)
    .map((line) => {
      // 1) explicit secret key:value / key=value
      let masked = line.replace(SECRET_LINE_RE, (_m, p1) => `${p1}${SECRET_REDACTION}`);
      // 2) combolist rows a:b(:c) — mask the trailing secret segment, keep the
      //    leading identity (url/user/email). Only when it looks like a colon-combo
      //    and wasn't already handled as an explicit key:value above.
      if (masked === line && /^[^\s:]+(:[^\s:]+){1,3}$/.test(line.trim())) {
        const parts = line.trim().split(":");
        parts[parts.length - 1] = SECRET_REDACTION;
        masked = parts.join(":");
      }
      return masked;
    })
    .join("\n");
}

/** Build a SAFE victim-file result: metadata + a masked, length-capped preview.
 * Raw file bytes/secret values never leave this function. `sha256` (computed by the
 * caller, which has async crypto) is threaded in for chain-of-custody. */
export function safeVictimFile(opts: {
  logId: string;
  fileId: string;
  text: string;
  sha256?: string;
  previewLines?: number;
  previewChars?: number;
  reveal?: boolean;
}): Record<string, unknown> {
  const raw = typeof opts.text === "string" ? opts.text : "";
  const lineCount = raw ? raw.split(/\r?\n/).length : 0;
  const previewLines = opts.previewLines ?? 20;
  const previewChars = opts.previewChars ?? 2000;
  const reveal = !!opts.reveal;
  const preview = maskSecrets(raw.split(/\r?\n/).slice(0, previewLines).join("\n"), reveal).slice(0, previewChars);
  return {
    log_id: opts.logId,
    file_id: opts.fileId,
    size_bytes: raw.length,
    line_count: lineCount,
    sha256: opts.sha256 ?? null,
    // When reveal is off this is a masked triage excerpt; when the account authorizes
    // full reveal it carries the raw preview verbatim.
    [reveal ? "raw_preview" : "redacted_preview"]: preview,
    redaction_note: reveal
      ? "Account-authorized full reveal — this preview is UNMASKED (raw passwords/cookies/tokens included). Handle as sensitive."
      : "Secret values (passwords/cookies/tokens) are masked. This is a redacted excerpt for triage — do NOT record raw credentials as artifacts.",
  };
}
