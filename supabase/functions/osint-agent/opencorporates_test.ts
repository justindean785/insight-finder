/**
 * opencorporates_test.ts — Deno tests for opencorporates_search
 * (tool-registry.ts). Happy path trims + caps companies; the common keyless
 * 401/403/429 path returns a clean { error, status } and never throws.
 */
import { assertEquals, assert, assertStringIncludes } from "jsr:@std/assert@^1";
import { stub } from "jsr:@std/testing@^1/mock";
import { buildTools, type ToolContext } from "./tool-registry.ts";

function stubCtx(): ToolContext {
  return {
    supabase: {}, supabaseAdmin: {}, userId: "t", threadId: "t",
    archiveEnabled: false, detectedSeedType: "name", messages: [],
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

Deno.test("opencorporates_search: happy path returns trimmed, capped companies", async () => {
  const companies = Array.from({ length: 30 }, (_, i) => ({
    company: {
      name: `Acme ${i} Inc`, jurisdiction_code: "us_de", company_number: `${1000 + i}`,
      incorporation_date: "2001-01-01", current_status: "Active",
      registry_url: "drop-me", source: { huge: "x".repeat(1000) },
    },
  }));
  const fetchStub = stub(globalThis, "fetch", () => Promise.resolve(resp({ results: { companies } })));
  try {
    const r = await getTool("opencorporates_search").execute({ name: "Acme" }, {});
    assertEquals(r.ok, true);
    assertEquals(r.count, 20, "capped at 20");
    const c0 = (r.companies as Array<Record<string, unknown>>)[0];
    assertEquals(c0.name, "Acme 0 Inc");
    assertEquals(c0.jurisdiction_code, "us_de");
    assert(!("registry_url" in c0), "heavy fields trimmed away");
  } finally { fetchStub.restore(); }
});

Deno.test("opencorporates_search: 401 (no token) → clean { error, status }, no throw", async () => {
  const fetchStub = stub(globalThis, "fetch", () => Promise.resolve(resp({}, 401)));
  try {
    const r = await getTool("opencorporates_search").execute({ name: "Acme" }, {});
    assertEquals(r.ok, false);
    assertEquals(r.status, 401);
    assertStringIncludes(r.error as string, "token");
  } finally { fetchStub.restore(); }
});

Deno.test("opencorporates_search: 429 rate-limit → clean { error, status }, no throw", async () => {
  // fetchRetry retries 429; the stub returns 429 each attempt and the tool must
  // ultimately surface a clean error object rather than throw.
  const fetchStub = stub(globalThis, "fetch", () => Promise.resolve(resp({}, 429)));
  try {
    const r = await getTool("opencorporates_search").execute({ name: "Acme" }, {});
    assertEquals(r.ok, false);
    assertEquals(r.status, 429);
    assert(typeof r.error === "string");
  } finally { fetchStub.restore(); }
});
