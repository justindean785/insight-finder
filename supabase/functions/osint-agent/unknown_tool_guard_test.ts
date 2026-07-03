// unknown_tool_guard_test.ts — Phase B4: hallucinated tool names are dropped
// (redirected to the sink), never executed as themselves, never surfaced.
import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  UNKNOWN_TOOL_SINK,
  unknownToolNudge,
  repairUnknownTool,
} from "./unknown-tool-guard.ts";

const REGISTRY = ["hibp_lookup", "dns_records", "gemini_deep_dork", UNKNOWN_TOOL_SINK];

Deno.test("sink name is pinned to the literal registered in tool-registry.ts", () => {
  // tool-registry.ts registers `(tools as ToolRegistry).unknown_tool_ignored`
  // as a LITERAL (so the catalog↔runtime contract parser can see it). If this
  // constant ever changes, that literal + catalog.ts must change with it.
  assertEquals(UNKNOWN_TOOL_SINK, "unknown_tool_ignored");
});

Deno.test("hallucinated name is redirected to the sink, not executed as itself", () => {
  for (const bogus of ["exify", "hackerone_lookup", "totally_made_up"]) {
    const d = repairUnknownTool(bogus, REGISTRY);
    assert(d.redirect, `${bogus} must be redirected`);
    if (d.redirect) {
      assertEquals(d.toolName, UNKNOWN_TOOL_SINK, "redirect must target the sink");
      assert(d.toolName !== bogus, "the invented tool must NEVER be the executed target");
      assertEquals(d.requested, bogus, "the invented name is carried to the sink for the nudge");
    }
  }
});

Deno.test("a real registry tool is NOT redirected (SDK handles it normally)", () => {
  for (const known of ["hibp_lookup", "dns_records", "gemini_deep_dork"]) {
    const d = repairUnknownTool(known, REGISTRY);
    assertEquals(d.redirect, false, `${known} is a real tool and must pass through`);
  }
});

Deno.test("guard works with a Set registry too (no accidental re-wrap)", () => {
  const d = repairUnknownTool("exify", new Set(REGISTRY));
  assert(d.redirect);
});

Deno.test("nudge names the dropped tool and points back at the schema", () => {
  const n = unknownToolNudge("exify");
  assert(n.includes("exify"));
  assert(/only tools listed/i.test(n));
  // Degrades safely with no name.
  assert(unknownToolNudge().length > 0);
});
