import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildTools, type ToolContext } from "./tool-registry.ts";
import { TOOL_CATALOG } from "./catalog.ts";

// CATALOG ↔ RUNTIME CONTRACT
// --------------------------
// The orchestrator's tool awareness comes from TOOL_CATALOG (catalog.ts):
// list_tools and the system prompt advertise exactly those names/descriptions.
// The tools that actually execute come from buildTools() (tool-registry.ts).
// If the two drift, the model is told about a tool that cannot run, or a tool
// runs that the model was never told how/when to use. Either way the agent
// degrades silently. These tests fail loudly on any drift so the catalog and
// runtime registry stay 1:1.
//
// buildTools() only CONSTRUCTS the tool definitions (the execute closures are
// not invoked here), so a stub context is sufficient and no network I/O occurs.

function stubCtx(): ToolContext {
  // buildTools() only CONSTRUCTS tool definitions here; the supabase clients
  // are captured by execute() closures that are never invoked, so a bare stub
  // is sufficient. Avoiding a real createClient() also keeps the supabase-js
  // GoTrue refresh interval (a test leak) out of the picture entirely.
  return {
    supabase: {},
    supabaseAdmin: {},
    userId: "contract-test-user",
    threadId: "contract-test-thread",
    archiveEnabled: false,
    detectedSeedType: "email",
    messages: [],
    manualOverrideSelector: null,
  } as unknown as ToolContext;
}

function runtimeToolNames(): Set<string> {
  const { tools } = buildTools(stubCtx());
  return new Set(Object.keys(tools));
}

function catalogToolNames(): string[] {
  return TOOL_CATALOG.tools.map((t) => t.name);
}

Deno.test("catalog↔runtime: catalog has no duplicate tool names", () => {
  const names = catalogToolNames();
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  assertEquals(dupes, [], `TOOL_CATALOG has duplicate names: ${dupes.join(", ")}`);
});

Deno.test("catalog↔runtime: every catalog entry has a runtime tool that executes it", () => {
  const runtime = runtimeToolNames();
  const orphanCatalog = catalogToolNames().filter((n) => !runtime.has(n)).sort();
  assertEquals(
    orphanCatalog,
    [],
    `Catalog advertises tools with no runtime implementation: ${orphanCatalog.join(", ")}`,
  );
});

Deno.test("catalog↔runtime: every runtime tool is advertised in the catalog", () => {
  const catalog = new Set(catalogToolNames());
  const uncatalogued = [...runtimeToolNames()].filter((n) => !catalog.has(n)).sort();
  assertEquals(
    uncatalogued,
    [],
    `Runtime tools missing from TOOL_CATALOG (model can't discover them): ${uncatalogued.join(", ")}`,
  );
});

Deno.test("catalog↔runtime: catalog and runtime tool sets are identical in size", () => {
  const runtime = runtimeToolNames();
  const catalog = new Set(catalogToolNames());
  assertEquals(
    runtime.size,
    catalog.size,
    `runtime tools (${runtime.size}) != catalog tools (${catalog.size})`,
  );
});

Deno.test("catalog↔runtime: every catalog entry is fully described", () => {
  // A catalogued tool with empty name/description/when_to_use/input gives the
  // model no basis to select it. Guard against half-filled entries.
  const incomplete: string[] = [];
  for (const t of TOOL_CATALOG.tools) {
    const ok = typeof t.name === "string" && t.name.length > 0 &&
      typeof t.description === "string" && t.description.trim().length > 0 &&
      typeof t.when_to_use === "string" && t.when_to_use.trim().length > 0 &&
      typeof t.input === "string" && t.input.trim().length > 0;
    if (!ok) incomplete.push(t.name || "(unnamed)");
  }
  assertEquals(incomplete, [], `Catalog entries missing required fields: ${incomplete.join(", ")}`);
});
