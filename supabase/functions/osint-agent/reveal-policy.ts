/**
 * reveal-policy.ts — the account-level breach-reveal flag, on its own.
 *
 * WHY A SEPARATE MODULE. This flag has to be readable from BOTH the tool layer
 * (which lives in the heavyweight `env.ts` graph: AI-SDK npm: specifiers, model
 * tables, retrying fetch) and from `system-prompt.ts`, which is imported by
 * frontend vitest suites through `src/test/runtime-policy.test.ts`. Pulling
 * `env.ts` into the prompt module drags `npm:@ai-sdk/openai-compatible@1` into
 * Vite's resolver, which cannot resolve a `npm:` specifier — the whole test file
 * fails to collect. So the flag lives here, in a leaf with no imports, and
 * `env.ts` re-exports it. One definition, two graphs, no duplicated parse.
 *
 * The parse must stay in exactly one place: prompt text and tool behavior are
 * derived from this single boolean, and a second copy that drifts is precisely
 * the failure this policy work exists to remove.
 */

/**
 * Guarded env read — this module is imported from Node (vitest, where `Deno` does
 * not exist) and from Deno without `--allow-env` (where the access throws).
 * Mirrors the same helper in runtime-policy.ts for the same reasons.
 */
function readEnv(name: string): string | undefined {
  try {
    // Via globalThis so the frontend tsc gate (no Deno types) still compiles —
    // a bare `Deno` reference breaks the build with TS2304.
    const env = (globalThis as { Deno?: { env?: { get?(k: string): string | undefined } } }).Deno?.env;
    return env?.get ? (env.get(name) ?? undefined) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Breach reveal — when ON, tools surface UNMASKED concrete values: serus is
 * queried with reveal=true, rapidapi keeps each exposed field's real value, and
 * the OathNet stealer/victim trimmers keep raw passwords/cookies instead of
 * stripping them. The platform owner explicitly authorized full reveal on their
 * own account for authorized investigations, so this DEFAULTS ON for this
 * deployment; set REVEAL_BREACH_DATA=false in the edge secrets to restore
 * masked-by-default behavior.
 *
 * NOTE: serus reveal still requires the SERUS_API_KEY to carry the
 * `darkweb:reveal` scope upstream — this flag opts in, it cannot grant a scope
 * the key does not have (a scopeless key 403s).
 *
 * Surfaced at /health as `reveal_breach_data` so the deployed value is
 * observable without running a real breach query.
 */
export const REVEAL_BREACH_DATA =
  (readEnv("REVEAL_BREACH_DATA") ?? "true").trim().toLowerCase() !== "false";
