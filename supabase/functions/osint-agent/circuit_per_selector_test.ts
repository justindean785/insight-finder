// Regression: per-selector deterministic rejections (http_400 / http_422) must
// NOT bump the consecutive-failure streak, or three bad URLs in a row would
// falsely disable an otherwise-healthy tool (jina_reader_scrape 422 on a
// malformed court-portal URL is the canonical case — see the "Daniel deroest"
// audit, thread d98deb37, which mixed 1×422 with 7 timeouts and came one
// bad selector away from a false suppression).
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { recordResult, shouldRun, clearThread, snapshot } from "./circuit.ts";

Deno.test("three 422s in a row must NOT disable the tool (per-selector, not per-provider)", () => {
  const thread = "t-422-streak";
  clearThread(thread);
  recordResult(thread, "jina_reader_scrape", "https://a.example/x", "default", { status: "http_422" });
  recordResult(thread, "jina_reader_scrape", "https://b.example/y", "default", { status: "http_422" });
  recordResult(thread, "jina_reader_scrape", "https://c.example/z", "default", { status: "http_422" });
  // A new selector must still be allowed — the tool is not disabled.
  assertEquals(shouldRun(thread, "jina_reader_scrape", "https://d.example/ok").allow, true);
  // But each rejected URL is dead-listed and total climbs so telemetry sees it.
  const s = snapshot(thread).find((x) => x.tool === "jina_reader_scrape");
  assertEquals(s?.disabledReason, undefined);
  assertEquals(s?.dead, 3);
  assertEquals(s?.total, 3);
  assertEquals(s?.consecutive, 0);
  clearThread(thread);
});

Deno.test("http_400 in a row also does not disable the tool (same exemption as http_422)", () => {
  const thread = "t-400-streak";
  clearThread(thread);
  recordResult(thread, "jina_reader_scrape", "https://a.example/x", "default", { status: "http_400" });
  recordResult(thread, "jina_reader_scrape", "https://b.example/y", "default", { status: "http_400" });
  recordResult(thread, "jina_reader_scrape", "https://c.example/z", "default", { status: "http_400" });
  const s = snapshot(thread).find((x) => x.tool === "jina_reader_scrape");
  assertEquals(s?.disabledReason, undefined);
  assertEquals(s?.consecutive, 0);
  assertEquals(s?.total, 3);
  clearThread(thread);
});

Deno.test("http_500 still trips the consecutive streak (only per-selector kinds are exempt)", () => {
  const thread = "t-500-still-fails";
  clearThread(thread);
  // 500 suppresses the provider on the first hit anyway, but the streak must
  // also be maintained so unrelated tools relying on b.consecutive see it.
  recordResult(thread, "jina_reader_scrape", "https://a.example/x", "default", { status: "http_500" });
  const s = snapshot(thread).find((x) => x.tool === "jina_reader_scrape");
  assertEquals(s?.consecutive, 1);
  clearThread(thread);
});

Deno.test("3 consecutive timeouts still disable the tool (unaffected by the 400/422 exemption)", () => {
  const thread = "t-timeout-still-disables";
  clearThread(thread);
  recordResult(thread, "jina_reader_scrape", "https://a.example/x", "default", { status: "timeout" });
  recordResult(thread, "jina_reader_scrape", "https://b.example/y", "default", { status: "timeout" });
  recordResult(thread, "jina_reader_scrape", "https://c.example/z", "default", { status: "timeout" });
  const s = snapshot(thread).find((x) => x.tool === "jina_reader_scrape");
  assertEquals(s?.consecutive, 3);
  assertEquals(s?.disabledReason, "disabled after 3 consecutive failures");
  clearThread(thread);
});

Deno.test("a mixed streak (422, timeout, 422) does not double-count the 422s toward disabling", () => {
  const thread = "t-mixed-streak";
  clearThread(thread);
  recordResult(thread, "jina_reader_scrape", "https://a.example/x", "default", { status: "http_422" });
  recordResult(thread, "jina_reader_scrape", "https://b.example/y", "default", { status: "timeout" });
  recordResult(thread, "jina_reader_scrape", "https://c.example/z", "default", { status: "http_422" });
  const s = snapshot(thread).find((x) => x.tool === "jina_reader_scrape");
  // Only the single timeout bumped `consecutive`.
  assertEquals(s?.consecutive, 1);
  assertEquals(s?.total, 3);
  clearThread(thread);
});
