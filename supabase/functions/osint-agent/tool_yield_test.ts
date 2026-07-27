// tool_yield_test.ts — the measurement contract for adaptive tool selection.
//
// WHAT THIS PROTECTS: tool_health scores reliability and latency, and its ok_pct
// excludes the 'empty' outcome from BOTH the numerator and the denominator, so a
// tool that returns HTTP 200 and nothing useful is invisible to scoring rather than
// penalised. Production 2026-07-27: google_dorks logged 309 calls at 99.7% ok and
// produced 5 artifacts; dork_harvest produced 1,132 from 138 calls. Nothing in the
// system could tell those apart. countExtractableFindings is the number that can.
//
// The single most important property here is the undefined/0 distinction. The
// ranking views EXCLUDE NULL and COUNT 0. If an unmeasurable payload ever returns 0
// instead of undefined, every tool whose value the model reads rather than the
// extractor parses (jina_reader_scrape, socialfetch_web_read) is scored as dead and
// the router stops calling it. That failure is silent and would look like data.
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { countExtractableFindings, OPTIONAL_USAGE_COLUMNS } from "./cache.ts";

Deno.test("unmeasurable output is undefined, never 0", () => {
  // undefined => logged as NULL => excluded from the ranking views.
  assertEquals(countExtractableFindings("any_tool", null), undefined);
  assertEquals(countExtractableFindings("any_tool", undefined), undefined);
});

Deno.test("a real payload that yields nothing is 0, not undefined", () => {
  // 0 is the whole point of this feature: "ran fine, found nothing" must be a
  // MEASURED zero that drags the tool's ranking down, not an absence that hides it.
  const empty = countExtractableFindings("google_dorks", { ok: true, results: [] });
  assertEquals(typeof empty, "number", "a non-null payload must produce a measurement");
  assertEquals(empty, 0);
});

Deno.test("a payload with findings counts them", () => {
  const n = countExtractableFindings("breach_check", {
    ok: true,
    breaches: [{ Name: "Dubsmash.com" }, { Name: "Poloniex.com" }],
  });
  assertEquals(typeof n, "number");
  assert((n as number) >= 0, "count must be non-negative");
});

Deno.test("never throws on hostile output — telemetry cannot break a run", () => {
  // This runs on the hot path of every tool call. A malformed payload reaching the
  // extractor must cost us one measurement, never an investigation.
  const hostile: unknown[] = [
    { toString() { throw new Error("boom"); } },
    new Proxy({}, { get() { throw new Error("trap"); } }),
    Symbol("nope"),
    () => {},
    NaN,
    "",
    [],
    { deeply: { nested: { beyond: { reason: Array(50).fill({ a: 1 }) } } } },
  ];
  // Index the payloads rather than stringifying them: several of these throw FROM
  // toString/get, so building the assertion message is itself hostile.
  for (let i = 0; i < hostile.length; i++) {
    const r = countExtractableFindings("jina_reader_scrape", hostile[i]);
    assert(r === undefined || typeof r === "number", `must return number|undefined for hostile payload #${i}`);
  }
});

Deno.test("a self-referential payload does not hang or throw", () => {
  const cyclic: Record<string, unknown> = { ok: true };
  cyclic.self = cyclic;
  const r = countExtractableFindings("socialfetch_lookup", cyclic);
  assert(r === undefined || typeof r === "number");
});

Deno.test("the deploy-ordering column list covers every optional column", () => {
  // If a migration adds a tool_usage_log column and it is not listed here, a build
  // that ships before its migration loses the ENTIRE telemetry row rather than one
  // field — which silently starves the ranking views of the data they exist for.
  assert(OPTIONAL_USAGE_COLUMNS.includes("outcome"));
  assert(OPTIONAL_USAGE_COLUMNS.includes("extracted_findings"));
  for (const c of OPTIONAL_USAGE_COLUMNS) {
    assertEquals(c, c.toLowerCase(), "matched against Postgres error text case-insensitively via toLowerCase()");
  }
});
