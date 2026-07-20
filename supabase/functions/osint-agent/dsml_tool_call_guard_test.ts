import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  hasDsmlToolCallMarkup,
  parseDsmlToolCalls,
  stripDsmlToolCallMarkup,
} from "./dsml-tool-call-guard.ts";

// Reconstructed from a live production leak (seed "loadq.com") — 4 well-formed
// intended tool calls that rendered as raw text instead of executing.
const LIVE_SAMPLE =
  '<｜DSML｜tool_calls><｜DSML｜invoke name="http_fingerprint">' +
  '<｜DSML｜parameter name="url" string="true">https://links.loadq.com</｜DSML｜parameter>' +
  '</｜DSML｜invoke><｜DSML｜invoke name="serus_darkweb_scan">' +
  '<｜DSML｜parameter name="identifier" string="true">loadq.com</｜DSML｜parameter>' +
  '<｜DSML｜parameter name="identifierType" string="true">domain</｜DSML｜parameter>' +
  '</｜DSML｜invoke><｜DSML｜invoke name="jina_reader_scrape">' +
  '<｜DSML｜parameter name="url" string="true">https://loadq.com/</｜DSML｜parameter>' +
  '</｜DSML｜invoke><｜DSML｜invoke name="minimax_web_search">' +
  '<｜DSML｜parameter name="search_terms" string="true">"loadq.com" company OR "about us" OR founder OR developer</｜DSML｜parameter>' +
  '<｜DSML｜parameter name="num_results" string="false">10</｜DSML｜parameter>' +
  "</｜DSML｜invoke></｜DSML｜tool_calls>";

Deno.test("hasDsmlToolCallMarkup: detects the live production sample", () => {
  assertEquals(hasDsmlToolCallMarkup(LIVE_SAMPLE), true);
});

Deno.test("hasDsmlToolCallMarkup: false on ordinary text / null / empty", () => {
  assertEquals(hasDsmlToolCallMarkup("Just a normal findings summary."), false);
  assertEquals(hasDsmlToolCallMarkup(""), false);
  assertEquals(hasDsmlToolCallMarkup(null), false);
  assertEquals(hasDsmlToolCallMarkup(undefined), false);
});

Deno.test("hasDsmlToolCallMarkup: also matches the plain-ASCII-pipe variant", () => {
  const ascii = LIVE_SAMPLE.replace(/｜/g, "|");
  assertEquals(hasDsmlToolCallMarkup(ascii), true);
});

Deno.test("parseDsmlToolCalls: recovers all 4 calls with correct names + args from the live sample", () => {
  const calls = parseDsmlToolCalls(LIVE_SAMPLE);
  assertEquals(calls.length, 4);
  assertEquals(calls[0], { name: "http_fingerprint", args: { url: "https://links.loadq.com" } });
  assertEquals(calls[1], {
    name: "serus_darkweb_scan",
    args: { identifier: "loadq.com", identifierType: "domain" },
  });
  assertEquals(calls[2], { name: "jina_reader_scrape", args: { url: "https://loadq.com/" } });
  assertEquals(calls[3], {
    name: "minimax_web_search",
    args: { search_terms: '"loadq.com" company OR "about us" OR founder OR developer', num_results: "10" },
  });
});

Deno.test("parseDsmlToolCalls: recovers calls even without the outer <tool_calls> wrapper (truncated stream)", () => {
  const truncated = LIVE_SAMPLE
    .replace(/^<｜DSML｜tool_calls>/, "")
    .replace(/<\/｜DSML｜tool_calls>$/, "");
  const calls = parseDsmlToolCalls(truncated);
  assertEquals(calls.length, 4);
  assertEquals(calls[0].name, "http_fingerprint");
});

Deno.test("parseDsmlToolCalls: returns [] on empty/null/no-markup input, never throws", () => {
  assertEquals(parseDsmlToolCalls(""), []);
  assertEquals(parseDsmlToolCalls(null), []);
  assertEquals(parseDsmlToolCalls("no markup here"), []);
  assertEquals(parseDsmlToolCalls("<｜DSML｜invoke name=\"x\">unterminated"), []);
});

Deno.test("parseDsmlToolCalls: decodes common XML entities in parameter values", () => {
  const sample =
    '<｜DSML｜invoke name="minimax_web_search">' +
    '<｜DSML｜parameter name="search_terms" string="true">Tom &amp; Jerry &lt;site&gt; &quot;quoted&quot;</｜DSML｜parameter>' +
    "</｜DSML｜invoke>";
  const calls = parseDsmlToolCalls(sample);
  assertEquals(calls[0].args.search_terms, 'Tom & Jerry <site> "quoted"');
});

Deno.test("stripDsmlToolCallMarkup: removes the block entirely, leaving surrounding prose intact", () => {
  const text = `Let me check a few things.\n\n${LIVE_SAMPLE}\n\nDone.`;
  const stripped = stripDsmlToolCallMarkup(text);
  assert(!hasDsmlToolCallMarkup(stripped), "no DSML tokens should remain");
  assert(stripped.includes("Let me check a few things."));
  assert(stripped.includes("Done."));
});

Deno.test("stripDsmlToolCallMarkup: a no-markup string passes through unchanged", () => {
  const text = "## Findings report\n\nConfirmed: example.com resolves to 1.2.3.4.";
  assertEquals(stripDsmlToolCallMarkup(text), text);
});
