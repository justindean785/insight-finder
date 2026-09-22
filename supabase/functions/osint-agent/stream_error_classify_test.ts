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

Deno.test("describeStreamError: status and enum code, and the raw body NEVER rides the string", async () => {
  const { describeStreamError } = await import("./stream-error-classify.ts");
  const apiErr = Object.assign(new Error("Bad Request"), {
    statusCode: 400,
    responseBody: '{ "error": { "message": "Invalid JSON payload: tools[3].function.parameters.anyOf is not supported",\n  "status": "INVALID_ARGUMENT" } }',
  });
  const out = describeStreamError(apiErr);
  if (!out.startsWith("Bad Request [HTTP 400 INVALID_ARGUMENT")) throw new Error(`unexpected: ${out}`);
  if (out.includes("anyOf is not supported")) throw new Error(`free text leaked: ${out}`);
  if (!/body=\d+B/.test(out)) throw new Error(`body size missing: ${out}`);
  if (out.includes("\n")) throw new Error("must be single-line");
});

Deno.test("describeStreamError: an ECHOED INPUT in the body cannot reach the persisted string", async () => {
  const { describeStreamError } = await import("./stream-error-classify.ts");
  // This is the defect the review named: a 4xx body routinely quotes the request
  // back, and the request here is the investigation. Nothing from it may survive.
  const echoed = Object.assign(new Error("Bad Request"), {
    statusCode: 400,
    responseBody: JSON.stringify({
      error: {
        code: "invalid_request_error",
        message: "Invalid value for contents[0].parts[0].text",
        param: "leoseyes86@gmail.com / hunter2 / +1 703 795 5364",
      },
    }),
  });
  const out = describeStreamError(echoed);
  for (const secret of ["leoseyes86", "gmail.com", "hunter2", "703", "contents[0]"]) {
    if (out.includes(secret)) throw new Error(`echoed input leaked (${secret}): ${out}`);
  }
  if (!out.includes("invalid_request_error")) throw new Error(`enum code lost: ${out}`);
});

Deno.test("describeStreamError: a free-text code is DROPPED, not truncated", async () => {
  const { describeStreamError } = await import("./stream-error-classify.ts");
  const err = Object.assign(new Error("Bad Request"), {
    statusCode: 400,
    responseBody: JSON.stringify({ error: { status: "the value leoseyes86@gmail.com was rejected" } }),
  });
  const out = describeStreamError(err);
  if (out.includes("leoseyes86")) throw new Error(`free-text code leaked: ${out}`);
  if (out !== `Bad Request [HTTP 400 body=${JSON.stringify({ error: { status: "the value leoseyes86@gmail.com was rejected" } }).length}B]`) {
    throw new Error(`unexpected: ${out}`);
  }
});

Deno.test("describeStreamError: includeBody is the explicit opt-in, and it is bounded", async () => {
  const { describeStreamError, STREAM_ERROR_DETAIL_MAX } = await import("./stream-error-classify.ts");
  const apiErr = Object.assign(new Error("Bad Request"), {
    statusCode: 400,
    responseBody: '{ "error": { "message": "anyOf is not supported", "status": "INVALID_ARGUMENT" } }',
  });
  if (describeStreamError(apiErr, false).includes("anyOf")) throw new Error("body included by DEFAULT");
  if (!describeStreamError(apiErr, true).includes("anyOf")) throw new Error("opt-in did not include the body");
  const huge = Object.assign(new Error("Bad Request"), { statusCode: 400, responseBody: "x".repeat(5000) });
  if (describeStreamError(huge, true).length > STREAM_ERROR_DETAIL_MAX + 40) throw new Error("not bounded");
});

Deno.test("describeStreamError: a body with no status still reports its size, never its content", async () => {
  const { describeStreamError } = await import("./stream-error-classify.ts");
  const err = Object.assign(new Error("fetch failed"), { responseBody: "upstream said leoseyes86@gmail.com" });
  const out = describeStreamError(err);
  if (out.includes("leoseyes86")) throw new Error(`leaked: ${out}`);
  if (out !== "fetch failed [body=34B]") throw new Error(`unexpected: ${out}`);
});

Deno.test("describeStreamError: a plain Error or non-Error is the message alone", async () => {
  const { describeStreamError } = await import("./stream-error-classify.ts");
  if (describeStreamError(new Error("Investigation stopped by analyst")) !== "Investigation stopped by analyst") throw new Error("plain error changed");
  if (describeStreamError("boom") !== "boom") throw new Error("string changed");
});
