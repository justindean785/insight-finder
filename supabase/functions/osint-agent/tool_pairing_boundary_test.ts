// enforceToolPairing — the last line before the model call.
//
// A production run wedged permanently with AI_MissingToolResultsError at step 0
// (<200ms, every retry, forever). That error is thrown by the AI SDK's
// convertToLanguageModelPrompt, and its rule is POSITIONAL, which is the part
// that keeps getting stated wrongly:
//
//   walk the messages; assistant tool-calls add ids; tool-results delete them;
//   on reaching a `user` or `system` message with any id STILL OUTSTANDING, throw.
//
// So "the result appears somewhere later in the array" is not enough — it must
// appear before the next user/system turn.
//
// The oracle below is that rule transcribed from the SDK source, so these tests
// check against the real contract rather than against our own restatement of it.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { enforceToolPairing } from "./message-sanitize.ts";

type Msg = { role: string; content: unknown };

/** The SDK's rule, transcribed from convertToLanguageModelPrompt. */
function sdkWouldThrow(messages: Msg[]): string[] | null {
  const outstanding = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const p of m.content as Array<{ type?: string; toolCallId?: string; providerExecuted?: boolean }>) {
        if (p?.type === "tool-call" && p.toolCallId && !p.providerExecuted) outstanding.add(p.toolCallId);
      }
    } else if (m.role === "tool" && Array.isArray(m.content)) {
      for (const p of m.content as Array<{ type?: string; toolCallId?: string }>) {
        if (p?.type === "tool-result" && p.toolCallId) outstanding.delete(p.toolCallId);
      }
    } else if (m.role === "user" || m.role === "system") {
      if (outstanding.size > 0) return [...outstanding];
    }
  }
  return outstanding.size > 0 ? [...outstanding] : null;
}

const call = (id: string, name = "socialfetch_web_read") =>
  ({ role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: name, input: {} }] });
const result = (id: string, name = "socialfetch_web_read") =>
  ({ role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: name, output: { type: "text", value: "ok" } }] });
const user = (t = "go") => ({ role: "user", content: [{ type: "text", text: t }] });

function assertSdkAccepts(msgs: Msg[], label: string) {
  const bad = sdkWouldThrow(msgs);
  assertEquals(bad, null, `${label}: SDK would still throw for ${JSON.stringify(bad)}`);
}

Deno.test("pairing: the exact production shape — aborted call, then a new user turn", () => {
  // socialfetch_web_read aborted at 22s; its result frame never reached the
  // browser, so the browser re-uploads the call alone and the analyst types
  // again. This is the sequence that wedged thread 9ac01762 forever.
  const wedged = [user("investigate"), call("call_ec12"), user("run this pivot")];
  assert(sdkWouldThrow(wedged), "precondition: this shape must be one the SDK rejects");

  const { messages, repaired } = enforceToolPairing(wedged as never);
  assertEquals(repaired, ["call_ec12"]);
  assertSdkAccepts(messages as never, "repaired wedge");
});

Deno.test("pairing: the placeholder lands BEFORE the next user turn, not merely later", () => {
  const { messages } = enforceToolPairing([user(), call("c1"), user("next")] as never);
  const roles = (messages as Msg[]).map((m) => m.role);
  // user, assistant, tool, user — the tool message must precede the second user.
  assertEquals(roles, ["user", "assistant", "tool", "user"]);
});

Deno.test("pairing: an outstanding call at the END of the array is also repaired", () => {
  // The SDK re-checks after the walk, so a trailing dangling call throws too.
  const msgs = [user(), call("c9")];
  assert(sdkWouldThrow(msgs as never));
  const { messages, repaired } = enforceToolPairing(msgs as never);
  assertEquals(repaired, ["c9"]);
  assertSdkAccepts(messages as never, "trailing call");
});

Deno.test("pairing: multiple unresolved calls across one block all get results", () => {
  const multi = [
    user(),
    { role: "assistant", content: [
      { type: "tool-call", toolCallId: "a", toolName: "t1", input: {} },
      { type: "tool-call", toolCallId: "b", toolName: "t2", input: {} },
    ]},
    result("a", "t1"),
    user("again"),
  ];
  const { messages, repaired } = enforceToolPairing(multi as never);
  assertEquals(repaired, ["b"], "only the genuinely unresolved call is synthesized");
  assertSdkAccepts(messages as never, "partial parallel results");
});

Deno.test("pairing: a healthy conversation is left completely untouched", () => {
  const healthy = [user(), call("c1"), result("c1"), user("more"), call("c2"), result("c2")];
  const { messages, repaired } = enforceToolPairing(healthy as never);
  assertEquals(repaired, [], "no repair on a well-formed history");
  assertEquals((messages as Msg[]).length, healthy.length, "no messages added");
  assertSdkAccepts(messages as never, "healthy");
});

Deno.test("pairing: providerExecuted calls are NOT counted (matching the SDK)", () => {
  // The SDK skips these; synthesizing a result for one would inject a bogus row.
  const msgs = [
    user(),
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "p1", toolName: "t", input: {}, providerExecuted: true }] },
    user("next"),
  ];
  assertEquals(sdkWouldThrow(msgs as never), null, "precondition: SDK ignores providerExecuted");
  const { repaired } = enforceToolPairing(msgs as never);
  assertEquals(repaired, [], "we must ignore it too");
});

Deno.test("pairing: repeated user turns after a wedge stay valid (retry must work)", () => {
  // The defining property: a wedged thread must become runnable again, and stay
  // runnable across further turns — that is what Retry could never do before.
  let msgs: Msg[] = [user("investigate"), call("call_ec12"), user("retry 1")];
  msgs = enforceToolPairing(msgs as never).messages as never;
  msgs = [...msgs, user("retry 2")];
  assertSdkAccepts(enforceToolPairing(msgs as never).messages as never, "second retry");
});
