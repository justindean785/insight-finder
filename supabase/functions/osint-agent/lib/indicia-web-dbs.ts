// indicia-web-dbs.ts — which corpora `indicia_web_dbs` queries when the caller names none.
//
// Pure and dependency-free so `health-handler.ts` can self-test it without importing the
// AI SDK (`tools/indicia.ts` re-exports everything here).
//
// WHY the default is NOT the whole closed set: the provider rejects a request that selects
// `snusbase` without a `snusbaseType` ("HTTP 400: snusbaseType is required when snusbase
// is selected"). This tool's request body is `{ query, services }` and never carries that
// field, and the allowed values are not documented in this repo. 5 of 8 calls in 30 days
// failed on exactly this (audit of 2026-11-08). So the DEFAULT omits snusbase; a caller
// that names it explicitly is still forwarded as asked.
//
// Kill switch, read at CALL TIME: INDICIA_WEB_DBS_SNUSBASE_DEFAULT=true restores the old
// default (the full closed set) on the running build.

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

/** Corpora that need no field beyond `{ query, services }`. */
export const WEB_DB_DEFAULT_SERVICES = [
  "cloudsint",
  "leakcheck",
  "intelligencex.identityportal",
] as const;

export function webDbsSnusbaseDefaultRestored(
  env: (k: string) => string | undefined = (k) => Deno.env.get(k),
): boolean {
  return (env("INDICIA_WEB_DBS_SNUSBASE_DEFAULT") ?? "").trim().toLowerCase() === "true";
}

/**
 * Resolve the `services` list to send. `services` is REQUIRED by the endpoint and
 * validated against a closed set — omitting it, or naming a service outside the set, is
 * an unconditional 400. Resolved HERE rather than only in the zod schema: execute() is
 * called directly by tests and by any path that skips schema parsing, and an explicit
 * `services: []` would satisfy a .default() while still 400ing.
 */
export function resolveWebDbServices(
  services: readonly unknown[] | undefined,
  env?: (k: string) => string | undefined,
): string[] {
  const requested = (services ?? [])
    .map((s) => String(s).trim().toLowerCase())
    .filter((s) => (WEB_DB_SERVICES as readonly string[]).includes(s));
  if (requested.length > 0) return requested;
  return webDbsSnusbaseDefaultRestored(env) ? [...WEB_DB_SERVICES] : [...WEB_DB_DEFAULT_SERVICES];
}

/** /health self-test: the default omits snusbase, an explicit request is honoured, and
 *  an empty request cannot fall back to the full set. Pure. */
export function webDbsDefaultSelfTest(
  env?: (k: string) => string | undefined,
): { ok: boolean; detail: string } {
  if (webDbsSnusbaseDefaultRestored(env)) {
    return { ok: true, detail: "LEGACY via INDICIA_WEB_DBS_SNUSBASE_DEFAULT" };
  }
  const dflt = resolveWebDbServices(undefined, env);
  const empty = resolveWebDbServices([], env);
  const explicit = resolveWebDbServices(["snusbase"], env);
  const ok = !dflt.includes("snusbase") && !empty.includes("snusbase") &&
    dflt.length === WEB_DB_DEFAULT_SERVICES.length && explicit.length === 1 && explicit[0] === "snusbase";
  return {
    ok,
    detail: ok
      ? `default services: ${dflt.join(",")} (snusbase omitted: the request cannot carry its required snusbaseType)`
      : `default=${dflt.join(",")} empty=${empty.join(",")} explicit=${explicit.join(",")}`,
  };
}
