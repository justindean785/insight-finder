/**
 * wayback_cdx_test.ts — Deno tests for wayback_cdx_search (tool-registry.ts).
 * Happy path parses the CDX header + rows; error path (502) → { error }.
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
function resp(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body),
    body: { cancel: async () => {} },
  } as unknown as Response;
}

Deno.test("wayback_cdx_search: happy path returns earliest/latest + capped captures", async () => {
  const header = ["urlkey", "timestamp", "original", "statuscode"];
  const rows = Array.from({ length: 40 }, (_, i) => [
    "k", `2010010100000${i}`.slice(0, 14), `http://acme.com/${i}`, "200",
  ]);
  const fetchStub = stub(globalThis, "fetch", () => Promise.resolve(resp([header, ...rows])));
  try {
    const r = await getTool("wayback_cdx_search").execute({ url: "acme.com" }, {});
    assertEquals(r.ok, true);
    assertEquals(r.count, 40);
    assertEquals((r.captures as unknown[]).length, 25, "captures capped at 25");
    assert(typeof r.earliest === "string");
    assert(typeof r.latest === "string");
    const c0 = (r.captures as Array<Record<string, unknown>>)[0];
    assertEquals(c0.statuscode, "200");
  } finally { fetchStub.restore(); }
});

Deno.test("wayback_cdx_search: empty archive → count 0, no error", async () => {
  const fetchStub = stub(globalThis, "fetch", () => Promise.resolve(resp([])));
  try {
    const r = await getTool("wayback_cdx_search").execute({ url: "acme.com" }, {});
    assertEquals(r.ok, true);
    assertEquals(r.count, 0);
    assertEquals(r.captures, []);
  } finally { fetchStub.restore(); }
});

Deno.test("wayback_cdx_search: non-200 returns { error } and never throws", async () => {
  const fetchStub = stub(globalThis, "fetch", () => Promise.resolve(resp({}, 403)));
  try {
    const r = await getTool("wayback_cdx_search").execute({ url: "acme.com" }, {});
    assertEquals(r.ok, false);
    assertEquals(r.status, 403);
    assert(typeof r.error === "string");
  } finally { fetchStub.restore(); }
});
