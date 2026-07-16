// Dedicated tests for the timeout-suppression threshold (Step-4 commit 6 —
// port of the live OathNet 2-strike behavior from the deployed mirror).
//
// Rationale: OathNet's endpoints run a legitimate 20s internal fetch, so a
// single outer-wrapper timeout can be latency noise rather than proof the
// quota-shared provider is dead. One timeout must NOT nuke the whole family
// for the rest of the investigation; a second consecutive timeout must.
// Every other provider keeps the strict suppress-on-first-timeout behavior.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  shouldRun,
  recordResult,
  clearThread,
  providerForTool,
} from "./circuit.ts";

Deno.test("bosint family covers email AND phone lookups", () => {
  assertEquals(providerForTool("bosint_email_lookup"), "bosint");
  assertEquals(providerForTool("bosint_phone_lookup"), "bosint");
});

Deno.test("non-OathNet provider: FIRST timeout suppresses the provider for the run", () => {
  const thread = "t-timeout-first-strike";
  clearThread(thread);

  const before = shouldRun(thread, "serus_darkweb_scan", "alice@example.com");
  assertEquals(before.allow, true, "provider should start allowed");

  recordResult(thread, "serus_darkweb_scan", "alice@example.com", "default", { status: "timeout" });

  const after = shouldRun(thread, "serus_darkweb_scan", "bob@example.com");
  assertEquals(after.allow, false, "one timeout must suppress a non-OathNet provider");

  clearThread(thread);
});

Deno.test("OathNet: first timeout does NOT suppress the family; second consecutive does", () => {
  const thread = "t-oathnet-two-strike";
  clearThread(thread);

  // Strike 1 — family must stay available (sibling endpoint included).
  recordResult(thread, "oathnet_lookup", "alice@example.com", "default", { status: "timeout" });
  const sibling = shouldRun(thread, "oathnet_stealer_search", "alice@example.com");
  assertEquals(sibling.allow, true, "one OathNet timeout must not suppress the family");
  const sameTool = shouldRun(thread, "oathnet_lookup", "bob@example.com");
  assertEquals(sameTool.allow, true, "one OathNet timeout must not suppress the tool itself");

  // Strike 2 — now the whole family is suppressed for the investigation.
  recordResult(thread, "oathnet_lookup", "bob@example.com", "default", { status: "timeout" });
  const siblingAfter = shouldRun(thread, "oathnet_victims_search", "alice@example.com");
  assertEquals(siblingAfter.allow, false, "second consecutive OathNet timeout must suppress the family");

  clearThread(thread);
});

Deno.test("OathNet: a success between timeouts resets the strike count", () => {
  const thread = "t-oathnet-strike-reset";
  clearThread(thread);

  recordResult(thread, "oathnet_lookup", "alice@example.com", "default", { status: "timeout" });
  recordResult(thread, "oathnet_lookup", "alice@example.com", "default", { status: "ok", artifactCount: 1 });
  // The next timeout is strike 1 again, not strike 2.
  recordResult(thread, "oathnet_lookup", "bob@example.com", "default", { status: "timeout" });

  const after = shouldRun(thread, "oathnet_stealer_search", "carol@example.com");
  assertEquals(after.allow, true, "success must reset the consecutive-timeout strike count");

  clearThread(thread);
});
