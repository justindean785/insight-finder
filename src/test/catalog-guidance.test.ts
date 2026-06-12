import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

/**
 * Tranche 1 catalog-guidance hygiene.
 *
 * The catalog (`supabase/functions/osint-agent/catalog.ts`) is the text the
 * LLM reads via `list_tools`. These tests lock down two contradictions the
 * audit found:
 *   - intelbase_email_lookup was advertised as the "FIRST choice / Primary /
 *     unlimited" email source AND simultaneously labelled "PERMANENTLY
 *     DISABLED — do not request it". The model received both at once.
 *   - username_search was presented as a distinct tool despite being an exact
 *     alias of username_sweep.
 *
 * Read the catalog as text (not import) — it is Deno-targeted and pulls in
 * runtime-only modules; the catalog↔runtime contract test uses the same
 * approach.
 */

const CATALOG = fs.readFileSync(
  path.resolve(process.cwd(), "supabase/functions/osint-agent/catalog.ts"),
  "utf-8",
);

describe("catalog guidance — intelbase_email_lookup contradiction", () => {
  it("no longer advertises intelbase as a primary / first-choice / unlimited source", () => {
    expect(CATALOG).not.toMatch(/Primary email enrichment source/i);
    expect(CATALOG).not.toMatch(/FIRST choice for email/i);
    expect(CATALOG).not.toMatch(/unlimited on current plan/i);
  });

  it("no longer carries the contradictory 'PERMANENTLY DISABLED' note", () => {
    expect(CATALOG).not.toMatch(/PERMANENTLY DISABLED/i);
  });

  it("describes intelbase consistently as gated-off", () => {
    // Still present (catalog↔runtime symmetry requires it), but the single
    // surviving description must be the gated/disabled one.
    const occurrences = [...CATALOG.matchAll(/name:\s*"intelbase_email_lookup"/g)];
    expect(occurrences).toHaveLength(1);
    expect(CATALOG).toMatch(/intelbase_email_lookup[^]*?GATED OFF by default/);
  });

  it("no longer lists intelbase as an active parallel tool in any fan-out recipe", () => {
    // The recipe arrays push tools to fire "in parallel". intelbase must not
    // appear inside a "parallel with ..." instruction anymore.
    expect(CATALOG).not.toMatch(/parallel with[^"]*intelbase_email_lookup/i);
  });
});

describe("catalog guidance — username_search duplicate", () => {
  it("marks username_search as a deprecated alias of username_sweep", () => {
    const entry = CATALOG.match(/name:\s*"username_search"[^}]*\}/)?.[0] ?? "";
    expect(entry).toMatch(/DEPRECATED/i);
    expect(entry).toMatch(/username_sweep/);
    expect(entry).toMatch(/prefer username_sweep/i);
  });
});
