// lib/socq.ts — client for SocQ (api.socq.ai): asynchronous public social-data collection.
//
// CONTRACT. Read 2026-11-09 from docs.socq.ai (llms.txt, api-manual/agent-api/overview.md,
// errors.md, the per-endpoint pages, capability-catalog.json and agent-api.json):
//   POST /v1/<platform>/<api>  body: the endpoint's own fields (usernames[] | urls[] | query,
//                              results_limit)  → { code:200, data:{ task_id, status } }
//   GET  /v1/tasks/{task_id}?view=standard&limit=N
//                              → { code:200, data:{ task_id, status, result_count, credits_amount,
//                                  error_message?, results:{ items:[…], next_cursor, has_more } } }
//   Terminal statuses are `succeeded` and `failed`; anything else is still running.
//   Errors: { code, error:{ message, type } } — 400 bad body, 401 key, 402 credits,
//   403 task not ours, 404 not found, 422 validation, 429 rate or credit limit (Retry-After).
// Billing (overview.md#billing): per returned record. A submit RESERVES credits from
// results_limit (or the number of usernames/urls) and SocQ settles on the actual result_count.
// The catalog's credits per result are copied into SOCQ_ENDPOINTS below. The dollar value of a
// credit is not published; costs.ts ledgers an UNVERIFIED $0.01 until the plan is confirmed.
//
// NEVER USED: callback_url (no inbound webhook), the raw /files export, comments, follower or
// following LISTS. Every list endpoint is sent an explicit results_limit, clamped ≤25 — one of
// them (linkedin/profile-posts) defaults to 100 when it is omitted.
//
// POLLING. Submit, then poll the task with backoff 2s → 3s → 5s → 8s… until SOCQ_TOTAL_TIMEOUT_MS.
// A task still running at the deadline returns `{ ok:true, partial:true, pending:true, task_id }`
// (partial ⇒ never cached, cache.ts isCacheableToolResult) and the FREE socq_task_result reads it
// later. Do not resubmit: a second submit reserves credits again.
//
// FAILURE SHAPES follow lib/opsis.ts / lib/contextdev.ts: missing key or kill switch is a
// pre-provider gate; 402 and 429 log as skipped (provider suppressed); other errors log as failed;
// a succeeded task with zero records logs as empty. Provider text is bounded into
// `provider_message`, never into `error`.
//
// Zero imports on purpose: pure, testable with an injected fetch and clock.

export const SOCQ_BASE_URL = "https://api.socq.ai";
export const SOCQ_API_KEY_ENV = "SOCQ_API_KEY";
/** Kill switch, read at CALL TIME: `SOCQ_DISABLED=true` stops every socq_* call. */
export const SOCQ_DISABLED_ENV = "SOCQ_DISABLED";

/** Whole submit-and-poll budget for one call. The cache.ts wrapper cap sits above it. */
export const SOCQ_TOTAL_TIMEOUT_MS = 40_000;
/** One HTTP request, always also bounded by what is left of the total budget. */
export const SOCQ_REQUEST_TIMEOUT_MS = 8_000;
/** Poll waits, in order; the last repeats. */
export const SOCQ_POLL_BACKOFF_MS: readonly number[] = [2_000, 3_000, 5_000, 8_000];
export const SOCQ_DEFAULT_RESULTS = 10;
export const SOCQ_MAX_RESULTS = 25;
const PROVIDER_MESSAGE_MAX_CHARS = 200;
const TEXT_MAX_CHARS = 400;

export type SocqInput = "usernames" | "urls" | "query";
export type SocqSchema = "account" | "post" | "company";

export interface SocqEndpoint {
  /** Path under /v1/, e.g. "instagram/profiles". */
  path: string;
  platform: "instagram" | "x" | "linkedin";
  input: SocqInput;
  /** Sends results_limit (clamped). Endpoints without it are billed per submitted selector. */
  limited: boolean;
  /** Fixed results_limit for an endpoint that takes one but should only ever return one record. */
  fixedLimit?: number;
  /** Catalog price, credits per returned record (capability-catalog.json, 2026-11-09). */
  creditsPerResult: number;
  schema: SocqSchema;
  /** For url inputs: the URL must be on this host and match this path shape. */
  urlPattern?: RegExp;
}

export const SOCQ_ENDPOINTS: Readonly<Record<string, SocqEndpoint>> = {
  socq_instagram_profile: { path: "instagram/profiles", platform: "instagram", input: "usernames", limited: false, creditsPerResult: 0.6, schema: "account" },
  socq_x_profile: { path: "x/profiles", platform: "x", input: "usernames", limited: false, creditsPerResult: 0.6, schema: "account" },
  socq_linkedin_profile: {
    path: "linkedin/profiles", platform: "linkedin", input: "urls", limited: false, creditsPerResult: 2.5, schema: "account",
    urlPattern: /^https:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\/[^/?#]+\/?$/i,
  },
  socq_instagram_posts: { path: "instagram/posts", platform: "instagram", input: "usernames", limited: true, creditsPerResult: 0.34, schema: "post" },
  socq_instagram_post_info: {
    path: "instagram/post-info", platform: "instagram", input: "urls", limited: false, creditsPerResult: 0.5, schema: "post",
    urlPattern: /^https:\/\/(www\.)?instagram\.com\/(p|reel|reels|tv)\/[^/?#]+\/?$/i,
  },
  socq_instagram_search: { path: "instagram/search", platform: "instagram", input: "query", limited: true, creditsPerResult: 0.54, schema: "account" },
  socq_instagram_followers_count: {
    path: "instagram/followers-count", platform: "instagram", input: "usernames", limited: true, fixedLimit: 1, creditsPerResult: 0.52, schema: "account",
  },
  socq_x_user_posts: { path: "x/user-posts", platform: "x", input: "usernames", limited: true, creditsPerResult: 0.5, schema: "post" },
  socq_x_search: { path: "x/search", platform: "x", input: "query", limited: true, creditsPerResult: 0.7, schema: "post" },
  socq_linkedin_company: {
    path: "linkedin/companies", platform: "linkedin", input: "urls", limited: false, creditsPerResult: 2, schema: "company",
    urlPattern: /^https:\/\/([a-z]{2,3}\.)?linkedin\.com\/company\/[^/?#]+\/?$/i,
  },
  socq_linkedin_posts: {
    path: "linkedin/profile-posts", platform: "linkedin", input: "urls", limited: true, creditsPerResult: 1, schema: "post",
    urlPattern: /^https:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\/[^/?#]+\/?$/i,
  },
};

export const SOCQ_SUBMIT_TOOLS: readonly string[] = Object.keys(SOCQ_ENDPOINTS);

export interface SocqDeps {
  apiKey: string | undefined;
  disabled: boolean;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}

type Out = Record<string, unknown>;

export function socqKillSwitchOn(env: (k: string) => string | undefined = (k) => Deno.env.get(k)): boolean {
  return (env(SOCQ_DISABLED_ENV) ?? "").trim().toLowerCase() === "true";
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

export function socqDepsFromEnv(signal?: AbortSignal): SocqDeps {
  return {
    apiKey: Deno.env.get(SOCQ_API_KEY_ENV),
    disabled: socqKillSwitchOn(),
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    sleep: abortableSleep,
    signal,
  };
}

export function socqGate(deps: Pick<SocqDeps, "apiKey" | "disabled">): Out | null {
  if (deps.disabled) return { error: "socq unavailable: disabled (provider disabled in config)", provider_attempted: false };
  if (!deps.apiKey) return { error: "SOCQ_API_KEY not configured", provider_attempted: false };
  return null;
}

function bounded(text: unknown, max: number): string | undefined {
  if (typeof text !== "string") return undefined;
  const t = text.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : undefined;
}

/** Handle → the form SocQ accepts: no @, trimmed, lowercased; null when it cannot be a handle. */
export function normalizeHandle(raw: unknown, platform: SocqEndpoint["platform"]): string | null {
  const h = (typeof raw === "string" ? raw : "").trim().replace(/^@+/, "").toLowerCase();
  if (platform === "instagram") return /^[a-z0-9._]{1,30}$/.test(h) ? h : null;
  if (platform === "x") return /^[a-z0-9_]{1,15}$/.test(h) ? h : null;
  return null;
}

/** URL → https, no query/fragment, trailing slash kept as given; null unless it matches the endpoint. */
export function normalizeSocqUrl(raw: unknown, ep: SocqEndpoint): string | null {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return null;
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const clean = `https://${u.hostname.toLowerCase()}${u.pathname}`;
  return ep.urlPattern && ep.urlPattern.test(clean) ? clean : null;
}

/** Instagram search rejects punctuation (catalog pattern); collapse whitespace, cap length. */
export function normalizeSearchQuery(raw: unknown, ep: SocqEndpoint): string | null {
  const q = (typeof raw === "string" ? raw : "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (q.length < 2) return null;
  if (ep.path === "instagram/search" && /[!?.,:;\-+=*&%$#@/\\~^|<>()[\]{}"'`]/.test(q)) return null;
  return q;
}

export function clampResults(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : SOCQ_DEFAULT_RESULTS;
  return Math.max(1, Math.min(SOCQ_MAX_RESULTS, n));
}

/** Build the submit body, or a gate (never sent) when the selector does not fit the endpoint. */
export function buildSubmitBody(
  ep: SocqEndpoint,
  input: { username?: unknown; url?: unknown; query?: unknown; results_limit?: unknown },
): { body: Record<string, unknown>; selector: string } | { gate: string } {
  let selector: string | null = null;
  const body: Record<string, unknown> = {};
  if (ep.input === "usernames") {
    selector = normalizeHandle(input.username, ep.platform);
    if (!selector) return { gate: `socq ${ep.path}: gated — not a valid ${ep.platform} username` };
    body.usernames = [selector];
  } else if (ep.input === "urls") {
    selector = normalizeSocqUrl(input.url, ep);
    if (!selector) return { gate: `socq ${ep.path}: gated — not a ${ep.platform} URL of the right kind for this endpoint` };
    body.urls = [selector];
  } else {
    selector = normalizeSearchQuery(input.query, ep);
    if (!selector) return { gate: `socq ${ep.path}: gated — empty or unsupported search query` };
    body.query = selector;
  }
  if (ep.limited) body.results_limit = ep.fixedLimit ?? clampResults(input.results_limit);
  return { body, selector };
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function httpFailure(res: Response, label: string): Promise<Out> {
  const body = await readJson(res) as Record<string, unknown> | null;
  const err = (body?.error ?? {}) as Record<string, unknown>;
  const provider_message = bounded(err.message, PROVIDER_MESSAGE_MAX_CHARS);
  const type = typeof err.type === "string" ? err.type.slice(0, 40) : undefined;
  // A 404 here means the TASK or ENDPOINT is missing — never "the target has no record". The
  // outcome classifier reads `status: 404` as a valid negative (empty), so it travels as
  // `http_status` and the call logs as failed.
  const statusField = res.status === 404 ? { http_status: 404 } : { status: res.status };
  const base = { ok: false, ...statusField, endpoint: label, ...(type ? { code: type } : {}), ...(provider_message ? { provider_message } : {}) };
  if (res.status === 402) return { ...base, error: "socq quota/credit exhausted (HTTP 402) — provider suppressed for investigation" };
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after"));
    return {
      ...base,
      ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retry_after_s: retryAfter } : {}),
      error: "socq rate-limited — provider suppressed for investigation",
    };
  }
  return { ...base, error: `socq ${label} HTTP ${res.status}` };
}

async function request(deps: SocqDeps, path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const timeout = AbortSignal.timeout(Math.max(1, timeoutMs));
  const signal = deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout;
  return await deps.fetch(`${SOCQ_BASE_URL}${path}`, {
    ...init,
    headers: { "Authorization": `Bearer ${deps.apiKey}`, "Content-Type": "application/json" },
    signal,
  });
}

function shapeItem(raw: unknown, schema: SocqSchema): Out {
  const i = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const loc = (i.location && typeof i.location === "object" ? i.location : null) as Record<string, unknown> | null;
  const m = (i.metrics && typeof i.metrics === "object" ? i.metrics : {}) as Record<string, unknown>;
  const location = loc ? [loc.name ?? loc.city, loc.region, loc.country].map((x) => bounded(x, 80)).filter(Boolean).join(", ") || null : null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  if (schema === "account") {
    return {
      url: bounded(i.url, 300) ?? null,
      username: bounded(i.username, 80) ?? null,
      name: bounded(i.name, 120) ?? null,
      bio: bounded(i.text, TEXT_MAX_CHARS) ?? null,
      website: bounded(i.website, 300) ?? null,
      location,
      is_verified: typeof i.is_verified === "boolean" ? i.is_verified : null,
      is_private: typeof i.is_private === "boolean" ? i.is_private : null,
      followers_count: num(m.followers_count),
      following_count: num(m.following_count),
      posts_count: num(m.posts_count),
      avatar_url: bounded(i.avatar_url, 600) ?? null,
      collected_at: bounded(i.collected_at, 40) ?? null,
    };
  }
  if (schema === "company") {
    return {
      url: bounded(i.url, 300) ?? null,
      name: bounded(i.name, 160) ?? null,
      description: bounded(i.text, TEXT_MAX_CHARS) ?? null,
      website: bounded(i.website, 300) ?? null,
      industry: bounded(i.industry, 120) ?? null,
      location,
      collected_at: bounded(i.collected_at, 40) ?? null,
    };
  }
  const author = (i.author && typeof i.author === "object" ? i.author : {}) as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 10) : []);
  return {
    url: bounded(i.url, 300) ?? null,
    published_at: bounded(i.published_at, 40) ?? null,
    text: bounded(i.text, TEXT_MAX_CHARS) ?? null,
    author: bounded(author.username, 80) ?? bounded(author.name, 120) ?? null,
    hashtags: list(i.hashtags),
    mentions: list(i.mentions),
    location,
    collected_at: bounded(i.collected_at, 40) ?? null,
  };
}

const SCHEMA_IDS: Readonly<Record<string, SocqSchema>> = { account: "account", post: "post", company: "company" };

/** Shape one task-detail response. Pure. `schema` may be overridden by the response's schema_id. */
export function shapeTask(raw: unknown, ctx: { endpoint: string; schema?: SocqSchema; maxItems: number }): Out {
  const env = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = (env.data && typeof env.data === "object" ? env.data : env) as Record<string, unknown>;
  const taskId = typeof d.task_id === "string" ? d.task_id : undefined;
  const status = typeof d.status === "string" ? d.status : "unknown";
  const results = (d.results && typeof d.results === "object" ? d.results : {}) as Record<string, unknown>;
  const schema = SCHEMA_IDS[String(results.schema_id ?? "")] ?? ctx.schema ?? "account";
  const provenance = {
    provider: "socq",
    source: "socq",
    endpoint: ctx.endpoint,
    task_id: taskId,
    captured_at: new Date().toISOString(),
    linkage: "unverified — a same-handle account on another platform is not the subject until corroborated",
  };
  if (status === "failed") {
    const msg = bounded(d.error_message, PROVIDER_MESSAGE_MAX_CHARS);
    return { ok: false, ...provenance, status, ...(msg ? { provider_message: msg } : {}), error: "socq task failed" };
  }
  if (status !== "succeeded") {
    return {
      ok: true,
      partial: true,
      pending: true,
      ...provenance,
      status,
      read_with: { tool: "socq_task_result", task_id: taskId },
      note: "SocQ is still collecting. Read it later with socq_task_result (free). Do NOT submit the same request again: a second submit reserves credits again.",
    };
  }
  const items = Array.isArray(results.items) ? results.items.slice(0, ctx.maxItems).map((x) => shapeItem(x, schema)) : [];
  const credits = typeof d.credits_amount === "number" ? d.credits_amount : undefined;
  const resultCount = typeof d.result_count === "number" ? d.result_count : items.length;
  if (items.length === 0) {
    return { ok: false, empty: true, ...provenance, status, result_count: resultCount, credits_amount: credits, error: "socq: no usable result" };
  }
  return {
    ok: true,
    ...provenance,
    status,
    result_count: resultCount,
    credits_amount: credits,
    count: items.length,
    more_available: results.has_more === true,
    items,
  };
}

async function pollTask(deps: SocqDeps, taskId: string, ctx: { endpoint: string; schema?: SocqSchema; maxItems: number }, deadlineAt: number): Promise<Out> {
  let last: Out | null = null;
  for (let attempt = 0; ; attempt++) {
    const remaining = deadlineAt - deps.now();
    if (remaining <= 0) break;
    const wait = Math.min(SOCQ_POLL_BACKOFF_MS[Math.min(attempt, SOCQ_POLL_BACKOFF_MS.length - 1)], remaining);
    await deps.sleep(wait, deps.signal);
    if (deps.signal?.aborted) break;
    const left = deadlineAt - deps.now();
    if (left <= 0) break;
    let res: Response;
    try {
      res = await request(deps, `/v1/tasks/${encodeURIComponent(taskId)}?view=standard&limit=${ctx.maxItems}`, { method: "GET" }, Math.min(SOCQ_REQUEST_TIMEOUT_MS, left));
    } catch {
      continue; // a slow or dropped poll; the deadline bounds the retries
    }
    if (!res.ok) {
      if (res.status === 429 || res.status >= 500) continue;
      return { task_id: taskId, ...await httpFailure(res, "tasks") };
    }
    last = shapeTask(await readJson(res), ctx);
    if (last.pending !== true) return last;
  }
  return last ?? shapeTask({ data: { task_id: taskId, status: "running" } }, ctx);
}

/** Submit one collection and poll it to the deadline. `tool` must be a key of SOCQ_ENDPOINTS. */
export async function socqSubmit(
  tool: string,
  input: { username?: unknown; url?: unknown; query?: unknown; results_limit?: unknown },
  deps: SocqDeps,
): Promise<Out> {
  const ep = SOCQ_ENDPOINTS[tool];
  if (!ep) return { ok: false, error: `socq: unknown endpoint for ${tool}` };
  const gate = socqGate(deps);
  if (gate) return gate;
  const built = buildSubmitBody(ep, input);
  if ("gate" in built) return { error: built.gate, provider_attempted: false };
  const startedAt = deps.now();
  const deadlineAt = startedAt + SOCQ_TOTAL_TIMEOUT_MS;
  let res: Response;
  try {
    res = await request(deps, `/v1/${ep.path}`, { method: "POST", body: JSON.stringify(built.body) }, SOCQ_REQUEST_TIMEOUT_MS);
  } catch (e) {
    const name = (e as { name?: string })?.name ?? "";
    // A submit that timed out MAY have been accepted; say so, so the model does not pay twice.
    return name === "TimeoutError" || name === "AbortError"
      ? { ok: false, endpoint: ep.path, error: `socq ${ep.path} submit timed out`, note: "The task may have been created. Do not resubmit in this run." }
      : { ok: false, endpoint: ep.path, error: `socq ${ep.path} network error` };
  }
  if (!res.ok) return await httpFailure(res, ep.path);
  const submitted = (await readJson(res) ?? {}) as Record<string, unknown>;
  const data = (submitted.data && typeof submitted.data === "object" ? submitted.data : {}) as Record<string, unknown>;
  const taskId = typeof data.task_id === "string" && data.task_id ? data.task_id : null;
  if (!taskId) return { ok: false, endpoint: ep.path, error: "socq returned no task_id" };
  const maxItems = ep.limited ? Number(built.body.results_limit) : 1;
  const out = await pollTask(deps, taskId, { endpoint: ep.path, schema: ep.schema, maxItems }, deadlineAt);
  return { ...out, query_selector: built.selector, ...(ep.limited ? { results_limit: built.body.results_limit } : {}) };
}

/** `socq_task_result`: read an existing task (free) and poll it to the deadline if still running. */
export async function socqTaskResult(input: { task_id?: unknown }, deps: SocqDeps): Promise<Out> {
  const gate = socqGate(deps);
  if (gate) return gate;
  const taskId = typeof input.task_id === "string" ? input.task_id.trim() : "";
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(taskId)) {
    return { error: "socq task result: gated — not a SocQ task id", provider_attempted: false };
  }
  // First read immediately: a finished task should not wait a backoff step.
  try {
    const res = await request(deps, `/v1/tasks/${encodeURIComponent(taskId)}?view=standard&limit=${SOCQ_MAX_RESULTS}`, { method: "GET" }, SOCQ_REQUEST_TIMEOUT_MS);
    if (!res.ok) return { task_id: taskId, ...await httpFailure(res, "tasks") };
    const first = shapeTask(await readJson(res), { endpoint: "tasks", maxItems: SOCQ_MAX_RESULTS });
    if (first.pending !== true) return first;
  } catch {
    // fall through to the bounded poll
  }
  return await pollTask(deps, taskId, { endpoint: "tasks", maxItems: SOCQ_MAX_RESULTS }, deps.now() + SOCQ_TOTAL_TIMEOUT_MS - SOCQ_REQUEST_TIMEOUT_MS);
}

/** `/health` → `checks.socq`. Pure: exercises shaping and input validation with synthetic data. */
export function socqSelfTest(hasKey: boolean, disabled: boolean): { ok: boolean; configured: boolean; disabled: boolean; tools: number; detail: string } {
  const ig = SOCQ_ENDPOINTS.socq_instagram_profile;
  const posts = SOCQ_ENDPOINTS.socq_linkedin_posts;
  const okBody = buildSubmitBody(ig, { username: "@Example.Handle" });
  const badBody = buildSubmitBody(ig, { username: "not a handle!" });
  const capped = buildSubmitBody(posts, { url: "https://www.linkedin.com/in/example-person/", results_limit: 500 });
  const pending = shapeTask({ data: { task_id: "TASKEXAMPLE1", status: "running" } }, { endpoint: "x", schema: "account", maxItems: 1 });
  const done = shapeTask({
    data: { task_id: "TASKEXAMPLE1", status: "succeeded", result_count: 1, results: { schema_id: "account", items: [{ username: "example", text: "b".repeat(900), website: "https://example.com" }] } },
  }, { endpoint: "x", maxItems: 1 });
  const ok = "body" in okBody && (okBody.body.usernames as string[])[0] === "example.handle" && "gate" in badBody &&
    "body" in capped && capped.body.results_limit === SOCQ_MAX_RESULTS &&
    pending.pending === true && pending.partial === true &&
    done.ok === true && String(((done.items as Out[])[0]).bio).length === TEXT_MAX_CHARS &&
    normalizeSocqUrl("https://www.linkedin.com/company/example/", SOCQ_ENDPOINTS.socq_linkedin_profile) === null;
  const state = disabled ? "switched off (SOCQ_DISABLED=true)" : hasKey ? "configured" : "not configured (SOCQ_API_KEY unset)";
  return {
    ok,
    configured: hasKey,
    disabled,
    tools: SOCQ_SUBMIT_TOOLS.length + 1,
    detail: ok
      ? `${state}; submit+poll bounded at ${SOCQ_TOTAL_TIMEOUT_MS / 1000}s, pending tasks read free with socq_task_result; results_limit ≤${SOCQ_MAX_RESULTS}; no callback_url, no raw files, no follower lists or comments; free-first gated`
      : "socq request building / shaping misbehaving on its own probe",
  };
}
