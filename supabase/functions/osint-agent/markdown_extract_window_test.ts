// markdown_extract_window_test.ts — a long document is PAGED, never silently
// truncated.
//
// The tool returned `content.slice(0, 12000)` with a bare `truncated: true` and
// no way to reach the rest. A 41,842-char upload arrived as 29% of itself, and
// nothing in the result told the model the other 71% was retrievable — so it
// reasoned over a fragment as though it were the whole document.
//
// The window stays 12k deliberately: raising it trades a truncation bug for a
// context-growth bug, and context growth is the measured cause of the 180s
// invocation ceiling (27 of 54 invocations forced-finalize at ~182s).
import { assert, assertEquals } from "jsr:@std/assert@^1";
import { buildTools, MARKDOWN_EXTRACT_WINDOW, type ToolContext } from "./tool-registry.ts";

type AnyRec = Record<string, unknown>;

function stubCtx() {
  const supabase = {
    from: (_t: string) => ({ insert: (_rows: AnyRec[]) => Promise.resolve({ error: null }) }),
  };
  return {
    supabase, supabaseAdmin: supabase, userId: "u", threadId: "t-md-window",
    archiveEnabled: false, detectedSeedType: "url", messages: [], manualOverrideSelector: null,
  } as unknown as ToolContext;
}

function getTool(name: string) {
  const { tools } = buildTools(stubCtx());
  return (tools as Record<string, { execute: (a: unknown, o: unknown) => Promise<unknown> }>)[name];
}

/** The real production size: a 41,842-char document. */
const DOC = "x".repeat(41_842);

function stubMarkdownNew(content: string) {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: Request | URL | string) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("markdown.new")) {
      return new Response(JSON.stringify({ success: true, title: "Doc", content, tokens: 9 }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof globalThis.fetch;
  return () => { globalThis.fetch = orig; };
}

Deno.test("the first window reports the TRUE total and how to get the rest", async () => {
  const restore = stubMarkdownNew(DOC);
  try {
    const r = await getTool("markdown_extract").execute({ url: "https://example.com/a.pdf" }, {}) as AnyRec;
    assertEquals(r.ok, true);
    assertEquals(r.total_chars, 41_842, "the model must see the document's real size");
    assertEquals(r.offset, 0);
    assertEquals(r.returned_chars, MARKDOWN_EXTRACT_WINDOW);
    assertEquals((r.content as string).length, MARKDOWN_EXTRACT_WINDOW);
    assertEquals(r.next_offset, MARKDOWN_EXTRACT_WINDOW, "a non-null next_offset is the signal there is more");
    assertEquals(r.truncated, true);
  } finally { restore(); }
});

Deno.test("paging with next_offset reaches the END of the document, losing nothing", async () => {
  const restore = stubMarkdownNew(DOC);
  try {
    const tool = getTool("markdown_extract");
    let offset: number | null = 0;
    let assembled = "";
    let calls = 0;
    while (offset !== null) {
      const r = await tool.execute({ url: "https://example.com/a.pdf", offset }, {}) as AnyRec;
      assembled += r.content as string;
      offset = r.next_offset as number | null;
      if (++calls > 10) break; // guard against a non-terminating pager
    }
    assertEquals(assembled.length, DOC.length, "paging must reconstruct the whole document");
    assertEquals(assembled, DOC);
    assertEquals(calls, 4, "41,842 chars at a 12k window is exactly 4 calls");
  } finally { restore(); }
});

Deno.test("the FINAL window reports next_offset null, so the model knows to stop", async () => {
  const restore = stubMarkdownNew(DOC);
  try {
    const r = await getTool("markdown_extract").execute(
      { url: "https://example.com/a.pdf", offset: 36_000 }, {},
    ) as AnyRec;
    assertEquals(r.next_offset, null);
    assertEquals(r.returned_chars, 41_842 - 36_000);
  } finally { restore(); }
});

Deno.test("a SHORT document is returned whole, with no paging signal", async () => {
  const restore = stubMarkdownNew("a short report");
  try {
    const r = await getTool("markdown_extract").execute({ url: "https://example.com/b.txt" }, {}) as AnyRec;
    assertEquals(r.content, "a short report");
    assertEquals(r.next_offset, null);
    assertEquals(r.truncated, false, "a whole document must not be labelled truncated");
    assertEquals(r.total_chars, 14);
  } finally { restore(); }
});

Deno.test("an offset past the end is clamped and never throws", async () => {
  const restore = stubMarkdownNew("short");
  try {
    const r = await getTool("markdown_extract").execute(
      { url: "https://example.com/b.txt", offset: 999_999 }, {},
    ) as AnyRec;
    assertEquals(r.content, "");
    assertEquals(r.next_offset, null);
    assertEquals(r.returned_chars, 0);
  } finally { restore(); }
});

Deno.test("one window never exceeds the context bound, whatever the document size", async () => {
  const restore = stubMarkdownNew("y".repeat(500_000));
  try {
    const r = await getTool("markdown_extract").execute({ url: "https://example.com/big.pdf" }, {}) as AnyRec;
    assert((r.content as string).length <= MARKDOWN_EXTRACT_WINDOW, "the per-turn context bound must hold");
    assertEquals(r.total_chars, 500_000);
  } finally { restore(); }
});
