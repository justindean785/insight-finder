// Regression test for the 2026-06-13 "disable consistently-failing tools" pass.
// The synapsint_lookup and deepfind_ransomware_exposure / deepfind_profile_analyzer
// providers that this file used to assert stayed gated have since been REMOVED
// from the runtime entirely, so there is no longer a keyed-but-disabled provider
// to guard. What remains verified below: a healthy keyed provider is available,
// and the 12 WORKING deepfind endpoints are available when the key is set.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { discoverCapabilities } from "./capabilities.ts";

Deno.test("a healthy keyed provider is still available (control)", () => {
  const caps = discoverCapabilities({ IPQUALITYSCORE_API_KEY: true }, null);
  const ipqs = caps.find((c) => c.tool === "ipqualityscore_lookup");
  assertEquals(ipqs?.available, true);
  assertEquals(ipqs?.reason, "ok");
});

Deno.test("working deepfind endpoints are available when key is set", () => {
  const caps = discoverCapabilities({ DEEPFIND_API_KEY: true }, null);
  const byTool = new Map(caps.map((c) => [c.tool, c]));
  for (
    const t of [
      "deepfind_reverse_email",
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
