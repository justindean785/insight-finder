// Jina timeout-tolerance fix (Step-4 optional commit, JD Q3 = ride the deploy).
// McGovern-run audit (thread 389365bc, 2026-07-16): ONE jina_reader_scrape
// timeout suppressed the provider for the remainder of the investigation and
// two later valid scrapes were skipped. Fix = 18s wrapper cap (cache.ts) +
// 2-strike suppression tolerance (circuit.ts). This file tests the circuit
// half; the 18s cap is pinned in tool_timeout_caps_test.ts.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { shouldRun, recordResult, clearThread } from "./circuit.ts";

Deno.test("jina: one timeout does NOT suppress the provider — later scrapes still run", () => {
  const thread = "t-jina-one-timeout";
  clearThread(thread);

  recordResult(thread, "jina_reader_scrape", "https://a.example.com", "default", { status: "timeout" });

  const after = shouldRun(thread, "jina_reader_scrape", "https://b.example.com");
  assertEquals(after.allow, true, "a single jina timeout must not suppress the provider for the run");

  clearThread(thread);
});

Deno.test("jina: a SECOND consecutive timeout suppresses the provider for the run", () => {
  const thread = "t-jina-two-timeouts";
  clearThread(thread);

  recordResult(thread, "jina_reader_scrape", "https://a.example.com", "default", { status: "timeout" });
  recordResult(thread, "jina_reader_scrape", "https://b.example.com", "default", { status: "timeout" });

  const after = shouldRun(thread, "jina_reader_scrape", "https://c.example.com");
  assertEquals(after.allow, false, "two consecutive jina timeouts must suppress the provider");

  clearThread(thread);
});

Deno.test("jina: a successful scrape between timeouts resets the strike", () => {
  const thread = "t-jina-strike-reset";
  clearThread(thread);

  recordResult(thread, "jina_reader_scrape", "https://a.example.com", "default", { status: "timeout" });
  recordResult(thread, "jina_reader_scrape", "https://b.example.com", "default", { status: "ok", artifactCount: 1 });
  recordResult(thread, "jina_reader_scrape", "https://c.example.com", "default", { status: "timeout" });

  const after = shouldRun(thread, "jina_reader_scrape", "https://d.example.com");
  assertEquals(after.allow, true, "an ok between timeouts must reset the jina strike count");

  clearThread(thread);
});
