import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

/**
 * Catalog ↔ runtime contract test.
 *
 * The catalog (`supabase/functions/osint-agent/catalog.ts`) is what the
 * LLM sees via `list_tools`. The runtime comes from two sources:
 *   1. Static exports: `export const foo = tool({...})` in tools/*.ts
 *   2. Late-injected:   `(tools as ToolRegistry).foo = tool({...})` in index.ts
 *
 * This test enforces: every tool the LLM can read about actually
 * exists at runtime, and every runtime tool is documented for the LLM.
 * Catches the class of bug that left 4 audit tools (coverage_audit,
 * detect_contradictions, tool_audit, record_finding) invisible to the
 * agent for an entire release.
 */

const ROOT = path.resolve(process.cwd(), "supabase/functions/osint-agent");

function bash(cmd: string): string {
  return execSync(cmd, { cwd: process.cwd(), encoding: "utf-8" });
}

function staticToolNames(): Set<string> {
  // Match both "export const name = tool({" (with space) and "= tool({"
  // (no space, used by disabled.ts). Negative-lookahead excludes
  // "ALL_STATIC_TOOLS = {" which is the barrel object, not a tool.
  const out = bash(
    `grep -hE '^export const [a-z_]+ *= *tool' "${ROOT}/tools"/*.ts | ` +
      `sed -E 's/^export const ([a-z_]+) *= *tool.*/\\1/'`,
  );
  return new Set(out.split("\n").map((s) => s.trim()).filter(Boolean));
}

function lateInjectedNames(): Set<string> {
  const out = bash(
    `grep -oE '\\(tools as (any|ToolRegistry)\\)\\.([a-z_]+) *= *tool' "${ROOT}/index.ts" | ` +
      `sed -E 's/.+\\.([a-z_]+) *= *tool/\\1/'`,
  );
  return new Set(out.split("\n").map((s) => s.trim()).filter(Boolean));
}

function catalogNames(): Set<string> {
  const src = fs.readFileSync(path.join(ROOT, "catalog.ts"), "utf-8");
  const matches = [...src.matchAll(/name:\s*"([a-z_]+)"/g)].map((m) => m[1]);
  return new Set(matches);
}

describe("catalog ↔ runtime tool contract", () => {
  const staticNames = staticToolNames();
  const lateNames = lateInjectedNames();
  const catalog = catalogNames();
  const allRuntime = new Set([...staticNames, ...lateNames]);

  it("discovers >= 50 static tools (smoke check that grep isn't broken)", () => {
    expect(staticNames.size).toBeGreaterThanOrEqual(50);
  });

  it("discovers >= 4 late-injected tools (the audit set)", () => {
    // Today: memory_recall, memory_save, coverage_audit, detect_contradictions,
    // tool_audit, record_finding. If the late-injection pattern is ever
    // removed, this test will fail loudly.
    expect(lateNames.size).toBeGreaterThanOrEqual(4);
  });

  it("late-injected set includes the known audit gate tools", () => {
    for (const required of [
      "memory_recall",
      "memory_save",
      "coverage_audit",
      "detect_contradictions",
      "tool_audit",
      "record_finding",
    ]) {
      expect(lateNames, `expected ${required} to be late-injected`).toContain(required);
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

  it("summary: static + late-injected == catalog (perfect symmetry)", () => {
    // The audit that this test was written to lock down was an asymmetry
    // where 4 late-injected tools were missing from the catalog, leaving
    // the LLM unable to call them by name. If this assertion ever fails
    // it's the same bug returning.
    const summary = {
      static: staticNames.size,
      late: lateNames.size,
      catalog: catalog.size,
      symmetric: staticNames.size + lateNames.size === catalog.size,
    };
    if (!summary.symmetric) {
      throw new Error(
        `Tool count asymmetry: static(${summary.static}) + late(${summary.late}) != catalog(${summary.catalog}). ` +
          `Missing from catalog: ${[...allRuntime].filter((n) => !catalog.has(n)).join(", ")}. ` +
          `In catalog but not runtime: ${[...catalog].filter((n) => !allRuntime.has(n)).join(", ")}.`,
      );
    }
  });
});
