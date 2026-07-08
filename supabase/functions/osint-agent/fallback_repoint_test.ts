// fallback_repoint_test.ts — the orchestrator fallback is direct Gemini API;
// the Lovable AI gateway path has been removed. These tests verify the abort
// guard (#205) is intact: an already-aborted caller signal must NOT trigger
// the fallback, and a MiniMax failure should cascade to Gemini.
import { assert, assertEquals } from "jsr:@std/assert@^1";
import { minimaxChatWithFallback } from "./providers.ts";

const MINIMAX_HOST = "api.minimax.io";
const GEMINI_HOST = "generativelanguage.googleapis.com";

Deno.test("fallback: MiniMax 429 cascades to direct Gemini", async () => {
  const origFetch = globalThis.fetch;
  const seen: string[] = [];
  try {
    globalThis.fetch = (async (input: Request | URL | string) => {
      const url = input instanceof Request ? input.url : String(input);
      seen.push(url);
      if (url.includes(MINIMAX_HOST)) return new Response("rate limited", { status: 429 });
      if (url.includes(GEMINI_HOST)) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "gemini-answer" } }] }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof globalThis.fetch;

    const result = await minimaxChatWithFallback({ user: "test" }, { gemini: true });
    assertEquals(result.usedFallback, true);
    assertEquals(result.ok, true);
    assertEquals(result.content, "gemini-answer");
    assert(seen[0].includes(MINIMAX_HOST));
    assert(seen[1].includes(GEMINI_HOST));
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("#205: an already-aborted caller signal does NOT trigger the fallback", async () => {
  const origFetch = globalThis.fetch;
  const hosts: string[] = [];
  try {
    globalThis.fetch = (async (input: Request | URL | string) => {
      const url = input instanceof Request ? input.url : String(input);
      hosts.push(url);
      if (url.includes(MINIMAX_HOST)) throw new DOMException("Aborted", "AbortError");
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof globalThis.fetch;

    const ctrl = new AbortController();
    ctrl.abort();
    let threw = false;
    try {
      await minimaxChatWithFallback({ user: "test", signal: ctrl.signal }, { gemini: true });
    } catch {
      threw = true;
    }
    assert(threw, "aborted-caller path must rethrow, not swallow into a fallback");
    assert(hosts.length > 0 && hosts.every((h) => h.includes(MINIMAX_HOST)), "fallback must NOT be called after caller abort");
  } finally {
    globalThis.fetch = origFetch;
  }
});
