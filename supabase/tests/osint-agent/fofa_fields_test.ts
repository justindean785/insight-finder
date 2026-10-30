// fofa_fields_test.ts — fofa_search must only request fields the account's plan
// can return.
//
// Measured 2026-10-30 (tool_usage_log, 14 days): fofa_search failed 7 of 7 calls,
// every one with `fofa 200: [820001] No permission to search as_organization
// field`. FOFA rejects the WHOLE request when the `fields` list names a field the
// plan lacks, so asking for `as_organization` turned every call into a failure,
// whatever the query. The tool was dead in production while its key was fine.
//
// FOFA_API_KEY is read inside execute(), so setting it here is enough.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.env.set("FOFA_API_KEY", "fofa_test_key");

const { buildTools } = await import("../../functions/osint-agent/tool-registry.ts");

type AnyRec = Record<string, unknown>;

function stubCtx() {
  const supabase = {
    from: (_t: string) => ({ insert: (_rows: AnyRec[]) => Promise.resolve({ error: null }) }),
  };
  return {
    supabase, supabaseAdmin: supabase, userId: "u", threadId: "t-fofa-fields",
    archiveEnabled: false, detectedSeedType: "domain", messages: [], manualOverrideSelector: null,
  } as unknown as Parameters<typeof buildTools>[0];
}

function getTool(name: string) {
  const { tools } = buildTools(stubCtx());
  return (tools as Record<string, { execute: (a: unknown, o: unknown) => Promise<unknown> }>)[name];
}

function stubFofa(body: unknown) {
  const urls: URL[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: Request | URL | string) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "en.fofa.info") urls.push(url);
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof globalThis.fetch;
  return { urls, restore: () => { globalThis.fetch = orig; } };
}

Deno.test("fofa_search does not request as_organization, which the plan cannot return", async () => {
  const fofa = stubFofa({ error: false, size: 0, results: [] });
  try {
    await getTool("fofa_search").execute({ query: 'domain="example.com"' }, {});
    assertEquals(fofa.urls.length, 1);
    const fields = (fofa.urls[0].searchParams.get("fields") ?? "").split(",");
    assert(!fields.includes("as_organization"), `fields still include as_organization: ${fields.join(",")}`);
    assert(fields.includes("host") && fields.includes("ip"), "core fields must still be requested");
  } finally {
    fofa.restore();
  }
});

Deno.test("fofa_search maps each returned row onto the requested fields in order", async () => {
  const fofa = stubFofa({
    error: false,
    size: 1,
    results: [["example.com", "93.184.216.34", "443", "https", "example.com", "Example", "nginx", "United States"]],
  });
  try {
    const res = await getTool("fofa_search").execute({ query: 'domain="example.com"' }, {}) as AnyRec;
    assertEquals(res.ok, true);
    const row = (res.results as AnyRec[])[0];
    assertEquals(row.ip, "93.184.216.34");
    assertEquals(row.country_name, "United States");
    assertEquals("as_organization" in row, false);
  } finally {
    fofa.restore();
  }
});

Deno.test("a FOFA permission error at HTTP 200 is still reported as a failure, not as zero assets", async () => {
  const fofa = stubFofa({ error: true, errmsg: "[820001] No permission to search icp field" });
  try {
    const res = await getTool("fofa_search").execute({ query: 'domain="example.com"' }, {}) as AnyRec;
    assert(typeof res.error === "string" && res.error.includes("820001"));
    assertEquals(res.ok, undefined);
  } finally {
    fofa.restore();
  }
});
