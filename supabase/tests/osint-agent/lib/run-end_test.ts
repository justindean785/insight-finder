import { assert, assertEquals } from "jsr:@std/assert@1";
import { classifyRunEnd, runEndNote, runEndSelfTest } from "../../../functions/osint-agent/lib/run-end.ts";

Deno.test("a loop that completed before persistence is a clean end", () => {
  const c = classifyRunEnd({ loopDone: true, isAborted: false, clientSignalAborted: false });
  assertEquals(c, { cause: "loop_complete", premature: false });
  assertEquals(runEndNote(c), null);
});

Deno.test("persistence before the loop finished, with the request aborted, is a client cancel", () => {
  const c = classifyRunEnd({ loopDone: false, isAborted: false, clientSignalAborted: true });
  assertEquals(c, { cause: "premature_client_cancel", premature: true });
  assert(runEndNote(c)?.startsWith("run_end:premature_client_cancel"));
});

Deno.test("persistence before the loop finished with no measured reason stays 'unknown', never guessed", () => {
  const c = classifyRunEnd({ loopDone: false, isAborted: false, clientSignalAborted: false });
  assertEquals(c.cause, "premature_unknown");
  assert(c.premature);
});

Deno.test("an explicit abort wins over everything and is not 'premature'", () => {
  const c = classifyRunEnd({ loopDone: false, isAborted: true, clientSignalAborted: true });
  assertEquals(c, { cause: "aborted", premature: false });
});

Deno.test("the kill switch removes the note and reports LEGACY", () => {
  Deno.env.set("RUN_END_LOG_DISABLED", "true");
  try {
    assertEquals(runEndNote({ cause: "premature_client_cancel", premature: true }), null);
    assert(runEndSelfTest().detail.startsWith("LEGACY"));
  } finally {
    Deno.env.delete("RUN_END_LOG_DISABLED");
  }
});

Deno.test("self test passes on the shipped build", () => {
  assertEquals(runEndSelfTest().ok, true);
});

// Source-level wiring: the classifier is useless unless the shipped handler feeds it the two
// facts it needs and writes the note. Negative control: revert index.ts and these fail.
Deno.test("index.ts wires streamText's own completion into the run-end classification", async () => {
  const src = await Deno.readTextFile(new URL("../../../functions/osint-agent/index.ts", import.meta.url));
  assert(/onFinish:\s*\(\)\s*=>\s*\{\s*loopDone\s*=\s*true;/.test(src), "streamText onFinish must set loopDone");
  assert(/onAbort:\s*\(\)\s*=>\s*\{\s*loopAborted\s*=\s*true;/.test(src), "streamText onAbort must set loopAborted");
  assert(/classifyRunEnd\(\{[\s\S]*?loopDone,[\s\S]*?clientSignalAborted:\s*req\.signal\.aborted/.test(src), "persistFinalMessages must classify with loopDone and req.signal");
  assert(/errorMessage:\s*runEndNote\(runEnd\)/.test(src), "the invocation row must carry the run-end note");
});
