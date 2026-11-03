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
 * - network error / per-attempt timeout → ONE retry, unless the wrapper signal aborted.
 * - every other 4xx (400 validation, 401, 402 USAGE_EXCEEDED, 403, 404, 422) → no retry.
 *   Context.dev states these are not charged and that an unchanged retry cannot succeed.
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
  | { ok: false; status: number | null; error: string; error_code?: string; provider_message?: string; retries: number };

/** Seconds from `Retry-After`, capped; the default when absent or not a number. */
function retryAfterMs(h: Headers): number {
  const raw = h.get("Retry-After");
  const secs = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(secs) || secs < 0) return CONTEXT_DEV_RETRY_AFTER_DEFAULT_MS;
  return Math.min(secs * 1000, CONTEXT_DEV_RETRY_AFTER_CAP_MS);
}

async function readJson(r: Response): Promise<Out | null> {
  try {
    const j = await r.json();
    return j && typeof j === "object" ? (j as Out) : null;
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
 * One bounded POST to Context.dev. Never throws. `timeoutMs` bounds EACH attempt and is
 * chained to the wrapper's signal, so a wrapper abort ends the attempt and stops retries.
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
  for (;;) {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    deps.signal?.addEventListener("abort", onAbort, { once: true });
    if (deps.signal?.aborted) ctrl.abort();
    const tid = setTimeout(() => ctrl.abort(), timeoutMs);
    let r: Response;
    try {
      r = await deps.fetch(url, { ...init, signal: ctrl.signal });
    } catch {
      clearTimeout(tid);
      deps.signal?.removeEventListener("abort", onAbort);
      if (networkRetries < MAX_RETRIES_NETWORK && !deps.signal?.aborted) {
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

    const status = r.status;
    if (status >= 200 && status < 300) {
      const json = (await readJson(r)) ?? {};
      const km = json.key_metadata as Out | undefined;
      const out: ContextDevHttp = { ok: true, status, json };
      if (typeof km?.credits_consumed === "number") out.credits_consumed = km.credits_consumed;
      if (typeof json.request_id === "string") out.request_id = json.request_id;
      return out;
    }

    const retriable429 = status === 429 && retries < MAX_RETRIES_429;
    const retriable5xx = (status === 408 || status >= 500) && retries < MAX_RETRIES_5XX;
    if ((retriable429 || retriable5xx) && !deps.signal?.aborted) {
      const wait = status === 429 ? retryAfterMs(r.headers) : RETRY_BACKOFF_BASE_MS * Math.pow(2, retries);
      await r.body?.cancel().catch(() => {});
      retries++;
      await deps.sleep(wait, deps.signal);
      continue;
    }
    return errorFromBody(status, await readJson(r), retries);
  }
}

// ── Health ──────────────────────────────────────────────────────────────────

/** `/health` detail for `checks.contextdev`. Presence only — no network. */
export function contextdevHealthDetail(hasKey: boolean, disabled: boolean): { ok: true; detail: string } {
  if (disabled) return { ok: true, detail: `disabled via ${CONTEXT_DEV_DISABLED_ENV}` };
  if (!hasKey) return { ok: true, detail: `not configured (${CONTEXT_DEV_API_KEY_ENV} unset); contextdev tools removed from the schema` };
  return { ok: true, detail: "configured; contextdev_web_search / contextdev_scrape / contextdev_people_search live" };
}
