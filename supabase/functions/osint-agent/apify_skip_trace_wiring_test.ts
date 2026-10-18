// apify_skip_trace_wiring_test.ts — the Apify skip-trace tool is wired at every
// boundary a paid, key-gated provider needs (lib/apify-skip-trace.ts is the client;
// this pins the call sites). Source-level on purpose: the defect class here is a
// tool present in one table and absent from another.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { PROVIDER_REQUIREMENTS } from "./capabilities.ts";
import { TOOL_COSTS_MICRO_USD } from "./costs.ts";
import { isPremiumTool } from "./circuit.ts";
import { toolTimeoutMs } from "./cache.ts";
import { classifySource } from "./source-classification.ts";
import { TOOL_CATALOG } from "./catalog.ts";
import { APIFY_SKIP_TRACE_CLIENT_TIMEOUT_MS, APIFY_SKIP_TRACE_RUN_TIMEOUT_S } from "./lib/apify-skip-trace.ts";

const REGISTRY = await Deno.readTextFile(new URL("./tool-registry.ts", import.meta.url));
const HEALTH = await Deno.readTextFile(new URL("./health-handler.ts", import.meta.url));
const PERSIST = await Deno.readTextFile(new URL("./auto-persist-findings.ts", import.meta.url));

Deno.test("apify wiring: the live registry defines apify_skip_trace and gates it on the key + kill switch", () => {
  assertStringIncludes(REGISTRY, "apify_skip_trace: tool({");
  assertStringIncludes(REGISTRY, "if (!APIFY_API_KEY || apifySkipTraceKillSwitchOn())");
  assertStringIncludes(REGISTRY, "apifySkipTraceDepsFromEnv(");
  assertEquals(PROVIDER_REQUIREMENTS.apify_skip_trace?.requiresKey, "APIFY_API_KEY");
});

Deno.test("apify wiring: catalog entry exists and tells the model it is paid per row, one query per call", () => {
  const entry = TOOL_CATALOG.tools.find((t) => t.name === "apify_skip_trace");
  assert(entry, "catalog entry");
  assert(/PAID/.test(entry.description), "paid");
  assert(/one query entry per call/i.test(entry.description), "one query per call");
  assert(/never identity proof/i.test(entry.when_to_use), "leads, not proof");
});

Deno.test("apify wiring: costed, premium (once per entity), classed data_broker, and its wrapper cap clears the run bound", () => {
  assertEquals(TOOL_COSTS_MICRO_USD.apify_skip_trace, 7_000);
  assertEquals(isPremiumTool("apify_skip_trace"), true);
  assertEquals(classifySource("apify_skip_trace"), "data_broker");
  assertEquals(classifySource("apify:one-api/skip-trace"), "data_broker");
  assert(toolTimeoutMs("apify_skip_trace") > APIFY_SKIP_TRACE_CLIENT_TIMEOUT_MS, "wrapper cap must exceed the client bound");
  assert(APIFY_SKIP_TRACE_CLIENT_TIMEOUT_MS > APIFY_SKIP_TRACE_RUN_TIMEOUT_S * 1000, "client bound must exceed Apify's own bound");
});

Deno.test("apify wiring: /health lists the key in the tools presence line and carries the proof key", () => {
  assertStringIncludes(HEALTH, "apify: has(env.APIFY_API_KEY)");
  assertStringIncludes(HEALTH, "r.checks.apify_skip_trace = apifySkipTraceHealthDetail(");
  assert(!/APIFY_API_KEY\s*[:=]\s*`|console\.log\([^)]*APIFY_API_KEY/.test(HEALTH), "never logs the key");
});

Deno.test("apify wiring: auto-persist extracts leads from rows and skips fallback rows", () => {
  const i = PERSIST.indexOf('if (toolName === "apify_skip_trace")');
  assert(i > 0, "extractor block");
  const block = PERSIST.slice(i, i + 1_800);
  assertStringIncludes(block, 'if (r.name_match === "fallback") continue;');
  assert(!/relatives_count|associates_count|Relatives|Associates/.test(block.replace(/\/\/.*$/gm, "")), "third parties never persisted");
});
