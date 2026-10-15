import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

/**
 * The deployed edge-function folders must stay small enough to upload.
 *
 * Lovable's `supabase--deploy_edge_functions` uploads the WHOLE function folder, and the
 * platform refuses a bundle above 4.5 MB (decimal). On 2026-10-15 `osint-agent` measured
 * 4,614,744 bytes and the deploy failed — 1,949,181 of those bytes were `*_test.ts` files that
 * never run in production. The tests now live in `supabase/tests/<fn>/` (run by
 * `npm run test:edge`), and this guard keeps them from creeping back into the upload.
 */

const ROOT = process.cwd();
const FUNCTIONS_DIR = path.join(ROOT, "supabase/functions");

/** 200 KB of headroom under the 4.5 MB platform limit — fail early, not on deploy day. */
const OSINT_AGENT_MAX_BYTES = 4_300_000;
const PLATFORM_LIMIT_BYTES = 4_500_000;

// deno test's default discovery pattern: {*_,*.,}test.{js,mjs,ts,mts,jsx,tsx}
const DENO_TEST_FILE = /^(?:.*[._])?test\.(?:js|mjs|ts|mts|jsx|tsx)$/;

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules") return [];
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

describe("edge deploy bundle", () => {
  it("contains no test files under supabase/functions/", () => {
    const strays = walk(FUNCTIONS_DIR)
      .filter((f) => DENO_TEST_FILE.test(path.basename(f)))
      .map((f) => path.relative(ROOT, f));
    expect(
      strays,
      "edge tests belong in supabase/tests/<fn>/ (mirroring the function layout), not in the deployed folder",
    ).toEqual([]);
  });

  it(`keeps supabase/functions/osint-agent under ${OSINT_AGENT_MAX_BYTES} bytes`, () => {
    const files = walk(path.join(FUNCTIONS_DIR, "osint-agent"));
    // Anti-vacuous: the folder must actually be measured.
    expect(files.some((f) => f.endsWith(`${path.sep}index.ts`))).toBe(true);
    const bytes = files.reduce((sum, f) => sum + fs.statSync(f).size, 0);
    console.info(
      `[edge-deploy-bundle] osint-agent deployable size: ${bytes} bytes ` +
        `(${((bytes / PLATFORM_LIMIT_BYTES) * 100).toFixed(1)}% of the ${PLATFORM_LIMIT_BYTES}-byte upload limit)`,
    );
    expect(
      bytes,
      `osint-agent is ${bytes} bytes; the Lovable/Supabase upload limit is ${PLATFORM_LIMIT_BYTES}`,
    ).toBeLessThanOrEqual(OSINT_AGENT_MAX_BYTES);
  });
});
