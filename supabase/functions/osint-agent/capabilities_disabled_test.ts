// Regression test for the 2026-06-13 "disable consistently-failing tools" pass.
// These providers were dead in production traces (synapsint 5xx, the whole
// deepfind family 403/404). They must stay gated OUT even when their API key
// is present — `disabled: true` short-circuits the key check.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { discoverCapabilities } from "./capabilities.ts";

// DeepFind re-verified 2026-06-13 against the live API with a valid key: 12/14
// endpoints work (correct methods already in code). Only these two still 404
// upstream and stay disabled; synapsint stays disabled (5xx every call).
const DEAD_TOOLS = [
  "synapsint_lookup",
  "deepfind_ransomware_exposure",
  "deepfind_profile_analyzer",
];

Deno.test("disabled providers stay gated even with their API key set", () => {
  // Keys present on purpose — `disabled` must win over key presence.
  const env = { SYNAPSINT_API_KEY: true, DEEPFIND_API_KEY: true };
  const caps = discoverCapabilities(env, null);
  const byTool = new Map(caps.map((c) => [c.tool, c]));
  for (const t of DEAD_TOOLS) {
    const c = byTool.get(t);
    assertEquals(c?.available, false, `${t} must be unavailable`);
    assertEquals(c?.reason, "disabled", `${t} must be reason=disabled (key present)`);
  }
});

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
