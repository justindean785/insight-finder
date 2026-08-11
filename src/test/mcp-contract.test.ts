import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

/**
 * Contract lock for the `mcp` edge function (src/lib/mcp/**).
 *
 * `mcp` is a FOURTH live edge function that reached production without ever
 * existing in this repository — authored in Lovable, deployed from the mirror.
 * See src/lib/mcp/README.md for the full provenance.
 *
 * Read as TEXT, not imported: these files are Deno/Lovable-targeted, import
 * `@lovable.dev/mcp-js` (deliberately NOT a dependency here), and are excluded
 * from tsconfig.app.json. Same approach as catalog-guidance.test.ts reading
 * tool-registry.ts, and the edge suite's reviews_wiring_test.ts reading
 * index.ts off disk.
 *
 * SCOPE — read before trusting a green run. This is a CANONICAL CONTRACT LOCK,
 * NOT a canonical↔mirror or canonical↔production drift detector. It reads only
 * src/lib/mcp/** from THIS checkout. It never opens the Lovable mirror and never
 * touches the deployed function, so a mirror-only edit or a regenerated
 * `supabase/functions/mcp/index.ts` can diverge from this record while every
 * assertion below stays green.
 *
 * What a FAILURE means: the canonical source changed without its recorded
 * contract changing (or vice versa) — investigate before "fixing" the test.
 * What a PASS means: only that the canonical source still matches this record.
 *
 * The three states are independent and must be checked separately:
 *   1. canonical contract    — this test
 *   2. canonical↔mirror sync — diff src/lib/mcp/** against the mirror's copy
 *   3. deployed reality      — independent production verification
 * See src/lib/mcp/README.md for how to do 2 and 3.
 */

const MCP_DIR = path.resolve(process.cwd(), "src/lib/mcp");
const read = (rel: string) => fs.readFileSync(path.join(MCP_DIR, rel), "utf-8");

const INDEX = read("index.ts");
const ECHO = read("tools/echo.ts");
const LIST = read("tools/list-investigations.ts");
const GET = read("tools/get-investigation.ts");
const DB_TOOLS: Array<[string, string]> = [
  ["list-investigations", LIST],
  ["get-investigation", GET],
];

describe("mcp contract — server definition", () => {
  it("registers exactly the three known tools", () => {
    expect(INDEX).toMatch(/tools:\s*\[echoTool,\s*listInvestigationsTool,\s*getInvestigationTool\]/);
    for (const name of ["echo", "list_investigations", "get_investigation"]) {
      const source = [ECHO, LIST, GET].join("\n");
      expect(source).toContain(`name: "${name}"`);
    }
  });

  it("keeps every tool read-only and closed-world", () => {
    for (const [label, src] of [["echo", ECHO], ...DB_TOOLS] as Array<[string, string]>) {
      expect(src, `${label} must declare readOnlyHint`).toContain("readOnlyHint: true");
      expect(src, `${label} must declare openWorldHint: false`).toContain("openWorldHint: false");
    }
  });
});

describe("mcp contract — security posture", () => {
  /**
   * These are the properties that make this NOT an auth bypass. Audited
   * 2026-08-11: the function validates the Supabase issuer/audience, forwards
   * the caller's own bearer token, and uses the publishable (anon) key, so
   * user-scoped RLS is the enforcing control. Losing any of them is a
   * privilege escalation, not a refactor.
   */
  it("pins the OAuth issuer to Supabase auth with the authenticated audience", () => {
    expect(INDEX).toContain("auth.oauth.issuer(");
    expect(INDEX).toMatch(/issuer:\s*`https:\/\/\$\{projectRef\}\.supabase\.co\/auth\/v1`/);
    expect(INDEX).toContain('acceptedAudiences: "authenticated"');
  });

  it("never uses a service-role key — RLS must remain the enforcing control", () => {
    for (const [label, src] of DB_TOOLS) {
      expect(src, `${label} must not reference a service-role key`).not.toMatch(/SERVICE_ROLE/i);
      expect(src, `${label} must use the publishable key`).toContain("SUPABASE_PUBLISHABLE_KEY");
    }
  });

  it("forwards the caller's own bearer token on every DB tool", () => {
    for (const [label, src] of DB_TOOLS) {
      expect(src, `${label} must forward ctx.getToken()`).toContain(
        "Authorization: `Bearer ${ctx.getToken()}`",
      );
    }
  });

  it("rejects unauthenticated callers before touching the database", () => {
    for (const [label, src] of DB_TOOLS) {
      expect(src, `${label} must gate on ctx.isAuthenticated()`).toContain("ctx.isAuthenticated()");
      const gate = src.indexOf("ctx.isAuthenticated()");
      const firstQuery = src.indexOf(".from(");
      expect(gate, `${label} must check auth before its first query`).toBeLessThan(firstQuery);
    }
  });

  it("scopes list_investigations to the caller and selects explicit columns", () => {
    expect(LIST).toContain('.eq("user_id", ctx.getUserId())');
    expect(LIST).toMatch(/\.select\("id,title,seed_type,seed_value,status,credits_used,created_at,updated_at"\)/);
    expect(LIST).not.toContain('.select("*")');
  });
});

describe("mcp contract — KNOWN INTEGRITY GAPS (documented, not yet fixed)", () => {
  /**
   * These assertions deliberately encode the canonical record of the behaviour
   * as audited on 2026-08-11, so it cannot change silently in either direction.
   * They assert what the canonical source says — NOT what production is running;
   * confirming the deployed function still matches requires separate production
   * verification. When a fix lands, update these in the SAME commit — a green
   * suite must never mean "the gap is closed" when it only means "nobody looked".
   *
   * Gap 1 — raw rows bypass the report/evidence integrity layers. `metadata`
   * is returned verbatim, and quarantine state (`subject_unlinked`) lives
   * INSIDE that JSON rather than in a column, so a column allowlist cannot
   * express the fix; an authority-aware DTO is required. Integrity-critical:
   * needs sign-off per CLAUDE.md.
   */
  it("get_investigation still returns raw messages and artifacts (gap 1)", () => {
    expect(GET).toContain('sb.from("messages").select("*")');
    expect(GET).toContain('sb.from("artifacts").select("*")');
    expect(GET).toContain("structuredContent: payload");
  });

  /**
   * Gap 2 — the thread-ownership check races the data reads. RLS still
   * prevents cross-user reads, so this is not a demonstrated tenant-isolation
   * vulnerability, but the application-level guard is decorative: the
   * subordinate queries are already in flight before its result is known.
   *
   * When ownership is serialized ahead of the reads, replace this with the
   * positive assertion — that the messages/artifacts queries appear only
   * AFTER the ownership result is awaited.
   */
  it("get_investigation still launches the ownership check concurrently (gap 2)", () => {
    expect(GET).toContain("await Promise.all([");
    const parallel = GET.slice(GET.indexOf("await Promise.all(["), GET.indexOf("]);"));
    expect(parallel).toContain('sb.from("threads")');
    expect(parallel).toContain('sb.from("messages")');
    expect(parallel).toContain('sb.from("artifacts")');
  });
});
