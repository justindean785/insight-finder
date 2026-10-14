import { assert, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";

const registry = await Deno.readTextFile(new URL("./tool-registry.ts", import.meta.url));
const catalog = await Deno.readTextFile(new URL("./catalog.ts", import.meta.url));

function leakcheckBlock(): string {
  const start = registry.indexOf("leakcheck_lookup: tool({");
  assert(start > 0, "leakcheck_lookup is defined in tool-registry.ts");
  return registry.slice(start, registry.indexOf("hibp_lookup: tool({", start));
}

Deno.test("leakcheck_lookup no longer tells the model it has a daily allowance", () => {
  assertFalse(/200 calls\/day|200\/day/.test(leakcheckBlock()), "tool-registry description");
  const entry = catalog.slice(catalog.indexOf('name: "leakcheck_lookup"'), catalog.indexOf('name: "leakcheck_lookup"') + 900);
  assertFalse(/200 calls\/day|200\/day/.test(entry), "catalog entry");
  assert(/FIXED POOL/.test(leakcheckBlock()) && /not per day/i.test(entry));
});

Deno.test("leakcheck_lookup runs the quota guard BEFORE the network call, fails open, and records quota", () => {
  const b = leakcheckBlock();
  const guard = b.indexOf("leakcheckGuard(");
  const fetchAt = b.indexOf("fetchT(url");
  assert(guard > 0 && fetchAt > guard, "guard precedes the fetch");
  assert(b.includes("provider_attempted: false"), "a guard skip is the house provider-not-attempted skip");
  assert(b.includes("leakcheck_guard_skip"), "a durable log event names every guard skip");
  assert(/priorCalls = error \|\| typeof count !== "number" \? null/.test(b), "an unreadable count is null (fail open)");
  assert(b.includes("lastLeakcheckQuota = seenQuota"), "the provider-reported quota feeds the next call");
  assert(b.includes('.eq("cached", false)'), "cached replays are not counted as spent");
});
