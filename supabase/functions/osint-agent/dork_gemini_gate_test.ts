import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Fix #5c — the Gemini-read arm of the dork relevance gate. A dork hit whose URL
// does NOT carry the seed is READ by Gemini; it is recorded only if the seed
// appears in the extracted text, else held as a candidate link.
//
// PERPLEXITY_API_KEY is read at import (dork_harvest's perplexity path), so it is
// set before the dynamic import. GEMINI_API_KEY is read at CALL time by the
// dork read-branch, so it is set only INSIDE each test — setting it at import
// would pollute env.ts's boot-time fallback-provider selection for
// providers_test/fallback_repoint in the shared `deno test` process.
Deno.env.set("PERPLEXITY_API_KEY", "pplx-test-key");

const { buildTools } = await import("./tool-registry.ts");

const PPLX_HOST = "api.perplexity.ai";
const GEMINI_HOST = "generativelanguage.googleapis.com";
type Row = Record<string, unknown>;

/** Set GEMINI_API_KEY for the duration of fn only, then restore. */
async function withGeminiKey(fn: () => Promise<void>) {
  const orig = Deno.env.get("GEMINI_API_KEY");
  Deno.env.set("GEMINI_API_KEY", "gv-test-key");
  try { await fn(); }
  finally { if (orig === undefined) Deno.env.delete("GEMINI_API_KEY"); else Deno.env.set("GEMINI_API_KEY", orig); }
}

function stubCtx(sink: Row[]) {
  const supabase = {
    from: (_t: string) => ({ insert: (rows: Row[]) => { sink.push(...rows); return Promise.resolve({ error: null }); } }),
  };
  return {
    supabase, supabaseAdmin: supabase, userId: "u", threadId: "t-dork-gemini",
    archiveEnabled: false, detectedSeedType: "username", messages: [], manualOverrideSelector: null,
  } as unknown as Parameters<typeof buildTools>[0];
}
function getDork(sink: Row[]) {
  const { tools } = buildTools(stubCtx(sink));
  return (tools as Record<string, { execute: (a: unknown, o: unknown) => Promise<unknown> }>).dork_harvest;
}

// A doc whose URL lacks the seed but whose extracted TEXT contains it.
function makeFetch(extractedText: string, citation: string) {
  return (async (input: Request | URL | string) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes(PPLX_HOST)) {
      return new Response(JSON.stringify({ choices: [{ message: { content: "hit" } }], citations: [citation] }), { status: 200 });
    }
    if (url.includes(GEMINI_HOST)) {
      const modelJson = JSON.stringify({ extracted_text: extractedText, tables: [], selectors: ["found@example.com"], confidence: 70 });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: modelJson }] } }] }), { status: 200 });
    }
    // The doc byte-fetch (runGeminiVision → fetchBytes) — return small PDF bytes.
    return new Response(new Uint8Array([37, 80, 68, 70]), { status: 200, headers: { "content-type": "application/pdf" } });
  }) as typeof globalThis.fetch;
}

Deno.test("dork_harvest (e) Gemini reads the doc; seed FOUND in text → recorded, extracted_from_document", async () => {
  const origFetch = globalThis.fetch;
  const inserted: Row[] = [];
  try {
    globalThis.fetch = makeFetch("Report mentions zephyrquokka and contact found@example.com", "https://host.example/quarterly-report.pdf");
    await withGeminiKey(async () => {
      const dork = getDork(inserted);
      const res = await dork.execute({ seed: "zephyrquokka", kind: "username", max_queries: 1 }, {}) as {
        artifacts_inserted: number; gemini_reads: number; candidate_links_unread_count: number;
      };
      assertEquals(res.gemini_reads, 1);
      assertEquals(res.artifacts_inserted, 1);
      assertEquals(res.candidate_links_unread_count, 0);
      const meta = inserted[0].metadata as Record<string, unknown>;
      assertEquals(meta.provenance, "extracted_from_document");
      assertEquals(meta.read_by, "gemini_vision");
      assert(Array.isArray(meta.extracted_selectors));
    });
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("dork_harvest (f) Gemini reads the doc; seed ABSENT from text → candidate_links_unread, not recorded", async () => {
  const origFetch = globalThis.fetch;
  const inserted: Row[] = [];
  try {
    globalThis.fetch = makeFetch("This is an unrelated PNC SEC filing about quarterly earnings.", "https://host.example/pnc-10k.pdf");
    await withGeminiKey(async () => {
      const dork = getDork(inserted);
      const res = await dork.execute({ seed: "zephyrquokka", kind: "username", max_queries: 1 }, {}) as {
        artifacts_inserted: number; gemini_reads: number; candidate_links_unread_count: number;
      };
      assertEquals(res.gemini_reads, 1);
      assertEquals(res.artifacts_inserted, 0);
      assertEquals(res.candidate_links_unread_count, 1);
      assertEquals(inserted.length, 0);
    });
  } finally {
    globalThis.fetch = origFetch;
  }
});
