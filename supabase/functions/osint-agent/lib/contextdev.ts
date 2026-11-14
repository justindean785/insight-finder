// lib/contextdev.ts — client for Context.dev (api.context.dev/v1): anti-bot page scrape
// and natural-language people search.
//
// CONTRACT. Read 2026-11-09 from the provider's OpenAPI document
// (https://www.context.dev/openapi.json, servers: https://api.context.dev/v1,
// security: `Authorization: Bearer <key>`):
//   POST /web/scrape    { url, formats:{markdown:true}, sharedParams:{mainContentOnly},
//                         maxAgeMs (default 3 days, 0 = fresh), timeoutOpts:{milliseconds} }
//                       → { url, markdown:{requested,success,data,error_code?,message?},
//                           metadata:{title?,…}, cache_metadata:{status,age_ms}, key_metadata? }
//   POST /people/search { query (≤500 chars in fast mode), mode:"fast", filters? }
//                       → { results:[≤10 people], next_cursor, key_metadata? }
// Pricing (context.dev/pricing, 2026-11-09): scrape from 1 credit; people search from
// 10 credits per call. Credit value is plan-dependent ($0.004 on Developer, $0.0009 on
// Pro) — costs.ts ledgers the conservative upper bound.
//
// WHAT IS DELIBERATELY NOT WIRED: web search (exa_search / minimax_web_search already
// cover it, and a free-text query has no selector for the free-first guard), crawl,
// people enrich (20 credits per match), screenshots, HTML, images, authenticated
// browser profiles, and the people-search cursor (one page per call, by design).
//
// FAILURE SHAPES follow this codebase (see lib/opsis.ts):
//   • missing key / kill switch → { error:"…not configured…" | "…provider disabled in config", provider_attempted:false }
//   • 402 → "…quota/credit exhausted (HTTP 402) — provider suppressed for investigation" (logs skipped)
//   • 429 → "context.dev rate-limited — provider suppressed for investigation" (logs skipped)
//   • other non-2xx → { ok:false, status, error:"context.dev <endpoint> HTTP <n>" } (logs failed)
//   • 200 with no usable content → { ok:false, empty:true, error:"…no usable result" } (logs empty)
// Provider text never goes into `error` (it is regex-classified); it travels bounded
// as `provider_message`. No retries: a paid call is never re-sent blind, and a
// repeating failure is what dead-target memory is for.
//
// Zero imports on purpose: pure, testable with an injected fetch.

export const CONTEXT_DEV_BASE_URL = "https://api.context.dev/v1";
export const CONTEXT_DEV_API_KEY_ENV = "CONTEXT_DEV_API_KEY";
/** Kill switch, read at CALL TIME: `CONTEXT_DEV_DISABLED=true` stops every contextdev_* call. */
export const CONTEXT_DEV_DISABLED_ENV = "CONTEXT_DEV_DISABLED";

/** Markdown handed back to the model, at most. The rest is counted, not inlined. */
export const SCRAPE_MAX_CHARS = 8_000;
/** Provider-side deadline sent as timeoutOpts, so Context.dev answers 408 before our own abort. */
export const SCRAPE_PROVIDER_TIMEOUT_MS = 35_000;
/**
 * Our own fetch budgets — the numbers tool_timeout_contract_test.ts measures. The cache.ts
 * wrapper caps (TOOL_TIMEOUT_OVERRIDE_MS) sit ABOVE the largest of these, so the tool
 * always fails cleanly before the wrapper fires.
 */
export const SCRAPE_FETCH_TIMEOUT_MS = 38_000;
export const PEOPLE_FETCH_TIMEOUT_MS = 25_000;
const PROVIDER_MESSAGE_MAX_CHARS = 200;
const PEOPLE_DESCRIPTION_MAX_CHARS = 240;
const PEOPLE_MAX_PROFILES = 5;
const PEOPLE_QUERY_MAX_CHARS = 500;

export interface ContextDevDeps {
  apiKey: string | undefined;
  disabled: boolean;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  signal?: AbortSignal;
}

type Out = Record<string, unknown>;

export function contextDevKillSwitchOn(env: (k: string) => string | undefined = (k) => Deno.env.get(k)): boolean {
  return (env(CONTEXT_DEV_DISABLED_ENV) ?? "").trim().toLowerCase() === "true";
}

export function contextDevDepsFromEnv(signal?: AbortSignal): ContextDevDeps {
  return {
    apiKey: Deno.env.get(CONTEXT_DEV_API_KEY_ENV),
    disabled: contextDevKillSwitchOn(),
    fetch: (url, init) => fetch(url, init),
    signal,
  };
}

/** Not configured / switched off: a pre-provider gate, so the paid slot is refunded. */
export function contextDevGate(deps: Pick<ContextDevDeps, "apiKey" | "disabled">): Out | null {
  if (deps.disabled) {
    return { error: "context.dev unavailable: disabled (provider disabled in config)", provider_attempted: false };
  }
  if (!deps.apiKey) return { error: "CONTEXT_DEV_API_KEY not configured", provider_attempted: false };
  return null;
}

function bounded(text: unknown, max: number): string | undefined {
  if (typeof text !== "string") return undefined;
  const t = text.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : undefined;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** Shape a non-2xx answer. `endpoint` is a constant label, never caller text. */
export async function httpFailure(res: Response, endpoint: string): Promise<Out> {
  const body = await readJson(res) as Record<string, unknown> | null;
  const code = typeof body?.error_code === "string" ? body.error_code.slice(0, 60) : undefined;
  const provider_message = bounded(body?.message, PROVIDER_MESSAGE_MAX_CHARS);
  const base = { ok: false, status: res.status, endpoint, ...(code ? { code } : {}), ...(provider_message ? { provider_message } : {}) };
  if (res.status === 402) {
    return { ...base, error: `context.dev quota/credit exhausted (HTTP 402) — provider suppressed for investigation` };
  }
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after"));
    return {
      ...base,
      ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retry_after_s: retryAfter } : {}),
      error: "context.dev rate-limited — provider suppressed for investigation",
    };
  }
  return { ...base, error: `context.dev ${endpoint} HTTP ${res.status}` };
}

async function post(deps: ContextDevDeps, path: string, body: unknown, timeoutMs: number): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout;
  return await deps.fetch(`${CONTEXT_DEV_BASE_URL}${path}`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${deps.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

function networkFailure(e: unknown, endpoint: string): Out {
  const name = (e as { name?: string })?.name ?? "";
  const timedOut = name === "TimeoutError" || name === "AbortError";
  return { ok: false, endpoint, error: timedOut ? `context.dev ${endpoint} timed out` : `context.dev ${endpoint} network error` };
}

function creditsOf(body: Record<string, unknown> | null): number | undefined {
  const km = body?.key_metadata as Record<string, unknown> | undefined;
  return typeof km?.credits_consumed === "number" ? km.credits_consumed : undefined;
}

/** Normalize a scrape URL: http(s) only, fragment and common tracking params dropped. */
export function normalizeScrapeUrl(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return null;
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  u.hash = "";
  for (const k of [...u.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$|igshid$|mc_eid$|mc_cid$|ref_src$)/i.test(k)) u.searchParams.delete(k);
  }
  return u.toString();
}

/** Trim a scrape response to what the model needs. Pure. */
export function shapeScrape(requestedUrl: string, raw: unknown): Out {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const md = (body.markdown ?? {}) as Record<string, unknown>;
  const meta = (body.metadata ?? {}) as Record<string, unknown>;
  const cache = (body.cache_metadata ?? {}) as Record<string, unknown>;
  const finalUrl = typeof body.url === "string" ? body.url : requestedUrl;
  const common = {
    source: "context.dev",
    endpoint: "web/scrape",
    url: requestedUrl,
    ...(finalUrl !== requestedUrl ? { final_url: finalUrl } : {}),
    ...(bounded(meta.title, 200) ? { title: bounded(meta.title, 200) } : {}),
    cache_status: typeof cache.status === "string" ? cache.status : undefined,
    cache_age_ms: typeof cache.age_ms === "number" ? cache.age_ms : undefined,
    credits_consumed: creditsOf(body),
    captured_at: new Date().toISOString(),
  };
  if (md.success === false) {
    const code = typeof md.error_code === "string" ? md.error_code.slice(0, 60) : "unknown";
    return {
      ok: false,
      ...common,
      code,
      ...(bounded(md.message, PROVIDER_MESSAGE_MAX_CHARS) ? { provider_message: bounded(md.message, PROVIDER_MESSAGE_MAX_CHARS) } : {}),
      error: `context.dev scrape failed (${code})`,
    };
  }
  const text = typeof md.data === "string" ? md.data.trim() : "";
  if (!text) return { ok: false, empty: true, ...common, error: "context.dev scrape: no usable result" };
  const truncated = text.length > SCRAPE_MAX_CHARS;
  return {
    ok: true,
    ...common,
    markdown: truncated ? text.slice(0, SCRAPE_MAX_CHARS) : text,
    chars: text.length,
    truncated,
  };
}

/** `contextdev_scrape`: one page, Markdown only, main content only. */
export async function contextDevScrape(input: { url: string; fresh?: boolean }, deps: ContextDevDeps): Promise<Out> {
  const gate = contextDevGate(deps);
  if (gate) return gate;
  const url = normalizeScrapeUrl(input.url);
  if (!url) {
    return { error: "context.dev scrape: gated — not an http(s) URL", provider_attempted: false };
  }
  const body: Record<string, unknown> = {
    url,
    formats: { markdown: true },
    sharedParams: { mainContentOnly: true },
    markdownParams: { includeLinks: true, includeImages: false },
    timeoutOpts: { milliseconds: SCRAPE_PROVIDER_TIMEOUT_MS, behavior: "fail" },
    ...(input.fresh === true ? { maxAgeMs: 0 } : {}),
  };
  let res: Response;
  try {
    res = await post(deps, "/web/scrape", body, SCRAPE_FETCH_TIMEOUT_MS);
  } catch (e) {
    return networkFailure(e, "web/scrape");
  }
  if (!res.ok) return { url, ...await httpFailure(res, "web/scrape") };
  return shapeScrape(url, await readJson(res));
}

/**
 * Build the people-search query from structured anchors. A name alone is a same-name
 * fishing net, so at least one anchor (company, city, title) is required. Returns
 * null when the request is too thin to send.
 */
export function buildPeopleQuery(input: { name?: unknown; company?: unknown; city?: unknown; title?: unknown }): string | null {
  const clean = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
  const name = clean(input.name);
  const company = clean(input.company);
  const city = clean(input.city);
  const title = clean(input.title);
  if (name.split(" ").filter(Boolean).length < 2) return null;
  if (!company && !city && !title) return null;
  const parts = [name];
  if (title) parts.push(title);
  if (company) parts.push(`at ${company}`);
  if (city) parts.push(`in ${city}`);
  return parts.join(", ").slice(0, PEOPLE_QUERY_MAX_CHARS);
}

/** Trim one person to identity-relevant, analyst-checkable fields. Pure. */
export function shapePerson(raw: unknown): Out {
  const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const loc = (p.location ?? {}) as Record<string, unknown>;
  const role = (p.role ?? {}) as Record<string, unknown>;
  const company = role.company && typeof role.company === "object"
    ? bounded((role.company as Record<string, unknown>).name, 120)
    : bounded(role.company, 120);
  const profiles = Array.isArray(p.profiles)
    ? p.profiles.map((x) => (typeof x === "string" ? x : (x as Record<string, unknown>)?.url))
      .filter((x): x is string => typeof x === "string" && /^https?:\/\//i.test(x)).slice(0, PEOPLE_MAX_PROFILES)
    : [];
  return {
    name: bounded(p.name, 120) ?? null,
    description: bounded(p.description, PEOPLE_DESCRIPTION_MAX_CHARS) ?? null,
    profiles,
    location: [bounded(loc.city, 80), bounded(loc.region, 80), bounded(loc.country_code, 8)].filter(Boolean).join(", ") || null,
    title: bounded(role.title, 120) ?? null,
    company: company ?? null,
  };
}

/** `contextdev_people_search`: ONE page (≤10 people), fast mode, never paged. */
export async function contextDevPeopleSearch(
  input: { name: string; company?: string; city?: string; title?: string; country?: string },
  deps: ContextDevDeps,
): Promise<Out> {
  const gate = contextDevGate(deps);
  if (gate) return gate;
  const query = buildPeopleQuery(input);
  if (!query) {
    return {
      error: "context.dev people search: gated — needs a full name plus at least one anchor (company, city or title)",
      provider_attempted: false,
    };
  }
  const country = typeof input.country === "string" && /^[a-z]{2}$/i.test(input.country.trim())
    ? input.country.trim().toUpperCase()
    : undefined;
  const body = { query, mode: "fast", ...(country ? { filters: { countries: [country] } } : {}) };
  let res: Response;
  try {
    res = await post(deps, "/people/search", body, PEOPLE_FETCH_TIMEOUT_MS);
  } catch (e) {
    return networkFailure(e, "people/search");
  }
  if (!res.ok) return await httpFailure(res, "people/search");
  const raw = await readJson(res) as Record<string, unknown> | null;
  const results = Array.isArray(raw?.results) ? raw!.results.map(shapePerson) : [];
  const common = {
    source: "context.dev",
    endpoint: "people/search",
    query,
    credits_consumed: creditsOf(raw),
    captured_at: new Date().toISOString(),
    // Never paged by this tool: one page per call caps spend at one charge.
    more_available: typeof raw?.next_cursor === "string" && raw.next_cursor.length > 0,
    linkage: "unverified — candidate profiles only; a same-name match is not the subject until a selector overlaps",
  };
  if (results.length === 0) return { ok: false, empty: true, ...common, error: "context.dev people search: no usable result" };
  return { ok: true, ...common, count: results.length, people: results };
}

/** `/health` → `checks.contextdev`. Pure: exercises the shapers with synthetic data. */
export function contextDevSelfTest(hasKey: boolean, disabled: boolean): { ok: boolean; configured: boolean; disabled: boolean; detail: string } {
  const scraped = shapeScrape("https://example.com/a", {
    url: "https://example.com/a",
    markdown: { requested: true, success: true, data: "x".repeat(SCRAPE_MAX_CHARS + 10) },
    metadata: { title: "Example" },
    cache_metadata: { status: "miss", age_ms: 0 },
  });
  const failed = shapeScrape("https://example.com/a", { markdown: { requested: true, success: false, data: null, error_code: "BLOCKED" } });
  const empty = shapeScrape("https://example.com/a", { markdown: { requested: true, success: true, data: "  " } });
  const person = shapePerson({ name: "Jane Example", profiles: ["https://example.com/in/jane", "not a url"], role: { company: { name: "Example Corp" } } });
  const ok = scraped.ok === true && scraped.truncated === true && String(scraped.markdown).length === SCRAPE_MAX_CHARS &&
    failed.ok === false && String(failed.error) === "context.dev scrape failed (BLOCKED)" && empty.empty === true &&
    (person.profiles as string[]).length === 1 && person.company === "Example Corp" &&
    buildPeopleQuery({ name: "Jane Example" }) === null && buildPeopleQuery({ name: "Jane Example", city: "Springfield" }) !== null &&
    normalizeScrapeUrl("javascript:alert(1)") === null &&
    normalizeScrapeUrl("https://example.com/a?utm_source=x&id=2#top") === "https://example.com/a?id=2";
  const state = disabled ? "switched off (CONTEXT_DEV_DISABLED=true)" : hasKey ? "configured" : "not configured (CONTEXT_DEV_API_KEY unset)";
  return {
    ok,
    configured: hasKey,
    disabled,
    detail: ok
      ? `${state}; scrape returns ≤${SCRAPE_MAX_CHARS} chars of main-content Markdown; people search is one page, needs name + anchor; both are free-first gated`
      : "context.dev response shaping misbehaving on its own probe",
  };
}
