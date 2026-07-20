import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { z } from "npm:zod@3";
import {
  hasDsmlToolCallMarkup,
  parseDsmlToolCalls,
  stripDsmlToolCallMarkup,
  coerceDsmlArgsForValidation,
  resolveDsmlExecutionPlan,
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

// Double-separator variant observed in production (fingerprint.to investigation,
// 2026-07-20): DeepSeek emits ｜｜DSML｜｜ instead of ｜DSML｜.
const DOUBLE_SEP_SAMPLE =
  '<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="record_artifacts">' +
  '<｜｜DSML｜｜parameter name="artifacts" string="false">[{"kind":"domain","value":"fingerprint.to"}]</｜｜DSML｜｜parameter>' +
  '</｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>';

Deno.test("hasDsmlToolCallMarkup: detects double-separator ｜｜DSML｜｜ variant", () => {
  assertEquals(hasDsmlToolCallMarkup(DOUBLE_SEP_SAMPLE), true);
});

Deno.test("parseDsmlToolCalls: recovers calls from double-separator ｜｜DSML｜｜ variant", () => {
  const calls = parseDsmlToolCalls(DOUBLE_SEP_SAMPLE);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].name, "record_artifacts");
  assertEquals(calls[0].args.artifacts, '[{"kind":"domain","value":"fingerprint.to"}]');
});

Deno.test("stripDsmlToolCallMarkup: strips double-separator variant cleanly", () => {
  const text = `Findings below.\n\n${DOUBLE_SEP_SAMPLE}\n\nEnd.`;
  const stripped = stripDsmlToolCallMarkup(text);
  assert(!hasDsmlToolCallMarkup(stripped), "no DSML tokens should remain");
  assert(stripped.includes("Findings below."));
  assert(stripped.includes("End."));
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

Deno.test("coerceDsmlArgsForValidation: numeric/boolean-looking strings become real types", () => {
  const coerced = coerceDsmlArgsForValidation({ num_results: "10", verbose: "true", ratio: "1.5" });
  assertEquals(coerced, { num_results: 10, verbose: true, ratio: 1.5 });
});

Deno.test("coerceDsmlArgsForValidation: free-text values (URLs, search terms, quoted strings) are left as strings", () => {
  const coerced = coerceDsmlArgsForValidation({
    url: "https://loadq.com/",
    search_terms: '"loadq.com" company OR founder',
  });
  assertEquals(coerced, {
    url: "https://loadq.com/",
    search_terms: '"loadq.com" company OR founder',
  });
});

Deno.test("coerceDsmlArgsForValidation: null and empty string are handled without throwing", () => {
  const coerced = coerceDsmlArgsForValidation({ a: "null", b: "" });
  assertEquals(coerced.a, null);
  assertEquals(coerced.b, ""); // "" is not valid JSON — stays a string
});

// ---- resolveDsmlExecutionPlan — the three security-review guards -----------

const GOOGLE_DORKS = { execute: () => Promise.resolve({ ok: true }), inputSchema: z.object({ seed: z.string(), kind: z.string() }) };
const MINIMAX_SEARCH = { execute: () => Promise.resolve({ ok: true }), inputSchema: z.object({ search_terms: z.string(), num_results: z.number() }) };
const RECORD_ARTIFACTS = { execute: () => Promise.resolve({ ok: true }), inputSchema: z.object({ artifacts: z.array(z.unknown()) }) };
const TOOLS = { google_dorks: GOOGLE_DORKS, minimax_web_search: MINIMAX_SEARCH, record_artifacts: RECORD_ARTIFACTS };

Deno.test("resolveDsmlExecutionPlan guard 1: rejects a call NOT in the permitted set (finalize-phase bypass)", () => {
  // Simulates: DSML leaks during the finalize/persist phase, where only
  // record_artifacts/finalize_no_findings are permitted — google_dorks must
  // be rejected even though it's a real, registered tool.
  const permitted = new Set(["record_artifacts", "finalize_no_findings"]);
  const plan = resolveDsmlExecutionPlan([{ name: "google_dorks", args: { seed: "x", kind: "domain" } }], permitted, TOOLS);
  assertEquals(plan[0].action, "reject");
  assertEquals((plan[0] as { reason: string }).reason, "not permitted in current phase");
});

Deno.test("resolveDsmlExecutionPlan guard 2: rejects a name not in the tool registry", () => {
  const permitted = new Set(["google_dorks", "dork_harvest"]); // dork_harvest permitted but NOT registered
  const plan = resolveDsmlExecutionPlan([{ name: "dork_harvest", args: {} }], permitted, TOOLS);
  assertEquals(plan[0].action, "reject");
  assertEquals((plan[0] as { reason: string }).reason, "unknown tool");
});

Deno.test("resolveDsmlExecutionPlan guard 3: validates against the REAL schema — wrong type is rejected, not silently passed", () => {
  const permitted = new Set(["minimax_web_search"]);
  // search_terms present, num_results MISSING entirely — genuinely invalid, no coercion can fix it.
  const plan = resolveDsmlExecutionPlan(
    [{ name: "minimax_web_search", args: { search_terms: "loadq.com" } }],
    permitted, TOOLS,
  );
  assertEquals(plan[0].action, "reject");
  assertEquals((plan[0] as { reason: string }).reason, "schema validation failed");
});

Deno.test("resolveDsmlExecutionPlan guard 3: a numeric field arriving as DSML text is coerced and VALIDATED, not blindly trusted", () => {
  const permitted = new Set(["minimax_web_search"]);
  const plan = resolveDsmlExecutionPlan(
    [{ name: "minimax_web_search", args: { search_terms: "loadq.com", num_results: "10" } }],
    permitted, TOOLS,
  );
  assertEquals(plan[0].action, "execute");
  assertEquals((plan[0] as { validatedArgs: unknown }).validatedArgs, { search_terms: "loadq.com", num_results: 10 });
});

Deno.test("resolveDsmlExecutionPlan: a fully valid, permitted, registered call executes with schema-validated args", () => {
  const permitted = new Set(["google_dorks"]);
  const plan = resolveDsmlExecutionPlan(
    [{ name: "google_dorks", args: { seed: "loadq.com", kind: "domain" } }],
    permitted, TOOLS,
  );
  assertEquals(plan[0].action, "execute");
  assertEquals((plan[0] as { validatedArgs: unknown }).validatedArgs, { seed: "loadq.com", kind: "domain" });
});

Deno.test("resolveDsmlExecutionPlan: mixed batch — each call judged independently, one bad call doesn't block good ones", () => {
  const permitted = new Set(["google_dorks", "minimax_web_search"]);
  const plan = resolveDsmlExecutionPlan(
    [
      { name: "google_dorks", args: { seed: "loadq.com", kind: "domain" } }, // valid
      { name: "dork_harvest", args: {} }, // not registered
      { name: "minimax_web_search", args: { search_terms: "x" } }, // missing num_results
    ],
    permitted, TOOLS,
  );
  assertEquals(plan.map((p) => p.action), ["execute", "reject", "reject"]);
});
