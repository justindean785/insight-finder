import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifyStreamProviderError, isMessageSchemaError } from "./stream-error-classify.ts";

Deno.test("classifyStreamProviderError: bare 'Forbidden' → clear quota/credit message (the beta bug)", () => {
  const msg = classifyStreamProviderError("Forbidden");
  assert(msg && /out of credits or over quota/i.test(msg), msg ?? "null");
  assert(!/forbidden/i.test(msg!), "must not leak the bare word 'Forbidden'");
});

Deno.test("classifyStreamProviderError: 'Provider returned error: 403' → quota/credit message", () => {
  const msg = classifyStreamProviderError("Provider returned error: 403");
  assert(msg && /credits or over quota/i.test(msg), msg ?? "null");
});

Deno.test("classifyStreamProviderError: 429 / rate limit → rate-limited message", () => {
  assert(/rate-limited/i.test(classifyStreamProviderError("Provider returned error: 429 rate limit") ?? ""));
  assert(/rate-limited/i.test(classifyStreamProviderError("Too Many Requests") ?? ""));
});

Deno.test("classifyStreamProviderError: 401 / unauthorized → operator-key message", () => {
  assert(/operator to check the provider key/i.test(classifyStreamProviderError("401 Unauthorized") ?? ""));
});

Deno.test("classifyStreamProviderError: context overflow → context-limit message", () => {
  assert(/context limit/i.test(classifyStreamProviderError("context window exceeded (2013)") ?? ""));
});

Deno.test("classifyStreamProviderError: network/timeout → unreachable message", () => {
  assert(/unreachable/i.test(classifyStreamProviderError("fetch failed: ECONNRESET") ?? ""));
  assert(/unreachable/i.test(classifyStreamProviderError("The operation timed out") ?? ""));
});

Deno.test("classifyStreamProviderError: unrecognized error → null (falls through to raw redacted)", () => {
  assertEquals(classifyStreamProviderError("some totally novel failure mode xyz"), null);
});

Deno.test("classifyStreamProviderError: does not fire on schema faults (those are handled first)", () => {
  assert(isMessageSchemaError("Tool results are missing for tool calls call_a_1"));
  assertEquals(classifyStreamProviderError("Tool results are missing for tool calls call_a_1"), null);
});
