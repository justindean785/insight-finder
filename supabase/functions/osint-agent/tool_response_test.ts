/**
 * tool_response_test.ts — Deno tests for the LIVE inline tools' response
 * interpreters (tool_response.ts).
 *
 * These lock the core beta contract: a failed third-party lookup must NEVER
 * read as an authoritative empty/clean/not-found result. Each test names a
 * concrete real-world failure mode that previously produced a false negative
 * (see commits 173e520 / ff7a886). Pure functions — no network, no stubbing.
 */
import { assertEquals } from "jsr:@std/assert@^1";
import {
  okWithSuccessFlag,
  socialfetchError,
  isHackertargetApiError,
  isCrtshOk,
  dohTypeError,
  blockchairError,
} from "./tool_response.ts";

// ── okWithSuccessFlag (OSINTNova / leakcheck {success:false}-at-200) ─────────
Deno.test("okWithSuccessFlag: 200 + success:true → ok", () => {
  assertEquals(okWithSuccessFlag(true, { success: true, data: {} }), true);
});
Deno.test("okWithSuccessFlag: 200 + success:false (quota/error) → NOT ok", () => {
  assertEquals(okWithSuccessFlag(true, { success: false, error: "quota" }), false);
});
Deno.test("okWithSuccessFlag: 200 + no success field → ok (body unaffected)", () => {
  assertEquals(okWithSuccessFlag(true, { result: "data" }), true);
});
Deno.test("okWithSuccessFlag: HTTP error → NOT ok regardless of body", () => {
  assertEquals(okWithSuccessFlag(false, { success: true }), false);
});
Deno.test("okWithSuccessFlag: malformed/raw body → follows http status", () => {
  assertEquals(okWithSuccessFlag(true, { raw: "not json" }), true);
  assertEquals(okWithSuccessFlag(false, null), false);
});

// ── socialfetchError ({error:{code,message}}) ───────────────────────────────
Deno.test("socialfetchError: success {data,meta} → no error", () => {
  assertEquals(socialfetchError({ data: {}, meta: {} }), undefined);
});
Deno.test("socialfetchError: error envelope → returns the error", () => {
  assertEquals(socialfetchError({ error: { code: "unauthorized", message: "Missing API key." } }), {
    code: "unauthorized",
    message: "Missing API key.",
  });
});
Deno.test("socialfetchError: null/raw body → no error", () => {
  assertEquals(socialfetchError(null), undefined);
  assertEquals(socialfetchError({ raw: "x" }), undefined);
});

// ── isHackertargetApiError (HTTP-200 plain-text error bodies) ────────────────
Deno.test("isHackertargetApiError: real recon output → not an error", () => {
  assertEquals(isHackertargetApiError("8.8.8.8,dns.google\n1.1.1.1,one.one"), false);
});
Deno.test("isHackertargetApiError: 'error invalid host' → error", () => {
  assertEquals(isHackertargetApiError("error invalid host"), true);
});
Deno.test("isHackertargetApiError: quota body → error", () => {
  assertEquals(isHackertargetApiError("API count exceeded - Increase Quota with Membership"), true);
});
Deno.test("isHackertargetApiError: 'No DNS Records found' → error", () => {
  assertEquals(isHackertargetApiError("No DNS Records found"), true);
});
Deno.test("isHackertargetApiError: a hostname starting with 'error' is not matched mid-line", () => {
  // The sentinel is anchored to the start of the body, so a legit first line wins.
  assertEquals(isHackertargetApiError("errordomain.com,1.2.3.4"), true); // anchored ^error
  assertEquals(isHackertargetApiError("mail.error.com,1.2.3.4"), false);
});

// ── isCrtshOk (2xx + JSON array) ────────────────────────────────────────────
Deno.test("isCrtshOk: 200 + array → ok", () => {
  assertEquals(isCrtshOk(true, [{ name_value: "a.example.com" }]), true);
  assertEquals(isCrtshOk(true, []), true); // genuinely empty is still a valid result
});
Deno.test("isCrtshOk: 5xx → NOT ok (must not read as 0 subdomains)", () => {
  assertEquals(isCrtshOk(false, [{ name_value: "x" }]), false);
});
Deno.test("isCrtshOk: 200 + HTML/non-array overload page → NOT ok", () => {
  assertEquals(isCrtshOk(true, null), false);
  assertEquals(isCrtshOk(true, { message: "rate limited" }), false);
});

// ── dohTypeError (Cloudflare DoH rcode logic) ───────────────────────────────
Deno.test("dohTypeError: NOERROR (0) → no error", () => {
  assertEquals(dohTypeError(true, 200, 0), null);
});
Deno.test("dohTypeError: NXDOMAIN (3) → no error (real negative)", () => {
  assertEquals(dohTypeError(true, 200, 3), null);
});
Deno.test("dohTypeError: SERVFAIL (2) → error (not 'no records')", () => {
  assertEquals(dohTypeError(true, 200, 2), "dns rcode 2");
});
Deno.test("dohTypeError: HTTP error → error", () => {
  assertEquals(dohTypeError(false, 503, 0), "doh http 503");
});
Deno.test("dohTypeError: missing Status field → trusts http ok", () => {
  assertEquals(dohTypeError(true, 200, undefined), null);
});

// ── blockchairError (ETH dashboard) ─────────────────────────────────────────
Deno.test("blockchairError: real dashboard → no error", () => {
  assertEquals(blockchairError({ data: { "0xabc": { address: {} } }, context: { code: 200 } }), null);
});
Deno.test("blockchairError: context.error set → error", () => {
  assertEquals(blockchairError({ data: null, context: { error: "Invalid address" } }), "Invalid address");
});
Deno.test("blockchairError: data:null without explicit error → error", () => {
  assertEquals(blockchairError({ data: null, context: {} }), "blockchair returned no address data");
});
Deno.test("blockchairError: empty/raw body → error (no data)", () => {
  assertEquals(blockchairError({}), "blockchair returned no address data");
  assertEquals(blockchairError(null), "blockchair returned no address data");
});
