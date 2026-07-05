import { assertEquals } from "jsr:@std/assert";
import {
  minimaxPreflightFailureLabel,
  shouldFallbackAfterMinimaxPreflight,
} from "./minimax-preflight.ts";

Deno.test("preflight: success keeps MiniMax primary", () => {
  assertEquals(shouldFallbackAfterMinimaxPreflight({ ok: true, status: 200 }), false);
});

Deno.test("preflight: timeout does NOT force gateway fallback (cold-start fix)", () => {
  assertEquals(shouldFallbackAfterMinimaxPreflight({ ok: false, status: 0 }), false);
  assertEquals(minimaxPreflightFailureLabel({ ok: false, status: 0 }), "timeout");
});

Deno.test("preflight: explicit HTTP failure forces gateway fallback", () => {
  assertEquals(shouldFallbackAfterMinimaxPreflight({ ok: false, status: 429 }), true);
  assertEquals(shouldFallbackAfterMinimaxPreflight({ ok: false, status: 503 }), true);
});
