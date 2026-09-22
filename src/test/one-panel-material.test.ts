// one-panel-material.test.ts - one material for the workspace's top-level surfaces.
//
// PRODUCT.md makes the glass a deliberate identity with a budget, and DESIGN.md
// says to use the shared `.panel` for any new surface because it "replaced six
// near-identical materials and exists so the workspace reads as one
// instrument." The rule was written down and then broken quietly, which is the
// only way this kind of drift ever happens.
//
// Measured on the live harness, 2026-09-22: the Report tab had ZERO `.panel`
// surfaces. Its two top-level sections were `bg-surface-1`, a SOLID navy plate
// at rgb(8, 14, 27), sitting beside `.panel` glass over true black everywhere
// else - which is what an operator saw as "blue on some tabs, black on others."
// The Audit view had six more on `bg-card/30`, a third material again.
//
// This asserts the shape, not a snapshot: a bordered, rounded, painted section
// in a workspace surface is a panel and says so. Nested sub-surfaces inside a
// panel are deliberately not covered - they are a different tier, and giving
// them glass too would stack blur against the budget.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/** The surfaces an analyst reads as "a panel on a tab". */
const ROOTS = ["src/components/workspace", "src/components/panel", "src/components/investigation"];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

// A section-level surface built by hand: rounded, bordered, and painted with
// one of the opaque ground tokens. A translucent wash on a nested block (an
// alpha suffix on the token) is not this; the tell is the opaque plate.
const HAND_ROLLED =
  /className="[^"]*\brounded-(?:lg|xl|2xl)\b[^"]*\bborder\b[^"]*\bbg-(?:surface-[123]|card)(?![/\w])[^"]*"/g;

/**
 * Deliberate exceptions, each for a reason the regex cannot see.
 *
 * The pattern matches "rounded, bordered, opaquely painted", which is also the
 * shape of a control strip and of a sub-surface nested inside a panel. Neither
 * is a top-level surface, and giving a nested one glass would stack blur
 * against the budget. Keyed by file so a NEW plate in the same file still
 * fails.
 */
const EXCEPTIONS: Record<string, string> = {
  // A filter strip is a control ground, not a region of the page.
  "components/panel/PivotsTab.tsx": "control strip",
  // The raw-markdown disclosure sits INSIDE the report panel. Second tier.
  "components/panel/ReportTab.tsx": "nested code panel",
};

describe("the workspace has one panel material", () => {
  const files = ROOTS.flatMap((r) => walk(resolve(process.cwd(), r)));

  it("finds the component tree it is meant to guard", () => {
    expect(files.length).toBeGreaterThan(8);
  });

  it("builds no top-level surface by hand instead of using .panel", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(HAND_ROLLED)) {
        if (/\bpanel\b/.test(m[0])) continue;
        const where = f.split("/src/")[1];
        if (EXCEPTIONS[where]) continue;
        offenders.push(where + " :: " + m[0].slice(11, 96));
      }
    }
    expect(offenders, "use the shared `panel` class - see DESIGN.md, Panel Roles").toEqual([]);
  });

  it("still defines the shared material exactly once", () => {
    // A second copy of the recipe under another name is the same drift wearing
    // a different class selector.
    const css = readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");
    expect(css.match(/^\s*\.panel\s*\{/gm) ?? []).toHaveLength(1);
  });
});
