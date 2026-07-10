// Regression test for the 2026-06-13 "disable consistently-failing tools" pass.
// The synapsint_lookup and deepfind_ransomware_exposure / deepfind_profile_analyzer
// providers that this file used to assert stayed gated have since been REMOVED
// from the runtime entirely, so there is no longer a keyed-but-disabled provider
// to guard. What remains verified below: a healthy keyed provider is available,
// and the 12 WORKING deepfind endpoints are available when the key is set.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { discoverCapabilities } from "./capabilities.ts";

Deno.test("a healthy keyed provider is still available (control)", () => {
  // Was ipqualityscore_lookup — cut 2026-07-05 (dead key). Use another healthy
  // keyed provider as the control that gating does NOT over-reach.
  const caps = discoverCapabilities({ OATHNET_API_KEY: true }, null);
  const oath = caps.find((c) => c.tool === "oathnet_lookup");
  assertEquals(oath?.available, true);
  assertEquals(oath?.reason, "ok");
});

Deno.test("cut providers (dead keys / dead APIs) are gated off the schedulable set", () => {
  // Even with its key present, the CUT ipqualityscore_lookup tool must report
  // unavailable so the readiness gate strips it from the schema (dead key, no real
  // signal). (The permanently-dead stolentax_footprint / synapsint_lookup / emailrep
  // tools were removed from the codebase entirely, not just disabled.)
  const caps = discoverCapabilities({ IPQUALITYSCORE_API_KEY: true }, null);
  const byTool = new Map(caps.map((c) => [c.tool, c]));
  assertEquals(byTool.get("ipqualityscore_lookup")?.available, false, "ipqualityscore_lookup must be gated off (cut)");
  assertEquals(byTool.get("ipqualityscore_lookup")?.reason, "disabled", "ipqualityscore_lookup reason must be 'disabled'");
});

Deno.test("low-yield planner tools (2026-07-09 cull) are disabled even with key present", () => {
  // deepfind_reverse_email (92% fail, all >8s timeouts) + dork_harvest (67% fail,
  // 23s avg, junk artifacts) were hard-disabled at the beta launch. Even with
  // DEEPFIND_API_KEY set, deepfind_reverse_email must report disabled so the
  // readiness gate strips it from the schema. dork_harvest takes no key and must
  // report disabled unconditionally. (They are ALSO in tool-registry PERMANENT_BLOCK.)
  const byTool = new Map(
    discoverCapabilities({ DEEPFIND_API_KEY: true }, null).map((c) => [c.tool, c]),
  );
  for (const t of ["deepfind_reverse_email", "dork_harvest"]) {
    assertEquals(byTool.get(t)?.available, false, `${t} must be gated off (disabled 2026-07-09)`);
    assertEquals(byTool.get(t)?.reason, "disabled", `${t} reason must be 'disabled'`);
  }
});

Deno.test("indicia tools are gated on INDICIA_API_KEY", () => {
  const withKey = new Map(
    discoverCapabilities({ INDICIA_API_KEY: true }, null).map((c) => [c.tool, c]),
  );
  const noKey = new Map(discoverCapabilities({}, null).map((c) => [c.tool, c]));
  for (const t of ["indicia_email", "indicia_phone", "indicia_person", "indicia_address", "indicia_web_dbs", "indicia_hudsonrock"]) {
    assertEquals(withKey.get(t)?.available, true, `${t} available with key`);
    assertEquals(noKey.get(t)?.available, false, `${t} gated without key`);
    assertEquals(noKey.get(t)?.reason, "missing_key", `${t} reason missing_key`);
  }
});

Deno.test("working deepfind endpoints are available when key is set", () => {
  const caps = discoverCapabilities({ DEEPFIND_API_KEY: true }, null);
  const byTool = new Map(caps.map((c) => [c.tool, c]));
  for (
    // deepfind_reverse_email intentionally omitted — hard-disabled 2026-07-09
    // (see the low-yield planner-cull test above). The other 11 keyed endpoints
    // remain available when DEEPFIND_API_KEY is set.
    const t of [
      "deepfind_disposable_email",
      "deepfind_ssl_inspect",
      "deepfind_tech_stack",
      "deepfind_url_unshorten",
      "deepfind_telegram_channel",
      "deepfind_telegram_search",
      "deepfind_vin_lookup",
      "deepfind_aircraft_lookup",
      "deepfind_vessel_lookup",
      "deepfind_mac_lookup",
      "deepfind_dark_web_link",
    ]
  ) {
    assertEquals(byTool.get(t)?.available, true, `${t} should be available with key`);
  }
});
