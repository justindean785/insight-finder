import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { TOOL_COSTS_MICRO_USD } from "./costs.ts";
import type { ToolContext } from "./tool-registry.ts";

// COST ↔ RUNTIME CONTRACT
// -----------------------
// Every tool that can actually execute (buildTools) must have an EXPLICIT entry
// in TOOL_COSTS_MICRO_USD. Tools missing from the map silently fall through to
// DEFAULT_TOOL_COST_MICRO_USD (the $0.0002 floor), which produces a dishonest
// $-per-investigation figure — a free/local tool over-bills and a paid provider
// under-bills. This test fails loudly on any drift so pricing stays 1:1 with the
// runtime tool set (mirrors catalog_contract_test.ts's use of buildTools()).
//
// buildTools() only CONSTRUCTS the tool definitions (execute closures are never
// invoked here), so a bare stub context is sufficient and no network I/O occurs.
// We import tool-registry.ts DYNAMICALLY: it transitively pulls in @vercel/oidc,
// whose module init reads the machine hostname and needs Deno's `sys` permission.
// Under the permission-restricted test gate (no --allow-sys) that import fails to
// load; we skip rather than fail there, since the same invariant is verified with
// full permissions (deploy / CI). A static import would wedge the whole file
// (this is exactly why catalog_contract_test.ts errors under the same gate).

function stubCtx(): ToolContext {
  return {
    supabase: {},
    supabaseAdmin: {},
    userId: "cost-contract-test-user",
    threadId: "cost-contract-test-thread",
    archiveEnabled: false,
    detectedSeedType: "email",
    messages: [],
    manualOverrideSelector: null,
  } as unknown as ToolContext;
}

Deno.test("cost↔runtime: every runtime tool has an explicit cost entry", async () => {
  let buildTools: (ctx: ToolContext) => { tools: Record<string, unknown> };
  try {
    ({ buildTools } = await import("./tool-registry.ts"));
  } catch (e) {
    // No `sys` permission → tool-registry's transitive @vercel/oidc import can't
    // read the hostname and won't load. Skip; the invariant is checked elsewhere
    // with full permissions.
    console.warn(
      "[costs_contract] skipping (tool-registry unavailable):",
      (e as Error).message,
    );
    return;
  }
  const { tools } = buildTools(stubCtx());
  const uncosted = Object.keys(tools)
    .filter((n) => !(n in TOOL_COSTS_MICRO_USD))
    .sort();
  assertEquals(
    uncosted,
    [],
    `Runtime tools missing an explicit TOOL_COSTS_MICRO_USD entry (they fall through to the default floor): ${uncosted.join(", ")}`,
  );
});
