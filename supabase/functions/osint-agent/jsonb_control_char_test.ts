// jsonb_control_char_test.ts — a NUL must never reach a JSONB column.
//
// INCIDENT 2026-08-02, thread e66255da. http_fingerprint fetched a host whose
// response carried a literal NUL. Postgres rejected the JSONB insert with
// "unsupported Unicode escape sequence", and a COMPLETE 12,736-character final
// report was discarded after 28 minutes and $0.97 of tool spend. The cache write
// had failed the same way two minutes earlier — the early warning nobody caught.
//
// Control characters are built with String.fromCharCode here on purpose: writing
// the literal bytes would make this test file binary to grep and diff.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { stripJsonbUnsafeControlChars } from "./safety.ts";

const NUL = String.fromCharCode(0);
const BEL = String.fromCharCode(7);
const DEL = String.fromCharCode(127);
const TAB = String.fromCharCode(9);
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);

Deno.test("strips NUL from a string leaf — the exact production failure", () => {
  assertEquals(stripJsonbUnsafeControlChars("Server: nginx" + NUL + NUL), "Server: nginx");
});

Deno.test("PRESERVES tab, newline and carriage return — they are legal and meaningful", () => {
  // This test previously asserted on the LITERAL text "line1' + B + 'nline2…" —
  // a botched concatenation that got embedded as characters. It contained no
  // tab, LF or CR at all, so it passed while testing nothing. Build them from
  // char codes and prove each one individually survives, so a regex that ate
  // one of the three could not hide behind the other two.
  assertEquals(stripJsonbUnsafeControlChars("a" + TAB + "b"), "a" + TAB + "b");
  assertEquals(stripJsonbUnsafeControlChars("a" + LF + "b"), "a" + LF + "b");
  assertEquals(stripJsonbUnsafeControlChars("a" + CR + "b"), "a" + CR + "b");

  // …and together, in the CRLF + tab-column shape real HTTP responses carry.
  const s = "line1" + CR + LF + "line2" + TAB + "col" + LF;
  assertEquals(stripJsonbUnsafeControlChars(s), s);
  // 5 + CR + LF + 5 + TAB + 3 + LF. If a future edit flattens the control
  // characters back into literal text the way the original did, this trips.
  assertEquals(s.length, 17, "fixture lost its control characters — it is not testing what it claims");

  // A NUL adjacent to legal whitespace: the NUL goes, the whitespace stays.
  assertEquals(
    stripJsonbUnsafeControlChars("a" + TAB + NUL + LF + "b"),
    "a" + TAB + LF + "b",
  );
});

Deno.test("strips the rest of C0 and DEL", () => {
  assertEquals(stripJsonbUnsafeControlChars("a" + BEL + "b" + DEL + "c"), "abc");
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
  const clean = stripJsonbUnsafeControlChars(parts);

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
  const clean = stripJsonbUnsafeControlChars(poisoned) as Record<string, unknown>;
  assertEquals(Object.keys(clean), ["header"]);
});

Deno.test("leaves clean payloads byte-identical and preserves non-string types", () => {
  const input = { a: "plain", n: 42, b: true, z: null, arr: [1, "two", false] };
  assertEquals(JSON.stringify(stripJsonbUnsafeControlChars(input)), JSON.stringify(input));
});

Deno.test("both persistence boundaries are wired, not just the message insert", () => {
  // The cache write failed FIRST in production. Fixing only index.ts would leave
  // that early signal broken and the cache un-writable for the offending tool.
  const idx = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));
  const cache = Deno.readTextFileSync(new URL("./cache.ts", import.meta.url));
  assert(/stripJsonbUnsafeControlChars\(/.test(idx), "index.ts message insert is not scrubbed");
  assert(/output_json: stripJsonbUnsafeControlChars\(/.test(cache), "tool_call_cache output_json is not scrubbed");
  assert(/input_json: stripJsonbUnsafeControlChars\(/.test(cache), "tool_call_cache input_json is not scrubbed");
});
