/**
 * opsis.ts — client for the Opsis OSINT API (username / email / domain account
 * enumeration across ~700 platforms).
 *
 * Contract: https://useopsis.com/docs/api (v1), read 2026-10-01. Every endpoint
 * and error code below is taken from that page, not inferred.
 *
 * ## Why the search is start-then-poll, never `wait:true`
 *
 * A full search touches ~500 modules and takes 60–90 s. `wait:true` blocks up to
 * 30 s and only THEN returns the `run_id`, so aborting it at our own deadline
 * would spend a credit and lose the only handle on the run. So we POST with
 * `wait:false` (returns `{run_id}` at once), then poll `GET /v1/searches/{id}`
 * until our deadline. Results accumulate across polls, so a deadline hit returns
 * what has arrived so far, marked `partial`.
 *
 * ## Why a separate `opsis_results` exists
 *
 * Opsis is explicit: a run that is still going is resumed by its `run_id` — "Do
 * not POST a replacement search." Every POST costs a credit; reading a run is
 * free. Without a resume path the agent's only way to get the rest of a partial
 * run is to pay for the same search again.
 *
 * ## Failure shapes follow this codebase, not the brief they came from
 *
 * - Missing key / kill switch → `{ error, skipped: true, provider_attempted: false }`:
 *   the house "not configured" skip, and the paid slot is refunded.
 * - 402 / 403 / 401 / 429 / 400 → `{ ok: false, status, code, error }` with a
 *   CONSTANT `error`. Not `skipped`: a tool-emitted skip is logged as outcome
 *   "ok", which would hide "out of Opsis credits" from `checks.credentials` and
 *   stop the circuit from suppressing a provider that will refuse every call.
 *   Provider text never goes into `error` (`isIntentionalSkip` regex-matches it);
 *   it is carried, bounded, as `provider_message`.
 *
 * Zero imports on purpose: pure, and testable with an injected fetch and clock.
 */

export const OPSIS_BASE_URL = "https://api.useopsis.com";
export const OPSIS_API_KEY_ENV = "OPSIS_API_KEY";
/** Kill switch, read at CALL TIME: `OPSIS_DISABLED=true` stops every opsis_* call. */
export const OPSIS_DISABLED_ENV = "OPSIS_DISABLED";

/** Hard ceiling on one opsis_search / opsis_results call, start to return. */
export const OPSIS_POLL_DEADLINE_MS = 25_000;
/** Opsis recommends polling every 2–5 s. */
export const OPSIS_POLL_INTERVAL_MS = 2_500;
/** Per-request cap; always also bounded by what is left of the deadline. */
export const OPSIS_REQUEST_TIMEOUT_MS = 8_000;
/** Rows handed back to the model. The rest is counted, not inlined — prompt budget. */
export const OPSIS_MAX_RESULTS_RETURNED = 100;
/** A result's `metadata` is kept only when its JSON fits in this many chars. */
export const OPSIS_RESULT_METADATA_MAX_CHARS = 300;
const PROVIDER_MESSAGE_MAX_CHARS = 200;

export type OpsisKind = "username" | "email" | "domain";
export const OPSIS_KINDS: readonly OpsisKind[] = ["username", "email", "domain"];

export interface OpsisDeps {
  apiKey: string | undefined;
  disabled: boolean;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** The tool wrapper's timeout signal; aborting it ends the call early. */
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
export function opsisKillSwitchOn(env: (k: string) => string | undefined = (k) => Deno.env.get(k)): boolean {
  return (env(OPSIS_DISABLED_ENV) ?? "").trim().toLowerCase() === "true";
}

/** Production deps. Env is read here, at CALL time, so the kill switch needs no deploy. */
export function opsisDepsFromEnv(signal?: AbortSignal): OpsisDeps {
  return {
    apiKey: Deno.env.get(OPSIS_API_KEY_ENV) || undefined,
    disabled: opsisKillSwitchOn(),
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    sleep: abortableSleep,
    signal,
  };
}

/** The skip every opsis_* tool returns before contacting Opsis, or null to proceed. */
export function opsisGate(deps: Pick<OpsisDeps, "apiKey" | "disabled">): Out | null {
  if (deps.disabled) {
    return { error: "opsis provider disabled in config", skipped: true, provider_attempted: false };
  }
  if (!deps.apiKey) {
    return { error: "OPSIS_API_KEY not configured", skipped: true, provider_attempted: false };
  }
  return null;
}

/** `/health` detail for `checks.opsis`. Presence only — no network. */
export function opsisHealthDetail(hasKey: boolean, disabled: boolean): { ok: true; detail: string } {
  if (disabled) return { ok: true, detail: `disabled via ${OPSIS_DISABLED_ENV}` };
  if (!hasKey) return { ok: true, detail: `not configured (${OPSIS_API_KEY_ENV} unset); opsis tools removed from the schema` };
  return {
    ok: true,
    detail: `configured; search bounded at ${OPSIS_POLL_DEADLINE_MS / 1000}s, partial runs resume via opsis_results`,
  };
}

// ── HTTP error mapping ────────────────────────────────────────────────────────

/** Constant texts only — see the header. Codes are the documented Opsis ones. */
const HTTP_ERRORS: Record<number, { code: string; error: string }> = {
  400: { code: "invalid_request", error: "opsis rejected the query as invalid" },
  401: { code: "invalid_api_key", error: "opsis API key was rejected" },
  402: { code: "insufficient_api_credits", error: "opsis account is out of API credits" },
  403: { code: "plan_required", error: "opsis plan does not include API access" },
  404: { code: "not_found", error: "opsis run was not found" },
  429: { code: "rate_limited", error: "opsis rate limit reached" },
};
const KNOWN_CODES = new Set([
  "invalid_request",
  "invalid_api_key",
  "insufficient_api_credits",
  "api_credit_adjustment_required",
  "plan_required",
]);

function boundText(s: unknown, max: number): string {
  return typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

async function httpFailure(res: Response, extra: Out = {}): Promise<Out> {
  const known = HTTP_ERRORS[res.status];
  let code = known?.code ?? "http_error";
  let providerMessage = "";
  try {
    const body = await res.json() as Record<string, unknown>;
    if (typeof body?.error === "string" && KNOWN_CODES.has(body.error)) code = body.error;
    providerMessage = boundText(body?.message, PROVIDER_MESSAGE_MAX_CHARS) ||
      boundText(typeof body?.detail === "string" ? body.detail : "", PROVIDER_MESSAGE_MAX_CHARS);
  } catch {
    // Non-JSON error body: the status and the constant text are enough.
  }
  return {
    ok: false,
    status: res.status,
    code,
    error: known?.error ?? (res.status >= 500 ? "opsis upstream error" : "opsis request failed"),
    ...(providerMessage ? { provider_message: providerMessage } : {}),
    ...extra,
  };
}

/** One request, never retried (a retried POST is a second paid search). */
async function request(
  deps: OpsisDeps,
  path: string,
  init: { method: "GET" | "POST"; body?: unknown },
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (deps.signal?.aborted) ctrl.abort();
  else deps.signal?.addEventListener("abort", onAbort, { once: true });
  const t = setTimeout(() => ctrl.abort(), Math.max(1, timeoutMs));
  try {
    return await deps.fetch(`${OPSIS_BASE_URL}${path}`, {
      method: init.method,
      headers: {
        "Authorization": `Bearer ${deps.apiKey}`,
        "Accept": "application/json",
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
    deps.signal?.removeEventListener("abort", onAbort);
  }
}

// ── Result shaping ────────────────────────────────────────────────────────────

interface OpsisRun {
  run_id?: string;
  status?: string;
  type?: string;
  query?: string;
  total_results?: number;
  results?: unknown[];
  progress?: Record<string, unknown> | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * One account row as the agent sees it. `module` and `opsis_confidence` are
 * renamed on purpose: Opsis's `source` is a module name and its `confidence` is
 * the module's own 0–1 score. Neither is OUR source or OUR confidence, and a
 * field named `source` or `confidence` invites exactly that mistake downstream.
 */
export function shapeOpsisResult(raw: unknown): Out | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const value = str(r.value);
  const platform = str(r.platform);
  if (!value && !platform) return null;
  const row: Out = {
    platform,
    value,
    type: str(r.type) ?? str(r.entity_type) ?? "account",
    module: str(r.source),
    opsis_confidence: typeof r.confidence === "number" && Number.isFinite(r.confidence) ? r.confidence : null,
  };
  if (r.metadata && typeof r.metadata === "object" && Object.keys(r.metadata as object).length > 0) {
    let json = "";
    try {
      json = JSON.stringify(r.metadata);
    } catch {
      json = "";
    }
    if (json && json.length <= OPSIS_RESULT_METADATA_MAX_CHARS) row.metadata = r.metadata;
    else row.metadata_omitted = true;
  }
  return row;
}

function pickProgress(p: unknown): Out | null {
  if (!p || typeof p !== "object") return null;
  const o = p as Record<string, unknown>;
  const out: Out = {};
  for (const k of ["modules_total", "modules_completed", "modules_with_hits"]) {
    if (typeof o[k] === "number") out[k] = o[k];
  }
  return Object.keys(out).length ? out : null;
}

const NOTE_PARTIAL =
  "Opsis is still searching. Call opsis_results with this run_id to fetch the rest. " +
  "Do not start a new opsis_search for the same selector: each search costs a credit, reading a run is free.";

function shapeRun(runId: string, kind: OpsisKind, value: string, run: OpsisRun | null): Out {
  const status = run?.status === "completed" || run?.status === "failed" ? run.status : "running";
  const rows = (Array.isArray(run?.results) ? run!.results : [])
    .map(shapeOpsisResult)
    .filter((r): r is Out => r !== null);
  const returned = rows.slice(0, OPSIS_MAX_RESULTS_RETURNED);
  const body: Out = {
    source: "opsis",
    run_id: runId,
    run_status: status,
    complete: status === "completed",
    kind,
    value,
    total_results: typeof run?.total_results === "number" ? run.total_results : rows.length,
    results_returned: returned.length,
    ...(rows.length > returned.length ? { results_truncated: rows.length - returned.length } : {}),
    progress: pickProgress(run?.progress),
    results: returned,
  };
  if (status === "failed") {
    // `error` is constant; the run id stays so the analyst can look it up.
    return { ok: false, error: "opsis search failed upstream", code: "run_failed", ...body };
  }
  if (status === "running") return { ok: true, partial: true, note: NOTE_PARTIAL, ...body };
  return { ok: true, ...body };
}

// ── Polling ───────────────────────────────────────────────────────────────────

/**
 * Poll one run until it is terminal or `deadlineAt` passes. Never throws.
 * `firstPollImmediately` is true for a resume (the run already exists) and false
 * right after a POST (nothing to read yet).
 */
async function pollRun(
  deps: OpsisDeps,
  runId: string,
  deadlineAt: number,
  firstPollImmediately: boolean,
): Promise<{ run: OpsisRun | null; failure: Out | null }> {
  let run: OpsisRun | null = null;
  let first = true;
  while (true) {
    if (!(first && firstPollImmediately)) {
      const wait = Math.min(OPSIS_POLL_INTERVAL_MS, deadlineAt - deps.now());
      if (wait <= 0) break;
      await deps.sleep(wait, deps.signal);
    }
    first = false;
    const remaining = deadlineAt - deps.now();
    if (remaining <= 0 || deps.signal?.aborted) break;
    let res: Response;
    try {
      res = await request(deps, `/v1/searches/${encodeURIComponent(runId)}`, { method: "GET" }, Math.min(OPSIS_REQUEST_TIMEOUT_MS, remaining));
    } catch {
      if (deps.signal?.aborted) break;
      continue; // a slow or dropped poll; the deadline bounds the retries
    }
    if (!res.ok) {
      // Auth, plan or a vanished run will not fix itself before the deadline.
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        return { run, failure: await httpFailure(res, { run_id: runId }) };
      }
      await res.body?.cancel().catch(() => {});
      continue; // 429 / 5xx: try again on the next tick
    }
    try {
      run = await res.json() as OpsisRun;
    } catch {
      continue;
    }
    if (run?.status === "completed" || run?.status === "failed") break;
  }
  return { run, failure: null };
}

function normKind(kind: unknown): OpsisKind | null {
  const k = typeof kind === "string" ? kind.trim().toLowerCase() : "";
  return (OPSIS_KINDS as readonly string[]).includes(k) ? k as OpsisKind : null;
}

// ── Public operations ─────────────────────────────────────────────────────────

/** `opsis_search`: start a search (1 credit, 2 for premium username) and poll to the deadline. */
export async function opsisSearch(
  input: { kind: string; value: string; premium?: boolean },
  deps: OpsisDeps,
): Promise<Out> {
  const gate = opsisGate(deps);
  if (gate) return gate;
  const kind = normKind(input.kind);
  const value = typeof input.value === "string" ? input.value.trim() : "";
  if (!kind || !value) {
    return { ok: false, skipped: true, reason: "opsis_search needs kind username|email|domain and a value", provider_attempted: false };
  }
  if (kind === "username" && /\s/.test(value)) {
    return { ok: false, skipped: true, reason: "opsis_search username must be a handle with no spaces", provider_attempted: false };
  }
  const startedAt = deps.now();
  const deadlineAt = startedAt + OPSIS_POLL_DEADLINE_MS;
  // Opsis ignores `premium` for email and domain; never send it there.
  const premium = kind === "username" && input.premium === true;

  let res: Response;
  try {
    res = await request(deps, "/v1/searches", {
      method: "POST",
      body: { type: kind, query: value, wait: false, premium },
    }, OPSIS_REQUEST_TIMEOUT_MS);
  } catch {
    return {
      ok: false,
      error: deps.signal?.aborted ? "opsis search start was cancelled" : "opsis search start request failed",
      code: "start_failed",
    };
  }
  if (!res.ok) return await httpFailure(res);
  let started: OpsisRun;
  try {
    started = await res.json() as OpsisRun;
  } catch {
    return { ok: false, error: "opsis returned an unreadable start response", code: "bad_response" };
  }
  const runId = str(started?.run_id);
  if (!runId) return { ok: false, error: "opsis returned no run_id", code: "bad_response" };

  // A start response may already be terminal; otherwise poll.
  if (started.status === "completed" || started.status === "failed") {
    return { ...shapeRun(runId, kind, value, started), premium };
  }
  const { run, failure } = await pollRun(deps, runId, deadlineAt, false);
  if (failure) return { ...failure, premium };
  return { ...shapeRun(runId, kind, value, run), premium };
}

/**
 * `opsis_results`: read an existing run (free) and keep polling to the deadline
 * if it is still going. The run must belong to the selector the agent names:
 * that keeps the dispatch guard and the quarantine taint, which key on the
 * selector, applying to results fetched by id.
 */
export async function opsisResults(
  input: { kind: string; value: string; run_id: string },
  deps: OpsisDeps,
): Promise<Out> {
  const gate = opsisGate(deps);
  if (gate) return gate;
  const kind = normKind(input.kind);
  const value = typeof input.value === "string" ? input.value.trim() : "";
  const runId = typeof input.run_id === "string" ? input.run_id.trim() : "";
  if (!kind || !value || !runId) {
    return { ok: false, skipped: true, reason: "opsis_results needs the run_id and the kind and value it was started with", provider_attempted: false };
  }
  const { run, failure } = await pollRun(deps, runId, deps.now() + OPSIS_POLL_DEADLINE_MS, true);
  if (failure) return failure;
  // Not one poll answered (timeouts, 429s, 5xx until the deadline). A search can
  // still return its run_id as partial — its POST was accepted — but a RESUME
  // learned nothing, so "still searching" would hide an outage from the model,
  // the circuit and credential health (Codex P2 on #659).
  if (!run) {
    return { ok: false, error: "opsis run status unavailable", code: "unavailable", run_id: runId };
  }
  const runKind = normKind(run.type);
  const runQuery = typeof run.query === "string" ? run.query.trim().toLowerCase() : null;
  if ((runKind && runKind !== kind) || (runQuery !== null && runQuery !== value.toLowerCase())) {
    return { ok: false, error: "opsis run belongs to a different selector", code: "selector_mismatch", run_id: runId };
  }
  return shapeRun(runId, kind, value, run);
}

/** `opsis_balance` / `opsis_status`: free account lookups. */
export async function opsisAccount(which: "balance" | "status", deps: OpsisDeps): Promise<Out> {
  const gate = opsisGate(deps);
  if (gate) return gate;
  const path = which === "balance" ? "/v1/credits" : "/v1/me";
  let res: Response;
  try {
    res = await request(deps, path, { method: "GET" }, OPSIS_REQUEST_TIMEOUT_MS);
  } catch {
    return { ok: false, error: `opsis ${which} request failed`, code: "request_failed" };
  }
  if (!res.ok) return await httpFailure(res);
  let body: Record<string, unknown>;
  try {
    body = await res.json() as Record<string, unknown>;
  } catch {
    return { ok: false, error: `opsis returned an unreadable ${which} response`, code: "bad_response" };
  }
  // Only documented, non-identifying fields; no user_id.
  const fields = which === "balance"
    ? ["tier", "available_api_credits", "api_credits_remaining", "use_subscription_credits", "credits_remaining", "credits_used", "credits_allowed", "period_end"]
    : ["tier", "api_access", "available_api_credits", "rate_limit_per_minute", "supports_streaming", "search_types"];
  const data: Out = {};
  for (const f of fields) if (f in body) data[f] = body[f];
  return { ok: true, source: "opsis", data };
}
