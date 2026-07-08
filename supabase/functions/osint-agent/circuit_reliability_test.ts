// Regression tests for the dead-provider reliability fixes (2026-06-13 trace:
// 144 calls / 30 fails — deepfind family + synapsint burned ~20 wasted calls).
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { recordResult, shouldRun, providerForTool, clearThread } from "./circuit.ts";

Deno.test("deepfind provider group covers all endpoints", () => {
  // Every deepfind_* endpoint shares one key/base — all must map to "deepfind".
  for (
    const t of [
      "deepfind_reverse_email",
      "deepfind_profile_analyzer",
      "deepfind_telegram_search",
      "deepfind_ransomware_exposure",
      "deepfind_url_unshorten",
      "deepfind_vin_lookup",
      "deepfind_dark_web_link",
    ]
  ) {
    assertEquals(providerForTool(t), "deepfind", `${t} not in deepfind group`);
  }
});

Deno.test("403 on one deepfind endpoint suppresses the whole family", () => {
  const thread = "t-403-suppress";
  clearThread(thread);
  // telegram_search rejects the key with 403.
  recordResult(thread, "deepfind_telegram_search", "somequery", "default", { status: "http_403" });
  // A sibling endpoint on the same dead key must now be blocked, not retried.
  const d = shouldRun(thread, "deepfind_profile_analyzer", "someuser");
  assertEquals(d.allow, false);
  clearThread(thread);
});

Deno.test("404 across 2 distinct selectors disables the endpoint for the run", () => {
  const thread = "t-404-escalate";
  clearThread(thread);
  // First 404 is treated as a legit per-selector miss — selector cached, tool live.
  recordResult(thread, "deepfind_profile_analyzer", "userA", "default", { status: "http_404" });
  assertEquals(shouldRun(thread, "deepfind_profile_analyzer", "userB").allow, true);
  // Second 404 on a different selector → endpoint is gone, disable the tool.
  recordResult(thread, "deepfind_profile_analyzer", "userB", "default", { status: "http_404" });
  assertEquals(shouldRun(thread, "deepfind_profile_analyzer", "userC").allow, false);
  clearThread(thread);
});

Deno.test("a paid provider's 500 suppresses on first failure (unchanged)", () => {
  const thread = "t-500";
  clearThread(thread);
  recordResult(thread, "serus_darkweb_scan", "example.com", "default", { status: "http_500" });
  assertEquals(shouldRun(thread, "serus_darkweb_scan", "other.com").allow, false);
  clearThread(thread);
});

Deno.test("indicia provider group covers all six endpoints", () => {
  // All six share one key + one prepaid balance — all must map to "indicia".
  for (
    const t of [
      "indicia_email",
      "indicia_phone",
      "indicia_person",
      "indicia_address",
      "indicia_web_dbs",
      "indicia_hudsonrock",
    ]
  ) {
    assertEquals(providerForTool(t), "indicia", `${t} not in indicia group`);
  }
});

Deno.test("402 on one indicia endpoint suppresses the whole family (Fix #3)", () => {
  const thread = "t-indicia-402";
  clearThread(thread);
  // Depleted prepaid balance surfaces as 402 on indicia_email.
  recordResult(thread, "indicia_email", "a@example.com", "default", { status: "http_402" });
  // Every sibling on the same empty balance must now be blocked, not retried.
  assertEquals(shouldRun(thread, "indicia_phone", "+15597727112").allow, false);
  assertEquals(shouldRun(thread, "indicia_person", "Jane Doe").allow, false);
  assertEquals(shouldRun(thread, "indicia_web_dbs", "jane@example.com").allow, false);
  clearThread(thread);
});
