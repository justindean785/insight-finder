/**
 * census_geocode_test.ts — Deno tests for census_geocode (tool-registry.ts).
 * Happy path returns matched address + coords; error path (500) → { error }.
 */
import { assertEquals, assert } from "jsr:@std/assert@^1";
import { stub } from "jsr:@std/testing@^1/mock";
import { buildTools, type ToolContext } from "./tool-registry.ts";

function stubCtx(): ToolContext {
  return {
    supabase: {}, supabaseAdmin: {}, userId: "t", threadId: "t",
    archiveEnabled: false, detectedSeedType: "address", messages: [],
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

Deno.test("census_geocode: happy path returns matched address + coords", async () => {
  const body = {
    result: {
      addressMatches: [
        { matchedAddress: "1600 PENNSYLVANIA AVE NW, WASHINGTON, DC, 20500", coordinates: { x: -77.03, y: 38.89 } },
      ],
    },
  };
  const fetchStub = stub(globalThis, "fetch", () => Promise.resolve(resp(body)));
  try {
    const r = await getTool("census_geocode").execute({ address: "1600 Pennsylvania Ave NW" }, {});
    assertEquals(r.ok, true);
    assertEquals(r.matched, true);
    const m0 = (r.matches as Array<Record<string, unknown>>)[0];
    assertEquals(m0.lon, -77.03);
    assertEquals(m0.lat, 38.89);
  } finally { fetchStub.restore(); }
});

Deno.test("census_geocode: no match → matched:false, ok:true", async () => {
  const fetchStub = stub(globalThis, "fetch", () => Promise.resolve(resp({ result: { addressMatches: [] } })));
  try {
    const r = await getTool("census_geocode").execute({ address: "nowhere" }, {});
    assertEquals(r.ok, true);
    assertEquals(r.matched, false);
  } finally { fetchStub.restore(); }
});

Deno.test("census_geocode: non-200 → { error }, never throws", async () => {
  const fetchStub = stub(globalThis, "fetch", () => Promise.resolve(resp({}, 403)));
  try {
    const r = await getTool("census_geocode").execute({ address: "x" }, {});
    assertEquals(r.ok, false);
    assertEquals(r.status, 403);
    assert(typeof r.error === "string");
  } finally { fetchStub.restore(); }
});
