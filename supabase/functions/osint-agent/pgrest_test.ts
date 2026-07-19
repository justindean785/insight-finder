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

Deno.test("parens (phone format) are quoted — they also break the tree", () => {
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

Deno.test("braces cannot break out of the cs.{...} array literal", () => {
  const filter = agentMemoryOrFilter("a}b{c");
  assertEquals(topLevelCommas(filter), 1);
  assertEquals(filter.includes('"a}b{c"'), true);
});

Deno.test("empty / nullish input is safe", () => {
  assertEquals(pgrestQuote(""), "");
  assertEquals(topLevelCommas(agentMemoryOrFilter("")), 1);
});
