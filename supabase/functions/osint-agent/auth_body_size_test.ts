// auth_body_size_test.ts — request body size guard (review finding: auth.ts
// accepted the request JSON and lastUser.parts without an explicit size cap
// before persistence, letting an authenticated caller inflate DB storage /
// processing cost). Covers the two pure predicates wired into setupRequest;
// no Supabase mocking needed since both are side-effect-free.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isBodyTooLarge, isContentLengthTooLarge, MAX_REQUEST_BODY_BYTES } from "./auth.ts";

Deno.test("isContentLengthTooLarge: rejects a declared length over the cap", () => {
  assertEquals(isContentLengthTooLarge(String(MAX_REQUEST_BODY_BYTES + 1), MAX_REQUEST_BODY_BYTES), true);
});

Deno.test("isContentLengthTooLarge: allows a declared length at or under the cap", () => {
  assertEquals(isContentLengthTooLarge(String(MAX_REQUEST_BODY_BYTES), MAX_REQUEST_BODY_BYTES), false);
  assertEquals(isContentLengthTooLarge("100", MAX_REQUEST_BODY_BYTES), false);
});

Deno.test("isContentLengthTooLarge: missing/invalid header never blocks by itself (post-parse check catches it)", () => {
  assertEquals(isContentLengthTooLarge(null, MAX_REQUEST_BODY_BYTES), false);
  assertEquals(isContentLengthTooLarge("not-a-number", MAX_REQUEST_BODY_BYTES), false);
});

Deno.test("isBodyTooLarge: rejects a parsed body whose serialized size exceeds the cap", () => {
  const huge = { threadId: "t1", messages: [{ role: "user", parts: [{ type: "text", text: "x".repeat(MAX_REQUEST_BODY_BYTES) }] }] };
  assertEquals(isBodyTooLarge(huge, MAX_REQUEST_BODY_BYTES), true);
});

Deno.test("isBodyTooLarge: a normal chat turn stays well under the cap", () => {
  const normal = { threadId: "t1", messages: [{ role: "user", parts: [{ type: "text", text: "investigate this email: test@example.com" }] }] };
  assertEquals(isBodyTooLarge(normal, MAX_REQUEST_BODY_BYTES), false);
});

Deno.test("isBodyTooLarge: unserializable input (circular) never throws — fails open to false", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assertEquals(isBodyTooLarge(circular, MAX_REQUEST_BODY_BYTES), false);
});

Deno.test("isBodyTooLarge: measures UTF-8 bytes, not UTF-16 code units (multi-byte payload)", () => {
  // Each CJK char is 1 UTF-16 code unit but 3 UTF-8 bytes. A payload whose
  // .length sits under the cap must still be rejected when its byte size
  // exceeds it — matching what Content-Length (bytes) would have said.
  const chars = Math.floor(MAX_REQUEST_BODY_BYTES / 2); // 1M code units → ~3MB UTF-8
  const multibyte = { text: "漢".repeat(chars) };
  assertEquals(JSON.stringify(multibyte).length < MAX_REQUEST_BODY_BYTES, true);
  assertEquals(isBodyTooLarge(multibyte, MAX_REQUEST_BODY_BYTES), true);
});
