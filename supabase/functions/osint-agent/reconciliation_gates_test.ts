// Reconciliation gate tests (mirror↔canonical Path A).
// One file, one gate per JD's required-test list. These assert the merged
// behavior holds after grafting the mirror-only production fixes onto canonical.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { TOOL_CATALOG } from "./catalog.ts";
import { classifySource } from "./source-classification.ts";
import { isPremiumTool, markProviderInFlight, clearProviderInFlight } from "./circuit.ts";
import { PROVIDER_REQUIREMENTS } from "./capabilities.ts";
import { TOOL_COSTS_MICRO_USD } from "./costs.ts";
import { TIER_B } from "./tiers.ts";
import { shouldSkipForFinalizeWindow, shouldSkipForToolCap, FINALIZE_RESERVE_MS } from "./orchestrator-finalize.ts";
import { ORCHESTRATOR_WALL_CLOCK_MS, MAX_TOOL_CALLS_PER_RUN } from "./orchestrator-budget.ts";
import { selectFallbackProvider } from "./orchestrator_select.ts";
import { minimaxChatWithFallback } from "./providers.ts";
import { handleHealthProbe } from "./health-handler.ts";

// ---- GATE 1: PDL smoke — catalog → registry → cost/tier/capability → class ----
// (catalog↔runtime-registry parity is additionally enforced by catalog_contract_test.ts,
//  which asserts every catalog entry has a runtime def; live execution needs a keyed
//  integration test — PEOPLEDATALABS_API_KEY — out of scope for a unit run.)
Deno.test("GATE1 PDL smoke: pdl_person_enrich fully wired across every layer", () => {
  assert(TOOL_CATALOG.tools.some((t) => t.name === "pdl_person_enrich"), "in catalog");
  assertEquals(classifySource("pdl_person_enrich"), "breach", "classed 'breach' (LEAD, never Confirmed alone)");
  assert(isPremiumTool("pdl_person_enrich"), "premium tool");
  assertEquals(TOOL_COSTS_MICRO_USD["pdl_person_enrich"], 50000, "cost entry");
  assert(TIER_B.includes("pdl_person_enrich"), "in TIER_B");
  assertEquals(PROVIDER_REQUIREMENTS["pdl_person_enrich"]?.requiresKey, "PEOPLEDATALABS_API_KEY", "gated on PDL key");
});

// ---- GATE 2: fallback architecture (kept canonical's gated-Lovable design) ----
Deno.test("GATE2 fallback: direct Gemini is attempted normally", () => {
  assertEquals(selectFallbackProvider({ gemini: true, lovable: true, allowLovable: false }).provider, "gemini");
});
Deno.test("GATE2 fallback: Lovable is unreachable when the gate is absent/false", () => {
  const c = selectFallbackProvider({ gemini: false, lovable: true, allowLovable: false });
  assertEquals(c.provider, null);
  assert(/ALLOW_LOVABLE_FALLBACK/.test(c.reason), "reason names the gate");
});
Deno.test("GATE2 fallback: Lovable is reachable ONLY when explicitly enabled", () => {
  assertEquals(selectFallbackProvider({ gemini: false, lovable: true, allowLovable: true }).provider, "lovable");
});
Deno.test("GATE2 fallback: an externally-aborted call does not cascade to a fallback LLM", async () => {
  const ac = new AbortController();
  ac.abort();
  // Caller's signal already aborted → the providers.ts guard must NOT fire an
  // off-ledger fallback. Either usedFallback:false (status branch) or re-throw
  // (catch branch) — never a fallback result.
  try {
    const r = await minimaxChatWithFallback(
      { system: "x", user: "y", signal: ac.signal },
      { gemini: true, lovable: true, allowLovable: true },
    );
    assert(r.usedFallback !== true, "aborted call must not cascade to a fallback");
  } catch (_) {
    // aborted → re-throw is the documented no-fallback path; acceptable.
  }
});

// ---- GATE 3: canonical in-flight gating survives the PDL graft ----
// (Deep proof of the gate is circuit_inflight_test.ts, unchanged. Here: the graft
//  was additive — PREMIUM_TOOLS gained PDL without dropping the in-flight-gated set,
//  and mark/clearProviderInFlight remain exported and callable.)
Deno.test("GATE3 in-flight gating intact after PDL graft", () => {
  assert(isPremiumTool("pdl_person_enrich"), "PDL added to PREMIUM_TOOLS");
  assert(isPremiumTool("oathnet_lookup"), "pre-existing premium tool preserved");
  assertEquals(typeof markProviderInFlight, "function");
  assertEquals(typeof clearProviderInFlight, "function");
  markProviderInFlight("gate3-thread", "oathnet_lookup");
  clearProviderInFlight("gate3-thread", "oathnet_lookup"); // must not throw
});

// ---- GATE 4: finalize-window — no new live lookup during forced persistence ----
Deno.test("GATE4 finalize-window: live lookups skipped once reserve opens, recorders exempt", () => {
  const openAt = ORCHESTRATOR_WALL_CLOCK_MS - FINALIZE_RESERVE_MS;
  assertEquals(shouldSkipForFinalizeWindow(openAt - 1, false), false, "before reserve: lookup may run");
  assertEquals(shouldSkipForFinalizeWindow(openAt, false), true, "reserve open: live lookup skipped");
  assertEquals(shouldSkipForFinalizeWindow(openAt + 30_000, true), false, "recording tool still runs during finalize");
});

// ---- GATE 5: the 36-call cap cannot bypass final artifact persistence ----
Deno.test("GATE5 tool-cap cannot starve record_artifacts (ALWAYS_ALLOW exempt)", () => {
  assertEquals(shouldSkipForToolCap(MAX_TOOL_CALLS_PER_RUN + 50, true), false, "recorder runs far past the cap");
  assertEquals(shouldSkipForToolCap(MAX_TOOL_CALLS_PER_RUN, false), true, "a live lookup at the cap is skipped");
});

// ---- GATE 6: health emits provider fields AND build SHA together ----
Deno.test("GATE6 health: selected_provider + orchestrator_reason + build SHA emitted together", async () => {
  const req = new Request("https://example.com/osint-agent?health=1", { method: "GET" });
  const res = await handleHealthProbe(req);
  const body = await res.json();
  assert(typeof body.build === "string" && body.build.length > 0, "build SHA present");
  assert("selected_provider" in body, "selected_provider present");
  assert("orchestrator_reason" in body, "orchestrator_reason present");
});
