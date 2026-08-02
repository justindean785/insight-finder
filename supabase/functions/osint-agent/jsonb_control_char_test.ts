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

Deno.test("strips NUL from a string leaf — the exact production failure", () => {
  assertEquals(stripJsonbUnsafeControlChars("Server: nginx" + NUL + NUL), "Server: nginx");
});

Deno.test("PRESERVES tab, newline and carriage return — they are legal and meaningful", () => {
  const s = "line1' + B + 'nline2' + B + 'tcol' + B + 'r";
  assertEquals(stripJsonbUnsafeControlChars(s), s);
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
  assertEquals(JSON.stringify(clean).includes(NUL), false, "a NUL survived the scrub");
  // Shape must be preserved exactly — this runs on every persisted message.
  assertEquals(clean.length, 2);
  assertEquals((clean[1] as Record<string, unknown>).state, "output-available");
  const out = (clean[1] as Record<string, Record<string, unknown>>).output;
  assertEquals(out.ok, true);
  assertEquals((out.body as string[])[1], "y");
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
