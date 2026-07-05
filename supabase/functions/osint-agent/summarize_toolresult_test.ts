import { assert, assertEquals } from "jsr:@std/assert@^1";
import { extractPivotSelectors, summarizeToolResultValue } from "./message-sanitize.ts";

// issue #238 — selector-preserving summarization of OLDER tool results.
// The load-bearing guarantee: compacting a raw result must NOT drop a pivot-able
// selector (email/username/phone/domain/ip/wallet/handle), because the
// orchestrator pivots off raw-result text before it's ever recorded as an
// artifact. Blind truncation (the prior behavior) drops selectors past the cut.

Deno.test("extractPivotSelectors: finds each selector class, de-duplicated", () => {
  const text = `contact alice@example.com or bob@example.com; site https://acme.io
    ip 8.8.8.8 handle @neo_hacker eth 0x${"a".repeat(40)} phone +1 (415) 555-0199
    bare domain evil-corp.net repeated evil-corp.net`;
  const sel = extractPivotSelectors(text);
  assert(sel.includes("alice@example.com"));
  assert(sel.includes("bob@example.com"));
  assert(sel.includes("8.8.8.8"));
  assert(sel.includes("@neo_hacker"));
  assert(sel.includes(`0x${"a".repeat(40)}`));
  assert(sel.some((s) => s.includes("evil-corp.net")));
  assert(sel.some((s) => s.includes("acme.io")));
  // dedup: evil-corp.net appears twice in text, once in the selector list
  assertEquals(sel.filter((s) => s === "evil-corp.net").length, 1);
});

Deno.test("summarizeToolResultValue: short value is returned unchanged", () => {
  const v = "small result: found user@site.com";
  assertEquals(summarizeToolResultValue(v, 8000, "breach_check"), v);
});

Deno.test("summarizeToolResultValue: CORE AC — a selector buried past the old truncation point survives", () => {
  // A secondary email sits at ~char 5000 — past the old MAX_TOOL_RESULT_CHARS_OLD
  // (4000) / STEP_OLDER_CHARS (3000) truncation, which would have DROPPED it.
  const filler = "x".repeat(5000);
  const raw = `primary: found breach for main@target.com\n${filler}\nsecondary contact discovered: hidden@pivot.org and @secret_handle`;
  const out = summarizeToolResultValue(raw, 3000, "oathnet_lookup") as string;
  assert(typeof out === "string");
  assert(out.length < raw.length, "summary must be smaller than raw");
  // Both the primary and the DEEPLY-BURIED secondary selectors survive verbatim.
  assert(out.includes("main@target.com"), "primary selector preserved");
  assert(out.includes("hidden@pivot.org"), "buried secondary selector preserved (the whole point)");
  assert(out.includes("@secret_handle"), "buried handle preserved");
  assert(out.includes("memory_recall"), "retrieval pointer present");
});

Deno.test("summarizeToolResultValue: preserves selectors from a structured (JSON) value", () => {
  const obj = { status: "ok", note: "z".repeat(4000), emails: ["a@x.com", "b@y.net"], ip: "1.2.3.4" };
  const out = summarizeToolResultValue(obj, 2000, "socialfetch_lookup") as string;
  assert(typeof out === "string");
  assert(out.includes("a@x.com") && out.includes("b@y.net") && out.includes("1.2.3.4"));
});

Deno.test("summarizeToolResultValue: no-selector blob still summarizes and stays under budget-ish", () => {
  const raw = "lorem ipsum ".repeat(1000); // ~12000 chars, no selectors
  const out = summarizeToolResultValue(raw, 2000, "http_fingerprint") as string;
  assert(typeof out === "string");
  assert(out.includes("no pivot selectors detected"));
  assert(out.length < raw.length);
});

Deno.test("summarizeToolResultValue: never returns larger than the original", () => {
  const raw = "a@b.com ".repeat(2000); // many repeated (dedups to 1 selector) + huge
  const out = summarizeToolResultValue(raw, 3000, "t") as string;
  assert((out as string).length < raw.length);
});
