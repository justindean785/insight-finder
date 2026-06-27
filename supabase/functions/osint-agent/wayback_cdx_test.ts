/**
 * wayback_cdx_test.ts — Deno tests for wayback_cdx_search (tool-registry.ts).
 * The tool now fires THREE tiny queries: a 25-row sample page plus two bookend
 * queries (&limit=1 = oldest, &limit=-1 = newest) so earliest/latest are
 * accurate and NOT understated by the capped sample. `sampled_count` is the
 * sample size, never the total. Error path (403) → { error }.
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

Deno.test("wayback_cdx_search: bookends come from separate queries, not the capped sample", async () => {
  const sampleHeader = ["urlkey", "timestamp", "original", "statuscode"];
  // 25 sample rows all clustered in 2010 — if the tool derived bookends from
  // THIS page it would report 2010 as both earliest and latest (the bug).
  const sampleRows = Array.from({ length: 25 }, (_, i) => [
    "k", `2010010100000${i}`.slice(0, 14), `http://acme.com/${i}`, "200",
  ]);
  const fetchStub = stub(globalThis, "fetch", (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("limit=-1")) return Promise.resolve(resp([["timestamp"], ["20230101000000"]]));
    if (u.includes("limit=1")) return Promise.resolve(resp([["timestamp"], ["19990101000000"]]));
    return Promise.resolve(resp([sampleHeader, ...sampleRows]));
  });
  try {
    const r = await getTool("wayback_cdx_search").execute({ url: "acme.com" }, {});
    assertEquals(r.ok, true);
    assertEquals(r.archived, true);
    assertEquals(r.earliest, "19990101000000", "earliest from &limit=1 query, not the 2010 sample");
    assertEquals(r.latest, "20230101000000", "latest from &limit=-1 query, not the 2010 sample");
    assertEquals(r.sampled_count, 25, "sampled_count is the sample size");
    assertEquals(r.capped, true, "capped flags that more captures exist than sampled");
    assert(!("count" in r), "no field presents the sample size as a complete total");
    assertEquals((r.captures as unknown[]).length, 25, "captures capped at 25");
  } finally { fetchStub.restore(); }
});

Deno.test("wayback_cdx_search: empty archive → archived:false, no error", async () => {
  const fetchStub = stub(globalThis, "fetch", () => Promise.resolve(resp([])));
  try {
    const r = await getTool("wayback_cdx_search").execute({ url: "acme.com" }, {});
    assertEquals(r.ok, true);
    assertEquals(r.archived, false);
    assertEquals(r.sampled_count, 0);
    assertEquals(r.earliest, null);
    assertEquals(r.captures, []);
  } finally { fetchStub.restore(); }
});

Deno.test("wayback_cdx_search: non-200 sample returns { error } and never throws", async () => {
  const fetchStub = stub(globalThis, "fetch", () => Promise.resolve(resp({}, 403)));
  try {
    const r = await getTool("wayback_cdx_search").execute({ url: "acme.com" }, {});
    assertEquals(r.ok, false);
    assertEquals(r.status, 403);
    assert(typeof r.error === "string");
  } finally { fetchStub.restore(); }
});
