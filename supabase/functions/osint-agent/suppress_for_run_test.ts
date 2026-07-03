// suppress_for_run_test.ts — Phase B2: a tool returning 401/403/429 is not
// re-scheduled for the remainder of the run. Exercises the FULL runtime path the
// cache wrapper uses: a raw HTTP-shaped tool result → classifyResult → recordResult
// → shouldRun blocks the next attempt. (Extends circuit_reliability_test.ts, which
// only covered 403/500 and did not go through classifyResult.)
import { assert, assertEquals } from "jsr:@std/assert@^1";
import { recordResult, shouldRun, classifyResult, clearThread } from "./circuit.ts";

// The three hard auth/rate failure classes B2 must suppress for the whole run.
for (const status of [401, 403, 429]) {
  Deno.test(`HTTP ${status} suppresses the tool for the rest of the run (via classifyResult)`, () => {
    const thread = `t-b2-${status}`;
    clearThread(thread);
    const tool = "ipqualityscore_lookup";
    // 1st attempt on a fresh run is allowed.
    assertEquals(shouldRun(thread, tool, "seed-a@example.com").allow, true);
    // The live call comes back with the failure status → runtime classifies + records.
    const kind = classifyResult({ ok: false, status }, null);
    assertEquals(kind, `http_${status}`, "classifyResult must map the status to its FailureKind");
    recordResult(thread, tool, "seed-a@example.com", "default", { status: kind });
    // A later attempt on a DIFFERENT selector must be blocked — not re-scheduled.
    const d = shouldRun(thread, tool, "seed-b@example.com");
    assertEquals(d.allow, false, `${tool} must be suppressed for the run after a ${status}`);
    assert((d.reason ?? "").length > 0, "a suppressed decision carries a reason");
    clearThread(thread);
  });
}

Deno.test("suppression is scoped — an unrelated provider stays schedulable", () => {
  const thread = "t-b2-scope";
  clearThread(thread);
  // Suppress ipqualityscore via a 403.
  recordResult(thread, "ipqualityscore_lookup", "x@y.com", "default", {
    status: classifyResult({ ok: false, status: 403 }, null),
  });
  assertEquals(shouldRun(thread, "ipqualityscore_lookup", "z@y.com").allow, false);
  // A free, unrelated tool must NOT be collaterally suppressed.
  assertEquals(shouldRun(thread, "dns_records", "example.com").allow, true);
  clearThread(thread);
});
