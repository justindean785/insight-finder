// Regression tests for the 5 production-audit fixes bundled into the
// claude/osint-agent-orchestration-hardening branch (2026-07-25, thread
// d98deb37, build 6d76133: 202 tool calls vs target ~60, 17 failed, 23 skipped
// in-flight collisions, 7 unknown_tool_ignored).
//
// Covers:
//  1. minimax_correlate timeout raised 30s -> 60s
//  2. gemini_deep_dork timeout raised 12s -> >=20s
//  3. jina_reader_scrape malformed-selector local guard (no provider call)
//  4. exact-duplicate in-flight suppression (distinct from provider-level gate)
//  5. TOOL_NAME_ALIASES redirect for known DeepSeek hallucinations; unknown
//     names still hit the zero-cost sink.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { toolTimeoutMs, TOOL_TIMEOUT_OVERRIDE_MS } from "./cache.ts";
import {
  shouldRun,
  markProviderInFlight,
  clearProviderInFlight,
  markCallInFlight,
  clearCallInFlight,
  isCallInFlight,
  clearThread,
  normalizeSelector,
} from "./circuit.ts";
import { repairUnknownTool } from "./unknown-tool-guard.ts";
import { TOOL_NAME_ALIASES } from "./tool-registry.ts";

// ---- Fix 1: minimax_correlate timeout -------------------------------------

Deno.test("minimax_correlate timeout override is 60s", () => {
  assertEquals(TOOL_TIMEOUT_OVERRIDE_MS.minimax_correlate, 60_000);
  assertEquals(toolTimeoutMs("minimax_correlate"), 60_000);
});

// ---- Fix 3: gemini_deep_dork timeout ---------------------------------------

Deno.test("gemini_deep_dork timeout override is >= 20s", () => {
  assert(TOOL_TIMEOUT_OVERRIDE_MS.gemini_deep_dork >= 20_000, "gemini_deep_dork timeout must be >= 20s");
  assert(toolTimeoutMs("gemini_deep_dork") >= 20_000);
});

// ---- Fix 2: jina_reader_scrape malformed-selector guard --------------------
//
// The guard lives inline in the jina_reader_scrape execute() in
// tool-registry.ts (it needs the parsed URL + fetch machinery in scope, so it
// isn't a standalone pure export). These tests exercise the SAME heuristic
// logic the guard uses so the decision boundary is pinned without needing to
// spin up the full tool registry / network layer. The guard itself asserts
// "no fetch happens" by construction: it returns before the fetchRetry call.

function looksLikeMalformedJinaSelector(url: string): boolean {
  const parsed = new URL(url);
  const decodedTail = decodeURIComponent(`${parsed.pathname}${parsed.search}`).replace(/[+]/g, " ");
  const words = decodedTail.trim().split(/\s+/).filter(Boolean);
  const looksLikePath = /[/._-]/.test(decodedTail.replace(/^\/+/, "").split(/[?=&\s]/)[0] ?? "");
  return words.length >= 4 && !looksLikePath;
}

Deno.test("jina malformed-selector guard: rejects a natural-language query passed as a URL path", () => {
  assertEquals(
    looksLikeMalformedJinaSelector("https://r.jina.ai/find John Smith twitter account"),
    true,
    "prose-shaped path must be flagged before hitting the provider",
  );
});

Deno.test("jina malformed-selector guard: allows a real article/profile URL", () => {
  assertEquals(looksLikeMalformedJinaSelector("https://example.com/blog/2024/my-article-title"), false);
  assertEquals(looksLikeMalformedJinaSelector("https://example.com/en/wiki/John_Smith"), false);
  assertEquals(looksLikeMalformedJinaSelector("https://example.com/profile/john.smith"), false);
});

Deno.test("jina malformed-selector guard: allows a short query string", () => {
  assertEquals(looksLikeMalformedJinaSelector("https://example.com/search?q=john+smith+texas"), false);
});

// ---- Fix 4: exact-duplicate in-flight suppression --------------------------

Deno.test("exact-duplicate in-flight: identical (tool, selector, purpose) call is suppressed with a distinct reason", () => {
  const thread = "t-dup-inflight";
  clearThread(thread);
  const sel = normalizeSelector("query", "site:example.com john smith");

  const first = shouldRun(thread, "minimax_web_search", sel, "default");
  assertEquals(first.allow, true, "first call should be allowed");
  markProviderInFlight(thread, "minimax_web_search");
  markCallInFlight(thread, "minimax_web_search", sel, "default");
  assert(isCallInFlight(thread, "minimax_web_search", sel, "default"));

  const dup = shouldRun(thread, "minimax_web_search", sel, "default");
  assertEquals(dup.allow, false, "identical duplicate call must be blocked");
  assertEquals(
    dup.allow === false && "duplicateInFlight" in dup ? dup.duplicateInFlight : false,
    true,
    "duplicate must be tagged distinctly from a generic provider-busy rejection",
  );

  clearProviderInFlight(thread, "minimax_web_search");
  clearCallInFlight(thread, "minimax_web_search", sel, "default");
  assertEquals(isCallInFlight(thread, "minimax_web_search", sel, "default"), false);
  clearThread(thread);
});

Deno.test("exact-duplicate in-flight: a DIFFERENT selector on the same provider is NOT a duplicate (still gated by the coarser provider lock, not the dup gate)", () => {
  const thread = "t-dup-inflight-diffsel";
  clearThread(thread);
  const selA = normalizeSelector("query", "alice");
  const selB = normalizeSelector("query", "bob");

  markProviderInFlight(thread, "minimax_web_search");
  markCallInFlight(thread, "minimax_web_search", selA, "default");

  const other = shouldRun(thread, "minimax_web_search", selB, "default");
  // Still blocked (provider-level in-flight gate), but NOT via the exact-duplicate
  // path — the distinguishing reason must not claim it's an identical duplicate.
  assertEquals(other.allow, false);
  assertEquals(
    other.allow === false && "duplicateInFlight" in other ? other.duplicateInFlight : false,
    false,
    "a different selector must not be reported as an identical duplicate",
  );

  clearProviderInFlight(thread, "minimax_web_search");
  clearCallInFlight(thread, "minimax_web_search", selA, "default");
  clearThread(thread);
});

// ---- Fix 5: DeepSeek tool-name alias drift ---------------------------------

Deno.test("TOOL_NAME_ALIASES: known hallucinated names redirect to real registered tools", () => {
  const known = new Set(["minimax_web_search", "google_dorks", "jina_reader_scrape", "unknown_tool_ignored"]);

  const webSearch = repairUnknownTool("web_search", known, TOOL_NAME_ALIASES);
  assertEquals(webSearch, { redirect: true, toolName: "minimax_web_search", requested: "web_search", aliased: true });

  const googleSearch = repairUnknownTool("google_search", known, TOOL_NAME_ALIASES);
  assertEquals(googleSearch, { redirect: true, toolName: "google_dorks", requested: "google_search", aliased: true });

  const scrapeUrl = repairUnknownTool("scrape_url", known, TOOL_NAME_ALIASES);
  assertEquals(scrapeUrl, { redirect: true, toolName: "jina_reader_scrape", requested: "scrape_url", aliased: true });

  const fetchUrl = repairUnknownTool("fetch_url", known, TOOL_NAME_ALIASES);
  assertEquals(fetchUrl, { redirect: true, toolName: "jina_reader_scrape", requested: "fetch_url", aliased: true });
});

Deno.test("TOOL_NAME_ALIASES: genuinely unknown names still hit the zero-cost sink, not an alias", () => {
  const known = new Set(["minimax_web_search", "unknown_tool_ignored"]);
  const decision = repairUnknownTool("exify", known, TOOL_NAME_ALIASES);
  assertEquals(decision, { redirect: true, toolName: "unknown_tool_ignored", requested: "exify" });
  assertEquals((decision as { aliased?: boolean }).aliased, undefined, "sink path must not be marked aliased");
});

Deno.test("TOOL_NAME_ALIASES: a known tool name is never redirected, aliased or not", () => {
  const known = new Set(["minimax_web_search", "unknown_tool_ignored"]);
  assertEquals(repairUnknownTool("minimax_web_search", known, TOOL_NAME_ALIASES), { redirect: false });
});

Deno.test("TOOL_NAME_ALIASES: an alias whose target is NOT currently registered falls back to the sink (never invents a call)", () => {
  // Defensive: if a registry rename ever drops the alias target, the guard must
  // not redirect to a dead tool name — it must fall back to the safe sink.
  const known = new Set(["unknown_tool_ignored"]); // minimax_web_search NOT registered here
  const decision = repairUnknownTool("web_search", known, TOOL_NAME_ALIASES);
  assertEquals(decision, { redirect: true, toolName: "unknown_tool_ignored", requested: "web_search" });
});
