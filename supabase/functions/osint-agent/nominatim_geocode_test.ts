/**
 * nominatim_geocode_test.ts — Deno tests for nominatim_geocode (tool-registry.ts).
 * Happy path returns top match + residential/commercial hint and sends a
 * descriptive User-Agent; error path (403) → { error }.
 */
import { assertEquals, assert, assertStringIncludes } from "jsr:@std/assert@^1";
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

Deno.test("nominatim_geocode: happy path → top match + place_type, descriptive UA", async () => {
  let sentUA = "";
  const body = [
    { display_name: "10 Downing St, London", lat: "51.50", lon: "-0.12", category: "building", type: "house", addresstype: "house" },
  ];
  const fetchStub = stub(globalThis, "fetch", (_url: string | URL | Request, init?: RequestInit) => {
    const h = (init?.headers ?? {}) as Record<string, string>;
    sentUA = h["User-Agent"] ?? "";
    return Promise.resolve(resp(body));
  });
  try {
    const r = await getTool("nominatim_geocode").execute({ address: "10 Downing St" }, {});
    assertEquals(r.ok, true);
    assertEquals(r.matched, true);
    assertEquals(r.lat, "51.50");
    assertEquals(r.place_type, "residential");
    assertStringIncludes(sentUA, "insight-finder-osint", "must send a descriptive User-Agent (OSM policy)");
  } finally { fetchStub.restore(); }
});

Deno.test("nominatim_geocode: no result → matched:false, ok:true", async () => {
  const fetchStub = stub(globalThis, "fetch", () => Promise.resolve(resp([])));
  try {
    const r = await getTool("nominatim_geocode").execute({ address: "zzz" }, {});
    assertEquals(r.ok, true);
    assertEquals(r.matched, false);
  } finally { fetchStub.restore(); }
});

Deno.test("nominatim_geocode: non-200 → { error }, never throws", async () => {
  const fetchStub = stub(globalThis, "fetch", () => Promise.resolve(resp({}, 403)));
  try {
    const r = await getTool("nominatim_geocode").execute({ address: "x" }, {});
    assertEquals(r.ok, false);
    assertEquals(r.status, 403);
    assert(typeof r.error === "string");
  } finally { fetchStub.restore(); }
});
