import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Source-level import-boundary guard.
 *
 * A previous revision had a real cycle — `intel.ts` imported `exclusion.ts`
 * while `exclusion.ts` imported `isPipelineExcluded` from `intel.ts` — and BOTH
 * files carried comments asserting the arrangement was acyclic. Comments cannot
 * enforce this; this test can.
 *
 * Required direction:
 *
 *     artifact-exclusion.ts   (imports nothing but types)
 *        ^            ^
 *        |            |
 *   exclusion.ts    intel.ts
 *        ^
 *        |
 *     intel.ts
 */

const read = (rel: string) => readFileSync(resolve(__dirname, "..", rel), "utf8");

/** Value (non-type) import specifiers. `import type` is erased at build time. */
function valueImports(src: string): string[] {
  const out: string[] = [];
  const re = /^import\s+(?!type\s)([\s\S]*?)from\s+["']([^"']+)["']/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    // `import { type X }` inline-type-only clauses still erase, but a mixed
    // clause is a real runtime import — keep it, we only care about the module.
    out.push(m[2]);
  }
  // bare side-effect imports
  const bare = /^import\s+["']([^"']+)["']/gm;
  while ((m = bare.exec(src))) out.push(m[1]);
  return out;
}

describe("import boundaries — the exclusion primitive stays at the bottom", () => {
  it("artifact-exclusion.ts imports nothing at runtime", () => {
    const imports = valueImports(read("lib/artifact-exclusion.ts"));
    expect(imports).toEqual([]);
  });

  it("exclusion.ts does NOT import intel.ts", () => {
    const imports = valueImports(read("lib/exclusion.ts"));
    expect(imports).not.toContain("@/lib/intel");
    // and must not reach it indirectly through the report-render layer either
    expect(imports).not.toContain("@/lib/report-hygiene");
  });

  it("exclusion.ts depends on the primitive", () => {
    expect(valueImports(read("lib/exclusion.ts"))).toContain("@/lib/artifact-exclusion");
  });

  it("intel.ts may depend on both, and does", () => {
    const imports = valueImports(read("lib/intel.ts"));
    expect(imports).toContain("@/lib/exclusion");
    expect(imports).toContain("@/lib/artifact-exclusion");
  });

  it("structured-input.ts is also a leaf, and imports nothing at runtime", () => {
    // Same reason as artifact-exclusion.ts: both seed.ts and intel.ts consult it,
    // so it must not be able to reach either of them.
    expect(valueImports(read("lib/structured-input.ts"))).toEqual([]);
  });

  it("seed.ts depends on the structured-input primitive, not on intel.ts", () => {
    const imports = valueImports(read("lib/seed.ts"));
    expect(imports).toContain("@/lib/structured-input");
    expect(imports).not.toContain("@/lib/intel");
  });

  it("the primitive does not import React or the Supabase client", () => {
    const src = read("lib/artifact-exclusion.ts");
    expect(src).not.toMatch(/from ["']react["']/);
    expect(src).not.toMatch(/integrations\/supabase/);
  });

  it("no file claims acyclicity that the graph contradicts", () => {
    // The two comments that were false are gone. If someone reinstates the
    // cycle they must also delete this guard, which is a visible act.
    const intel = read("lib/intel.ts");
    expect(intel).not.toMatch(/without intel\.ts importing exclusion\.ts/);
  });
});
