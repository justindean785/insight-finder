import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

/**
 * Catalog ↔ runtime contract test.
 *
 * The catalog (`supabase/functions/osint-agent/catalog.ts`) is what the
 * LLM sees via `list_tools`. A tool becomes part of the live runtime in
 * exactly two ways inside `buildTools()` (tool-registry.ts):
 *   1. Object-literal property:  `foo: tool({...})` inside `const tools = { ... }`
 *   2. Late-attach:              `(tools as ToolRegistry).foo = tool({...})`
 *                                `(tools as ToolRegistry).foo = foo`  (imported const)
 *
 * NB: a bare `export const foo = tool({...})` in tools/*.ts is NOT by itself a
 * runtime tool — several such exports are dead/legacy or intentionally disabled
 * (firecrawl_*, intelbase_email_lookup, bosint_phone_lookup, …) and are never
 * attached to the live `tools` object. Only the two patterns above register a
 * tool, so discovery keys off them (an earlier version grepped `export const`
 * and produced false positives on both the object-literal tools it couldn't see
 * and the dead exports it wrongly counted).
 *
 * This test enforces: every tool the LLM can read about actually exists at
 * runtime, and every runtime tool is documented for the LLM. Catches the class
 * of bug that left 4 audit tools (coverage_audit, detect_contradictions,
 * tool_audit, record_finding) invisible to the agent for an entire release.
 */

const ROOT = path.resolve(process.cwd(), "supabase/functions/osint-agent");

function bash(cmd: string): string {
  return execSync(cmd, { cwd: process.cwd(), encoding: "utf-8" });
}

function toSet(out: string): Set<string> {
  return new Set(out.split("\n").map((s) => s.trim()).filter(Boolean));
}

/**
 * Object-literal tools declared as `name: tool({...})` properties of the
 * `const tools = { ... }` registry in tool-registry.ts. This is the bulk of the
 * runtime surface. `= tool(` (late-attach) is deliberately not matched here —
 * that form is `.name = tool(`, never `name: tool(`.
 */
function objectLiteralToolNames(): Set<string> {
  const out = bash(
    `grep -hE '^[[:space:]]+[a-z_][a-z_0-9]*: tool\\(' "${ROOT}/tool-registry.ts" | ` +
      `sed -E 's/^[[:space:]]+([a-z_0-9]+): tool\\(.*/\\1/'`,
  );
  return toSet(out);
}

/**
 * Late-attached tools: `(tools as ToolRegistry).name = ...`. Matches BOTH the
 * inline `= tool({...})` form (memory_recall, the audit gate tools) and the
 * `= importedConst` form (serus_darkweb_scan, indicia_*, pdl_person_enrich,
 * gemini_vision) — anything assigned onto the live registry counts.
 */
function lateInjectedNames(): Set<string> {
  const out = bash(
    `grep -ohE '\\(tools as [^)]*\\)\\.[a-z_][a-z_0-9]* *=' "${ROOT}/tool-registry.ts" "${ROOT}/index.ts" | ` +
      `sed -E 's/.*\\.([a-z_0-9]+) *=/\\1/'`,
  );
  return toSet(out);
}

function catalogNames(): Set<string> {
  const src = fs.readFileSync(path.join(ROOT, "catalog.ts"), "utf-8");
  const matches = [...src.matchAll(/name:\s*"([a-z_]+)"/g)].map((m) => m[1]);
  return new Set(matches);
}

describe("catalog ↔ runtime tool contract", () => {
  const objectLiteralNames = objectLiteralToolNames();
  const lateNames = lateInjectedNames();
  const catalog = catalogNames();
  const allRuntime = new Set([...objectLiteralNames, ...lateNames]);

  it("discovers >= 50 object-literal tools (smoke check that grep isn't broken)", () => {
    expect(objectLiteralNames.size).toBeGreaterThanOrEqual(50);
  });

  it("discovers >= 4 late-attached tools (the audit set)", () => {
    // Today: memory_recall, memory_save, coverage_audit, detect_contradictions,
    // tool_audit, record_finding, plus imported-const attaches (serus, indicia_*,
    // pdl, gemini_vision). If the late-attach pattern is ever removed, this fails.
    expect(lateNames.size).toBeGreaterThanOrEqual(4);
  });

  it("late-attached set includes the known audit gate tools", () => {
    for (const required of [
      "memory_recall",
      "memory_save",
      "coverage_audit",
      "detect_contradictions",
      "tool_audit",
      "record_finding",
    ]) {
      expect(lateNames, `expected ${required} to be late-attached`).toContain(required);
    }
  });

  it("every runtime tool appears in the catalog (LLM-visible)", () => {
    const missing = [...allRuntime].filter((n) => !catalog.has(n));
    expect(missing, `runtime tools not in catalog: ${missing.join(", ")}`).toEqual([]);
  });

  it("every catalog entry exists at runtime (no phantom tools)", () => {
    const phantoms = [...catalog].filter((n) => !allRuntime.has(n));
    expect(phantoms, `catalog entries not implemented at runtime: ${phantoms.join(", ")}`).toEqual([]);
  });

  it("no duplicate catalog entries (paranoia check)", () => {
    const src = fs.readFileSync(path.join(ROOT, "catalog.ts"), "utf-8");
    const matches = [...src.matchAll(/name:\s*"([a-z_]+)"/g)].map((m) => m[1]);
    const counts = new Map<string, number>();
    for (const n of matches) counts.set(n, (counts.get(n) ?? 0) + 1);
    const dupes = [...counts.entries()].filter(([, c]) => c > 1).map(([n]) => n);
    expect(dupes, `duplicate catalog entries: ${dupes.join(", ")}`).toEqual([]);
  });

  it("summary: runtime (object-literal ∪ late-attach) == catalog (perfect symmetry)", () => {
    // The audit that this test was written to lock down was an asymmetry
    // where 4 late-attached tools were missing from the catalog, leaving the
    // LLM unable to call them by name. If this assertion ever fails it's the
    // same class of bug returning (a runtime tool undocumented, or a phantom
    // catalog entry the LLM can name but not call).
    const missing = [...allRuntime].filter((n) => !catalog.has(n));
    const phantoms = [...catalog].filter((n) => !allRuntime.has(n));
    if (allRuntime.size !== catalog.size || missing.length || phantoms.length) {
      throw new Error(
        `Tool count asymmetry: runtime(${allRuntime.size}) [object-literal(${objectLiteralNames.size}) ∪ late(${lateNames.size})] != catalog(${catalog.size}). ` +
          `Missing from catalog: ${missing.join(", ")}. ` +
          `In catalog but not runtime: ${phantoms.join(", ")}.`,
      );
    }
  });
});
