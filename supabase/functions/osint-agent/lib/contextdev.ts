/**
 * contextdev.ts — client for the Context.dev web-data API (web search, page scrape,
 * natural-language people search).
 *
 * Contract: https://docs.context.dev/api-reference/{web/search,web/scrape,people/search}.md
 * and https://docs.context.dev/account/credits.md, read 2026-11-03. Every endpoint, field
 * and status code below is taken from those pages, not inferred.
 *
 * ## Why this is its own module with an injected fetch (not fetch_retry.ts)
 *
 * `fetchRetry` retries 429/5xx on a fixed 400ms·2^n backoff and cannot read
 * `Retry-After`; it is also not injectable, so a test cannot script a 429. Context.dev
 * sends `Retry-After` on concurrency rejections and asks clients to honour it. So this
 * module carries its own bounded policy and takes `fetch`, the clock and `sleep` as
 * deps — the house pattern since lib/opsis.ts — and runs its tests in milliseconds.
 *
 * ## Retry policy (bounded, read before changing)
 *
 * - 429 → wait `Retry-After` seconds (capped at CONTEXT_DEV_RETRY_AFTER_CAP_MS, default
 *   CONTEXT_DEV_RETRY_AFTER_DEFAULT_MS when absent/unparseable), ONE retry.
 * - 408 and 5xx → 500ms·2^attempt backoff, TWO retries.
 * - network error → ONE retry, unless the wrapper signal aborted.
 * - the module's OWN timeout → NO retry: the provider may still complete and charge the
 *   first attempt, so a second attempt is the same page bought twice.
 * - every other 4xx (400 validation, 401, 402 USAGE_EXCEEDED, 403, 404, 422) → no retry.
 *   Context.dev states these are not charged and that an unchanged retry cannot succeed.
 *
 * `timeoutMs` is the budget for the WHOLE call, not per attempt: every attempt is capped by
 * what is left of it, and a retry (and its wait) is skipped when fewer than
 * CONTEXT_DEV_MIN_ATTEMPT_MS would remain. The wrapper caps in cache.ts sit above this
 * budget, so the module always fails cleanly first and the wrapper never discards a paid
 * answer that was one retry away.
 *
 * ## Failure shapes follow this codebase, not the docs
 *
 * - Missing key / kill switch → `{ error, skipped: true, provider_attempted: false }`:
 *   the house "not configured" skip, so the paid slot is refunded.
 * - Provider errors → `{ ok: false, status, error: <CONSTANT>, error_code?, provider_message? }`.
 *   Never `skipped`: a tool-emitted skip is logged as outcome "ok", which would hide
 *   "out of Context.dev credits" from `checks.credentials` and stop the circuit from
 *   suppressing a provider that will refuse every call (the Opsis lesson). Provider text
 *   never goes into `error` (`isIntentionalSkip` regex-matches it); it is carried,
 *   bounded, as `provider_message`.
 * - The API key is read from deps at call time and never copied into any result.
 *
 * Zero imports on purpose: pure, and testable with an injected fetch and clock.
 */

export const CONTEXT_DEV_BASE_URL = "https://api.context.dev/v1";
export const CONTEXT_DEV_API_KEY_ENV = "CONTEXT_DEV_API_KEY";
/** Kill switch, read at CALL TIME: `CONTEXT_DEV_DISABLED=true` stops every contextdev_* call. */
export const CONTEXT_DEV_DISABLED_ENV = "CONTEXT_DEV_DISABLED";
/** Provenance label every result carries. */
export const CONTEXT_DEV_PROVIDER = "context.dev";

/** Per-call fetch budgets. The wrapper caps in cache.ts sit ABOVE these so the module fails first. */
export const CONTEXT_DEV_SEARCH_TIMEOUT_MS = 20_000;
export const CONTEXT_DEV_SCRAPE_TIMEOUT_MS = 30_000;
export const CONTEXT_DEV_PEOPLE_TIMEOUT_MS = 25_000;
/** A `Retry-After` longer than this is cut here: a tool call cannot stall a minute inside its cap. */
export const CONTEXT_DEV_RETRY_AFTER_CAP_MS = 10_000;
/** Wait used when a 429 carries no parseable `Retry-After`. */
export const CONTEXT_DEV_RETRY_AFTER_DEFAULT_MS = 1_000;
const RETRY_BACKOFF_BASE_MS = 500;
/** A retry is attempted only when at least this much of the call budget would remain after its wait. */
export const CONTEXT_DEV_MIN_ATTEMPT_MS = 2_000;
const MAX_RETRIES_429 = 1;
const MAX_RETRIES_5XX = 2;
const MAX_RETRIES_NETWORK = 1;
const PROVIDER_MESSAGE_MAX_CHARS = 200;

/** CONSTANT error strings (never provider text — see header). */
export const CONTEXT_DEV_ERRORS = {
  not_configured: "CONTEXT_DEV_API_KEY not configured",
  disabled: "context.dev provider disabled in config",
  http: "context.dev request failed",
  network: "context.dev request did not complete",
  output_failed: "context.dev scrape output failed",
} as const;

export type ContextDevPath = "/web/search" | "/web/scrape" | "/people/search";

export interface ContextDevDeps {
  apiKey: string | undefined;
  disabled: boolean;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** The tool wrapper's timeout signal; aborting it ends the call early and stops retries. */
  signal?: AbortSignal;
}

type Out = Record<string, unknown>;

/** Resolves early (never rejects) when `signal` aborts. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted || ms <= 0) return resolve();
    const done = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** The kill switch, read at CALL time. */
export function contextdevKillSwitchOn(env: (k: string) => string | undefined = (k) => Deno.env.get(k)): boolean {
  return (env(CONTEXT_DEV_DISABLED_ENV) ?? "").trim().toLowerCase() === "true";
}

/** Production deps. Env is read here, at CALL time, so the kill switch needs no deploy. */
export function contextdevDepsFromEnv(signal?: AbortSignal): ContextDevDeps {
  return {
    apiKey: Deno.env.get(CONTEXT_DEV_API_KEY_ENV) || undefined,
    disabled: contextdevKillSwitchOn(),
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    sleep: abortableSleep,
    signal,
  };
}

/**
 * Tools whose governance selector is their natural-language `query`. The wrapper's generic
 * selector detection (cache.ts detectSelectorType/Value) reads email/username/url/… and not
 * `query`, so without this the premium once-per-query gate, dead-target memory and the
 * per-selector circuit keys all saw an EMPTY selector for contextdev_people_search (Codex
 * P2 on #973). Scoped to these tools on purpose: widening the generic detectors to `query`
 * would change the circuit keys of every search tool, which is a separate decision.
 */
export const CONTEXT_DEV_QUERY_SELECTOR_TOOLS: ReadonlySet<string> = new Set(["contextdev_web_search", "contextdev_people_search"]);

/** The normalized query selector for a Context.dev search tool, or null for any other tool / blank query. */
export function contextdevQuerySelector(tool: string, input: Record<string, unknown> | null | undefined): string | null {
  if (!CONTEXT_DEV_QUERY_SELECTOR_TOOLS.has(tool)) return null;
  const q = typeof input?.query === "string" ? input.query.trim().replace(/\s+/g, " ").toLowerCase() : "";
  return q || null;
}

/** The skip every contextdev_* tool returns before contacting the provider, or null to proceed. */
export function contextdevGate(deps: Pick<ContextDevDeps, "apiKey" | "disabled">): Out | null {
  if (deps.disabled) {
    return { error: CONTEXT_DEV_ERRORS.disabled, skipped: true, provider_attempted: false };
  }
  if (!deps.apiKey) {
    return { error: CONTEXT_DEV_ERRORS.not_configured, skipped: true, provider_attempted: false };
  }
  return null;
}

// ── URL canonicalisation + in-run dedup ─────────────────────────────────────

/** Query params that identify a click, not a page. Stripped before dedup. */
const TRACKING_PARAMS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid", "igshid", "mc_cid", "mc_eid"];

/**
 * The dedup key for a URL: lower-cased scheme and host, tracking params removed, fragment
 * dropped, path case preserved (paths are case-sensitive on most origins). Only http(s)
 * URLs qualify; anything else is `null` so a caller drops it rather than throwing.
 */
export function canonicalUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    for (const p of TRACKING_PARAMS) u.searchParams.delete(p);
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Keep the first occurrence of each canonical URL, in order; `seen` carries across calls
 * so a URL returned earlier in the run is reported as a duplicate rather than re-surfaced.
 * The kept items keep their ORIGINAL url string (evidence value); only the key is canonical.
 */
export function dedupByUrl<T extends { url: string }>(
  items: T[],
  seen: Set<string>,
): { kept: T[]; deduped: number; dropped_invalid: number } {
  const kept: T[] = [];
  let deduped = 0;
  let dropped_invalid = 0;
  for (const item of items) {
    const key = canonicalUrl(item?.url);
    if (!key) {
      dropped_invalid++;
      continue;
    }
    if (seen.has(key)) {
      deduped++;
      continue;
    }
    seen.add(key);
    kept.push(item);
  }
  return { kept, deduped, dropped_invalid };
}

// ── Request + retry policy ──────────────────────────────────────────────────

export type ContextDevHttp =
  | { ok: true; status: number; json: Out; credits_consumed?: number; request_id?: string }
  | {
    ok: false;
    status: number | null;
    error: string;
    error_code?: string;
    provider_message?: string;
    retries: number;
    /** The module's own budget ended the attempt; nothing was retried (see header). */
    timed_out?: boolean;
  };

/** Seconds from `Retry-After`, capped; the default when absent or not a number. */
function retryAfterMs(h: Headers): number {
  const raw = h.get("Retry-After");
  const secs = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(secs) || secs < 0) return CONTEXT_DEV_RETRY_AFTER_DEFAULT_MS;
  return Math.min(secs * 1000, CONTEXT_DEV_RETRY_AFTER_CAP_MS);
}

/** Lenient parse of a body already read: a non-object or malformed body is `null`, never a throw. */
function parseJson(text: string): Out | null {
  try {
    const j = JSON.parse(text);
    return j && typeof j === "object" && !Array.isArray(j) ? (j as Out) : null;
  } catch {
    return null;
  }
}

function errorFromBody(status: number, body: Out | null, retries: number): ContextDevHttp {
  const out: ContextDevHttp = { ok: false, status, error: CONTEXT_DEV_ERRORS.http, retries };
  if (typeof body?.error_code === "string") out.error_code = body.error_code;
  if (typeof body?.message === "string" && body.message.trim()) {
    out.provider_message = body.message.slice(0, PROVIDER_MESSAGE_MAX_CHARS);
  }
  return out;
}

/**
 * One bounded POST to Context.dev. Never throws. `timeoutMs` bounds the WHOLE call (all
 * attempts and waits) and every attempt is also chained to the wrapper's signal, so a
 * wrapper abort ends the attempt and stops retries.
 */
export async function contextdevRequest(
  path: ContextDevPath,
  body: Out,
  deps: ContextDevDeps,
  timeoutMs: number,
): Promise<ContextDevHttp> {
  const url = `${CONTEXT_DEV_BASE_URL}${path}`;
  const init: RequestInit = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${deps.apiKey ?? ""}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  };
  let retries = 0;
  let networkRetries = 0;
  const start = deps.now();
  const remaining = () => timeoutMs - (deps.now() - start);
  /** True when a wait of `waitMs` would leave too little budget for another attempt. */
  const cannotAfford = (waitMs: number) => remaining() - waitMs < CONTEXT_DEV_MIN_ATTEMPT_MS;
  for (;;) {
    const attemptBudget = Math.max(1, remaining());
    const attemptStart = deps.now();
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    deps.signal?.addEventListener("abort", onAbort, { once: true });
    if (deps.signal?.aborted) ctrl.abort();
    const tid = setTimeout(() => ctrl.abort(), attemptBudget);
    // fetch() resolves on HEADERS. The timer and the wrapper-signal chain stay armed until the
    // body is consumed (or cancelled) below, so a provider that answers promptly and then
    // stalls mid-body is still bounded by the budget and still stops when the wrapper aborts.
    let status: number;
    let headers: Headers;
    let text: string | null = null;
    let retryWait: number | null = null;
    try {
      const r = await deps.fetch(url, { ...init, signal: ctrl.signal });
      status = r.status;
      headers = r.headers;
      const retriable429 = status === 429 && retries < MAX_RETRIES_429;
      const retriable5xx = (status === 408 || status >= 500) && retries < MAX_RETRIES_5XX;
      if (retriable429 || retriable5xx) {
        const wait = status === 429 ? retryAfterMs(headers) : RETRY_BACKOFF_BASE_MS * Math.pow(2, retries);
        if (!deps.signal?.aborted && !cannotAfford(wait)) {
          retryWait = wait;
          await r.body?.cancel().catch(() => {});
        }
      }
      if (retryWait === null) text = await r.text();
    } catch {
      clearTimeout(tid);
      deps.signal?.removeEventListener("abort", onAbort);
      const ownTimeout = deps.now() - attemptStart >= attemptBudget;
      if (ownTimeout) return { ok: false, status: null, error: CONTEXT_DEV_ERRORS.network, retries, timed_out: true };
      if (networkRetries < MAX_RETRIES_NETWORK && !deps.signal?.aborted && !cannotAfford(RETRY_BACKOFF_BASE_MS)) {
        networkRetries++;
        retries++;
        await deps.sleep(RETRY_BACKOFF_BASE_MS, deps.signal);
        continue;
      }
      return { ok: false, status: null, error: CONTEXT_DEV_ERRORS.network, retries };
    } finally {
      clearTimeout(tid);
      deps.signal?.removeEventListener("abort", onAbort);
    }

    if (retryWait !== null) {
      retries++;
      await deps.sleep(retryWait, deps.signal);
      continue;
    }
    const body = parseJson(text ?? "");
    if (status >= 200 && status < 300) {
      const json = body ?? {};
      const km = json.key_metadata as Out | undefined;
      const out: ContextDevHttp = { ok: true, status, json };
      if (typeof km?.credits_consumed === "number") out.credits_consumed = km.credits_consumed;
      if (typeof json.request_id === "string") out.request_id = json.request_id;
      return out;
    }
    return errorFromBody(status, body, retries);
  }
}

// ── Health ──────────────────────────────────────────────────────────────────

/** `/health` detail for `checks.contextdev`. Presence only — no network. */
export function contextdevHealthDetail(hasKey: boolean, disabled: boolean): { ok: true; detail: string } {
  if (disabled) return { ok: true, detail: `disabled via ${CONTEXT_DEV_DISABLED_ENV}` };
  if (!hasKey) return { ok: true, detail: `not configured (${CONTEXT_DEV_API_KEY_ENV} unset); contextdev tools removed from the schema` };
  return { ok: true, detail: "configured; contextdev_web_search / contextdev_scrape / contextdev_people_search live" };
}

/**
 * `/health` `checks.contextdev`: the presence detail above plus a pure probe of the two
 * things this module decides on its own — URL canonicalisation/dedup and the Retry-After
 * parser. No network, no secrets. Its PRESENCE proves the build carrying the contextdev_*
 * tools is live; `ok:false` means canon/dedup or the retry wait regressed.
 */
export function contextdevSelfTest(hasKey: boolean, disabled: boolean): { ok: boolean; detail: string } {
  const base = contextdevHealthDetail(hasKey, disabled);
  const seen = new Set<string>();
  const d = dedupByUrl(
    [{ url: "https://A.example/p?utm_source=x&id=1#f" }, { url: "https://a.example/p?id=1" }, { url: "javascript:void(0)" }],
    seen,
  );
  const canonOk = d.kept.length === 1 && d.deduped === 1 && d.dropped_invalid === 1 &&
    seen.has("https://a.example/p?id=1") && canonicalUrl("ftp://a.example/") === null;
  const h = (v: string) => new Headers({ "Retry-After": v });
  const retryOk = retryAfterMs(h("2")) === 2_000 &&
    retryAfterMs(h("3600")) === CONTEXT_DEV_RETRY_AFTER_CAP_MS &&
    retryAfterMs(h("garbage")) === CONTEXT_DEV_RETRY_AFTER_DEFAULT_MS &&
    retryAfterMs(new Headers()) === CONTEXT_DEV_RETRY_AFTER_DEFAULT_MS;
  const ok = canonOk && retryOk;
  return { ok, detail: `${base.detail}; ${ok ? "selftest ok" : `selftest FAILED (canon ${canonOk}, retry_after ${retryOk})`}` };
}

// ── Trimming caps (prompt budget: the model reads every byte returned) ──────

/** Search never asks for more than 10: 1 credit per 10 results, so this is one base credit. */
export const CONTEXT_DEV_SEARCH_MAX_RESULTS = 10;
export const CONTEXT_DEV_SNIPPET_MAX_CHARS = 600;
export const CONTEXT_DEV_HIGHLIGHTS_MAX = 4;
export const CONTEXT_DEV_HIGHLIGHT_MAX_CHARS = 280;
/** Page markdown handed to the model. The full page never leaves this module. */
export const CONTEXT_DEV_MARKDOWN_MAX_CHARS = 2_000;
/** The API returns up to 10 per page; this is a defensive cap, not a request parameter. */
export const CONTEXT_DEV_PEOPLE_MAX_RESULTS = 10;
/** Provider-side deadlines, each under the module's own fetch cap so the API answers first. */
const SEARCH_PROVIDER_DEADLINE_MS = 15_000;
const SCRAPE_PROVIDER_DEADLINE_MS = 25_000;
/** `query` maxLength in `fast` mode (people/search). */
const PEOPLE_QUERY_MAX_CHARS = 500;

export interface SearchInput {
  query: string;
  numResults?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  freshness?: "last_24_hours" | "last_week" | "last_month" | "last_year";
  highlights?: boolean;
}
export interface ScrapeInput {
  url: string;
  /** true → `maxAgeMs: 0` (fetch fresh). Default leaves the provider's 3-day cache window. */
  fresh?: boolean;
}
export interface PeopleInput {
  query: string;
  countries?: string[];
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const asObj = (v: unknown): Out | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Out) : null);

function unexpectedShape(detail: string): Out {
  return { ok: false, status: 200, error: CONTEXT_DEV_ERRORS.http, error_code: "UNEXPECTED_SHAPE", provider_message: detail };
}

function withMeta(out: Out, http: Extract<ContextDevHttp, { ok: true }>): Out {
  if (http.credits_consumed !== undefined) out.credits_consumed = http.credits_consumed;
  if (http.request_id !== undefined) out.request_id = http.request_id;
  return out;
}

/** A provider error, re-shaped for the tool result (drops the internal retry counter). */
function httpFailure(http: Extract<ContextDevHttp, { ok: false }>): Out {
  const out: Out = { ok: false, status: http.status, error: http.error, provider: CONTEXT_DEV_PROVIDER };
  if (http.error_code) out.error_code = http.error_code;
  if (http.provider_message) out.provider_message = http.provider_message;
  return out;
}

// ── Web search ──────────────────────────────────────────────────────────────

/** `POST /web/search` → trimmed, deduped rows. `seen` is the run-wide canonical-URL set. */
export function shapeSearchResponse(raw: unknown, seen: Set<string>): Out {
  const d = asObj(raw);
  if (!d || !Array.isArray(d.results)) return unexpectedShape("web/search: no results array");
  const rows: Array<{ url: string } & Out> = [];
  for (const r of d.results as unknown[]) {
    const o = asObj(r);
    const url = str(o?.url);
    if (!o || !url) continue;
    const row: { url: string } & Out = { url };
    const title = str(o.title);
    if (title) row.title = title;
    const snippet = str(o.description);
    if (snippet) row.snippet = snippet.slice(0, CONTEXT_DEV_SNIPPET_MAX_CHARS);
    const relevance = str(o.relevance);
    if (relevance) row.relevance = relevance;
    const hl = asObj(o.highlights);
    if (hl?.code === "SUCCESS" && Array.isArray(hl.highlights)) {
      const passages = (hl.highlights as unknown[])
        .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
        .slice(0, CONTEXT_DEV_HIGHLIGHTS_MAX)
        .map((p) => p.slice(0, CONTEXT_DEV_HIGHLIGHT_MAX_CHARS));
      if (passages.length) row.highlights = passages;
    }
    rows.push(row);
  }
  const { kept, deduped, dropped_invalid } = dedupByUrl(rows, seen);
  const results = kept.slice(0, CONTEXT_DEV_SEARCH_MAX_RESULTS);
  const out: Out = { ok: true, provider: CONTEXT_DEV_PROVIDER, results, count: results.length, deduped, dropped_invalid };
  if (d.partial === true) out.partial = true;
  return out;
}

export async function contextdevWebSearch(input: SearchInput, deps: ContextDevDeps, seen: Set<string>): Promise<Out> {
  const gate = contextdevGate(deps);
  if (gate) return gate;
  const query = String(input.query ?? "").trim();
  const body: Out = {
    query,
    numResults: Math.max(1, Math.min(CONTEXT_DEV_SEARCH_MAX_RESULTS, Math.trunc(input.numResults ?? CONTEXT_DEV_SEARCH_MAX_RESULTS))),
    timeoutOpts: { milliseconds: SEARCH_PROVIDER_DEADLINE_MS, behavior: "return-partial" },
  };
  if (input.includeDomains?.length) body.includeDomains = input.includeDomains;
  if (input.excludeDomains?.length) body.excludeDomains = input.excludeDomains;
  if (input.freshness) body.freshness = input.freshness;
  // Schema: `enabled` + `maxCharacters` ONLY (additionalProperties: false). A `query` key here
  // is a 400 the circuit would then pin to the selector for the rest of the run.
  if (input.highlights === true) {
    body.highlightsOptions = { enabled: true, maxCharacters: CONTEXT_DEV_HIGHLIGHTS_MAX * CONTEXT_DEV_HIGHLIGHT_MAX_CHARS };
  }
  const http = await contextdevRequest("/web/search", body, deps, CONTEXT_DEV_SEARCH_TIMEOUT_MS);
  if (!http.ok) return httpFailure(http);
  const shaped = shapeSearchResponse(http.json, seen);
  if (shaped.ok !== true) return shaped;
  shaped.query = query;
  return withMeta(shaped, http);
}

// ── Scrape ──────────────────────────────────────────────────────────────────

/** `POST /web/scrape` (markdown only) → capped page text + provenance metadata. */
export function shapeScrapeResponse(raw: unknown): Out {
  const d = asObj(raw);
  const md = asObj(d?.markdown);
  if (!d || !md || typeof md.requested !== "boolean") return unexpectedShape("web/scrape: no markdown output block");
  if (md.success !== true || typeof md.data !== "string") {
    const out: Out = { ok: false, status: 200, error: CONTEXT_DEV_ERRORS.output_failed, provider: CONTEXT_DEV_PROVIDER };
    const code = str(md.error_code);
    if (code) out.error_code = code;
    const msg = str(md.message);
    if (msg) out.provider_message = msg.slice(0, PROVIDER_MESSAGE_MAX_CHARS);
    return out;
  }
  const meta = asObj(d.metadata);
  const cache = asObj(d.cache_metadata);
  const text = md.data;
  const out: Out = {
    ok: true,
    provider: CONTEXT_DEV_PROVIDER,
    markdown: text.slice(0, CONTEXT_DEV_MARKDOWN_MAX_CHARS),
    chars: text.length,
    truncated: text.length > CONTEXT_DEV_MARKDOWN_MAX_CHARS,
  };
  const title = str(meta?.title);
  if (title) out.title = title;
  const finalUrl = str(meta?.finalUrl);
  if (finalUrl) out.final_url = finalUrl;
  const cacheStatus = str(cache?.status);
  if (cacheStatus) out.cache_status = cacheStatus;
  return out;
}

export async function contextdevScrape(input: ScrapeInput, deps: ContextDevDeps): Promise<Out> {
  const gate = contextdevGate(deps);
  if (gate) return gate;
  const url = String(input.url ?? "").trim();
  const body: Out = {
    url,
    formats: { markdown: true },
    sharedParams: { mainContentOnly: true },
    timeoutOpts: { milliseconds: SCRAPE_PROVIDER_DEADLINE_MS, behavior: "fail" },
  };
  if (input.fresh === true) body.maxAgeMs = 0;
  const http = await contextdevRequest("/web/scrape", body, deps, CONTEXT_DEV_SCRAPE_TIMEOUT_MS);
  if (!http.ok) return httpFailure(http);
  const shaped = shapeScrapeResponse(http.json);
  shaped.url = url;
  const canon = canonicalUrl(url);
  if (canon) shaped.url_canonical = canon;
  if (shaped.ok !== true) return shaped;
  return withMeta(shaped, http);
}

// ── People search ───────────────────────────────────────────────────────────

/**
 * `POST /people/search` → lead-grade rows, in the provider's order (most relevant first).
 * Deduped on the first profile URL via `seen`, which must be a PEOPLE-ONLY set: a LinkedIn
 * URL that appeared in a 1-credit search snippet list is not the same evidence as a
 * 10-credit structured person row, so the web-search set never hides a person.
 */
export function shapePeopleResponse(raw: unknown, seen: Set<string>): Out {
  const d = asObj(raw);
  if (!d || !Array.isArray(d.results)) return unexpectedShape("people/search: no results array");
  const results: Out[] = [];
  let deduped = 0;
  let dropped_invalid = 0;
  for (const r of d.results as unknown[]) {
    const o = asObj(r);
    if (!o) continue;
    const row: Out = {};
    const name = str(o.name);
    if (name) row.name = name;
    const headline = str(o.description);
    if (headline) row.headline = headline;
    const profiles = Array.isArray(o.profiles) ? (o.profiles as unknown[]).filter((p): p is string => typeof p === "string" && p.trim().length > 0) : [];
    row.profiles = profiles;
    const loc = asObj(o.location);
    if (loc) {
      const location: Out = {};
      const city = str(loc.city);
      if (city) location.city = city;
      const region = str(loc.region);
      if (region) location.region = region;
      const country = str(loc.country);
      if (country) location.country = country;
      if (Object.keys(location).length) row.location = location;
    }
    const role = asObj(o.role);
    if (role) {
      const shapedRole: Out = {};
      const title = str(role.title);
      if (title) shapedRole.title = title;
      const company = asObj(role.company);
      const companyName = str(company?.name);
      if (companyName) {
        const c: Out = { name: companyName };
        const domain = str(company?.domain);
        if (domain) c.domain = domain;
        shapedRole.company = c;
      }
      if (Object.keys(shapedRole).length) row.role = shapedRole;
    }
    const yoe = num(o.years_of_experience);
    if (yoe !== undefined) row.years_of_experience = yoe;
    if (profiles.length) {
      const key = canonicalUrl(profiles[0]);
      if (!key) dropped_invalid++;
      else if (seen.has(key)) {
        deduped++;
        continue;
      } else seen.add(key);
    }
    if (results.length < CONTEXT_DEV_PEOPLE_MAX_RESULTS) results.push(row);
  }
  return {
    ok: true,
    provider: CONTEXT_DEV_PROVIDER,
    authority: "lead",
    results,
    count: results.length,
    deduped,
    dropped_invalid,
    empty: results.length === 0,
    has_more: typeof d.next_cursor === "string" && d.next_cursor.length > 0,
  };
}

export async function contextdevPeopleSearch(input: PeopleInput, deps: ContextDevDeps, seen: Set<string>): Promise<Out> {
  const gate = contextdevGate(deps);
  if (gate) return gate;
  const query = String(input.query ?? "").trim().slice(0, PEOPLE_QUERY_MAX_CHARS);
  const body: Out = { query, mode: "fast" };
  if (input.countries?.length) body.filters = { countries: input.countries };
  const http = await contextdevRequest("/people/search", body, deps, CONTEXT_DEV_PEOPLE_TIMEOUT_MS);
  if (!http.ok) return httpFailure(http);
  const shaped = shapePeopleResponse(http.json, seen);
  if (shaped.ok !== true) return shaped;
  shaped.query = query;
  return withMeta(shaped, http);
}
