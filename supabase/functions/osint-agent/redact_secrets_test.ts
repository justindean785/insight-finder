// C2 — credentials must not survive into logs, tool_usage_log rows, or any
// string handed back over the wire.
//
// The audit's stated mechanism was wrong in a way worth pinning here so nobody
// "simplifies" the fix back out. It claimed Deno's fetch TypeError embeds the
// request URL in `.message`, so `String(e)` leaked keys. Measured on Deno 2.9.5:
//
//   e.message  -> "fetch failed"          (no URL, no key)
//   String(e)  -> "TypeError: fetch failed" (no URL, no key)
//   e.cause    -> "error sending request for url (https://...?api_key=LIVE): ..."
//
// The URL is ONLY in `.cause`. So the leak was never the string conversions —
// it was passing the raw error OBJECT to console.*, which prints the cause
// chain verbatim into the function logs. describeError() closes that while
// keeping the cause visible to an operator.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { redactSecrets, describeError } from "./safety.ts";

Deno.test("redactSecrets: query-string credentials are caught for every provider shape", () => {
  const cases: Array<[string, string]> = [
    // FOFA
    ["https://en.fofa.info/api/v1/search/all?key=abc123DEF456", "abc123DEF456"],
    // OpenCorporates
    ["https://api.opencorporates.com/v0.4/companies/search?q=x&api_token=tok_live_99", "tok_live_99"],
    // Hunter — 40-hex, no prefix, so prefix-shaped rules can never catch it
    ["https://api.hunter.io/v2/email-verifier?email=a@b.c&api_key=0123456789abcdef0123456789abcdef01234567", "0123456789abcdef0123456789abcdef01234567"],
    // Gemini
    ["https://generativelanguage.googleapis.com/v1beta/models/x:generateContent?key=AIzaSyFAKEKEY123", "AIzaSyFAKEKEY123"],
  ];
  for (const [url, secret] of cases) {
    const out = redactSecrets(url);
    assert(!out.includes(secret), `secret survived redaction in: ${out}`);
    assert(out.includes("[REDACTED]"), `no redaction marker in: ${out}`);
  }
});

Deno.test("redactSecrets: prefix-shaped credentials still covered", () => {
  assert(!redactSecrets("Authorization: Bearer sk-abc.def-123").includes("abc.def-123"));
  assert(!redactSecrets("key sk-proj-SECRET123").includes("sk-proj-SECRET123"));
  assert(!redactSecrets("xai-SECRET456 in play").includes("xai-SECRET456"));
  assert(!redactSecrets("AIzaSyREALKEY789 here").includes("AIzaSyREALKEY789"));
});

Deno.test("redactSecrets: non-credential query params are left intact", () => {
  const out = redactSecrets("https://api.example.com/search?q=jordan+vale&limit=25&page=2");
  assertEquals(out, "https://api.example.com/search?q=jordan+vale&limit=25&page=2");
});

Deno.test("redactSecrets: a param merely ENDING in a credential word is not clobbered", () => {
  // `?monkey=` must not be treated as `key=`.
  const out = redactSecrets("https://api.example.com/z?monkey=banana");
  assertEquals(out, "https://api.example.com/z?monkey=banana");
});

Deno.test("describeError: walks the cause chain and redacts the URL credential", () => {
  // The exact shape Deno 2.x produces for a failed fetch.
  const cause = new Error(
    "error sending request for url (https://api.hunter.io/v2/people/find?api_key=0123456789abcdef0123456789abcdef01234567): client error",
  );
  const err = new TypeError("fetch failed", { cause });

  const described = describeError(err);

  assert(
    !described.includes("0123456789abcdef0123456789abcdef01234567"),
    `the key survived: ${described}`,
  );
  // The cause must still be legible — a redacted description an operator cannot
  // diagnose from is not an improvement over the leak.
  assert(described.includes("fetch failed"), "outer message must survive");
  assert(described.includes("error sending request"), "cause must remain visible");
  assert(described.includes("[REDACTED]"), "redaction marker expected");
});

Deno.test("describeError: the bare message alone never contained the key (audit premise check)", () => {
  const cause = new Error("error sending request for url (https://x/y?api_key=LIVEKEY): oops");
  const err = new TypeError("fetch failed", { cause });
  // Pins the measurement: String(e) is key-free on this runtime, so redacting
  // String(e) alone would have been a fix aimed at the wrong channel.
  assertEquals(String(err), "TypeError: fetch failed");
  assert(!String(err).includes("LIVEKEY"));
  // ...while the object's cause chain is exactly where the key lives.
  assert(String((err as Error).cause).includes("LIVEKEY"));
});

Deno.test("describeError: handles non-Error values and cyclic causes without hanging", () => {
  assertEquals(describeError("plain string"), "plain string");
  assertEquals(describeError(42), "42");

  const a = new Error("a");
  const b = new Error("b", { cause: a });
  (a as Error).cause = b; // cycle
  const out = describeError(b);
  assert(out.length > 0, "a cyclic cause chain must still produce output");
});

Deno.test("describeError: output is length-bounded", () => {
  const long = new Error("x".repeat(5000));
  assert(describeError(long).length <= 500);
});
