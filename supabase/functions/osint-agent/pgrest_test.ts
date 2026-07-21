import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { agentMemoryOrFilter, pgrestQuote } from "./pgrest.ts";

/** Count the top-level (unquoted) commas in a PostgREST logic tree. A well-formed
 *  two-condition `or` filter has exactly one. This is what actually broke: an
 *  address seed produced 3+, so PostgREST rejected the whole tree. */
function topLevelCommas(filter: string): number {
  let inQuotes = false;
  let escaped = false;
  let n = 0;
  for (const ch of filter) {
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === "," && !inQuotes) n++;
  }
  return n;
}

Deno.test("common seeds keep the exact pre-fix wire format (no regression)", () => {
  for (const v of ["alice@example.com", "brytbryt985", "example.com", "8.8.8.8", "9313787145"]) {
    assertEquals(pgrestQuote(v), v);
    assertEquals(agentMemoryOrFilter(v), `subject.eq.${v},related_values.cs.{${v}}`);
    assertEquals(topLevelCommas(agentMemoryOrFilter(v)), 1);
  }
});

Deno.test("REGRESSION: the live address seed no longer shreds the logic tree", () => {
  // The exact value from the 2026-07-19 failure.
  const seed = "1677 iroquois rd, rocklin, ca 95765";
  const filter = agentMemoryOrFilter(seed);
  // Pre-fix this produced 3 top-level commas -> "failed to parse logic tree".
  assertEquals(topLevelCommas(filter), 1);
  assertEquals(
    filter,
    'subject.eq."1677 iroquois rd, rocklin, ca 95765",related_values.cs.{"1677 iroquois rd, rocklin, ca 95765"}',
  );
});

Deno.test("parens (phone format) are quoted defensively", () => {
  // NOTE: verified against the live PostgREST endpoint — an UNQUOTED
  // "(916) 435-8887" is actually accepted (HTTP 200); parens in this position do
  // NOT break the logic tree. The comma is the only confirmed breaker. Quoting
  // them is cheap defence against grouping edge cases, not a fix for a known
  // parse failure — don't let the earlier, incorrect claim creep back in.
  const filter = agentMemoryOrFilter("(916) 435-8887");
  assertEquals(topLevelCommas(filter), 1);
  assertEquals(filter.includes('"(916) 435-8887"'), true);
});

Deno.test("embedded quotes and backslashes are escaped, not injected", () => {
  assertEquals(pgrestQuote('a"b'), '"a\\"b"');
  assertEquals(pgrestQuote("a\\b"), '"a\\\\b"');
  // an attempt to close the quote early and inject a condition stays contained
  const nasty = 'x",subject.eq.y';
  const filter = agentMemoryOrFilter(nasty);
  assertEquals(topLevelCommas(filter), 1);
});

Deno.test("brace values drop the cs.{...} clause instead of emitting a 400", () => {
  // Verified against a live PostgREST endpoint: a value containing { or } cannot
  // be represented inside a cs.{...} array literal — double-quoting AND
  // backslash-escaping both return 400 PGRST100. Emitting it would fail the WHOLE
  // filter (losing the subject match too), so the containment clause is dropped
  // and we recall by subject alone, which the parser accepts.
  const filter = agentMemoryOrFilter("a}b{c");
  assertEquals(filter, 'subject.eq."a}b{c"');
  assertEquals(filter.includes("related_values"), false);
  assertEquals(topLevelCommas(filter), 0); // single condition
});

Deno.test("empty / nullish input is safe", () => {
  assertEquals(pgrestQuote(""), "");
  assertEquals(topLevelCommas(agentMemoryOrFilter("")), 1);
});

// ---- Real PostgREST parser canary --------------------------------------------
// String assertions above prove the SHAPE of the filter; they cannot prove
// PostgREST accepts it. This canary sends the real filter to a real PostgREST
// endpoint and asserts the parser's verdict. It is read-only (select=id&limit=1,
// RLS-scoped, returns []) and self-skips when no endpoint/key is configured, so
// sandboxed CI is unaffected.
//
// Verified manually 2026-07-19 against the live project:
//   unquoted address       -> HTTP 400 PGRST100 "failed to parse logic tree"
//   quoted address (fixed) -> HTTP 200 []
//   plain email (control)  -> HTTP 200 []
const PGREST_URL = Deno.env.get("SUPABASE_URL") ?? Deno.env.get("PGREST_CANARY_URL") ?? "";
const PGREST_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("PGREST_CANARY_KEY") ?? "";
const canaryReady = PGREST_URL.length > 0 && PGREST_KEY.length > 0;

/** `innerFilter` is what supabase-js `.or()` receives; the client wraps it in
 *  parens to form `or=(...)`, so the canary must do the same or PostgREST reads
 *  the first condition as a column name ("column agent_memory.orsubject ..."). */
async function askPostgrest(innerFilter: string): Promise<{ status: number; body: string }> {
  const qs = new URLSearchParams({ or: `(${innerFilter})`, select: "id", limit: "1" });
  const r = await fetch(`${PGREST_URL}/rest/v1/agent_memory?${qs}`, {
    headers: { apikey: PGREST_KEY, Authorization: `Bearer ${PGREST_KEY}` },
  });
  return { status: r.status, body: (await r.text()).slice(0, 300) };
}

Deno.test({
  name: "CANARY: real PostgREST accepts the quoted filter and rejects the raw one",
  ignore: !canaryReady,
  fn: async () => {
    const addr = "1677 iroquois rd, rocklin, ca 95765";

    // The pre-fix filter must still be rejected — proves the bug is real and that
    // this canary can actually fail.
    const raw = await askPostgrest(`subject.eq.${addr},related_values.cs.{${addr}}`);
    assertEquals(raw.status, 400, `raw comma filter should be rejected, got ${raw.status}`);
    assertEquals(raw.body.includes("PGRST100") || raw.body.includes("failed to parse"), true);

    // Every value class we quote must be accepted by the real parser.
    for (const value of [addr, "(916) 435-8887", 'a"b', "a\\b", "a}b{c", "alice@example.com"]) {
      const res = await askPostgrest(agentMemoryOrFilter(value));
      assertEquals(res.status, 200, `PostgREST rejected quoted value ${JSON.stringify(value)}: ${res.body}`);
    }
  },
});
