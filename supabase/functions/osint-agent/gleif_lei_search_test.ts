/**
 * gleif_lei_search_test.ts — Deno tests for gleif_lei_search (tool-registry.ts).
 * Happy path trims + caps GLEIF LEI records; empty exact match falls back to
 * fuzzycompletions; a non-2xx (400) returns a clean { ok:false, error } w/o throw.
 */
import { assertEquals, assert } from "jsr:@std/assert@^1";
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

Deno.test("gleif_lei_search: happy path returns trimmed, capped LEI records", async () => {
  const data = Array.from({ length: 15 }, (_, i) => ({
    type: "lei-records", id: `LEI${i}`,
    attributes: {
      lei: `LEI${i}`,
      entity: {
        legalName: { name: `Acme ${i} Inc` },
        legalAddress: { city: "New York", country: "US", heavy: "x".repeat(1000) },
        jurisdiction: "US-DE", status: "ACTIVE",
      },
      registration: { status: "ISSUED" },
    },
  }));
  const fetchStub = stub(globalThis, "fetch", () => Promise.resolve(resp({ data })));
  try {
    const r = await getTool("gleif_lei_search").execute({ name: "Acme" }, {});
    assertEquals(r.ok, true);
    assertEquals(r.count, 10, "capped at 10");
    const c0 = (r.records as Array<Record<string, unknown>>)[0];
    assertEquals(c0.lei, "LEI0");
    assertEquals(c0.legalName, "Acme 0 Inc");
    assertEquals(c0.jurisdiction, "US-DE");
    assertEquals(c0.registrationStatus, "ISSUED");
    assertEquals((c0.legalAddress as Record<string, unknown>).country, "US");
    assert(!("heavy" in (c0.legalAddress as Record<string, unknown>)), "heavy fields trimmed");
  } finally { fetchStub.restore(); }
});

Deno.test("gleif_lei_search: empty exact match → fuzzy suggestions", async () => {
  const fetchStub = stub(globalThis, "fetch", (url: string | URL | Request) => {
    if (String(url).includes("fuzzycompletions")) {
      return Promise.resolve(resp({ data: [
        { attributes: { value: "Acme Corporation" }, relationships: { "lei-records": { data: { id: "LEI999" } } } },
      ] }));
    }
    return Promise.resolve(resp({ data: [] }));
  });
  try {
    const r = await getTool("gleif_lei_search").execute({ name: "Acme" }, {});
    assertEquals(r.ok, true);
    assertEquals(r.count, 0);
    assertEquals(r.fuzzy, true);
    const s0 = (r.suggestions as Array<Record<string, unknown>>)[0];
    assertEquals(s0.legalName, "Acme Corporation");
    assertEquals(s0.lei, "LEI999");
  } finally { fetchStub.restore(); }
});

Deno.test("gleif_lei_search: non-2xx → clean { ok:false, error }, no throw", async () => {
  // 400 is non-retryable (fetchRetry retries only 429/5xx) so the test stays fast.
  const fetchStub = stub(globalThis, "fetch", () => Promise.resolve(resp({}, 400)));
  try {
    const r = await getTool("gleif_lei_search").execute({ name: "Acme" }, {});
    assertEquals(r.ok, false);
    assertEquals(r.status, 400);
    assert(typeof r.error === "string");
  } finally { fetchStub.restore(); }
});
