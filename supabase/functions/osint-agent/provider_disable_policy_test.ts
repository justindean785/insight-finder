import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { PROVIDER_REQUIREMENTS } from "./capabilities.ts";

/**
 * The bar for hard-disabling a provider, pinned as a test.
 *
 * Three separate audits in September 2026 proposed gating providers that were
 * measurably HEALTHY, on the strength of a handful of recent 403s. Acting on any
 * of them would have deleted working capability from the fleet. This file exists
 * so the next one has to argue with a failing test rather than a comment.
 *
 * The standard (CLAUDE.md, "A 403 is not a dead credential"): measure `outcome`
 * over real attempts — `outcome IN ('ok','failed')`, with skips and empties
 * excluded from BOTH numerator and denominator — and disable only when the
 * provider has stopped landing calls entirely. A 403 is a request being refused;
 * weeks without a single success is a provider that is gone.
 *
 * Measured 2026-09-30 over the preceding 21 days:
 *   deepfind_email_breach    3 ok / 11 failed, last ok 2026-09-11  → DISABLED
 *   rapidapi_breach_search  58 ok /  6 failed, last ok 2026-09-25  → healthy
 *   nominatim_geocode        6 ok /  2 failed, last ok 2026-09-23  → healthy
 *   reddit_user              0 ok /  7 failed, never              → operator call
 */

type Req = { disabled?: boolean; requiresKey?: string };
const req = (name: string): Req => (PROVIDER_REQUIREMENTS as Record<string, Req>)[name] ?? {};
const isDisabled = (name: string) => req(name).disabled === true;

Deno.test("deepfind_email_breach is disabled — 19 days with no successful call", () => {
  assert(
    isDisabled("deepfind_email_breach"),
    "deepfind_email_breach last succeeded 2026-09-11 and returned nothing but 403 for the " +
    "19 days after. Re-enable only against a FRESH tool_usage_log query showing it landing " +
    "calls again — not because the entry looks like an oversight.",
  );
});

Deno.test("healthy providers are NOT disabled, however many 403s they logged recently", () => {
  // Each of these was proposed for gating by an audit in the same week it was
  // measurably working. rapidapi_breach_search is the case CLAUDE.md already
  // names: it was once reported dead while serving hundreds of successful
  // lookups. nominatim's 403 is OSM enforcing its 1 req/sec policy, which a
  // disable would "fix" by removing geocoding entirely.
  for (const name of ["rapidapi_breach_search", "nominatim_geocode"]) {
    assertEquals(
      isDisabled(name),
      false,
      `${name} was landing calls within the last week. Disabling it deletes working ` +
      `capability. Re-measure outcome IN ('ok','failed') before changing this.`,
    );
  }
});

Deno.test("a disabled entry keeps no requiresKey — the two gates are not additive", () => {
  // `disabled:true` deletes the tool from the schema outright; leaving a
  // requiresKey beside it implies the key could still bring it back and invites
  // a later edit that silently re-enables the tool by setting the secret.
  for (const [name, r] of Object.entries(PROVIDER_REQUIREMENTS as Record<string, Req>)) {
    if (r.disabled === true) {
      assertEquals(
        r.requiresKey,
        undefined,
        `${name} is disabled but still declares requiresKey — drop it, or the disable reads as key-gating`,
      );
    }
  }
});
