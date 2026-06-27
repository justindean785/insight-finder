/**
 * opencorporates_test.ts — Deno tests for opencorporates_search (tool-registry.ts).
 *
 * OpenCorporates retired keyless access: the v0.4 search endpoint now returns
 * 401 "Invalid Api Token" for every anonymous request. The tool is therefore
 * key-gated — without OPENCORPORATES_API_KEY it self-skips BEFORE any fetch
 * (matching the codebase's "tool self-skips when its key is missing" pattern),
 * so no doomed 401 call is ever made. These tests run with the key unset (the
 * default in CI), so they exercise that skip path.
 */
import { assertEquals, assert, assertStringIncludes } from "jsr:@std/assert@^1";
import { stub } from "jsr:@std/testing@^1/mock";
import { buildTools, type ToolContext } from "./tool-registry.ts";
import { OPENCORPORATES_API_KEY } from "./env.ts";

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

Deno.test("opencorporates_search: no API key → self-skips with { error, skipped } and never fetches", {
  ignore: !!OPENCORPORATES_API_KEY, // only meaningful when the key is unset (CI default)
}, async () => {
  let fetched = false;
  const fetchStub = stub(globalThis, "fetch", () => {
    fetched = true;
    return Promise.reject(new Error("fetch must NOT be called when the key is missing"));
  });
  try {
    const r = await getTool("opencorporates_search").execute({ name: "Acme" }, {});
    assertEquals(r.ok, undefined);
    assertEquals(r.skipped, true);
    assertStringIncludes(r.error as string, "OPENCORPORATES_API_KEY not configured");
    assert(!fetched, "no network call is made on the keyless skip path");
  } finally { fetchStub.restore(); }
});
