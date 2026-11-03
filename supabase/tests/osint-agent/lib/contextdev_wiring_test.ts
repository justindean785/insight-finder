// lib/contextdev_wiring_test.ts — the eleven checkpoints a provider touches here, pinned
// so a half-wired contextdev_* tool fails CI instead of silently never being called,
// never being billed, never being gated, or never being advertised.
//
// Source-reading assertions (tool-registry.ts, system-prompt.ts, health-handler.ts) need
// `--allow-read`; `npm run test:edge` passes it.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { costForTool } from "../../../functions/osint-agent/costs.ts";
import { capabilityEnvKeys, PROVIDER_REQUIREMENTS } from "../../../functions/osint-agent/capabilities.ts";
import { GENERAL_MULTI_ORIGIN_TOOLS, isPremiumTool, providerForTool } from "../../../functions/osint-agent/circuit.ts";
import { classifySource } from "../../../functions/osint-agent/source-classification.ts";
import { AUTO_EVIDENCE_TOOLS, toolTimeoutMs } from "../../../functions/osint-agent/cache.ts";
import { AUTO_PERSIST_TOOL_DENYLIST, ESCALATION_ELIGIBLE_TOOLS } from "../../../functions/osint-agent/auto-persist-findings.ts";
import { TOOL_CATALOG } from "../../../functions/osint-agent/catalog.ts";
import {
  CONTEXT_DEV_PEOPLE_TIMEOUT_MS,
  CONTEXT_DEV_SCRAPE_TIMEOUT_MS,
  CONTEXT_DEV_SEARCH_TIMEOUT_MS,
} from "../../../functions/osint-agent/lib/contextdev.ts";

const TOOLS = ["contextdev_web_search", "contextdev_scrape", "contextdev_people_search"] as const;
const fn = (rel: string) => Deno.readTextFileSync(new URL(`../../../functions/osint-agent/${rel}`, import.meta.url));

Deno.test("wiring: costs — each contextdev tool has its explicit micro-USD entry ($0.002/credit)", () => {
  assertEquals(costForTool("contextdev_web_search"), 2_000);
  assertEquals(costForTool("contextdev_scrape"), 2_000);
  assertEquals(costForTool("contextdev_people_search"), 20_000);
});

Deno.test("wiring: capabilities — all three require CONTEXT_DEV_API_KEY and capabilityEnvKeys() lists it", () => {
  for (const t of TOOLS) assertEquals(PROVIDER_REQUIREMENTS[t], { requiresKey: "CONTEXT_DEV_API_KEY" });
  assert(capabilityEnvKeys().includes("CONTEXT_DEV_API_KEY"));
});

Deno.test("wiring: circuit — one contextdev provider; scrape is multi-origin; people_search is premium (once per selector)", () => {
  for (const t of TOOLS) assertEquals(providerForTool(t), "contextdev");
  assert(GENERAL_MULTI_ORIGIN_TOOLS.has("contextdev_scrape"));
  assert(!GENERAL_MULTI_ORIGIN_TOOLS.has("contextdev_web_search"));
  assert(isPremiumTool("contextdev_people_search"));
  assert(!isPremiumTool("contextdev_web_search"));
  assert(!isPremiumTool("contextdev_scrape"));
});

Deno.test("wiring: source classes — search is ai_summary, scrape is independent_public (page fetch), people is data_broker", () => {
  assertEquals(classifySource("contextdev_web_search"), "ai_summary");
  assertEquals(classifySource("contextdev_scrape"), "independent_public");
  assertEquals(classifySource("contextdev_people_search"), "data_broker");
  const src = fn("source-classification.ts");
  const block = src.slice(src.indexOf("const PAGE_FETCH_TOOLS"), src.indexOf("]);", src.indexOf("const PAGE_FETCH_TOOLS")));
  assertStringIncludes(block, '"contextdev_scrape"');
});

Deno.test("wiring: timeouts — each wrapper cap sits above the module's own fetch budget", () => {
  assert(toolTimeoutMs("contextdev_web_search") > CONTEXT_DEV_SEARCH_TIMEOUT_MS);
  assert(toolTimeoutMs("contextdev_scrape") > CONTEXT_DEV_SCRAPE_TIMEOUT_MS);
  assert(toolTimeoutMs("contextdev_people_search") > CONTEXT_DEV_PEOPLE_TIMEOUT_MS);
});

// Parity with jina_reader_scrape. NOTE (measured 2026-11-03): autoAppendToolEvidence keys
// on extractEvidenceSeed(input), whose key list has no `url`, so for BOTH url-only readers
// the custody mirror is currently inert. The one-line `url` fix touches chain-of-custody
// (integrity-critical, sign-off required) and ships as its own PR; this entry makes
// contextdev_scrape start logging the moment that fix lands.
Deno.test("wiring: scrape is listed in AUTO_EVIDENCE_TOOLS for parity with jina_reader_scrape", () => {
  assert(AUTO_EVIDENCE_TOOLS.has("contextdev_scrape"));
  assert(AUTO_EVIDENCE_TOOLS.has("jina_reader_scrape"));
});

Deno.test("wiring: all three are auto-persist denylisted AND escalation-eligible (same class as exa_search / jina_reader_scrape)", () => {
  for (const t of TOOLS) {
    assert(AUTO_PERSIST_TOOL_DENYLIST.has(t), `${t} must not auto-persist blindly`);
    assert(ESCALATION_ELIGIBLE_TOOLS.has(t), `${t} must keep the zero-evidence durability path`);
  }
});

Deno.test("wiring: catalog advertises all three, names the cheaper tool first, and the input shapes match the schemas", () => {
  const byName = new Map(TOOL_CATALOG.tools.map((t) => [t.name, t]));
  for (const t of TOOLS) assert(byName.has(t), `${t} missing from TOOL_CATALOG`);
  const search = byName.get("contextdev_web_search")!;
  assertStringIncludes(search.when_to_use, "exa_search");
  assertStringIncludes(search.input, "numResults");
  const scrape = byName.get("contextdev_scrape")!;
  assertStringIncludes(scrape.when_to_use, "jina_reader_scrape");
  assertStringIncludes(scrape.input, "fresh");
  const people = byName.get("contextdev_people_search")!;
  assertStringIncludes(people.when_to_use, "ONE page");
  assertStringIncludes(people.description, "10 credits");
  assertEquals(people.input.includes("cursor"), false);
});

Deno.test("wiring: tool-registry has the inline defs, the key gate, the planner entries and the per-request seen set", () => {
  const src = fn("tool-registry.ts");
  for (const t of TOOLS) assert(new RegExp(`^\\s{2,}${t}: tool\\(\\{`, "m").test(src), `${t} inline def missing`);
  assertStringIncludes(src, 'from "./lib/contextdev.ts"');
  assertStringIncludes(src, "const contextdevSeenUrls = new Set<string>()");
  // key-absent / kill-switch gate removes the tools from the schema and the planner menu
  assertStringIncludes(src, "!CONTEXT_DEV_API_KEY || contextdevKillSwitchOn()");
  assertStringIncludes(src, 'name.startsWith("contextdev_")');
  const listStart = src.indexOf("const baseToolList = [");
  const listEnd = src.indexOf("];", listStart);
  const list = src.slice(listStart, listEnd);
  for (const t of TOOLS) assertStringIncludes(list, `"${t}"`);
});

Deno.test("wiring: the people_search schema has no cursor and no mode; the search schema caps numResults at 10", () => {
  const src = fn("tool-registry.ts");
  const at = src.indexOf("contextdev_people_search: tool({");
  const body = src.slice(at, src.indexOf("}),", src.indexOf("execute:", at)));
  assertEquals(/cursor/.test(body), false);
  assertEquals(/mode:/.test(body), false);
  const sAt = src.indexOf("contextdev_web_search: tool({");
  const sBody = src.slice(sAt, src.indexOf("execute:", sAt));
  assertStringIncludes(sBody, ".max(10)");
});

// ── Task 4: system prompt routing bullets + /health proof key ───────────────

Deno.test("wiring: system prompt carries one routing bullet per tool, prefer-free-first, one-page cap and the overlap guard", () => {
  const src = fn("system-prompt.ts");
  for (const t of TOOLS) assertStringIncludes(src, t);
  assertStringIncludes(src, "PREFER FREE FIRST");
  assertStringIncludes(src, "ONE page per call");
  assertStringIncludes(src, "never merge authority");
  assertStringIncludes(src, "deduped: N");
});

Deno.test("wiring: health-handler counts the provider and exposes checks.contextdev from the pure self-test", () => {
  const src = fn("health-handler.ts");
  assertStringIncludes(src, "contextdev: has(env.CONTEXT_DEV_API_KEY)");
  assertStringIncludes(src, "r.checks.contextdev = contextdevSelfTest(");
});
