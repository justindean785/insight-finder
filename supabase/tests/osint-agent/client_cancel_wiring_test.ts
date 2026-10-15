// client_cancel_wiring_test.ts — a dropped browser connection must not end the run.
//
// WHY A SOURCE-LEVEL TEST: the defect was pure wiring. persistFinalMessages was correct; it was
// attached to one stream too many (the browser-facing response, whose onFinish the SDK fires on
// CANCEL). No unit test of the handler could see that. This pins which stream carries it.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const INDEX = await Deno.readTextFile(new URL("../../functions/osint-agent/index.ts", import.meta.url));
const HEALTH = await Deno.readTextFile(new URL("../../functions/osint-agent/health-handler.ts", import.meta.url));

const block = (src: string, start: string, end: string): string => {
  const i = src.indexOf(start);
  assert(i >= 0, `${start} present`);
  const j = src.indexOf(end, i + start.length);
  assert(j > i, `${end} follows ${start}`);
  return src.slice(i, j);
};

Deno.test("client cancel: the server-owned persistence branch is the unconditional writer", () => {
  const branch = block(INDEX, "const persistenceStream = result.toUIMessageStream({", "});");
  assertStringIncludes(branch, "onFinish: persistFinalMessages,");
  assert(!branch.includes("persistOnClientCancelEnabled("), "the server branch must never be gated");
});

Deno.test("client cancel: the browser-facing response stream persists ONLY under the legacy switch", () => {
  const response = block(INDEX, "return result.toUIMessageStreamResponse({", "\n    });");
  assert(!/onFinish:\s*persistFinalMessages\s*,/.test(response), "a bare persistence onFinish on the response stream re-opens the defect");
  assertStringIncludes(response, "persistOnClientCancelEnabled(Deno.env.get(PERSIST_ON_CLIENT_CANCEL_ENV))");
  assertStringIncludes(response, "? persistFinalMessages");
  assertStringIncludes(response, ": undefined");
});

Deno.test("client cancel: exactly one unconditional persistence wiring exists in index.ts", () => {
  const bare = INDEX.match(/onFinish:\s*persistFinalMessages\s*,/g) ?? [];
  assertEquals(bare.length, 1, "only the server-owned branch may wire persistFinalMessages unconditionally");
});

Deno.test("client cancel: /health carries the proof key", () => {
  assertStringIncludes(HEALTH, "r.checks.client_cancel_isolation = clientCancelIsolationCheck(");
});
