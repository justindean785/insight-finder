// lib/leakcheck-key-probe.ts — ask LeakCheck whether it still accepts our key, without (we expect) running a lookup.
//
// ⚠️  OFF BY DEFAULT. Opt in with LEAKCHECK_KEY_PROBE_ENABLED=true — and only AFTER the billing assumption below has
// been verified against the real key (see "What is NOT verified"). `?health=1` is a PUBLIC path that the frontend's
// stuck-run sweeper GETs every 30 s from every tab with a running investigation (ChatWindow.tsx), so a probe that
// turned out to cost quota would not be a rounding error: it would drain the daily allowance in the background.
//
// The incident (2026-10-06). `LEAKCHECK_API_KEY` stopped being accepted on 2026-10-01 (a successful call on 09-30,
// then HTTP 401 on every attempt after). Nothing noticed for FIVE days, because the only instrument is
// `checks.credentials`, which is derived from past `tool_usage_log` rows: it learns a key is dead only after a real
// paid lookup is refused, and it cannot say the key is alive again until another real lookup succeeds.
//
// The idea. LeakCheck checks the key BEFORE it validates the query (measured live on 2026-10-06 with a throwaway key:
// a wrong key on a 2-character query answers `401 Invalid X-API-Key`, never the query-validation error). Their docs
// list a 400 "Too short query (< 3 characters)" (https://docs.leakcheck.io/errors). So a deliberately-too-short query
// SHOULD be a key test: a good key reaches validation and is refused with that 400, a bad key never gets that far.
//
// What is NOT verified — and why this ships dark:
//   1. That a VALID key on the 2-character query answers 400 "Too short query". Only the rejected-key path was
//      observed live.
//   2. That such a request spends NO quota. LeakCheck's docs say only that `quota` is returned on successful
//      responses; they do not say whether an error response is free.
//   scripts: see the PR for a controlled before/after quota check to run with the real key.
//
// Verdicts are deliberately conservative. Only THREE things are asserted, each on positive evidence:
//   rejected      HTTP 401, or a 400 that names the key                        → ok:false
//   plan_or_quota HTTP 403 (documented: "Active plan required" | "Limit reached") → ok:false, provider's words quoted
//   accepted      HTTP 400 whose error text IS the documented "Too short query" → ok:true
// Everything else — an unrecognised 400, a 422, a 429, a 5xx, a timeout — is `unverified` (ok:true: a blip says
// nothing about the key; a red /health that cries wolf is worse than none). If LeakCheck ever answers the probe like a
// real lookup (any 2xx, or a numeric `quota` in the body), the billing assumption is FALSE: the probe LATCHES OFF for
// the life of the isolate and reports ok:false so an operator unsets the switch.
//
// The key is never put in a URL or a detail string. Concurrent callers share ONE in-flight request, and the result is
// memoised per isolate (10 min; 60 s when unverified). Per-isolate memo is not a global rate limit — which is exactly
// why the default is off.
//
// SWITCHES, read at CALL TIME:
//   LEAKCHECK_KEY_PROBE_ENABLED=true   opt in (default: off)
//   LEAKCHECK_KEY_PROBE_DISABLED=true  hard off; beats ENABLED

export const LEAKCHECK_PROBE_URL = "https://leakcheck.io/api/v2/query/ab"; // 2 chars: < the 3-char minimum, on purpose
export const LEAKCHECK_PROBE_TIMEOUT_MS = 6_000;
/** A conclusive answer is reused this long (per isolate); an unverified one is retried sooner. */
export const LEAKCHECK_PROBE_TTL_MS = 10 * 60_000;
export const LEAKCHECK_PROBE_RETRY_MS = 60_000;

export type KeyProbeState = "not_run" | "rejected" | "plan_or_quota" | "accepted" | "unverified" | "assumption_violated";
export type KeyProbe = { ok: boolean; detail: string; state: KeyProbeState };
type Verdict = KeyProbe & { conclusive: boolean };

function envFlag(name: string): boolean {
  return (Deno.env.get(name) ?? "").trim().toLowerCase() === "true";
}

/** Opt-in AND not hard-disabled. Off unless an operator turned it on. */
export function leakcheckKeyProbeEnabled(): boolean {
  return envFlag("LEAKCHECK_KEY_PROBE_ENABLED") && !envFlag("LEAKCHECK_KEY_PROBE_DISABLED");
}

/** LeakCheck's own error text ({"success":false,"error":"…"}), made log-safe and bounded. */
function providerError(body: unknown): string {
  const e = (body as { error?: unknown } | null)?.error;
  return typeof e === "string" ? e.replace(/[^\x20-\x7E]/g, "").slice(0, 90).trim() : "";
}

/** A numeric `quota` is what a successful LOOKUP returns — its presence means a lookup ran. */
function lookupRan(status: number, body: unknown): boolean {
  if (status >= 200 && status < 300) return true;
  return typeof (body as { quota?: unknown } | null)?.quota === "number";
}

/**
 * Turn one LeakCheck response into a verdict. `conclusive` says whether it may be memoised for the full TTL.
 * Pure: (status, parsed body) in, verdict out.
 */
export function interpretLeakcheckProbe(status: number, body: unknown): Verdict {
  const err = providerError(body);
  const namesKey = /api[- ]?key|x-api-key/i.test(err);

  // The billing assumption is false: a lookup ran. Checked FIRST — nothing else matters once the probe costs quota.
  if (lookupRan(status, body)) {
    return {
      ok: false,
      conclusive: true,
      state: "assumption_violated",
      detail: `UNEXPECTED: LeakCheck answered the probe like a real lookup (HTTP ${status}) — it may have consumed quota. Probe latched OFF in this isolate; unset LEAKCHECK_KEY_PROBE_ENABLED and check LeakCheck usage`,
    };
  }
  // The key was refused (or never reached the server). 401 is what the live API answers for both a missing and a
  // wrong key; the docs say 400 for a wrong key, so a 400 that names the key counts too.
  if (status === 401 || (status === 400 && namesKey)) {
    return {
      ok: false,
      conclusive: true,
      state: "rejected",
      detail: `LeakCheck REJECTED the key (HTTP ${status}${err ? `: "${err}"` : ""}) — replace LEAKCHECK_API_KEY with the key from your LeakCheck account's API page`,
    };
  }
  // Documented 403s: "Active plan required" and "Limit reached". Say which ONLY when LeakCheck said which.
  if (status === 403) {
    const which = /active plan|plan required/i.test(err)
      ? "the plan is not active"
      : /limit reached|quota/i.test(err)
      ? "the usage quota is reached"
      : "the plan is inactive or the quota is reached (LeakCheck did not say which)";
    return {
      ok: false,
      conclusive: true,
      state: "plan_or_quota",
      detail: `LeakCheck refused the request (HTTP 403${err ? `: "${err}"` : ""}) — ${which}`,
    };
  }
  // The ONLY positive evidence of a good key: the documented validation error for the too-short query.
  if (status === 400 && /too short/i.test(err)) {
    return {
      ok: true,
      conclusive: true,
      state: "accepted",
      detail: `key accepted by LeakCheck (HTTP 400 "${err}" on a deliberately too-short query)`,
    };
  }
  // Anything else proves nothing about the key. Never "accepted".
  return {
    ok: true,
    conclusive: false,
    state: "unverified",
    detail: `UNVERIFIED — LeakCheck answered HTTP ${status}${err ? ` ("${err}")` : ""}; the key was not tested`,
  };
}

type Memo = { at: number; ttl: number; result: KeyProbe };
let MEMO: Memo | null = null;
let INFLIGHT: Promise<KeyProbe> | null = null;
let LATCHED: KeyProbe | null = null;

/** Test hook. */
export function resetLeakcheckKeyProbeMemo(): void {
  MEMO = null;
  INFLIGHT = null;
  LATCHED = null;
}

export async function probeLeakcheckKey(deps: {
  key?: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  /** Test hook; production reads the env switches at call time. */
  enabled?: boolean;
} = {}): Promise<KeyProbe> {
  const enabled = deps.enabled ?? leakcheckKeyProbeEnabled();
  if (!enabled) {
    return {
      ok: true,
      state: "not_run",
      detail: "not run — opt-in (LEAKCHECK_KEY_PROBE_ENABLED=true) until the no-quota assumption is verified with the real key; see PR #701",
    };
  }
  if (LATCHED) return LATCHED;
  const key = (deps.key ?? Deno.env.get("LEAKCHECK_API_KEY") ?? "").trim();
  if (!key) {
    return { ok: true, state: "not_run", detail: "not configured (LEAKCHECK_API_KEY unset) — leakcheck_lookup is removed from the tool list" };
  }
  const now = deps.now ?? Date.now;
  if (MEMO && now() - MEMO.at < MEMO.ttl) return MEMO.result;
  // Concurrent callers (the frontend sweeps /health every 30 s per tab) share one request instead of each making their own.
  if (INFLIGHT) return INFLIGHT;

  const doFetch = deps.fetchFn ?? fetch;
  INFLIGHT = (async (): Promise<KeyProbe> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LEAKCHECK_PROBE_TIMEOUT_MS);
    let verdict: Verdict;
    try {
      const res = await doFetch(LEAKCHECK_PROBE_URL, {
        headers: { "X-API-Key": key, Accept: "application/json" },
        signal: ctrl.signal,
      });
      let body: unknown = null;
      try { body = await res.json(); } catch { /* an unparsable body is still a status */ }
      verdict = interpretLeakcheckProbe(res.status, body);
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "AbortError" || /abort/i.test(e.message));
      verdict = {
        ok: true,
        conclusive: false,
        state: "unverified",
        detail: `UNVERIFIED — ${timedOut ? `no answer within ${LEAKCHECK_PROBE_TIMEOUT_MS / 1000}s` : "could not reach LeakCheck"}; the key was not tested`,
      };
    } finally {
      clearTimeout(timer);
    }
    const result: KeyProbe = { ok: verdict.ok, detail: verdict.detail, state: verdict.state };
    if (verdict.state === "assumption_violated") LATCHED = result;
    MEMO = { at: now(), ttl: verdict.conclusive ? LEAKCHECK_PROBE_TTL_MS : LEAKCHECK_PROBE_RETRY_MS, result };
    return result;
  })();
  try {
    return await INFLIGHT;
  } finally {
    INFLIGHT = null;
  }
}
