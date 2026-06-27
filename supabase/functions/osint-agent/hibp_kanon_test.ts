/**
 * hibp_kanon_test.ts — Deno tests for hibp_pwned_passwords_kanon
 * (tool-registry.ts). Verifies happy path (suffix matched → count), the
 * not-pwned path, the error path, AND the PRIVACY invariant: only the 5-char
 * SHA-1 prefix is ever sent — never the password or the full hash.
 *
 * SHA-1("password") = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
 *   prefix = 5BAA6   suffix = 1E4C9B93F3F0682250B6CF8331B7EE68FD8
 */
import { assertEquals, assert, assertStringIncludes } from "jsr:@std/assert@^1";
import { stub } from "jsr:@std/testing@^1/mock";
import { buildTools, type ToolContext } from "./tool-registry.ts";

const PW = "password";
const PREFIX = "5BAA6";
const SUFFIX = "1E4C9B93F3F0682250B6CF8331B7EE68FD8";

function stubCtx(): ToolContext {
  return {
    supabase: {}, supabaseAdmin: {}, userId: "t", threadId: "t",
    archiveEnabled: false, detectedSeedType: "email", messages: [],
    manualOverrideSelector: null,
  } as unknown as ToolContext;
}
function getTool(name: string) {
  const { tools } = buildTools(stubCtx());
  return (tools as Record<string, { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> }>)[name];
}
function textResp(text: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300, status,
    text: async () => text,
    json: async () => ({}),
    body: { cancel: async () => {} },
  } as unknown as Response;
}

Deno.test("hibp_kanon: pwned password → count, and ONLY the 5-char prefix is sent", async () => {
  let sentUrl = "";
  const body = `0018A45C4D1DEF81644B54AB7F969B88D65:1\r\n${SUFFIX}:99\r\nFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:0`;
  const fetchStub = stub(globalThis, "fetch", (url: string | URL | Request) => {
    sentUrl = String(url);
    return Promise.resolve(textResp(body));
  });
  try {
    const r = await getTool("hibp_pwned_passwords_kanon").execute({ password: PW }, {});
    assertEquals(r.ok, true);
    assertEquals(r.pwned, true);
    assertEquals(r.count, 99);
    // PRIVACY: only the 5-char prefix leaves; never the password or full hash.
    // (Check the path segment after /range/ — the host "pwnedpasswords.com"
    // happens to contain the substring "password", so a whole-URL substring
    // check would false-positive.)
    assertEquals(sentUrl, `https://api.pwnedpasswords.com/range/${PREFIX}`);
    const sentSegment = sentUrl.split("/range/")[1] ?? "";
    assertEquals(sentSegment, PREFIX, "exactly the 5-char prefix is the request path");
    assertEquals(sentSegment.length, 5, "only 5 chars sent");
    assert(!sentSegment.includes(SUFFIX), "full-hash suffix must NOT be sent");
    assert(!sentSegment.toLowerCase().includes(PW), "plaintext password must NOT be sent");
  } finally { fetchStub.restore(); }
});

Deno.test("hibp_kanon: suffix absent → pwned:false, count:0", async () => {
  const fetchStub = stub(globalThis, "fetch", () => Promise.resolve(textResp("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:3")));
  try {
    const r = await getTool("hibp_pwned_passwords_kanon").execute({ password: PW }, {});
    assertEquals(r.ok, true);
    assertEquals(r.pwned, false);
    assertEquals(r.count, 0);
  } finally { fetchStub.restore(); }
});

Deno.test("hibp_kanon: accepts a precomputed sha1 and still sends only the prefix", async () => {
  let sentUrl = "";
  const fetchStub = stub(globalThis, "fetch", (url: string | URL | Request) => {
    sentUrl = String(url);
    return Promise.resolve(textResp(`${SUFFIX}:5`));
  });
  try {
    const r = await getTool("hibp_pwned_passwords_kanon").execute(
      { sha1: "5baa61e4c9b93f3f0682250b6cf8331b7ee68fd8" }, {},
    );
    assertEquals(r.ok, true);
    assertEquals(r.count, 5);
    assertEquals(sentUrl, `https://api.pwnedpasswords.com/range/${PREFIX}`);
  } finally { fetchStub.restore(); }
});

Deno.test("hibp_kanon: non-200 → { error }, never throws", async () => {
  // 403 is non-retryable (fetchRetry only retries 429/5xx) so the test stays fast.
  const fetchStub = stub(globalThis, "fetch", () => Promise.resolve(textResp("forbidden", 403)));
  try {
    const r = await getTool("hibp_pwned_passwords_kanon").execute({ password: PW }, {});
    assertEquals(r.ok, false);
    assert(typeof r.error === "string");
  } finally { fetchStub.restore(); }
});
