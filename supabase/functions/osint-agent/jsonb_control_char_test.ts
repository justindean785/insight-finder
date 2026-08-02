// jsonb_control_char_test.ts — a NUL must never reach a JSONB column.
//
// INCIDENT 2026-08-02, thread e66255da. http_fingerprint fetched a host whose
// response carried a literal NUL. Postgres rejected the JSONB insert with
// "unsupported Unicode escape sequence", and a COMPLETE 12,736-character final
// report was discarded after 28 minutes and $0.97 of tool spend. The cache write
// had failed the same way two minutes earlier — the early warning nobody caught.
//
// SCOPE: the sanitiser removes U+0000 and nothing else. Every other C0 control
// and DEL is storable in jsonb (verified on PostgreSQL 16.13 -- see
// docs/reproducers/jsonb-nul.sql) and must survive untouched.
//
// Control characters are built with String.fromCharCode here on purpose: writing
// the literal bytes would make this test file binary to grep and diff.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { stripNulCharacters } from "./safety.ts";

const NUL = String.fromCharCode(0);
const BEL = String.fromCharCode(7);
const DEL = String.fromCharCode(127);
const TAB = String.fromCharCode(9);
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);

Deno.test("strips NUL from a string leaf — the exact production failure", () => {
  assertEquals(stripNulCharacters("Server: nginx" + NUL + NUL), "Server: nginx");
});

Deno.test("PRESERVES tab, newline and carriage return — they are legal and meaningful", () => {
  // This test previously asserted on the LITERAL text "line1' + B + 'nline2…" —
  // a botched concatenation that got embedded as characters. It contained no
  // tab, LF or CR at all, so it passed while testing nothing. Build them from
  // char codes and prove each one individually survives, so a regex that ate
  // one of the three could not hide behind the other two.
  assertEquals(stripNulCharacters("a" + TAB + "b"), "a" + TAB + "b");
  assertEquals(stripNulCharacters("a" + LF + "b"), "a" + LF + "b");
  assertEquals(stripNulCharacters("a" + CR + "b"), "a" + CR + "b");

  // …and together, in the CRLF + tab-column shape real HTTP responses carry.
  const s = "line1" + CR + LF + "line2" + TAB + "col" + LF;
  assertEquals(stripNulCharacters(s), s);
  // 5 + CR + LF + 5 + TAB + 3 + LF. If a future edit flattens the control
  // characters back into literal text the way the original did, this trips.
  assertEquals(s.length, 17, "fixture lost its control characters — it is not testing what it claims");

  // A NUL adjacent to legal whitespace: the NUL goes, the whitespace stays.
  assertEquals(
    stripNulCharacters("a" + TAB + NUL + LF + "b"),
    "a" + TAB + LF + "b",
  );
});

Deno.test("PRESERVES the rest of C0 and DEL — they are storable, and deleting them loses evidence", () => {
  // REVERSED from the original assertion, on the strength of a real reproducer
  // rather than an argument. Measured on PostgreSQL 16.13
  // (docs/reproducers/jsonb-nul.sql): U+0001 U+0007 U+0008 U+000B U+000C U+000E
  // U+001F U+007F all INSERT into jsonb cleanly, in values and in keys, and
  // round-trip byte-exact. Only U+0000 is rejected. The earlier revision deleted
  // all of them, which in an evidence system is silent data loss with no
  // database failure to justify it.
  assertEquals(stripNulCharacters("a" + BEL + "b" + DEL + "c"), "a" + BEL + "b" + DEL + "c");
  for (const code of [1, 7, 8, 11, 12, 14, 31, 127]) {
    const ch = String.fromCharCode(code);
    assertEquals(
      stripNulCharacters("x" + ch + "y"),
      "x" + ch + "y",
      `U+${code.toString(16).padStart(4, "0").toUpperCase()} was deleted, but Postgres accepts it`,
    );
  }
});

Deno.test("the sanitiser removes EXACTLY one codepoint across the whole C0 range + DEL", () => {
  // Sweep 0x00-0x1F and 0x7F. Exactly one must be removed. This is the guard
  // against the set quietly widening again.
  const removed: number[] = [];
  for (let code = 0; code <= 0x1f; code++) {
    const ch = String.fromCharCode(code);
    if (stripNulCharacters("a" + ch + "b") !== "a" + ch + "b") removed.push(code);
  }
  if (stripNulCharacters("a" + DEL + "b") !== "a" + DEL + "b") removed.push(127);
  assertEquals(removed, [0], `expected only U+0000 to be stripped, got ${JSON.stringify(removed)}`);
});

Deno.test("key collision after scrubbing: clean keys are inviolable", () => {
  // { "head<NUL>er": "a", "header": "b" } — both want the key "header".
  // No resolution is lossless inside a JSON object, so the rule is explicit:
  // a key that never needed scrubbing always keeps its value.
  const scrubbedFirst: Record<string, unknown> = {};
  scrubbedFirst["head" + NUL + "er"] = "from-poisoned-key";
  scrubbedFirst["header"] = "already-clean";
  const a = stripNulCharacters(scrubbedFirst) as Record<string, unknown>;
  assertEquals(Object.keys(a), ["header"]);
  assertEquals(a.header, "already-clean", "a scrubbed key displaced a clean one");

  // Same pair, opposite insertion order — the answer must not depend on it.
  const cleanFirst: Record<string, unknown> = {};
  cleanFirst["header"] = "already-clean";
  cleanFirst["head" + NUL + "er"] = "from-poisoned-key";
  const b = stripNulCharacters(cleanFirst) as Record<string, unknown>;
  assertEquals(Object.keys(b), ["header"]);
  assertEquals(b.header, "already-clean", "result depends on key order — the rule is not deterministic");
});

Deno.test("key collision between TWO scrubbed keys: first wins, deterministically", () => {
  // Neither is clean, so rule 3 applies and the earlier entry keeps the slot.
  const both: Record<string, unknown> = {};
  both["head" + NUL + "er"] = "first";
  both["heade" + NUL + "r"] = "second";
  const clean = stripNulCharacters(both) as Record<string, unknown>;
  assertEquals(Object.keys(clean), ["header"]);
  assertEquals(clean.header, "first");
});

Deno.test("a scrubbed key with no competitor still takes its slot", () => {
  // The collision rules must not cost the ordinary case its data.
  const only: Record<string, unknown> = {};
  only["head" + NUL + "er"] = "v";
  only["unrelated"] = "w";
  const clean = stripNulCharacters(only) as Record<string, unknown>;
  assertEquals(clean.header, "v");
  assertEquals(clean.unrelated, "w");
});

Deno.test("scrubs deep inside the assistant.parts shape that actually failed", () => {
  const parts = [
    { type: "text", text: "## Findings report" + NUL },
    {
      type: "tool-http_fingerprint",
      state: "output-available",
      output: { ok: true, headers: { server: "nginx" + NUL }, body: ["x" + NUL, "y"] },
    },
  ];
  const clean = stripNulCharacters(parts);

  // The previous assertion here was JSON.stringify(clean).includes(NUL) === false.
  // That can never be true: JSON.stringify escapes NUL to the six-character
  // sequence \u0000, so a raw NUL byte is absent from its output whether or not
  // the scrub ran. It passed against completely unscrubbed input. Assert the
  // concrete leaves instead — those are what Postgres actually rejected.
  assertEquals((clean[0] as Record<string, unknown>).text, "## Findings report");
  const out = (clean[1] as Record<string, Record<string, unknown>>).output;
  assertEquals((out.headers as Record<string, unknown>).server, "nginx");
  assertEquals((out.body as string[])[0], "x");

  // And the serialized form must not carry the ESCAPED sequence either — that is
  // the literal text Postgres refuses with "unsupported Unicode escape sequence".
  assert(
    !JSON.stringify(clean).includes("\\u0000"),
    "an escaped NUL survived into the JSONB payload — this is the exact byte Postgres rejects",
  );

  // Shape must be preserved exactly — this runs on every persisted message.
  assertEquals(clean.length, 2);
  assertEquals((clean[1] as Record<string, unknown>).state, "output-available");
  assertEquals(out.ok, true);
  assertEquals((out.body as string[])[1], "y");
});

Deno.test("guard: the old vacuous assertion would have passed on UNSCRUBBED input", () => {
  // Pins WHY the assertion above changed, so it cannot be reverted to the cheap
  // form. Raw, deliberately un-scrubbed input still contains no bare NUL once
  // serialized — proving the old check had no power to fail.
  const poisoned = [{ type: "text", text: "report" + NUL }];
  assertEquals(JSON.stringify(poisoned).includes(NUL), false);
  // The escaped form, by contrast, IS present — which is what we now assert on.
  assert(JSON.stringify(poisoned).includes("\\u0000"));
});

Deno.test("scrubs poisoned KEYS, not just values", () => {
  const poisoned: Record<string, unknown> = {};
  poisoned["head" + NUL + "er"] = "v";
  const clean = stripNulCharacters(poisoned) as Record<string, unknown>;
  assertEquals(Object.keys(clean), ["header"]);
});

Deno.test("leaves clean payloads byte-identical and preserves non-string types", () => {
  const input = { a: "plain", n: 42, b: true, z: null, arr: [1, "two", false] };
  assertEquals(JSON.stringify(stripNulCharacters(input)), JSON.stringify(input));
});

Deno.test("both persistence boundaries are wired, not just the message insert", () => {
  // The cache write failed FIRST in production. Fixing only index.ts would leave
  // that early signal broken and the cache un-writable for the offending tool.
  const idx = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));
  const cache = Deno.readTextFileSync(new URL("./cache.ts", import.meta.url));
  assert(/stripNulCharacters\(/.test(idx), "index.ts message insert is not scrubbed");
  assert(/output_json: stripNulCharacters\(/.test(cache), "tool_call_cache output_json is not scrubbed");
  assert(/input_json: stripNulCharacters\(/.test(cache), "tool_call_cache input_json is not scrubbed");
});
