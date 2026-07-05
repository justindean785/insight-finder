// fallback_repoint_test.ts — Phase B5: the orchestrator fallback no longer points
// at google/gemini-2.5-pro (which 403s on the Lovable gateway and killed the run).
// It is repointed to a served flash-class model, env-overridable, and the #205
// no-fallback-after-abort guard is intact.
import { assert, assertEquals } from "jsr:@std/assert@^1";
import { MODELS } from "./models.ts";
import { FALLBACK_MODEL_ID } from "./env.ts";
import { minimaxChatWithFallback } from "./providers.ts";

const MINIMAX_HOST = "api.minimax.io";
const LOVABLE_HOST = "ai.gateway.lovable.dev";

Deno.test("B5: fallback repointed off the 403-ing gemini-2.5-pro to flash-class", () => {
  assert(MODELS.fallback !== "google/gemini-2.5-pro", "must not use the credit-gated pro model that 403s");
  assert(/flash/i.test(MODELS.fallback), `fallback should be a flash-class model, got ${MODELS.fallback}`);
  assertEquals(FALLBACK_MODEL_ID, MODELS.fallback, "env.ts + models.ts must share one source of truth");
});

Deno.test("B5: MiniMax failure cascades to Lovable using the repointed model", async () => {
  const origFetch = globalThis.fetch;
  const seen: Array<{ url: string; model?: string }> = [];
  try {
    globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      let model: string | undefined;
      try { model = JSON.parse(String(init?.body ?? "{}")).model; } catch { /* ignore */ }
      seen.push({ url, model });
      if (url.includes(MINIMAX_HOST)) return new Response("rate limited", { status: 429 });
      if (url.includes(LOVABLE_HOST)) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "flash-answer" } }] }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof globalThis.fetch;

    const result = await minimaxChatWithFallback({ user: "test" }, { lovable: true, allowLovable: true });
    assertEquals(result.usedFallback, true);
    assertEquals(result.ok, true);
    assertEquals(result.content, "flash-answer");
    // The fallback request carried the repointed (served) model — the concrete B5 fix.
    const lov = seen.find((b) => b.url.includes(LOVABLE_HOST));
    assert(lov, "the Lovable fallback endpoint must have been called");
    assertEquals(lov?.model, MODELS.fallback);
    assert(lov?.model !== "google/gemini-2.5-pro");
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("B5/#205: an already-aborted caller signal does NOT trigger the fallback", async () => {
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
    ctrl.abort(); // the caller (per-tool timeout) already gave up
    let threw = false;
    try {
      await minimaxChatWithFallback({ user: "test", signal: ctrl.signal }, { gemini: true, lovable: true, allowLovable: true });
    } catch {
      threw = true;
    }
    assert(threw, "aborted-caller path must rethrow, not swallow into a fallback");
    assert(hosts.length > 0 && hosts.every((h) => h.includes(MINIMAX_HOST)), "fallback must NOT be called after caller abort");
  } finally {
    globalThis.fetch = origFetch;
  }
});
