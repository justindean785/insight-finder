// lib/indicia-web-dbs.ts — request resolution for Indicia's `/v1/search/intelligence/web-dbs`.
//
// WHY THIS EXISTS. The endpoint accepts `snusbase` in `services`, and when it is selected it
// REQUIRES a `snusbaseType`. The tool defaulted `services` to the full set (snusbase included)
// and never sent a type, so every call that omitted `services` was a guaranteed
// `HTTP 400: snusbaseType is required when snusbase is selected` (tasks/todo.md T1; 5 of 8
// production calls in the 30 days to 2026-11-08 per JD's ledger read).
//
// THE ALLOWED VALUES ARE THE PROVIDER'S, NOT INFERRED. Read 2026-11-09 from the live OpenAPI
// document (`GET https://api.indicia.app/openapi`, requestBody of web-dbs):
//   snusbaseType ∈ { _domain, email, hash, lastip, name, password, username, wildcard }
// There is NO phone type. The official CLI's generated description lists `phone`, but its
// own `choices` array and the OpenAPI enum both omit it, so it is not sent.
//
// Rules this module keeps:
//   • `password` is never INFERRED. A password is not recognisable from its shape, and guessing
//     one would send an analyst's selector to a credential search it was not meant for. The
//     caller may still name it explicitly (same rule as inferHudsonRockType).
//   • A selector Snusbase cannot search (phone-shaped) DROPS snusbase from the request instead
//     of mis-typing it as a username. The other corpora still run.
//   • Nothing here echoes the selector into an error string — `error` is lifted into
//     tool_usage_log.error_msg (same rule as the indicia_phone gate).
//
// Kill switch, read at CALL TIME: INDICIA_SNUSBASE_TYPE_DISABLED=true removes snusbase from every
// request (no type is ever sent). That is the safe fallback if the inference misbehaves: the
// other three corpora keep working. It does NOT restore the pre-fix behaviour, which was a
// guaranteed 400.
//
// Zero imports on purpose: pure, so /health can self-test it without loading the AI SDK.

/** The closed set of corpora `/web-dbs` accepts in `services` (as used by this tool). */
export const WEB_DB_SERVICES = [
  "cloudsint",
  "leakcheck",
  "snusbase",
  "intelligencex.identityportal",
] as const;

/** The provider's `snusbaseType` enum, verbatim from the OpenAPI document (2026-11-09). */
export const SNUSBASE_TYPES = [
  "_domain",
  "email",
  "hash",
  "lastip",
  "name",
  "password",
  "username",
  "wildcard",
] as const;
export type SnusbaseType = typeof SNUSBASE_TYPES[number];

export const INDICIA_SNUSBASE_TYPE_DISABLED_ENV = "INDICIA_SNUSBASE_TYPE_DISABLED";

export function indiciaSnusbaseTypeDisabled(
  env: (k: string) => string | undefined = (k) => Deno.env.get(k),
): boolean {
  return (env(INDICIA_SNUSBASE_TYPE_DISABLED_ENV) ?? "").trim().toLowerCase() === "true";
}

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
// Loose IPv6: hex groups and colons, at least two colons. A username cannot contain ':' on any
// mainstream platform, so the false-positive cost is negligible.
const IPV6_RE = /^[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,7}$/i;
// MD5 / SHA-1 / SHA-256 / SHA-512 hex digests.
const HASH_RE = /^(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64}|[0-9a-f]{128})$/i;
const PHONE_CHARS_RE = /^\+?[\d\s().-]+$/;
const DOMAIN_RE = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.([a-z]{2,63})$/i;
// A dotted handle (`jordan.vale`, `jane.example`) is shaped exactly like a domain. Typing it
// `_domain` would search the wrong Snusbase column, so a dotted selector counts as a domain only
// when its last label is a two-letter country code or one of these common generic TLDs. A domain
// on a rarer TLD falls through to `username`; the caller can always pass snusbaseType explicitly.
const COMMON_GTLDS = new Set([
  "com", "net", "org", "edu", "gov", "mil", "int", "info", "biz", "name", "pro", "mobi",
  "io", "app", "dev", "xyz", "online", "site", "tech", "store", "shop", "blog", "cloud",
  "live", "life", "world", "space", "website", "club", "agency", "company", "email", "link",
]);

function isDomainShaped(q: string): boolean {
  const m = DOMAIN_RE.exec(q);
  if (!m) return false;
  const tld = m[1].toLowerCase();
  return tld.length === 2 || COMMON_GTLDS.has(tld);
}

/**
 * Infer a Snusbase search type from the selector's shape, or `null` when Snusbase has no
 * type for it (a phone number). Never returns `password` or `wildcard`: neither is inferable
 * from shape, and both widen the search beyond what the analyst asked for.
 */
export function inferSnusbaseType(query: string): SnusbaseType | null {
  const q = String(query ?? "").trim();
  if (!q) return null;
  if (q.includes("@")) return "email";
  if (IPV4_RE.test(q) || IPV6_RE.test(q)) return "lastip";
  if (HASH_RE.test(q)) return "hash";
  if (PHONE_CHARS_RE.test(q)) {
    const digits = q.replace(/\D+/g, "").length;
    if (digits >= 7 && digits <= 15) return null; // phone-shaped: Snusbase has no phone type
  }
  if (isDomainShaped(q)) return "_domain";
  if (/\s/.test(q)) return "name";
  return "username";
}

export function normalizeSnusbaseType(value: unknown): SnusbaseType | null {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (SNUSBASE_TYPES as readonly string[]).includes(v) ? (v as SnusbaseType) : null;
}

export type WebDbsResolution =
  | {
    ok: true;
    body: { query: string; services: string[]; snusbaseType?: SnusbaseType };
    /** Services the caller asked for (or defaulted to) that this request will not send. */
    dropped: string[];
    snusbaseType: SnusbaseType | null;
    /** How the type was chosen: the caller named it, it was inferred, or snusbase is not in the request. */
    typeSource: "explicit" | "inferred" | "none";
  }
  | { ok: false; error: string };

/**
 * Resolve the web-dbs request body. Pure.
 *
 * `services` is filtered to the closed set; an omitted or empty list defaults to all of it.
 * When snusbase is in the list it gets a type (explicit, else inferred) or is dropped. If
 * dropping it leaves nothing to query, the result is a gate (`ok:false`): the caller must not
 * contact the provider, and the error says "gated" so the call is logged as skipped.
 */
export function resolveWebDbsRequest(
  input: { query: string; services?: unknown[]; snusbaseType?: unknown },
  opts: { snusbaseDisabled?: boolean } = {},
): WebDbsResolution {
  const query = String(input.query ?? "").trim();
  const requested = (Array.isArray(input.services) ? input.services : [])
    .map((s) => String(s).trim().toLowerCase())
    .filter((s) => (WEB_DB_SERVICES as readonly string[]).includes(s));
  const deduped = [...new Set(requested)];
  const wanted = deduped.length > 0 ? deduped : [...WEB_DB_SERVICES];

  if (!wanted.includes("snusbase")) {
    return { ok: true, body: { query, services: wanted }, dropped: [], snusbaseType: null, typeSource: "none" };
  }

  const explicit = normalizeSnusbaseType(input.snusbaseType);
  const type = opts.snusbaseDisabled ? null : (explicit ?? inferSnusbaseType(query));
  if (type) {
    return {
      ok: true,
      body: { query, services: wanted, snusbaseType: type },
      dropped: [],
      snusbaseType: type,
      typeSource: explicit && !opts.snusbaseDisabled ? "explicit" : "inferred",
    };
  }

  const services = wanted.filter((s) => s !== "snusbase");
  if (services.length === 0) {
    const why = opts.snusbaseDisabled
      ? `snusbase is switched off (${INDICIA_SNUSBASE_TYPE_DISABLED_ENV})`
      : "snusbase has no search type for a phone-shaped selector";
    return {
      ok: false,
      error: `indicia web-dbs: gated — ${why} and no other web-DB service was requested`,
    };
  }
  return { ok: true, body: { query, services }, dropped: ["snusbase"], snusbaseType: null, typeSource: "none" };
}

/** /health self-test. Synthetic selectors only (reserved domains, documentation IP ranges). */
export function indiciaSnusbaseTypeSelfTest(
  disabled = indiciaSnusbaseTypeDisabled(),
): { ok: boolean; switch: string; detail: string } {
  const sw = INDICIA_SNUSBASE_TYPE_DISABLED_ENV;
  const probes: Array<[string, SnusbaseType | null]> = [
    ["jane@example.com", "email"],
    ["192.0.2.10", "lastip"],
    ["2001:db8::1", "lastip"],
    ["d41d8cd98f00b204e9800998ecf8427e", "hash"],
    ["+1 (202) 555-0100", null],
    ["example.org", "_domain"],
    ["Jane Q Example", "name"],
    ["example_handle", "username"],
    ["jordan.vale", "username"],
  ];
  const inferenceOk = probes.every(([q, want]) => inferSnusbaseType(q) === want);
  const omitted = resolveWebDbsRequest({ query: "example_handle" }, { snusbaseDisabled: disabled });
  const phoneOnly = resolveWebDbsRequest({ query: "+1 202 555 0100", services: ["snusbase"] }, { snusbaseDisabled: disabled });
  const neverPassword = probes.every(([q]) => inferSnusbaseType(q) !== "password");

  if (disabled) {
    const ok = inferenceOk && neverPassword && omitted.ok && !omitted.body.services.includes("snusbase") &&
      !("snusbaseType" in omitted.body) && !phoneOnly.ok;
    return {
      ok,
      switch: `${sw}=true`,
      detail: ok
        ? `LEGACY-SAFE via ${sw}: snusbase is removed from every web-dbs request (no type sent); the other corpora still run`
        : "indicia web-dbs resolution misbehaving with the switch on",
    };
  }
  const ok = inferenceOk && neverPassword && omitted.ok && omitted.body.services.includes("snusbase") &&
    omitted.body.snusbaseType === "username" && !phoneOnly.ok;
  return {
    ok,
    switch: `${sw}=false`,
    detail: ok
      ? "indicia_web_dbs sends snusbaseType whenever snusbase is selected (explicit, else inferred from the selector's shape; never password); a phone-shaped selector drops snusbase instead of mis-typing it"
      : "indicia web-dbs snusbaseType inference misbehaving",
  };
}
