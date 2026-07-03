import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

/**
 * Tranche 1 catalog-guidance hygiene.
 *
 * The catalog (`supabase/functions/osint-agent/catalog.ts`) is the text the
 * LLM reads via `list_tools`. This test locks down a contradiction the audit
 * found:
 *   - username_search was presented as a distinct tool despite being an exact
 *     alias of username_sweep.
 *
 * (The intelbase_email_lookup contradiction that this file also used to guard
 * is moot now that intelbase_email_lookup has been removed from the catalog
 * and runtime entirely.)
 *
 * Read the catalog as text (not import) — it is Deno-targeted and pulls in
 * runtime-only modules; the catalog↔runtime contract test uses the same
 * approach.
 */

const CATALOG = fs.readFileSync(
  path.resolve(process.cwd(), "supabase/functions/osint-agent/catalog.ts"),
  "utf-8",
);
const TOOL_REGISTRY_PATH = path.resolve(process.cwd(), "supabase/functions/osint-agent/tool-registry.ts");
const INDEX_PATH = path.resolve(process.cwd(), "supabase/functions/osint-agent/index.ts");
const INDEX = fs.existsSync(TOOL_REGISTRY_PATH)
  ? fs.readFileSync(TOOL_REGISTRY_PATH, "utf-8")
  : fs.readFileSync(INDEX_PATH, "utf-8");

describe("catalog guidance — username_search duplicate", () => {
  it("marks username_search as a deprecated alias of username_sweep", () => {
    const entry = CATALOG.match(/name:\s*"username_search"[^}]*\}/)?.[0] ?? "";
    expect(entry).toMatch(/DEPRECATED/i);
    expect(entry).toMatch(/username_sweep/);
    expect(entry).toMatch(/prefer username_sweep/i);
  });
});

describe("paired dork tools — person seed compatibility", () => {
  it("accepts and normalizes person seeds in both google_dorks and dork_harvest", () => {
    const googleDorks = INDEX.match(/google_dorks:\s*tool\(\{[^]*?\n\s*\}\),\n\s*dork_harvest:/)?.[0] ?? "";
    const dorkHarvest = INDEX.match(/dork_harvest:\s*tool\(\{[^]*?\n\s*\}\),\n\s*gemini_deep_dork:/)?.[0] ?? "";

    expect(googleDorks).toMatch(/"name",\s*"person"/);
    expect(googleDorks).toMatch(/rawKind === "person" \? "name" : rawKind/);
    expect(dorkHarvest).toMatch(/"name",\s*"person"/);
    expect(dorkHarvest).toMatch(/rawKind === "person" \? "name" : rawKind/);
  });

  it("documents person as a valid dork_harvest kind", () => {
    const entry = CATALOG.match(/name:\s*"dork_harvest"[^}]*\}/)?.[0] ?? "";
    expect(entry).toMatch(/person/i);
  });
});
