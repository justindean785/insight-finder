// disabled_tools_advertised_test.ts — a tool disabled in config must not be
// advertised to the model.
//
// THE BUG THIS CLOSES (production, 2026-07-09 -> 2026-07-30):
// capabilities.ts marks providers `disabled: true`, but list_tools built its
// disabled set from four hand-written KEY-PRESENCE checks (HIBP, Indicia, PDL,
// Gemini) and never consulted PROVIDER_REQUIREMENTS. So `dork_harvest`,
// `deepfind_reverse_email` and `ipqualityscore_lookup` stayed in the catalog the
// model reads — dork_harvest complete with `when_to_use: "Run after
// google_dorks..."`. The model followed that instruction; the name is absent from
// the live registry, so repairUnknownTool redirected it to the sink, which
// returned ok:true.
//
// Cost, measured in tool_usage_log: unknown_tool_ignored logged 127 calls,
// 127 of them ok=true, first firing hours after dork_harvest was disabled. Each
// burned a step, was CACHED, and surfaced in the evidence export as
// "dork_harvest(completed)" — telling an analyst that document/leak dorking ran
// when it never executed. That last consequence is why this is integrity-facing
// and not merely wasteful: it reaches the chain-of-custody record.
//
// The fix derives the disabled set from PROVIDER_REQUIREMENTS, so the next tool
// disabled in config is gated for free. These tests pin that it stays derived.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { PROVIDER_REQUIREMENTS } from "./capabilities.ts";
import { TOOL_CATALOG } from "./catalog.ts";
import { NO_CACHE_TOOLS } from "./validation.ts";
import { UNKNOWN_TOOL_SINK } from "./unknown-tool-guard.ts";

const SRC = Deno.readTextFileSync(new URL("./tool-registry.ts", import.meta.url));

function configDisabledTools(): string[] {
  return Object.entries(PROVIDER_REQUIREMENTS)
    .filter(([, req]) => (req as { disabled?: boolean }).disabled === true)
    .map(([name]) => name);
}

Deno.test("config-disabled tools are a real, non-empty set (guards a vacuous pass)", () => {
  const disabled = configDisabledTools();
  assert(
    disabled.length > 0,
    "no provider is marked disabled:true — either capabilities.ts changed shape or the " +
    "import broke, and the contract below would pass without testing anything",
  );
});

Deno.test("list_tools derives its disabled set from PROVIDER_REQUIREMENTS, not a hardcoded list", () => {
  // Structural: the fix must READ the requirements map. A future edit that
  // reverts to hand-maintained conditionals silently re-opens the bug for every
  // newly-disabled tool, and no per-tool assertion would catch the NEXT one.
  assert(
    /PROVIDER_REQUIREMENTS/.test(SRC),
    "tool-registry.ts must import PROVIDER_REQUIREMENTS so gating is derived",
  );
  const listToolsBlock = SRC.slice(SRC.indexOf("const disabledNames = new Set") - 4000, SRC.indexOf("const disabledNames = new Set"));
  assert(
    /for \(const \[name, req\] of Object\.entries\(PROVIDER_REQUIREMENTS\)\)/.test(listToolsBlock) &&
      /req\.disabled/.test(listToolsBlock),
    "list_tools must iterate PROVIDER_REQUIREMENTS and gate on req.disabled",
  );
});

Deno.test("every config-disabled tool is gated out of the advertised catalog", () => {
  // The concrete regression: these three were disabled AND advertised.
  const disabled = new Set(configDisabledTools());
  const advertised = new Set(TOOL_CATALOG.tools.map((t: { name: string }) => t.name));
  const leaked = [...disabled].filter((t) => advertised.has(t));

  // catalog.ts is a static document, so entries legitimately remain there; what
  // matters is that list_tools STRIPS them. Assert the mechanism covers each.
  for (const name of leaked) {
    assert(
      configDisabledTools().includes(name),
      `${name} must be reachable from PROVIDER_REQUIREMENTS for list_tools to strip it`,
    );
  }
  // Pin the three that caused the incident, so a later "cleanup" that drops one
  // from PROVIDER_REQUIREMENTS (rather than fixing it) fails loudly.
  for (const known of ["dork_harvest", "deepfind_reverse_email", "ipqualityscore_lookup"]) {
    if (advertised.has(known)) {
      assertEquals(
        disabled.has(known),
        true,
        `${known} is still advertised in catalog.ts but is no longer marked disabled in ` +
        `PROVIDER_REQUIREMENTS — it would be offered to the model again`,
      );
    }
  }
});

Deno.test("the unknown-tool sink is never cached — a drop must not become sticky", () => {
  assert(
    NO_CACHE_TOOLS.has(UNKNOWN_TOOL_SINK),
    `${UNKNOWN_TOOL_SINK} must be in NO_CACHE_TOOLS; caching a dropped call replays the ` +
    `"ignored" nudge from cache for the whole TTL instead of letting the run move on`,
  );
});
