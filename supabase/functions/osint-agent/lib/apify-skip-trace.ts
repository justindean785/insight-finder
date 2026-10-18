/**
 * apify-skip-trace.ts — client for the Apify Actor `one-api/skip-trace`, reached
 * through the Lovable connector gateway.
 *
 * Contract: https://apify.com/one-api/skip-trace (README + input schema, read
 * 2026-10-14). Input: `name[]`, `street_citystatezip[]`, `phone_number[]`,
 * `email[]`, `max_results` (Actor default 1, Actor max 10). Each dataset row is
 * one person: `First Name`, `Last Name`, `Age`, `Lives in`, `Email-1..5`,
 * `Phone-1..5` (+ `Type` / `Provider` / `First Reported`), `Previous Addresses[]`,
 * `Relatives[]`, `Associates[]`, `Person Link`, and — only for an entry that
 * carried a ` | Full Name` suffix — `Target Name` and `Name Match`
 * (`matched` | `fallback`).
 *
 * ## Transport: the Lovable connector gateway, never api.apify.com
 *
 * The operator connected Apify through Lovable's connector gateway. `APIFY_API_KEY`
 * is a gateway CONNECTION key, not the raw Apify token, and is only honoured by
 * the gateway: every call goes to `${APIFY_GATEWAY_BASE}` (which already includes
 * Apify's `/v2`) with `Authorization: Bearer ${LOVABLE_API_KEY}` and
 * `X-Connection-Api-Key: ${APIFY_API_KEY}`. No token ever goes in the URL.
 *
 * ## Why run-sync-get-dataset-items, bounded
 *
 * One POST starts the Actor, waits for it, and returns the dataset rows — no
 * run id to track, no second request. Apify bounds the wait with the `timeout`
 * query parameter (seconds); we also hold an AbortController at a slightly
 * longer client deadline and forward the tool wrapper's signal. A deadline hit
 * is `{ ok:false, code:"timeout" }`, never a retry: a retried POST is a second
 * billed run.
 *
 * ## Billing
 *
 * Pay-per-event, ~$7.00 per 1,000 result rows (≈ $0.007/row) against the
 * account's usage-credit pool. The tool keeps the bill small by construction:
 * ONE query entry per call and `max_results` clamped to
 * `APIFY_SKIP_TRACE_MAX_RESULTS_CAP`, so a call returns at most that many rows.
 * costs.ts prices the call flat at one row (the default); `results_returned`
 * on the result says what actually came back.
 *
 * ## Evidence posture
 *
 * Rows are people-search AGGREGATOR leads (source class `data_broker`, cap 60):
 * never identity proof. A `Name Match: fallback` row is the Actor's default
 * first result, NOT the person asked for, and is marked `name_match:"fallback"`
 * so nothing downstream treats it as the subject. Relatives and associates are
 * counted, not inlined (third-party PII).
 *
 * ## Failure shapes follow this codebase (see lib/opsis.ts)
 *
 * - Missing key / kill switch → `{ error, skipped:true, provider_attempted:false }`.
 * - HTTP refusals → `{ ok:false, status, code, error }` with a CONSTANT `error`
 *   (provider text, bounded, rides in `provider_message`). 402 = the Apify
 *   usage-credit pool is spent; 404 = the Actor was renamed or removed
 *   (terminal, do not retry).
 *
 * Zero imports on purpose: pure, and testable with an injected fetch.
 */

export const APIFY_GATEWAY_BASE = "https://connector-gateway.lovable.dev/apify";
export const APIFY_SKIP_TRACE_ACTOR = "one-api~skip-trace";
export const APIFY_API_KEY_ENV = "APIFY_API_KEY";
export const LOVABLE_API_KEY_ENV = "LOVABLE_API_KEY";
/** Kill switch, read at CALL TIME: `APIFY_SKIP_TRACE_DISABLED=true` stops every call. */
export const APIFY_SKIP_TRACE_DISABLED_ENV = "APIFY_SKIP_TRACE_DISABLED";

/** Apify-side wait bound, seconds (the `timeout` query parameter on run-sync). */
export const APIFY_SKIP_TRACE_RUN_TIMEOUT_S = 60;
/** Client-side deadline, a little past the Apify bound so Apify's own answer wins. */
export const APIFY_SKIP_TRACE_CLIENT_TIMEOUT_MS = 66_000;
/** `max_results` default and hard cap: every row is a billed event. */
export const APIFY_SKIP_TRACE_DEFAULT_MAX_RESULTS = 1;
export const APIFY_SKIP_TRACE_MAX_RESULTS_CAP = 3;
/** Rows handed back to the model; the rest is counted, not inlined. */
export const APIFY_SKIP_TRACE_MAX_ROWS_RETURNED = 10;
const PROVIDER_MESSAGE_MAX_CHARS = 200;
const FIELD_MAX_CHARS = 200;

export type SkipTraceQueryKind = "name" | "street_citystatezip" | "phone_number" | "email";
export const SKIP_TRACE_QUERY_KINDS: readonly SkipTraceQueryKind[] = ["name", "street_citystatezip", "phone_number", "email"];

export interface SkipTraceInput {
  name?: string[];
  street_citystatezip?: string[];
  phone_number?: string[];
  email?: string[];
  max_results?: number;
}

export interface ApifySkipTraceDeps {
  apiKey: string | undefined;
  lovableKey: string | undefined;
  disabled: boolean;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** The tool wrapper's timeout signal; aborting it ends the call early. */
  signal?: AbortSignal;
}

type Out = Record<string, unknown>;

/** The kill switch, read at CALL time. */
export function apifySkipTraceKillSwitchOn(env: (k: string) => string | undefined = (k) => Deno.env.get(k)): boolean {
  return (env(APIFY_SKIP_TRACE_DISABLED_ENV) ?? "").trim().toLowerCase() === "true";
}

/** Production deps. Env is read here, at CALL time, so the kill switch needs no deploy. */
export function apifySkipTraceDepsFromEnv(signal?: AbortSignal): ApifySkipTraceDeps {
  return {
    apiKey: Deno.env.get(APIFY_API_KEY_ENV) || undefined,
    lovableKey: Deno.env.get(LOVABLE_API_KEY_ENV) || undefined,
    disabled: apifySkipTraceKillSwitchOn(),
    fetch: (url, init) => fetch(url, init),
    signal,
  };
}

/** The skip returned before contacting the gateway, or null to proceed. */
export function apifySkipTraceGate(deps: Pick<ApifySkipTraceDeps, "apiKey" | "lovableKey" | "disabled">): Out | null {
  if (deps.disabled) {
    return { error: "apify skip-trace disabled in config", skipped: true, provider_attempted: false };
  }
  if (!deps.apiKey) {
    return { error: `${APIFY_API_KEY_ENV} not configured`, skipped: true, provider_attempted: false };
  }
  if (!deps.lovableKey) {
    // The connection key is only honoured through the Lovable gateway, which needs its own key.
    return { error: `${LOVABLE_API_KEY_ENV} not configured (required for the connector gateway)`, skipped: true, provider_attempted: false };
  }
  return null;
}

/** /health detail for `checks.apify_skip_trace`. Presence only — no network, never the key. */
export function apifySkipTraceHealthDetail(hasKey: boolean, hasLovableKey: boolean, disabled: boolean): { ok: true; configured: boolean; detail: string } {
  if (disabled) return { ok: true, configured: false, detail: `disabled via ${APIFY_SKIP_TRACE_DISABLED_ENV}` };
  if (!hasKey) return { ok: true, configured: false, detail: `not configured (${APIFY_API_KEY_ENV} unset); apify_skip_trace removed from the schema` };
  if (!hasLovableKey) return { ok: true, configured: false, detail: `${APIFY_API_KEY_ENV} set but ${LOVABLE_API_KEY_ENV} unset; the connector gateway cannot be reached` };
  return {
    ok: true,
    configured: true,
    detail: `configured via the Lovable connector gateway; one query per call, max_results capped at ${APIFY_SKIP_TRACE_MAX_RESULTS_CAP}, run bounded at ${APIFY_SKIP_TRACE_RUN_TIMEOUT_S}s`,
  };
}

// ── Input normalisation ───────────────────────────────────────────────────────

function cleanEntries(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((s) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : ""))
    .filter((s) => s.length > 0 && s.length <= FIELD_MAX_CHARS);
}

export interface NormalizedSkipTraceQuery {
  kind: SkipTraceQueryKind;
  entry: string;
  maxResults: number;
  /** The Actor input body, exactly as sent. */
  body: Record<string, unknown>;
}

/**
 * One query entry per call, by design (each row is billed and the dataset
 * does not say which entry a row answers when several are sent). Returns a
 * structured input error when nothing usable was given, or when more than one
 * kind / more than one entry is supplied.
 */
export function normalizeSkipTraceInput(input: SkipTraceInput | null | undefined): NormalizedSkipTraceQuery | Out {
  const given: Array<{ kind: SkipTraceQueryKind; entries: string[] }> = [];
  for (const kind of SKIP_TRACE_QUERY_KINDS) {
    const entries = cleanEntries((input as Record<string, unknown> | null | undefined)?.[kind]);
    if (entries.length) given.push({ kind, entries });
  }
  if (given.length === 0) {
    return {
      ok: false,
      skipped: true,
      provider_attempted: false,
      code: "empty_input",
      reason: "apify_skip_trace needs exactly one of name, street_citystatezip, phone_number or email (a non-empty array of one string)",
    };
  }
  const totalEntries = given.reduce((n, g) => n + g.entries.length, 0);
  if (given.length > 1 || totalEntries > 1) {
    return {
      ok: false,
      skipped: true,
      provider_attempted: false,
      code: "one_query_per_call",
      reason: "apify_skip_trace takes ONE query entry per call (each result row is billed); call it again for the next selector",
    };
  }
  const { kind, entries } = given[0];
  const raw = input?.max_results;
  let maxResults = APIFY_SKIP_TRACE_DEFAULT_MAX_RESULTS;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 1) {
    maxResults = Math.min(Math.floor(raw), APIFY_SKIP_TRACE_MAX_RESULTS_CAP);
  }
  return { kind, entry: entries[0], maxResults, body: { [kind]: [entries[0]], max_results: maxResults } };
}

export function isSkipTraceInputError(v: unknown): v is Out {
  return !!v && typeof v === "object" && (v as Out).ok === false;
}

// ── HTTP error mapping ────────────────────────────────────────────────────────

/** Constant texts only. 401 can be either key (gateway or connection); the gateway does not say which. */
const HTTP_ERRORS: Record<number, { code: string; error: string }> = {
  400: { code: "invalid_request", error: "apify rejected the actor input as invalid" },
  401: { code: "invalid_api_key", error: "apify connector gateway rejected the key (LOVABLE_API_KEY or the Apify connection key)" },
  402: { code: "out_of_credits", error: "apify account is out of usage credits — the skip-trace pool is spent until the monthly reset or a top-up" },
  403: { code: "forbidden", error: "apify refused the actor run (plan or permission)" },
  404: { code: "actor_not_found", error: "apify actor one-api/skip-trace was not found (renamed or removed) — do not retry" },
  408: { code: "timeout", error: "apify actor run did not finish within the time bound" },
  429: { code: "rate_limited", error: "apify rate limit reached" },
};

function boundText(s: unknown, max: number): string {
  return typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

async function httpFailure(res: Response): Promise<Out> {
  const known = HTTP_ERRORS[res.status];
  let providerMessage = "";
  try {
    const body = await res.json() as Record<string, unknown>;
    const err = body?.error;
    if (err && typeof err === "object") providerMessage = boundText((err as Record<string, unknown>).message, PROVIDER_MESSAGE_MAX_CHARS);
    if (!providerMessage) providerMessage = boundText(body?.message ?? (typeof err === "string" ? err : ""), PROVIDER_MESSAGE_MAX_CHARS);
  } catch {
    // Non-JSON error body: the status and the constant text are enough.
  }
  return {
    ok: false,
    status: res.status,
    code: known?.code ?? "http_error",
    error: known?.error ?? (res.status >= 500 ? "apify upstream error" : "apify request failed"),
    ...(known?.code === "actor_not_found" ? { terminal: true } : {}),
    ...(providerMessage ? { provider_message: providerMessage } : {}),
  };
}

// ── Result shaping ────────────────────────────────────────────────────────────

function str(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return typeof v === "string" && v.trim() ? v.trim().slice(0, FIELD_MAX_CHARS) : null;
}

export interface SkipTracePhone {
  number: string;
  type: string | null;
  provider: string | null;
  first_reported: string | null;
  last_reported: string | null;
}

export interface SkipTraceAddress {
  street: string | null;
  locality: string | null;
  region: string | null;
  postal_code: string | null;
  county: string | null;
  timespan: string | null;
}

export interface SkipTraceRow {
  search_option: string | null;
  input_given: string | null;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  age: string | null;
  born: string | null;
  lives_in: string | null;
  current_address: SkipTraceAddress | null;
  emails: string[];
  phones: SkipTracePhone[];
  previous_addresses: SkipTraceAddress[];
  relatives_count: number;
  associates_count: number;
  person_link: string | null;
  target_name: string | null;
  /** "matched" | "fallback" when the entry carried a target name, else null. */
  name_match: "matched" | "fallback" | null;
}

function shapeAddress(a: unknown): SkipTraceAddress | null {
  if (!a || typeof a !== "object") return null;
  const o = a as Record<string, unknown>;
  const out: SkipTraceAddress = {
    street: str(o.streetAddress ?? o["Street Address"]),
    locality: str(o.addressLocality ?? o["Address Locality"]),
    region: str(o.addressRegion ?? o["Address Region"]),
    postal_code: str(o.postalCode ?? o["Postal Code"]),
    county: str(o.county ?? o["County Name"]),
    timespan: str(o.timespan),
  };
  return out.street || out.locality || out.postal_code ? out : null;
}

/** Normalise one dataset row. Returns null for a row with no person in it. */
export function shapeSkipTraceRow(raw: unknown): SkipTraceRow | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const firstName = str(r["First Name"]);
  const lastName = str(r["Last Name"]);
  const fullName = [firstName, lastName].filter(Boolean).join(" ") || null;
  const emails: string[] = [];
  const phones: SkipTracePhone[] = [];
  for (let i = 1; i <= 5; i++) {
    const e = str(r[`Email-${i}`]);
    if (e && e.includes("@")) emails.push(e);
    const p = str(r[`Phone-${i}`]);
    if (p) {
      phones.push({
        number: p,
        type: str(r[`Phone-${i} Type`]),
        provider: str(r[`Phone-${i} Provider`]),
        first_reported: str(r[`Phone-${i} First Reported`]),
        last_reported: str(r[`Phone-${i} Last Reported`]),
      });
    }
  }
  const current = shapeAddress({
    streetAddress: r["Street Address"],
    addressLocality: r["Address Locality"],
    addressRegion: r["Address Region"],
    postalCode: r["Postal Code"],
    county: r["County Name"],
  });
  const previous = (Array.isArray(r["Previous Addresses"]) ? r["Previous Addresses"] : [])
    .map(shapeAddress)
    .filter((a): a is SkipTraceAddress => a !== null)
    .slice(0, 10);
  const livesIn = str(r["Lives in"]);
  if (!fullName && !livesIn && emails.length === 0 && phones.length === 0) return null;
  const matchRaw = typeof r["Name Match"] === "string" ? r["Name Match"].trim().toLowerCase() : "";
  const personLink = str(r["Person Link"]);
  return {
    search_option: str(r["Search Option"]),
    input_given: str(r["Input Given"]),
    first_name: firstName,
    last_name: lastName,
    full_name: fullName,
    age: str(r.Age),
    born: str(r.Born),
    lives_in: livesIn,
    current_address: current,
    emails,
    phones,
    previous_addresses: previous,
    relatives_count: Array.isArray(r.Relatives) ? r.Relatives.length : 0,
    associates_count: Array.isArray(r.Associates) ? r.Associates.length : 0,
    person_link: personLink && /^https?:\/\//i.test(personLink) ? personLink : null,
    target_name: str(r["Target Name"]),
    name_match: matchRaw === "matched" ? "matched" : matchRaw === "fallback" ? "fallback" : null,
  };
}

const NOTE_LEADS =
  "People-search aggregator rows: association leads, never identity proof. Corroborate any email/phone/address " +
  "with an independent source class before relying on it. A row marked name_match:\"fallback\" is the Actor's " +
  "default first result, NOT the person asked for.";

// ── Public operation ──────────────────────────────────────────────────────────

/** `apify_skip_trace`: one bounded run of the Actor through the Lovable connector gateway. */
export async function apifySkipTrace(input: SkipTraceInput, deps: ApifySkipTraceDeps): Promise<Out> {
  const gate = apifySkipTraceGate(deps);
  if (gate) return gate;
  const q = normalizeSkipTraceInput(input);
  if (isSkipTraceInputError(q)) return q;
  const query = q as NormalizedSkipTraceQuery;

  const url = `${APIFY_GATEWAY_BASE}/acts/${APIFY_SKIP_TRACE_ACTOR}/run-sync-get-dataset-items` +
    `?timeout=${APIFY_SKIP_TRACE_RUN_TIMEOUT_S}&format=json&clean=true`;
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (deps.signal?.aborted) ctrl.abort();
  else deps.signal?.addEventListener("abort", onAbort, { once: true });
  const t = setTimeout(() => ctrl.abort(), APIFY_SKIP_TRACE_CLIENT_TIMEOUT_MS);

  const base: Out = {
    source: "apify:one-api/skip-trace",
    actor: "one-api/skip-trace",
    query_kind: query.kind,
    query: query.entry,
    max_results: query.maxResults,
  };

  let res: Response;
  try {
    res = await deps.fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${deps.lovableKey}`,
        "X-Connection-Api-Key": deps.apiKey!,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify(query.body),
      signal: ctrl.signal,
    });
  } catch {
    clearTimeout(t);
    deps.signal?.removeEventListener("abort", onAbort);
    if (ctrl.signal.aborted) {
      return {
        ok: false,
        code: "timeout",
        error: deps.signal?.aborted
          ? "apify skip-trace call was cancelled by the run"
          : `apify skip-trace run exceeded the ${APIFY_SKIP_TRACE_CLIENT_TIMEOUT_MS / 1000}s client bound`,
        ...base,
      };
    }
    return { ok: false, code: "request_failed", error: "apify connector gateway request failed", ...base };
  }
  clearTimeout(t);
  deps.signal?.removeEventListener("abort", onAbort);

  if (!res.ok) return { ...(await httpFailure(res)), ...base };

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return { ok: false, code: "bad_response", error: "apify returned an unreadable dataset response", ...base };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, code: "bad_response", error: "apify returned a dataset that is not a JSON array", ...base };
  }
  const rows = parsed.map(shapeSkipTraceRow).filter((r): r is SkipTraceRow => r !== null);
  const returned = rows.slice(0, APIFY_SKIP_TRACE_MAX_ROWS_RETURNED);
  return {
    ok: true,
    ...base,
    results_total: parsed.length,
    results_returned: returned.length,
    ...(rows.length > returned.length ? { results_truncated: rows.length - returned.length } : {}),
    fallback_rows: returned.filter((r) => r.name_match === "fallback").length,
    note: NOTE_LEADS,
    results: returned,
  };
}
