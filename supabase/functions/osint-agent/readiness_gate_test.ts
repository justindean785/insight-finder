// readiness_gate_test.ts — Phase B1 (startup provider-readiness gate).
// A tool whose key is absent must be removed from BOTH the schedulable set and the
// tool schema the model sees. Verified via the pure capabilities helpers that
// index.ts's boot gate uses to delete tools from the `tools` object.
import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  discoverCapabilities,
  gatedToolNames,
  schedulableTools,
} from "./capabilities.ts";

// A representative slice of the live schema: keyed tools + always-on free tools.
const SCHEMA = [
  "hibp_lookup",
  "ipqualityscore_lookup",
  "stolentax_footprint",
  "breach_check", // keyless fallback → must SURVIVE the gate
  "rapidapi_breach_search",
  "rapidapi_all_breaches",
  "gemini_deep_dork",
  // free / always-on — must always survive the gate
  "dns_records",
  "whois_lookup",
  "http_fingerprint",
];

Deno.test("keyless tools are gated out of schedulable set AND schema", () => {
  // No keys present at all.
  const caps = discoverCapabilities({}, null);
  const gated = new Set(gatedToolNames(caps));
  for (
    const t of [
      "hibp_lookup",
      "ipqualityscore_lookup",
      "stolentax_footprint",
      "rapidapi_breach_search",
      "rapidapi_all_breaches",
      "gemini_deep_dork",
    ]
  ) {
    assert(gated.has(t), `${t} must be gated when its key is absent`);
  }
  const active = schedulableTools(SCHEMA, caps);
  for (const t of gated) {
    assert(!active.includes(t), `${t} must be absent from the schedulable schema`);
  }
});

Deno.test("breach_check is NOT gated — it has a keyless leakcheck.io fallback", () => {
  // Regression guard: breach_check returns breach data even with no STOLENTAX key
  // (tool-registry.ts leakcheck.io/api/public fallback), so gating it would remove
  // real capability. It must survive the readiness gate on a keyless deploy.
  const caps = discoverCapabilities({}, null);
  assertEquals(gatedToolNames(caps).includes("breach_check"), false);
  assert(schedulableTools(SCHEMA, caps).includes("breach_check"));
});

Deno.test("free / always-on tools survive the readiness gate", () => {
  const caps = discoverCapabilities({}, null);
  const active = schedulableTools(SCHEMA, caps);
  for (const t of ["dns_records", "whois_lookup", "http_fingerprint"]) {
    assert(active.includes(t), `${t} is unauthenticated and must stay schedulable`);
  }
});

Deno.test("a present key keeps its tool in the schema (control)", () => {
  const caps = discoverCapabilities(
    { IPQUALITYSCORE_API_KEY: true, RAPIDAPI_KEY: true, STOLENTAX_API_KEY: true },
    null,
  );
  const active = schedulableTools(SCHEMA, caps);
  assert(active.includes("ipqualityscore_lookup"));
  assert(active.includes("rapidapi_breach_search"));
  assert(active.includes("breach_check"));
});

Deno.test("newly-mapped rapidapi breach tools are gated only on their own key", () => {
  // RAPIDAPI absent → both rapidapi tools gated (they self-skip without the key).
  const gatedNoKey = new Set(gatedToolNames(discoverCapabilities({}, null)));
  assertEquals(gatedNoKey.has("rapidapi_breach_search"), true);
  assertEquals(gatedNoKey.has("rapidapi_all_breaches"), true);
  // RAPIDAPI present → they survive.
  const gatedWithKey = new Set(gatedToolNames(discoverCapabilities({ RAPIDAPI_KEY: true }, null)));
  assertEquals(gatedWithKey.has("rapidapi_breach_search"), false);
  assertEquals(gatedWithKey.has("rapidapi_all_breaches"), false);
});
