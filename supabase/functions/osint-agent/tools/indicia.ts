// tools/indicia.ts
//
// Indicia (api.indicia.app) — US person/phone/email/address + web-DB breach
// aggregator. Added 2026-07-05 to replace the cut footprint aggregators
// (the permanently-dead synapsint and stolentax footprint tools).
//
// These are LIVE runtime tool defs (AI-SDK `tool()`), imported and late-attached
// into buildTools() in tool-registry.ts — NOT the dead `tools/*.ts` barrel. Gated
// on INDICIA_API_KEY in capabilities.ts (the readiness gate drops all six from the
// schema on a keyless deploy).
//
// SCOPE — approved endpoints ONLY (all POST, header auth `x-api-key`):
//   email, phone, person, address, web-dbs, hudsonrock
//
// EXPLICITLY EXCLUDED — hard policy boundary, not a preference. Do NOT add, import,
// or reference in catalog.ts / any fan-out:
//   - /v1/search/intelligence/facial      (reverse face search)
//   - /v1/search/intelligence/geolocation (image geolocation)
//   - /v1/search/intelligence/gmail       (GHunt)
//   - /v2/search/socials/username         (redundant w/ username_sweep)
//   - any 5-10 token premium endpoint (intelx, pimeyes, osintindustries, …)
//
// RESPONSE SHAPE: { "success": true, "data": { "<key>": [ ... ] } }. Live-verified
// for email returns records under data.web; other endpoints MAY nest under a
// different key, so records are extracted defensively across ALL array-valued keys
// of `data` (never assume "web") — assuming a fixed key is exactly the shape bug
// that a hardcoded parser would reproduce.
//
// OUTCOME CONTRACT (drives cache.ts classifyToolOutcome via the returned object):
//   • records found          → { ok:true, ... }                         → ok
//   • success:true, 0 records → { ok:false, empty:true, error:"...no    → empty
//                                 usable result..." }
//   • 402 / 429 (our balance  → { ok:false, error:"...provider           → skipped
//     dry / rate-limited)        suppressed for investigation" }
//       (NB: NO `skipped:true` flag — that would flip deriveOk to ok=true and log
//        the skip as a success. The "provider suppressed" phrasing is what routes
//        it to outcome=skipped. A depleted BALANCE is neutral, not a vendor fault.)
//   • non-2xx / success:false → { ok:false, status, error }             → failed
//   • network error / timeout → { error }                               → failed
//
// CONFIDENCE: broker/lead tier. Classified `breach` in source-classification.ts
// (CLASS_CAP 60, in NEVER_HIGH) so a single Indicia hit can NEVER reach Confirmed —
// it is a Lead until independently corroborated. This file returns raw results +
// outcome only; it does not and must not set confidence itself.

import { tool } from "npm:ai@6";
import { z } from "npm:zod@3";
import { fetchT } from "../fetch_retry.ts";
import { parseStructuredName } from "../name-parse.ts";

const INDICIA_BASE = "https://api.indicia.app";
// Under the 20s per-tool cap set for indicia_* in cache.ts TOOL_TIMEOUT_OVERRIDE_MS,
// so the tool's own fetch times out cleanly before the wrapper cap fires.
const INDICIA_HTTP_TIMEOUT_MS = 18_000;

/**
 * The closed set of web-DB corpora the `/web-dbs` endpoint accepts. The endpoint
 * requires a non-empty `services` list and rejects any name outside this set, so
 * both the default and the filter read from here — one list, not three.
 */
export const WEB_DB_SERVICES = [
  "cloudsint",
  "leakcheck",
  "snusbase",
  "intelligencex.identityportal",
] as const;

/** The closed set of selector types the `/hudsonrock` endpoint accepts. */
export const HUDSONROCK_TYPES = ["domain", "email", "ip", "password", "username"] as const;

/**
 * Infer a Hudson Rock selector type from the selector's shape. Never returns
 * "password" — a password is not inferable from shape, and guessing one would send
 * an analyst's selector to a credential-search endpoint it was not meant for. The
 * caller must name that type explicitly.
 */
export function inferHudsonRockType(query: string): string {
  const q = String(query ?? "").trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(q)) return "ip";
  if (q.includes("@")) return "email";
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(q)) return "domain";
  return "username";
}

interface IndiciaToolResult {
  ok?: boolean;
  empty?: boolean;
  source?: string;
  endpoint?: string;
  query?: unknown;
  count?: number;
  records?: unknown[];
  status?: number;
  error?: string;
  raw?: unknown;
}

/**
 * Defensively collect result records from an Indicia `data` envelope. Unions
 * every array-valued key (data.web, data.snusbase, data.leakcheck, …) rather than
 * assuming a single "web" key, so a populated response under an unexpected key is
 * NOT misread as empty. Falls back to treating a non-trivial `data` object as a
 * single record when it carries substantive fields but no arrays.
 */
export function extractIndiciaRecords(data: unknown): unknown[] {
  if (!data || typeof data !== "object") return [];
  const d = data as Record<string, unknown>;
  const out: unknown[] = [];
  for (const v of Object.values(d)) {
    if (Array.isArray(v)) out.push(...v.filter((x) => x != null));
  }
  if (out.length === 0) {
    // No arrays — but some endpoints may return a single record object under
    // data.<key>. Count it only if it carries a real PAYLOAD (guards against an
    // empty {}, or a metadata-only no-hit echo like {found:0} / {count:0} /
    // {found:false} being misread as a hit). A bare number/boolean is metadata,
    // not a record: `found`/`count` sentinels are exactly how these endpoints
    // signal a valid negative, so a scalar-only object must read as EMPTY. Only
    // a non-empty nested object/array or a non-empty string counts as substance.
    const substantive = Object.values(d).some((v) => {
      if (v == null) return false;
      if (Array.isArray(v)) return v.some((x) => x != null);
      if (typeof v === "object") return Object.keys(v as object).length > 0;
      if (typeof v === "string") return v.trim().length > 0;
      // number / boolean → metadata sentinel (found/count/exists), never a record.
      return false;
    });
    if (substantive && Object.keys(d).length > 0) out.push(d);
  }
  return out;
}

/**
 * Core request handler. Every Indicia intelligence endpoint shares auth, envelope,
 * and failure modes, so each tool below is a thin wrapper over this.
 */
async function indiciaRequest(
  endpoint: string,
  dataKeyLabel: string,
  body: Record<string, unknown>,
  query: unknown,
  signal: AbortSignal | undefined,
): Promise<IndiciaToolResult> {
  const apiKey = Deno.env.get("INDICIA_API_KEY");
  if (!apiKey) {
    // Gated by capabilities.ts, so this is defensive only. "not configured"
    // classifies as an intentional skip (never a failure).
    return { error: "INDICIA_API_KEY not configured", source: "indicia", endpoint: dataKeyLabel };
  }

  // Drop undefined body fields so we never send `{"city": null}` etc.
  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "")) payload[k] = v;
  }

  let resp: Response;
  try {
    resp = await fetchT(
      `${INDICIA_BASE}${endpoint}`,
      {
        method: "POST",
        headers: { "x-api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
        signal,
      },
      INDICIA_HTTP_TIMEOUT_MS,
    );
  } catch (err) {
    // Network-level failure (timeout, DNS, connection reset) — a genuine failure.
    const isAbort = err instanceof DOMException && err.name === "AbortError";
    return {
      error: isAbort
        ? `indicia ${dataKeyLabel} timed out`
        : `indicia network error: ${err instanceof Error ? err.message : String(err)}`,
      source: "indicia",
      endpoint: dataKeyLabel,
    };
  }

  // Credit exhaustion / rate-limit is a SKIP, not a failure — a depleted balance
  // must not tank this tool's reliability score (the stolentax lesson). NO
  // `skipped:true` flag: the "provider suppressed" phrasing routes it to
  // outcome=skipped without flipping deriveOk to a logged success.
  if (resp.status === 402 || resp.status === 429) {
    await resp.body?.cancel().catch(() => {});
    return {
      ok: false,
      status: resp.status,
      source: "indicia",
      endpoint: dataKeyLabel,
      error: `indicia ${dataKeyLabel} quota/credit exhausted (HTTP ${resp.status}) — provider suppressed for investigation`,
    };
  }

  let json: unknown;
  try {
    json = await resp.json();
  } catch (err) {
    return {
      ok: false,
      status: resp.status,
      source: "indicia",
      endpoint: dataKeyLabel,
      error: `indicia ${dataKeyLabel} invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!resp.ok) {
    const msg = (json as { message?: unknown; error?: unknown })?.message
      ?? (json as { error?: unknown })?.error;
    return {
      ok: false,
      status: resp.status,
      source: "indicia",
      endpoint: dataKeyLabel,
      raw: json,
      error: `indicia ${dataKeyLabel} HTTP ${resp.status}${typeof msg === "string" ? `: ${msg}` : ""}`,
    };
  }

  const envelope = json as { success?: boolean; data?: unknown };
  if (envelope.success !== true) {
    // A 2xx with success:false is a genuine per-query failure — HTTP status alone
    // does not decide outcome (the same trap that bit ipqualityscore).
    return {
      ok: false,
      status: resp.status,
      source: "indicia",
      endpoint: dataKeyLabel,
      raw: json,
      error: `indicia ${dataKeyLabel} returned success:false`,
    };
  }

  const records = extractIndiciaRecords(envelope.data);
  if (records.length === 0) {
    // success:true + no records = valid negative → outcome=empty (NOT failed).
    // "no usable result" is what classifyToolOutcome maps to `empty`.
    return {
      ok: false,
      empty: true,
      status: resp.status,
      source: "indicia",
      endpoint: dataKeyLabel,
      query,
      error: `indicia ${dataKeyLabel}: no usable result — no record found for this selector`,
    };
  }

  return {
    ok: true,
    source: "indicia",
    endpoint: dataKeyLabel,
    query,
    count: records.length,
    records,
  };
}

const getSignal = (opts: unknown): AbortSignal | undefined =>
  (opts as { abortSignal?: AbortSignal } | undefined)?.abortSignal;

/** Email → linked person/records. 1 token/call. Broker/lead tier. */
export const indicia_email = tool({
  description:
    "Indicia email intelligence (api.indicia.app) — US person/broker + web-DB records linked to an email address. Broker/breach-dump data: LEAD until corroborated, never confirmed on a single hit. 1 token/call.",
  inputSchema: z.object({ query: z.string().min(3).describe("Email address to look up.") }),
  execute: async ({ query }, opts) =>
    indiciaRequest("/v1/search/intelligence/email", "email", { query }, query, getSignal(opts)),
});

/**
 * Reduce a phone selector to the bare 10-digit NANP number the Indicia phone
 * endpoint accepts, or null when the selector cannot be used.
 *
 * The endpoint validates `exactly length 10`, so a formatted or E.164 selector
 * ("+1 (212) 555-0123") is rejected 400 before it reaches the data layer. An
 * 11-digit number with a leading US country code is reduced rather than refused —
 * live telemetry recorded successful calls at both 10 and 11 digits, and 10 is the
 * length that satisfies the documented validator, so normalising down is correct
 * under both accounts.
 */
export function normalizeUsPhone(raw: string): string | null {
  const digits = String(raw ?? "").replace(/\D+/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return null;
}

/** Phone → linked person/records. 1 token/call. Broker/lead tier. */
export const indicia_phone = tool({
  description:
    "Indicia phone intelligence (api.indicia.app) — US person/broker + web-DB records linked to a phone number. Broker/breach-dump data: LEAD until corroborated. 1 token/call.",
  inputSchema: z.object({
    query: z.string().min(7).describe("Phone number (any format — normalized to bare digits before the call)."),
  }),
  execute: async ({ query }, opts) => {
    // Normalize rather than relying on the model to send bare digits: 26 of 33
    // observed HTTP 400s carried non-digit characters (12 leading "+", 15 with
    // "()- ."), while every successful call sent pure digits.
    const normalized = normalizeUsPhone(query);
    if (!normalized) {
      // Two deliberate properties, both load-bearing:
      //
      //  1. "gated" routes this through classifyToolOutcome's SKIP_RE to SKIPPED.
      //     A selector we DECLINED TO SEND is not a measurement. Phrasing it as
      //     "no usable result" would match EMPTY_RE and record `empty` — asserting
      //     the provider was asked and had no record, when no call was made at
      //     all. That is the absence-assertion defect this codebase has already
      //     hit three times (sweeper 4xx, RDAP bootstrap, sweep echo); recording a
      //     never-made call as measured absence is the same error a fourth time.
      //
      //  2. It reports the digit COUNT, never the number. A tool's `error` string
      //     is lifted by extractToolError into `tool_usage_log.error_msg`, so
      //     interpolating the selector would write an analyst-supplied phone number
      //     into telemetry — exactly what env.ts's logging policy forbids.
      const digitCount = String(query ?? "").replace(/\D+/g, "").length;
      return {
        error: `indicia phone: gated — selector is not a usable US phone number ` +
          `(expected 10 digits, or 11 with a leading country code; got ${digitCount})`,
        source: "indicia",
        endpoint: "phone",
        // No fetch was issued above, so this call cost nothing. The marker
        // releases the paid-call slot reserved at admission — see
        // runtime-policy.ts:isPreProviderGate. Any tool that declines its
        // selector before contacting the provider must set this.
        provider_attempted: false,
      };
    }
    return indiciaRequest(
      "/v1/search/intelligence/phone",
      "phone",
      { query: normalized },
      normalized,
      getSignal(opts),
    );
  },
});

/** Name + city/state (US) → person records. 1 token/call. Broker/lead tier. */
export const indicia_person = tool({
  description:
    "Indicia person search (api.indicia.app) — US people-search/broker records for a full name, optionally narrowed by city + state. Same-name collision risk: LEAD until a selector overlaps, never confirmed alone. 1 token/call.",
  inputSchema: z.object({
    name: z.string().min(2).describe("Full name."),
    city: z.string().optional().describe("US city to narrow the search."),
    state: z.string().optional().describe("US state (2-letter or full) to narrow the search."),
  }),
  execute: async ({ name, city, state }, opts) => {
    // Broker/public-record seeds often arrive as "LAST, FIRST MIDDLE[, ST]"
    // (LEADS/CSV export style). Reorder to natural "First … Last" and lift a
    // trailing state code so the person API isn't fed a comma-inverted query.
    const parsed = parseStructuredName(name);
    const resolvedName = parsed.name || name;
    const resolvedState = state ?? parsed.state;
    const query = { name: resolvedName, city, state: resolvedState };
    return indiciaRequest("/v1/search/intelligence/person", "person", query, query, getSignal(opts));
  },
});

/** US address → linked individuals/records. 1 token/call. Broker/lead tier. */
export const indicia_address = tool({
  description:
    "Indicia address intelligence (api.indicia.app) — individuals/records linked to a US street address. Broker data: LEAD until corroborated. 1 token/call.",
  inputSchema: z.object({
    address1: z.string().min(3).describe("Street address line 1."),
    city: z.string().optional(),
    state: z.string().optional().describe("US state (2-letter or full)."),
    // REQUIRED by the API (`path:["zip"] code:"required"`) — an omitted zip is a
    // hard 400, not a broader search. Already required in the deployed build.
    zip: z.string().describe("US 5-digit ZIP code (required by the provider)."),
    address2: z.string().optional(),
  }),
  execute: async ({ address1, city, state, zip, address2 }, opts) =>
    indiciaRequest(
      "/v1/search/intelligence/address",
      "address",
      { address1, city, state, zip, address2 },
      { address1, city, state, zip },
      getSignal(opts),
    ),
});

/** Aggregated web/breach databases (leakcheck, snusbase, cloudsint, …). 1-2 tokens/call. */
export const indicia_web_dbs = tool({
  description:
    "Indicia web-DB breach aggregator (api.indicia.app) — queries multiple breach corpora (leakcheck, snusbase, cloudsint, …) for a selector. Breach-dump data: LEAD until corroborated, never auto-pivot leaked passwords. 1-2 tokens/call.",
  inputSchema: z.object({
    query: z.string().min(3).describe("Selector (email, username, phone, …)."),
    services: z.array(z.string()).optional().describe(
      `Optional subset of web-DB services: ${WEB_DB_SERVICES.join(" | ")}. Defaults to all.`,
    ),
  }),
  execute: async ({ query, services }, opts) => {
    // `services` is REQUIRED by the endpoint and validated against a closed set —
    // omitting it, or naming a service outside the set, is an unconditional 400.
    // Resolved HERE rather than only in the zod schema: execute() is called
    // directly by tests and by any path that skips schema parsing, and an explicit
    // `services: []` would satisfy a .default() while still 400ing.
    const requested = (services ?? [])
      .map((s) => String(s).trim().toLowerCase())
      .filter((s) => (WEB_DB_SERVICES as readonly string[]).includes(s));
    const resolved = requested.length > 0 ? requested : [...WEB_DB_SERVICES];
    return indiciaRequest(
      "/v1/search/intelligence/web-dbs",
      "web-dbs",
      { query, services: resolved },
      query,
      getSignal(opts),
    );
  },
});

/** Hudson Rock — infostealer/compromised-credential exposure. FREE (0 tokens/call). */
export const indicia_hudsonrock = tool({
  description:
    "Indicia Hudson Rock lookup (api.indicia.app) — infostealer / compromised-machine credential exposure for an email, domain, or username. FREE (0 tokens). Exposure is a LEAD; corroborate before treating as confirmed.",
  inputSchema: z.object({
    query: z.string().min(3).describe("Email, domain, or username to check for infostealer exposure."),
    type: z.string().optional().describe(
      `Selector type: ${HUDSONROCK_TYPES.join(" | ")}. Inferred from the selector shape when omitted.`,
    ),
  }),
  execute: async ({ query, type }, opts) => {
    // `type` is REQUIRED and validated against a closed set, so an omitted hint is
    // a 400 rather than a broader search. Infer it from the selector's shape.
    const hint = type ? String(type).trim().toLowerCase() : "";
    const q = String(query).trim();
    const resolved = (HUDSONROCK_TYPES as readonly string[]).includes(hint) ? hint : inferHudsonRockType(q);
    return indiciaRequest(
      "/v1/search/intelligence/hudsonrock",
      "hudsonrock",
      { query: q, type: resolved },
      q,
      getSignal(opts),
    );
  },
});
