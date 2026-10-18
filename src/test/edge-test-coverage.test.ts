import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

/**
 * Every Deno test file under `supabase/tests/` (and, should one ever creep back,
 * `supabase/functions/`) must be reached by `npm run test:edge`.
 *
 * Until 2026-09-14 the script globbed `*_test.ts` at the osint-agent top level only, so
 * `lib/cluster_test.ts` — the suite guarding against false identity merges — plus
 * `lib/memory_save_test.ts`, `lib/memory_supersession_test.ts`, `tools/serus_core_test.ts`
 * and `evidence-export/text-sanitize_test.ts` were executed by no automated gate. 34 tests,
 * all green when finally run, but nothing would have noticed the day one went red.
 *
 * This reads the script as text and resolves its positional paths the way `deno test`
 * does, so a test placed where the script cannot see it fails HERE, in the vitest job,
 * instead of silently never running.
 */

const ROOT = process.cwd();
// Edge tests live in supabase/tests/<fn>/ since 2026-10-15 (they were moved out of the
// deployed function folders to stay under the 4.5 MB upload limit). Both trees are walked so
// a test added back under supabase/functions/ is still checked for coverage here — and is
// refused outright by edge-deploy-bundle.test.ts.
const EDGE_TEST_DIRS = [path.join(ROOT, "supabase/tests"), path.join(ROOT, "supabase/functions")];

// deno test's default discovery pattern: {*_,*.,}test.{js,mjs,ts,mts,jsx,tsx}
const DENO_TEST_FILE = /^(?:.*[._])?test\.(?:js|mjs|ts|mts|jsx|tsx)$/;

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules") return [];
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

function discoverEdgeTestFiles(): string[] {
  return EDGE_TEST_DIRS.flatMap((dir) => walk(dir)).filter((f) => DENO_TEST_FILE.test(path.basename(f)));
}

/** Returns the discovered test files that `script` would NOT execute. */
function uncoveredBy(script: string, files: string[]): string[] {
  const m = script.match(/^cd\s+(\S+)\s+&&\s+deno\s+test\s+(.*)$/);
  if (!m) throw new Error(`test:edge no longer has the shape "cd <dir> && deno test ...": ${script}`);
  const cwd = path.resolve(ROOT, m[1]);
  const positional = m[2].split(/\s+/).filter((t) => t && !t.startsWith("-"));
  const targets = positional.length ? positional : ["."];

  const covers = (file: string) =>
    targets.some((target) => {
      if (target.includes("*")) {
        // A shell glob is expanded non-recursively in its own directory.
        const dir = path.resolve(cwd, path.dirname(target));
        const base = new RegExp(`^${path.basename(target).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);
        return path.dirname(file) === dir && base.test(path.basename(file));
      }
      const resolved = path.resolve(cwd, target);
      return file === resolved || file.startsWith(resolved + path.sep);
    });

  return files.filter((f) => !covers(f)).map((f) => path.relative(ROOT, f));
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
const TEST_EDGE: string = pkg.scripts["test:edge"];

describe("test:edge reaches every edge-function test file", () => {
  const files = discoverEdgeTestFiles();

  it("discovers the nested suites (a discovery bug must not pass vacuously)", () => {
    const rel = files.map((f) => path.relative(ROOT, f));
    expect(rel).toContain("supabase/tests/osint-agent/lib/cluster_test.ts");
    expect(rel).toContain("supabase/tests/evidence-export/text-sanitize_test.ts");
  });

  it("leaves no test file outside the script's paths", () => {
    expect(uncoveredBy(TEST_EDGE, files)).toEqual([]);
  });

  it("would have caught the old top-level-only glob", () => {
    const old = "cd supabase/tests/osint-agent && deno test --no-check --allow-read *_test.ts";
    expect(uncoveredBy(old, files)).toEqual(
      expect.arrayContaining([
        "supabase/tests/osint-agent/lib/cluster_test.ts",
        "supabase/tests/evidence-export/text-sanitize_test.ts",
      ]),
    );
  });
});
