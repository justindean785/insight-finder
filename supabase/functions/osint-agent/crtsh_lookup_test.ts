/**
 * crtsh_lookup_test.ts — Deno tests for crtsh_lookup (tool-registry.ts).
 * Happy path dedups subdomains + issuers; error path (non-JSON / non-200) →
 * { error } and never throws.
 */
import { assertEquals, assert } from "jsr:@std/assert@^1";
import { stub } from "jsr:@std/testing@^1/mock";
import { buildTools, type ToolContext } from "./tool-registry.ts";

function stubCtx(): ToolContext {
  return {
    supabase: {}, supabaseAdmin: {}, userId: "t", threadId: "t",
    archiveEnabled: false, detectedSeedType: "domain", messages: [],
    manualOverrideSelector: null,
  } as unknown as ToolContext;
}
function getTool(name: string) {
  const { tools } = buildTools(stubCtx());
  return (tools as Record<string, { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> }>)[name];
}
function jsonResp(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body),
    body: { cancel: async () => {} },
  } as unknown as Response;
}
function htmlResp(status = 200): Response {
  return {
    ok: status >= 200 && status < 300, status,
    json: async () => { throw new SyntaxError("Unexpected token <"); },
    text: async () => "<html>overloaded</html>",
    body: { cancel: async () => {} },
  } as unknown as Response;
}

Deno.test("crtsh_lookup: happy path returns unique subdomains + issuers", async () => {
  const certs = [
    { name_value: "acme.com\nwww.acme.com", issuer_name: "Let's Encrypt" },
    { name_value: "www.acme.com\napi.acme.com", issuer_name: "Let's Encrypt" },
    { name_value: "mail.acme.com", issuer_name: "DigiCert" },
  ];
  const fetchStub = stub(globalThis, "fetch", () => Promise.resolve(jsonResp(certs)));
  try {
    const r = await getTool("crtsh_lookup").execute({ domain: "acme.com" }, {});
    assertEquals(r.ok, true);
    assertEquals(r.cert_count, 3);
    const subs = r.subdomains as string[];
    assertEquals(new Set(subs).size, subs.length, "subdomains are unique");
    assert(subs.includes("www.acme.com"));
    assertEquals((r.issuers as string[]).sort(), ["DigiCert", "Let's Encrypt"]);
  } finally { fetchStub.restore(); }
});

Deno.test("crtsh_lookup: non-JSON overload page → { error }, never throws", async () => {
  const fetchStub = stub(globalThis, "fetch", () => Promise.resolve(htmlResp(200)));
  try {
    const r = await getTool("crtsh_lookup").execute({ domain: "acme.com" }, {});
    assertEquals(r.ok, false);
    assert(typeof r.error === "string");
  } finally { fetchStub.restore(); }
});

Deno.test("crtsh_lookup: non-200 → { error }, never throws", async () => {
  const fetchStub = stub(globalThis, "fetch", () => Promise.resolve(jsonResp(null, 403)));
  try {
    const r = await getTool("crtsh_lookup").execute({ domain: "acme.com" }, {});
    assertEquals(r.ok, false);
    assertEquals(r.status, 403);
    assert(typeof r.error === "string");
  } finally { fetchStub.restore(); }
});
