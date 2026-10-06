// lib/leakcheck-key-probe.ts — ask LeakCheck whether it still accepts our key, without running a lookup.
//
// The incident (2026-10-06). `LEAKCHECK_API_KEY` stopped being accepted on 2026-10-01 (a successful
// call on 09-30, then HTTP 401 on every attempt after). Nothing noticed for FIVE days, because the
// only instrument is `checks.credentials`, which is derived from past `tool_usage_log` rows: it learns a
// key is dead only after a real paid lookup is refused, and it cannot say the key is alive again until
// another real lookup succeeds. After the key was replaced, the deploy agent could only report "I
// couldn't confirm the fix yet — run a scan and look at the Health tab", i.e. spend a lookup on a real
// case to find out.
//
// LeakCheck checks the key BEFORE it validates the query (measured against the live API: a wrong key on a
// 2-character query is `401 Invalid X-API-Key`, no key is `401 Missing X-API-Key header`). So a request with
// a deliberately-too-short query is a free key test: a good key reaches validation and is told the query is
// too short (HTTP 400, no search run); a bad key never gets that far (HTTP 401).
//
// What this CANNOT establish (and the detail never claims): that the plan is active or the daily quota has
// room — a 403 ("Active plan required" / "Limit reached") is reported as such when LeakCheck volunteers it,
// but a 400 on a short query says only "the key was accepted".
//
// The key is never put in a URL or a detail string. The probe is memoised per isolate so a health poll
// cannot hammer a third party, and every outcome except a DEFINITIVE rejection reports ok:true — a network
// blip or a 429 says nothing about the key, and a red /health that cries wolf is worse than none.
//
// KILL SWITCH, read at CALL TIME: LEAKCHECK_KEY_PROBE_DISABLED=true.

export const LEAKCHECK_PROBE_URL = "https://leakcheck.io/api/v2/query/ab"; // 2 chars: < the 3-char minimum, on purpose
export const LEAKCHECK_PROBE_TIMEOUT_MS = 6_000;
/** A conclusive answer is reused this long (per isolate); an inconclusive one is retried sooner. */
export const LEAKCHECK_PROBE_TTL_MS = 10 * 60_000;
export const LEAKCHECK_PROBE_RETRY_MS = 60_000;

export type KeyProbe = { ok: boolean; detail: string };

export function leakcheckKeyProbeDisabled(): boolean {
  return (Deno.env.get("LEAKCHECK_KEY_PROBE_DISABLED") ?? "").trim().toLowerCase() === "true";
}

/** LeakCheck's own error text ({"success":false,"error":"…"}), made log-safe and bounded. */
function providerError(body: unknown): string {
  const e = (body as { error?: unknown } | null)?.error;
  return typeof e === "string" ? e.replace(/[^\x20-\x7E]/g, "").slice(0, 90).trim() : "";
}

/**
 * Turn one LeakCheck response into a verdict. `conclusive` says whether it may be memoised for the full TTL.
 * Pure: (status, parsed body) in, verdict out.
 */
export function interpretLeakcheckProbe(status: number, body: unknown): KeyProbe & { conclusive: boolean } {
  const err = providerError(body);
  const keyWords = /api[- ]?key|x-api-key/i.test(err);

  // The key was refused (or never reached the server). 401 is what the live API answers for both a missing
  // and a wrong key; the docs say 400 for a wrong key, so a 400 that names the key counts too.
  if (status === 401 || (status === 400 && keyWords)) {
    return {
      ok: false,
      conclusive: true,
      detail: `LeakCheck REJECTED the key (HTTP ${status}${err ? `: "${err}"` : ""}) — replace LEAKCHECK_API_KEY with the key from your LeakCheck account's API page`,
    };
  }
  // Plan or quota: the key itself was recognised, but the account cannot serve queries.
  if (status === 403) {
    return {
      ok: false,
      conclusive: true,
      detail: `LeakCheck accepted the key but refused the request (HTTP 403${err ? `: "${err}"` : ""}) — the plan is inactive or the daily quota is used up`,
    };
  }
  // A 400 that does not name the key = validation failed on the deliberately-too-short query = key accepted.
  if (status === 400 || status === 422 || (status >= 200 && status < 300)) {
    return {
      ok: true,
      conclusive: true,
      detail: `key accepted by LeakCheck (HTTP ${status} on a deliberately too-short query — no lookup was run)`,
    };
  }
  return {
    ok: true,
    conclusive: false,
    detail: `inconclusive — LeakCheck answered HTTP ${status}${err ? ` ("${err}")` : ""}; the key was not tested`,
  };
}

type Memo = { at: number; ttl: number; result: KeyProbe };
let MEMO: Memo | null = null;

/** Test hook. */
export function resetLeakcheckKeyProbeMemo(): void { MEMO = null; }

export async function probeLeakcheckKey(deps: {
  key?: string;
  fetchFn?: typeof fetch;
  now?: () => number;
} = {}): Promise<KeyProbe> {
  if (leakcheckKeyProbeDisabled()) return { ok: true, detail: "LEGACY via LEAKCHECK_KEY_PROBE_DISABLED" };
  const key = (deps.key ?? Deno.env.get("LEAKCHECK_API_KEY") ?? "").trim();
  if (!key) {
    return { ok: true, detail: "not configured (LEAKCHECK_API_KEY unset) — leakcheck_lookup is removed from the tool list" };
  }
  const now = deps.now ?? Date.now;
  if (MEMO && now() - MEMO.at < MEMO.ttl) return MEMO.result;

  const doFetch = deps.fetchFn ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LEAKCHECK_PROBE_TIMEOUT_MS);
  let verdict: KeyProbe & { conclusive: boolean };
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
      detail: `inconclusive — ${timedOut ? `no answer within ${LEAKCHECK_PROBE_TIMEOUT_MS / 1000}s` : "could not reach LeakCheck"}; the key was not tested`,
    };
  } finally {
    clearTimeout(timer);
  }
  const result: KeyProbe = { ok: verdict.ok, detail: verdict.detail };
  MEMO = { at: now(), ttl: verdict.conclusive ? LEAKCHECK_PROBE_TTL_MS : LEAKCHECK_PROBE_RETRY_MS, result };
  return result;
}
