/**
 * cors-preflight — answer a CORS preflight (`OPTIONS`) BEFORE the per-request
 * reset at the top of `Deno.serve` (index.ts).
 *
 * Why: index.ts resets module-scoped run state on every non-health request —
 * `degradedTools.clear()`, `deadHosts.clear()`, `resetCorrelateRun()`,
 * `routingGuard.*`, `triageState.*` — and only THEN reaches `setupRequest`,
 * which is where an `OPTIONS` request has always been answered. A preflight is
 * not a run. If one is served by the same worker as a live run, those resets
 * clobber the live run's guard state.
 *
 * The chat POST already preflights once per run start. The maintenance-lockdown
 * frontend change sends `Authorization` on the open-case stale-run sweep, which
 * makes that GET non-simple too: about one preflight every 30 s DURING a live
 * run. This module lets index.ts answer them first, with the same body and
 * headers `setupRequest` returned, plus `Access-Control-Max-Age` so the browser
 * caches the answer instead of preflighting every sweep.
 *
 * KILL SWITCH (read at call time): CORS_PREFLIGHT_EARLY_DISABLED=true restores
 * the old fall-through (preflight answered by setupRequest after the reset).
 */

/** Seconds a browser may cache the preflight answer (Chrome caps at 7200). */
export const CORS_PREFLIGHT_MAX_AGE_S = 600;

export function isCorsPreflight(req: Pick<Request, "method">): boolean {
  return req.method === "OPTIONS";
}

export function corsPreflightEarlyDisabled(
  env: (k: string) => string | undefined = (k) => {
    try { return Deno.env.get(k); } catch { return undefined; }
  },
): boolean {
  return (env("CORS_PREFLIGHT_EARLY_DISABLED") ?? "").trim().toLowerCase() === "true";
}

/** The same "ok" body setupRequest returns for OPTIONS, plus a cache lifetime. */
export function corsPreflightResponse(corsHeaders: Record<string, string>): Response {
  return new Response("ok", {
    headers: { ...corsHeaders, "Access-Control-Max-Age": String(CORS_PREFLIGHT_MAX_AGE_S) },
  });
}

/**
 * `/health` proof key `checks.cors_preflight_early`. Pure. PRESENCE proves the
 * deployed bundle; "LEGACY" = the kill switch is on; ok:false = the predicate
 * failed its own probe.
 */
export function corsPreflightEarlySelfTest(
  disabled: boolean = corsPreflightEarlyDisabled(),
): { ok: boolean; detail: string } {
  if (disabled) return { ok: true, detail: "LEGACY via CORS_PREFLIGHT_EARLY_DISABLED — OPTIONS falls through the per-request reset" };
  const ok = isCorsPreflight({ method: "OPTIONS" }) && !isCorsPreflight({ method: "GET" }) &&
    !isCorsPreflight({ method: "POST" }) && !isCorsPreflight({ method: "HEAD" });
  return ok
    ? { ok: true, detail: `OPTIONS answered before the per-request reset (max-age ${CORS_PREFLIGHT_MAX_AGE_S}s)` }
    : { ok: false, detail: "isCorsPreflight failed its self-test" };
}
