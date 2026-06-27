import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * dork_harvest end-to-end tests (the 400-fix regression guard).
 *
 * env.ts captures API keys at module-load time, so they must be set BEFORE the
 * first import of env.ts (transitively, tool-registry.ts). This file:
 *   - sorts FIRST among the osint-agent test files (the "aaa_" prefix), and
 *   - has NO static import that pulls env.ts; it imports tool-registry.ts
 *     DYNAMICALLY after Deno.env.set, so the keys are captured as set.
 * That makes the keyed happy-path and Exa-fallback paths exercisable.
 */
Deno.env.set("PERPLEXITY_API_KEY", "pplx-test-key");
Deno.env.set("EXA_API_KEY", "exa-test-key");

const { buildTools } = await import("./tool-registry.ts");

const PPLX_HOST = "api.perplexity.ai";
const EXA_HOST = "api.exa.ai";

type Row = Record<string, unknown>;

function stubCtx(insertedSink: Row[]) {
  const supabase = {
    from: (_table: string) => ({
      insert: (rows: Row[]) => {
        insertedSink.push(...rows);
        return Promise.resolve({ error: null });
      },
    }),
  };
  return {
    supabase,
    supabaseAdmin: supabase,
    userId: "dork-test-user",
    threadId: "dork-test-thread",
    archiveEnabled: false,
    detectedSeedType: "email",
    messages: [],
    manualOverrideSelector: null,
  } as unknown as Parameters<typeof buildTools>[0];
}

function getDork(insertedSink: Row[]) {
  const { tools } = buildTools(stubCtx(insertedSink));
  return (tools as Record<string, { execute: (a: unknown, o: unknown) => Promise<unknown> }>).dork_harvest;
}

Deno.test("dork_harvest (a) happy path: Perplexity citations parsed + classified into document/leak_paste", async () => {
  const origFetch = globalThis.fetch;
  const inserted: Row[] = [];
  try {
    globalThis.fetch = (async (input: Request | URL | string) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes(PPLX_HOST)) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: "Results:\nhttps://victim.example/leak.pdf\nhttps://pastebin.com/abc123" } }],
          citations: ["https://victim.example/leak.pdf", "https://pastebin.com/abc123", "https://nonmatch.example/page"],
        }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${url}`); // Exa must NOT be hit on the happy path
    }) as typeof globalThis.fetch;

    const dork = getDork(inserted);
    const res = await dork.execute({ seed: "alice@example.com", kind: "email", max_queries: 1 }, {}) as {
      ok: boolean; artifacts_inserted: number; provider_stats: Record<string, number>; sample: Array<{ classify: string }>;
    };

    assertEquals(res.ok, true);
    // leak.pdf → document, pastebin → leak_paste; nonmatch dropped.
    assertEquals(res.artifacts_inserted, 2);
    assert(res.provider_stats.perplexity >= 1, "primary provider must be labelled perplexity");
    assertEquals(res.provider_stats.exa, 0);
    const kinds = inserted.map((r) => r.kind).sort();
    assertEquals(kinds, ["document", "leak_paste"]);
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("dork_harvest (b) primary failure → falls back to Exa and returns Exa URLs", async () => {
  const origFetch = globalThis.fetch;
  const inserted: Row[] = [];
  let exaCalled = false;
  try {
    globalThis.fetch = (async (input: Request | URL | string) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes(PPLX_HOST)) return new Response("bad request", { status: 400 }); // the historical bug status
      if (url.includes(EXA_HOST)) {
        exaCalled = true;
        return new Response(JSON.stringify({
          results: [{ url: "https://dump.example/breach.csv" }, { url: "https://rentry.co/leak42" }],
        }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof globalThis.fetch;

    const dork = getDork(inserted);
    const res = await dork.execute({ seed: "bob", kind: "username", max_queries: 1 }, {}) as {
      ok: boolean; artifacts_inserted: number; degraded: boolean;
      provider_stats: Record<string, number>; per_query: Array<{ provider?: string }>;
    };

    assert(exaCalled, "Exa fallback must be invoked when Perplexity 400s");
    assertEquals(res.ok, true);
    assertEquals(res.artifacts_inserted, 2); // breach.csv (document) + rentry.co (leak_paste)
    assertEquals(res.degraded, true);
    assertEquals(res.provider_stats.exa, 1);
    assertEquals(res.per_query[0].provider, "exa_search");
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("dork_harvest (c) dork→Exa translation: drops filetype:/quotes, maps site: to includeDomains", async () => {
  const origFetch = globalThis.fetch;
  const inserted: Row[] = [];
  let exaBody: Record<string, unknown> | null = null;
  try {
    globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes(PPLX_HOST)) return new Response("server error", { status: 500 }); // force fallback
      if (url.includes(EXA_HOST)) {
        exaBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response(JSON.stringify({ results: [{ url: "https://x.example/a.pdf" }] }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof globalThis.fetch;

    // domain kind, query #1 is: site:example.com (ext:env OR ext:log OR ...)
    const dork = getDork(inserted);
    await dork.execute({ seed: "example.com", kind: "domain", max_queries: 1 }, {});

    assert(exaBody, "Exa must have been called");
    const body = exaBody as { query: string; includeDomains?: string[]; type?: string };
    assertEquals(body.includeDomains, ["example.com"]);
    assertEquals(body.type, "keyword");
    // No dork operators leak into the keyword query.
    assertEquals(/filetype:|ext:|site:|intitle:|inurl:|["']/.test(body.query), false);
  } finally {
    globalThis.fetch = origFetch;
  }
});
