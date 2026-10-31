// analyst_stop_wiring_test.ts — the server half of "Stop investigation".
//
// WHY A SOURCE-LEVEL TEST: the analyst's Stop is a client write of
// `threads.status='stopped'`, and the ONLY thing that turns it into an ended run
// is a closure inside index.ts: `prepareStep` re-reads the thread status before
// every model step and throws an AbortError when it is "stopped". That closure
// has no unit test because it is built inline against the live `streamText`
// call. The frontend (src/lib/composer-primary.ts, 2026-10-31) now offers Stop
// while a tab is FOLLOWING a run it is not streaming — reload mid-run, dropped
// connection — where the browser-side `stop()` is a no-op and this poll is the
// whole mechanism. If the poll is ever refactored away, Stop becomes a button
// that does nothing while the run keeps spending, and every unit test stays
// green. This asserts the wiring itself, the way reviews_wiring_test.ts does.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const INDEX = await Deno.readTextFile(new URL("../../functions/osint-agent/index.ts", import.meta.url));

Deno.test("analyst stop: prepareStep re-reads threads.status and aborts on 'stopped'", () => {
  // The read and the abort must sit inside prepareStep — a check anywhere else
  // (request admission, onFinish) is not "within one step".
  const m = /const prepareStep\b[\s\S]{0,900}?\.from\("threads"\)[\s\S]{0,400}?status === "stopped"[\s\S]{0,300}?new DOMException\([^)]*"AbortError"\)/.exec(INDEX);
  assert(m, "prepareStep must read threads.status and throw an AbortError when it is 'stopped'");
  // The read is keyed on THIS thread, not a table scan.
  assertStringIncludes(m[0], '.eq("id", threadId)', "the status read must be keyed on the run's thread id");
  // And it comes BEFORE the step's message trimming, so a stopped run never pays
  // for another model call.
  const trimAt = INDEX.indexOf("STEP_RECENT_WINDOW", m.index);
  assert(trimAt > m.index + m[0].length, "the stop check must run before the step's prompt is assembled");
});

Deno.test("analyst stop: prepareStep is actually wired into the streamText call", () => {
  // Building the closure is not enough; it has to be passed. #900 wrapped it in
  // timing telemetry, so accept either the bare or the wrapped form.
  assert(
    /\bprepareStep:\s*(withPrepareTiming\(\s*)?prepareStep\b/.test(INDEX),
    "streamText must receive prepareStep (bare or wrapped in withPrepareTiming)",
  );
});

Deno.test("analyst stop: every terminal status write is guarded on status='active'", () => {
  // The analyst's `stopped` row must survive the run's own end. Both server-side
  // terminal writes — the stream-error path and the completion path — are
  // conditional updates on `status='active'`; an unguarded write would paint a
  // stopped run `finished` (and the UI green) a step after the analyst stopped it.
  const writes = [...INDEX.matchAll(/\.from\("threads"\)\s*\.update\(\{[\s\S]{0,900}?\}\)\s*\.eq\("id", threadId\)([\s\S]{0,120}?)(?=;|\n\s*if\b)/g)];
  const terminal = writes.filter((w) => /status:\s*("finished"|terminal\.status)/.test(w[0]));
  assertEquals(terminal.length, 2, `expected the error-path and completion-path terminal writes, found ${terminal.length}`);
  for (const w of terminal) {
    assertStringIncludes(w[1], '.eq("status", "active")', `a terminal status write is not guarded on status='active':\n${w[0].slice(0, 200)}`);
  }
});

Deno.test("analyst stop: the abort is classified as an analyst stop, not a client cancel", () => {
  // run-end telemetry must keep the two apart: a stopped run is `aborted` (not
  // premature), a dropped browser is `premature_client_cancel`. The stop message
  // is the string the classifier and the stream-error describer see.
  assertStringIncludes(INDEX, '"Investigation stopped by analyst"');
  assertStringIncludes(INDEX, "onAbort: () => { loopAborted = true", "streamText.onAbort must record the loop abort so run_end reads 'aborted'");
});
