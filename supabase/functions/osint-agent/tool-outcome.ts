/**
 * tool-outcome.ts — honest tool-call outcome classification.
 *
 * The `tool_usage_log` "failure rate" was inflated because the wrapper logged
 * orchestrator GOVERNANCE decisions (budget/burst/concurrency caps, dedup,
 * provider suppression, gating, missing-key/disabled stubs) and NEGATIVE results
 * (target simply has no record) all as `ok=false` — i.e. as if the tool broke.
 *
 * `classifyToolOutcome` maps an (error_msg, status_code) pair to one of four
 * buckets so telemetry and the circuit breaker can tell a real provider failure
 * apart from an intentional skip or an empty-but-successful lookup:
 *   • ok      — genuine success
 *   • skipped — governance / gating / suppression: the tool was intentionally
 *               not run (or its result discarded by policy). NOT a failure.
 *   • empty   — the tool ran fine but the target has no record (404 / no result).
 *               NOT a failure.
 *   • failed  — a real error: upstream 5xx, genuine provider 4xx (400/401/403/429),
 *               timeout, or abort.
 *
 * Pure + deterministic (string/number in, enum out) so it is fully unit-tested
 * and safe to share between cache.ts (the logged outcome) and circuit.ts (the
 * suppression counter — which must increment ONLY on `failed`).
 */

export type ToolOutcome = "ok" | "skipped" | "empty" | "failed";

// Governance / gating / suppression phrases the runtime emits on purpose.
// Matching any of these means the tool did not really run (or its result was
// intentionally discarded) — it must never count as a provider failure.
const SKIP_RE =
  /execution plan required|duplicate call|burst limit|same-tool (?:cycle limit|budget)|paid-call (?:cycle limit|budget)|internal (?:paid-call|run|per-tool) cap reached|active-call concurrency|internal concurrency cap|already has a call in-flight|high-cost tool already used|weak lead blocked|expected value\s+\d+\s+below|disabled after \d+ consecutive|degraded this run|suppressed for investigation|selector blacklisted|unavailable:\s*(?:disabled|missing_key|gated)|\bgated\b|not configured|provider disabled in config|rate-limited\s*[—-]\s*provider|provider\b[^]*?\bsuppressed|5xx\s*[—-]\s*provider|finalize window open|run tool-call cap reached|opsis search guard:|redundant correlate|dead target:|disabled for thread/i;

// Tool ran, but the target has no record. A successful negative, not a failure.
const EMPTY_RE = /no usable result|skipped\s*[—-]\s*no usable result|not found\b/i;

export function classifyToolOutcome(
  errorMsg: string | null | undefined,
  statusCode: number | null | undefined,
): ToolOutcome {
  // Coerce defensively: some tools (e.g. serus_darkweb_scan) pass a non-string
  // error payload (an object) despite the string type, which made `.trim()`
  // throw `(errorMsg ?? "").trim is not a function` and crash classification.
  const msg = String(errorMsg ?? "").trim();
  // No error and no status → the call succeeded.
  if (!msg && (statusCode == null)) return "ok";

  // Governance / gating / suppression always wins — even when a status code is
  // present (e.g. "429 rate-limited — provider X suppressed for investigation").
  if (msg && SKIP_RE.test(msg)) return "skipped";

  // Negative result: explicit "no usable result" text, or a bare 404 (the
  // lookup worked, the record just isn't there — gravatar/hibp/github style).
  if (msg && EMPTY_RE.test(msg)) return "empty";
  if (statusCode === 404) return "empty";

  // Everything else with an error/status is a genuine failure (5xx, real
  // 400/401/403/429, 451 legal block, timeout, abort, parse error, …).
  return "failed";
}

// ---- Proven-empty result classification (H1) -----------------------------------
// `classifyToolOutcome` above maps (error_msg, status_code) → outcome, and is only
// reachable when the call FAILED. A successful negative — the provider ran fine and
// the target genuinely has no record — carries `ok:true`, no error and no status, so
// it could never reach the `empty` bucket and was persisted as `outcome:"ok"`.
// Measured in production 2026-08-24: gravatar_profile 79 ok / 0 empty (82 of 86 cached
// payloads are `found:false`), leakcheck_lookup 182 ok / 0 empty (78 cached payloads
// carry a top-level `found:0`).
//
// This resolver closes that gap WITHOUT touching operational success. It is consulted
// only for telemetry: a proven-empty result keeps `ok:true`, stays chargeable, stays
// cacheable, and stays circuit-breaker-healthy. ONLY the persisted `outcome` changes.
//
// DESIGN RULES (deliberate, do not relax):
//  • EXPLICIT per-tool table — never a generic recursive sweep for `found`/`count`/
//    `matched`/`listed`/`archived`. Those field names do not carry the same semantics
//    across tools (socialfetch sets `found:false` for a PRIVATE profile, which is a
//    positive existence finding), and a generic sweep would also capture internal,
//    non-provider tools such as memory_recall / detect_contradictions.
//  • Every predicate is SHAPE-ANCHORED: it requires the exact field to be present with
//    the exact type, so an unrelated payload can never satisfy it by accident.
//  • Fail closed: anything not in the table, or any predicate that throws, is NOT empty.
export type EmptyPredicate = (r: Record<string, unknown>) => boolean;

const isArr = (v: unknown): v is unknown[] => Array.isArray(v);
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

// Per-tool proven-negative signals. Each entry cites the tool-registry.ts return that
// produces it. "parse-overlap" notes tools whose negative branch is ALSO reached when a
// 200 response body fails to parse — see PARSE_OVERLAP_TOOLS below.
export const PROVEN_EMPTY_PREDICATES: Readonly<Record<string, EmptyPredicate>> = {
  // {ok: r.ok || r.status===404, status, found, ...} — `found` is r.ok, i.e. derived
  // from the HTTP status, never from the body. No parse overlap.
  gravatar_profile: (r) => r.found === false,

  // Clean-negative branch returns a TOP-LEVEL `found: 0`; the positive branch carries
  // the count under `data.found` only. Requiring the top-level field is what separates
  // them, so this must NOT be relaxed to a nested lookup.
  leakcheck_lookup: (r) => r.found === 0,

  // Profile routes carry data.lookupStatus 'found' | 'private' | 'not_found'.
  // ONLY an explicit 'not_found' is empty. 'private' means the profile EXISTS and is a
  // positive existence finding (27 such cached rows in production) — it stays `ok`.
  socialfetch_lookup: (r) => r.lookupStatus === "not_found",

  // `listed:false` is emitted on the HTTP-404 branch only. No parse overlap.
  ransomwarelive_lookup: (r) => r.listed === false && r.count === 0,

  census_geocode: (r) => r.matched === false && isArr(r.matches) && r.matches.length === 0,
  nominatim_geocode: (r) => r.matched === false,

  // CDX returns [] or a header-only array when nothing is archived.
  wayback_cdx_search: (r) =>
    r.archived === false && isArr(r.captures) && r.captures.length === 0,

  // Two distinct zero-LEI returns exist. The one with `records: []` is a proven
  // zero-result. The FUZZY one ({count:0, fuzzy:true, suggestions:[...]}) returned
  // candidate entities and is a PARTIAL result — it has no `records` key, so requiring
  // an empty `records` array excludes it. Keep it that way.
  gleif_lei_search: (r) =>
    r.count === 0 && r.fuzzy !== true && isArr(r.records) && r.records.length === 0,

  // `found:false` + `upstream_status:404` is emitted by lib/negative-lookup.ts on InternetDB's
  // HTTP-404 branch ONLY — a 2xx never carries `found`. No parse overlap.
  shodan_internetdb: (r) => r.found === false && r.upstream_status === 404,

  // `found:false` + `target_status` 404/410 is emitted only when Jina's own header says the
  // ORIGIN answered 404/410. Any other origin error is a failed read, never a negative.
  jina_reader_scrape: (r) =>
    r.found === false && (r.target_status === 404 || r.target_status === 410),

  oathnet_stealer_search: (r) => r.count === 0 && isArr(r.items) && r.items.length === 0,
  oathnet_victims_search: (r) => r.count === 0 && isArr(r.items) && r.items.length === 0,
  oathnet_subdomains: (r) =>
    r.count === 0 && isArr(r.subdomains) && r.subdomains.length === 0,

  // oathnet_lookup returns the provider envelope verbatim: {ok, status, quota_left,
  // data:{success, message, data, _meta}}. `data.success` is true even for a zero-hit
  // search (612/612 cached rows), so it cannot discriminate. The V2-Breach-Search
  // service puts its rows in data.data.items; 203 of 612 cached rows hold an EMPTY
  // items array, and none of those carries an `offset` or a `next_cursor`, so an empty
  // items array is never an end-of-pagination artifact. The ip-info service returns a
  // different shape with NO `items` key, so requiring an actual array leaves it `ok`.
  // An empty page at a non-zero offset, or one that still advertises a next_cursor,
  // is END-OF-PAGINATION, not "no record" — guarded even though production shows the
  // case does not currently arise (all 203 empty-items rows carry a null offset and
  // no next_cursor).
  oathnet_lookup: (r) => {
    const d = obj(r.data);
    const inner = d ? obj(d.data) : null;
    if (!inner || !isArr(inner.items) || inner.items.length !== 0) return false;
    const offset = inner.offset;
    if (typeof offset === "number" && offset > 0) return false;
    const cursor = inner.next_cursor;
    if (cursor !== undefined && cursor !== null && cursor !== "") return false;
    return true;
  },
};

// Tools that fold a rare 200-with-unparseable-body into the SAME branch that emits
// their genuine zero-result, so a malformed response reads as `empty`. Recorded here
// for the audit trail: today those same responses are persisted as `ok`, which is
// strictly less accurate, so this is not a regression — the real fix is tool-side
// (return ok:false when the body does not parse) and is tracked as a follow-up.
//
// opencorporates_search is deliberately ABSENT from the table above and is NOT merely
// a parse-overlap case: it has a DEDICATED malformed-response guard
// (`if (!Array.isArray(companies)) return { ok:true, name, count:0, companies:[] }`)
// whose only trigger is a malformed body, and it emits a payload byte-identical to the
// genuine zero-result return further down. Two distinct code paths, one indistinguishable
// payload — so no predicate can separate them, and a malformed response is not evidence
// that no record exists. It keeps its current `ok` classification.
export const PARSE_OVERLAP_TOOLS: readonly string[] = [
  "leakcheck_lookup",
  "census_geocode",
  "nominatim_geocode",
  "wayback_cdx_search",
  "gleif_lei_search",
  "oathnet_stealer_search",
  "oathnet_victims_search",
  "oathnet_subdomains",
];

/**
 * True when `result` is a PROVEN successful-negative for `toolName`.
 *
 * Consulted only to decide the persisted `outcome`; it never affects operational
 * success, billing, caching, dedup, the circuit breaker, or the payload handed to the
 * model. Unknown tools and unrecognised shapes always return false (fail closed).
 */
export function isProvenEmptyResult(toolName: string, result: unknown): boolean {
  const predicate = PROVEN_EMPTY_PREDICATES[toolName];
  if (!predicate) return false;
  const r = obj(result);
  if (!r) return false;
  try {
    return predicate(r) === true;
  } catch {
    return false;
  }
}
