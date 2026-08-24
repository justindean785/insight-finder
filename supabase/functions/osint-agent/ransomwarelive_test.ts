/**
 * ransomwarelive_test.ts — Deno tests for the ransomwarelive_lookup tool
 * (tool-registry.ts). The tool uses api-pro.ransomware.live with an X-API-KEY
 * (the free api.ransomware.live host was retired); without RANSOMWARELIVE_API_KEY
 * it self-reports { ok:false, degraded:true } and makes no request.
 *
 * RANSOMWARELIVE_API_KEY is read at env.ts module-load, so the api-pro
 * happy/404/error paths can only be exercised when the key is present in the
 * process env. They are guarded with `ignore` so the keyless CI suite skips them
 * (green) rather than failing; the no-key degraded path always runs.
 */
import { assertEquals, assert } from "jsr:@std/assert@^1";
import { stub } from "jsr:@std/testing@^1/mock";
import { buildTools, type ToolContext } from "./tool-registry.ts";

const HAS_KEY = !!Deno.env.get("RANSOMWARELIVE_API_KEY");

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
function resp(body: unknown, status = 200, text?: string, contentType = "application/json"): Response {
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? contentType : null) },
    json: async () => body,
    text: async () => (text !== undefined ? text : JSON.stringify(body)),
    body: { cancel: async () => {} },
  } as unknown as Response;
}

Deno.test({
  name: "ransomwarelive_lookup: no key → degraded (free API retired), never throws, no fetch",
  ignore: HAS_KEY,
  fn: async () => {
    let called = false;
    const fetchStub = stub(globalThis, "fetch", () => { called = true; return Promise.resolve(resp({}, 200)); });
    try {
      const r = await getTool("ransomwarelive_lookup").execute({ domain: "acme.com" }, {});
      assertEquals(r.ok, false);
      assertEquals(r.degraded, true);
      assert(typeof r.error === "string");
      assertEquals(called, false, "must not call the retired free API without a key");
    } finally { fetchStub.restore(); }
  },
});

Deno.test({
  name: "ransomwarelive_lookup: happy path returns trimmed, capped victims",
  ignore: !HAS_KEY,
  fn: async () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      victim: `acme.com`, group_name: `grp${i}`, discovered: "2024-01-01",
      description: "x".repeat(500),
    }));
    const fetchStub = stub(globalThis, "fetch", () => Promise.resolve(resp(rows)));
    try {
      const r = await getTool("ransomwarelive_lookup").execute({ domain: "acme.com" }, {});
      assertEquals(r.ok, true);
      assertEquals(r.listed, true);
      assertEquals(r.count, 25, "capped at 25");
      assertEquals((r.victims as unknown[]).length, 25);
      const v0 = (r.victims as Array<Record<string, unknown>>)[0];
      assertEquals(v0.group, "grp0");
      assert((v0.description as string).length <= 300, "description trimmed");
    } finally { fetchStub.restore(); }
  },
});

Deno.test({
  name: "ransomwarelive_lookup: 404 means not listed (ok:true, victims:[])",
  ignore: !HAS_KEY,
  fn: async () => {
    const fetchStub = stub(globalThis, "fetch", () => Promise.resolve(resp({}, 404)));
    try {
      const r = await getTool("ransomwarelive_lookup").execute({ domain: "nope.com" }, {});
      assertEquals(r.ok, true);
      assertEquals(r.listed, false);
      assertEquals(r.victims, []);
    } finally { fetchStub.restore(); }
  },
});

Deno.test({
  name: "ransomwarelive_lookup: non-200 returns { error } and never throws",
  ignore: !HAS_KEY,
  fn: async () => {
    const fetchStub = stub(globalThis, "fetch", () => Promise.resolve(resp({}, 403)));
    try {
      const r = await getTool("ransomwarelive_lookup").execute({ domain: "acme.com" }, {});
      assertEquals(r.ok, false);
      assertEquals(r.status, 403);
      assert(typeof r.error === "string");
    } finally { fetchStub.restore(); }
  },
});
