// Regression test: Serus 422s a phone identifierValue that isn't E.164 (live
// case — seed "9165299191" sent as-is: "Serus darkweb scan rejected phone
// format — skipped"). runSerusScan now normalizes phone values before
// calling out; this covers the pure normalizer in isolation.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { normalizePhoneForSerus } from "./serus_core.ts";

Deno.test("normalizePhoneForSerus: bare 10-digit US number gets +1 prefix", () => {
  assertEquals(normalizePhoneForSerus("9165299191"), "+19165299191");
});

Deno.test("normalizePhoneForSerus: 11-digit number with leading 1 gets + prefix", () => {
  assertEquals(normalizePhoneForSerus("19165299191"), "+19165299191");
});

Deno.test("normalizePhoneForSerus: already-E.164 value passes through unchanged", () => {
  assertEquals(normalizePhoneForSerus("+19165299191"), "+19165299191");
  assertEquals(normalizePhoneForSerus("+79165299191"), "+79165299191");
});

Deno.test("normalizePhoneForSerus: dashes/spaces/parens are stripped before prefixing", () => {
  assertEquals(normalizePhoneForSerus("(916) 529-9191"), "+19165299191");
  assertEquals(normalizePhoneForSerus("916.529.9191"), "+19165299191");
});

Deno.test("normalizePhoneForSerus: non-US-shaped digit counts are passed through unguessed", () => {
  // 11 digits but not starting with "1" (a UK number, "020 7946 0958") —
  // neither confidently-US shape. Left exactly as given rather than guessing
  // a country code, which would be worse than the original 422.
  assertEquals(normalizePhoneForSerus("020 7946 0958"), "020 7946 0958");
});
