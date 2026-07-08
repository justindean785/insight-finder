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
  // Control that gating does NOT over-reach: a keyed, available provider survives.
  // (Was ipqualityscore_lookup — cut 2026-07-05 as a dead key; use rapidapi, which
  // is in SCHEMA and available with its key.)
  const caps = discoverCapabilities({ RAPIDAPI_KEY: true }, null);
  const active = schedulableTools(SCHEMA, caps);
  assert(active.includes("rapidapi_breach_search"));
  assert(active.includes("breach_check"));
});

Deno.test("cut tools are gated out of the schema even with their key present", () => {
  // ipqualityscore_lookup is disabled (dead key) in capabilities.ts, so it must be
  // gated even when IPQUALITYSCORE_API_KEY is present. (The permanently-dead
  // stolentax_footprint / synapsint_lookup / emailrep tools were removed entirely.)
  const caps = discoverCapabilities({ IPQUALITYSCORE_API_KEY: true }, null);
  const gated = new Set(gatedToolNames(caps));
  assert(
    gated.has("ipqualityscore_lookup"),
    "ipqualityscore_lookup is cut (disabled) and must be gated even with its key present",
  );
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

Deno.test("gemini_vision is gated on GEMINI_API_KEY (schema readiness)", () => {
  const gatedNoKey = new Set(gatedToolNames(discoverCapabilities({}, null)));
  assert(gatedNoKey.has("gemini_vision"), "gemini_vision must be gated when GEMINI_API_KEY is absent");
  const gatedWithKey = new Set(gatedToolNames(discoverCapabilities({ GEMINI_API_KEY: true }, null)));
  assertEquals(gatedWithKey.has("gemini_vision"), false);
});

Deno.test("Fix #4: list_tools omits indicia_* and gemini_vision when their key is absent", async () => {
  // list_tools was advertising these even when the schema gate had removed them —
  // the planner saw a tool the runtime deleted. Build the registry with no keys
  // and assert list_tools disables + filters them, matching the schema gate.
  const origIndicia = Deno.env.get("INDICIA_API_KEY");
  const origGemini = Deno.env.get("GEMINI_API_KEY");
  Deno.env.delete("INDICIA_API_KEY");
  Deno.env.delete("GEMINI_API_KEY");
  try {
    const { buildTools } = await import("./tool-registry.ts");
    const ctx = {
      supabase: {}, supabaseAdmin: {}, userId: "t", threadId: "t-listtools",
      archiveEnabled: false, detectedSeedType: "email", messages: [], manualOverrideSelector: null,
    } as unknown as Parameters<typeof buildTools>[0];
    const { tools } = buildTools(ctx);
    const listTools = tools.list_tools as unknown as { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> };
    const out = await listTools.execute({}, {});
    const disabledNames = new Set((out.disabled_tools as Array<{ name: string }>).map((d) => d.name));
    const advertised = new Set((out.tools as Array<{ name: string }>).map((t) => t.name));
    for (const n of ["indicia_email","indicia_phone","indicia_person","indicia_address","indicia_web_dbs","indicia_hudsonrock","gemini_vision"]) {
      assert(disabledNames.has(n), `${n} must be in disabled_tools when keyless`);
      assert(!advertised.has(n), `${n} must NOT be advertised in list_tools when keyless`);
    }
  } finally {
    if (origIndicia === undefined) Deno.env.delete("INDICIA_API_KEY"); else Deno.env.set("INDICIA_API_KEY", origIndicia);
    if (origGemini === undefined) Deno.env.delete("GEMINI_API_KEY"); else Deno.env.set("GEMINI_API_KEY", origGemini);
  }
});
