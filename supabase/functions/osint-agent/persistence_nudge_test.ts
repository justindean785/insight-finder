/**
 * persistence_nudge_test.ts — first-pass persistence nudge (DeepSeek deferral fix).
 *
 * DeepSeek (the live orchestrator) under-emits record_artifacts on the first pass: it
 * fans out through many discovery calls and defers structured persistence, often
 * waiting for minimax_correlate before recording. When correlate times out (chronic),
 * the first turn can finish with 0 artifacts even though hard identifiers were in hand
 * (live thread 32d301d0: 46 tool calls, 0 record_artifacts, zero_artifacts_at_completion).
 *
 * These tests pin the BEHAVIORAL nudge (prompt + one-time runtime instruction). They
 * assert it fires once after the threshold, never spams, is request-scoped, leaves
 * MiniMax's incremental behavior untouched, never blocks on / is unblocked by a
 * correlate timeout, and never deterministically extracts artifacts from narration.
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  shouldNudgePersistence,
  buildPersistenceNudgeDirective,
  buildFinalizePersistDirective,
  shouldForceFinalize,
  FINALIZE_ACTIVE_TOOLS,
  PERSISTENCE_NUDGE_TOOL_CALL_THRESHOLD,
} from "./orchestrator-finalize.ts";
import { countModelMessageToolCalls } from "./guard.ts";
import { UNKNOWN_TOOL_SINK } from "./unknown-tool-guard.ts";
import { runWithToolTimeout } from "./cache.ts";

// A ModelMessage-shaped assistant message carrying `n` tool-call parts, `record` of
// which are record_artifacts calls — the exact shape prepareStep counts over. `prefix`
// keeps toolCallIds globally unique so multi-message fixtures don't collide under the
// counter's dedupe-by-id (distinct calls, not the same call echoed).
function assistantWithToolCalls(
  n: number,
  record = 0,
  prefix = "c",
): { role: string; content: Array<Record<string, unknown>> } {
  const content: Array<Record<string, unknown>> = [];
  for (let i = 0; i < n; i++) {
    const isRecord = i < record;
    content.push({
      type: "tool-call",
      toolCallId: `${prefix}${i}`,
      toolName: isRecord ? "record_artifacts" : "google_dorks",
      input: {},
    });
  }
  return { role: "assistant", content };
}

// ---- Requirement 1: DeepSeek-style first turn — nudge fires once after threshold --

Deno.test("nudge: fires once many discovery calls land with zero record_artifacts", () => {
  const calls = PERSISTENCE_NUDGE_TOOL_CALL_THRESHOLD; // fan-out reached, nothing persisted
  assert(
    shouldNudgePersistence(calls, 0, false),
    "threshold tool calls + 0 record calls + not-yet-nudged must fire",
  );
});

Deno.test("nudge: counted from the running ModelMessages, fires at the boundary", () => {
  const msgs = [assistantWithToolCalls(PERSISTENCE_NUDGE_TOOL_CALL_THRESHOLD, 0)];
  const { toolCalls, recordCalls } = countModelMessageToolCalls(msgs);
  assertEquals(toolCalls, PERSISTENCE_NUDGE_TOOL_CALL_THRESHOLD);
  assertEquals(recordCalls, 0);
  assert(shouldNudgePersistence(toolCalls, recordCalls, false), "at the boundary the nudge fires");
});

Deno.test("nudge: exactly threshold-1 tool calls does NOT fire", () => {
  const msgs = [assistantWithToolCalls(PERSISTENCE_NUDGE_TOOL_CALL_THRESHOLD - 1, 0)];
  const { toolCalls, recordCalls } = countModelMessageToolCalls(msgs);
  assertEquals(toolCalls, PERSISTENCE_NUDGE_TOOL_CALL_THRESHOLD - 1);
  assertEquals(shouldNudgePersistence(toolCalls, recordCalls, false), false, "one short of threshold: keep working");
});

// ---- Requirement 1: cumulative count, no phantom inflation -----------------------

Deno.test("counter: cumulative across MULTIPLE messages (per-request, deduped by id)", () => {
  // Two prior steps' assistant messages — the count is the whole conversation so far.
  const msgs = [assistantWithToolCalls(3, 0, "s1_"), assistantWithToolCalls(2, 0, "s2_")];
  const { toolCalls } = countModelMessageToolCalls(msgs);
  assertEquals(toolCalls, 5, "3 + 2 distinct calls accumulate across steps");
});

Deno.test("counter: a repaired/hallucinated call (UNKNOWN_TOOL_SINK) is NOT counted", () => {
  const msgs = [{
    role: "assistant",
    content: [
      { type: "tool-call", toolCallId: "a", toolName: "google_dorks", input: {} },
      { type: "tool-call", toolCallId: "b", toolName: UNKNOWN_TOOL_SINK, input: {} }, // redirected, never ran
      { type: "tool-call", toolCallId: "c", toolName: "whois_lookup", input: {} },
    ],
  }];
  const { toolCalls } = countModelMessageToolCalls(msgs);
  assertEquals(toolCalls, 2, "the sink (non-executed) call must not inflate fan-out");
});

Deno.test("counter: the SAME toolCallId is never double-counted", () => {
  // Same id echoed in two messages (e.g. a call and a later reference) counts once.
  const msgs = [
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "dup", toolName: "whois_lookup", input: {} }] },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "dup", toolName: "whois_lookup", input: {} }] },
  ];
  assertEquals(countModelMessageToolCalls(msgs).toolCalls, 1, "duplicate id → counted once");
});

Deno.test("counter: tool-RESULT parts are never counted as calls", () => {
  // A failed/aborted call surfaces its outcome in a tool-result; only the tool-call
  // counts, so a call+result pair is 1, and a lone result is 0.
  const msgs = [
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "x", toolName: "whois_lookup", input: {} }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "x", toolName: "whois_lookup", output: { ok: false } }] },
  ];
  const { toolCalls, recordCalls } = countModelMessageToolCalls(msgs);
  assertEquals(toolCalls, 1, "call+result pair is one call, not two");
  assertEquals(recordCalls, 0);
});

// ---- Requirement 2: after nudge — record before correlate, never wait on correlate --

Deno.test("nudge directive: tells the model to record now, before correlate, w/ provenance", () => {
  const d = buildPersistenceNudgeDirective();
  assert(/record_artifacts/.test(d), "must name the record tool");
  assert(/only record_artifacts/i.test(d), "must restrict the nudged step to record_artifacts");
  assert(/minimax_correlate/i.test(d) && /(not|don't|do not).*wait/i.test(d), "must say do not wait for correlate");
  assert(/provenance|source|discovered_via/i.test(d), "must demand provenance preservation");
});

// ---- Requirement 3: no nudge spam ------------------------------------------------

Deno.test("no spam: the latch stops a second injection even while records stay 0", () => {
  const calls = PERSISTENCE_NUDGE_TOOL_CALL_THRESHOLD + 10;
  assert(shouldNudgePersistence(calls, 0, false), "first step fires");
  assertEquals(
    shouldNudgePersistence(calls, 0, /* alreadyNudged */ true),
    false,
    "once nudged this run, it never fires again — no spam",
  );
});

Deno.test("no spam: once record_artifacts has been called the nudge stops (independent of latch)", () => {
  const calls = PERSISTENCE_NUDGE_TOOL_CALL_THRESHOLD + 3;
  assertEquals(shouldNudgePersistence(calls, 1, false), false, "any record call short-circuits the nudge");
  assertEquals(shouldNudgePersistence(calls, 5, false), false, "still off once persistence has happened");
});

// ---- Requirement 4: normal MiniMax behavior unchanged ----------------------------

Deno.test("MiniMax unchanged: incremental recorder never trips the nudge", () => {
  // MiniMax records as it goes → recordCalls > 0 well before any fan-out threshold.
  const msgs = [assistantWithToolCalls(8, /* record */ 2)];
  const { toolCalls, recordCalls } = countModelMessageToolCalls(msgs);
  assertEquals(toolCalls, 8);
  assertEquals(recordCalls, 2);
  assertEquals(shouldNudgePersistence(toolCalls, recordCalls, false), false, "a recorder is never nudged");
});

Deno.test("MiniMax unchanged: a quiet early run (few calls, no records) is left alone", () => {
  assertEquals(shouldNudgePersistence(2, 0, false), false, "2 calls is normal opening triage, not a deferral");
});

Deno.test("recording before the threshold suppresses the nudge outright", () => {
  // Recorded on step 1, then a couple more lookups — recordCalls>0 the whole way.
  const msgs = [assistantWithToolCalls(3, /* record */ 1, "r1_"), assistantWithToolCalls(3, 0, "r2_")];
  const { toolCalls, recordCalls } = countModelMessageToolCalls(msgs);
  assert(toolCalls >= PERSISTENCE_NUDGE_TOOL_CALL_THRESHOLD, "fan-out crossed the threshold");
  assert(recordCalls >= 1, "but a record already happened");
  assertEquals(shouldNudgePersistence(toolCalls, recordCalls, false), false, "prior persistence → never nudge");
});

// ---- Requirement 2: nudge is subordinate to forced finalization ------------------

// Mirror of prepareStep's exact branch precedence: the finalize check runs FIRST and
// returns, so the nudge block in the else-branch is unreachable once finalize is due.
function prepareStepDecision(
  elapsedMs: number,
  stepNumber: number,
  capReached: boolean,
  toolCalls: number,
  recordCalls: number,
  alreadyNudged: boolean,
): "finalize" | "nudge" | "plain" {
  if (capReached || shouldForceFinalize(elapsedMs, stepNumber)) return "finalize";
  if (shouldNudgePersistence(toolCalls, recordCalls, alreadyNudged)) return "nudge";
  return "plain";
}

Deno.test("forced-finalize takes precedence: the nudge cannot replace finalization", () => {
  const finalizeEdge = 240_000 - 90_000; // reserve window open → finalize due
  // Nudge conditions ALSO hold (many calls, 0 records, not yet nudged) — finalize still wins.
  assertEquals(
    prepareStepDecision(finalizeEdge, 3, false, 20, 0, false),
    "finalize",
    "when finalize is due it is chosen even though the nudge conditions are met",
  );
  // Same via the tool-call cap trigger.
  assertEquals(
    prepareStepDecision(0, 0, /* capReached */ true, 20, 0, false),
    "finalize",
    "cap-reached forces finalize; the nudge is never reached",
  );
});

Deno.test("nudge only fires on a genuine intermediate step (not finalize)", () => {
  // Early step, budget healthy, fanned out with no records → nudge is the decision.
  assertEquals(prepareStepDecision(1_000, 3, false, 6, 0, false), "nudge");
  // Once latched, the same intermediate step decays to plain (one injection only).
  assertEquals(prepareStepDecision(1_000, 4, false, 8, 0, /* alreadyNudged */ true), "plain");
});

Deno.test("nudge injection is purely additive — the base prompt is not mutated", () => {
  // prepareStep composes: base + perCycle, then (if firing) += nudge. Model the base
  // as an immutable const and prove the nudge only ever appends a suffix.
  const base = "BASE_SYSTEM_PROMPT";
  const withNudge = base + buildPersistenceNudgeDirective();
  assert(withNudge.startsWith(base), "the base is preserved verbatim as a prefix");
  assert(withNudge.length > base.length, "the directive is appended, not substituted");
  assertEquals(base, "BASE_SYSTEM_PROMPT", "the base string is never mutated");
  // The builder is pure: two calls yield equal, independent strings.
  assertEquals(buildPersistenceNudgeDirective(), buildPersistenceNudgeDirective());
});

// ---- Requirement 5: correlate timeout does not block persistence / final report --

Deno.test("correlate timeout: runWithToolTimeout RESOLVES a schema-safe stub, never throws", async () => {
  // A correlate call that would run longer than its cap. The timeout must resolve
  // (ok:false stub) so the loop keeps going and record_artifacts can still fire — it
  // must NOT reject/throw and wedge the run before synthesis.
  const slowCorrelate = (signal: AbortSignal) =>
    new Promise<{ ok: true }>((resolve) => {
      const t = setTimeout(() => resolve({ ok: true }), 1_000);
      // Honor the cap's abort so no timer leaks past the test.
      signal.addEventListener("abort", () => clearTimeout(t), { once: true });
    });
  const out = await runWithToolTimeout("minimax_correlate", slowCorrelate, 5);
  const r = out as { ok?: boolean; _tool_timeout?: boolean };
  assertEquals(r.ok, false, "a timed-out correlate is ok:false (kept out of the cache)");
  assertEquals(r._tool_timeout, true, "and flagged as a tool timeout — not a hard crash");
});

Deno.test("correlate timeout: finalize still enters the persistence phase, correlate-independent", () => {
  // The forced finalize path (wall-clock reserve / step cap) is evaluated on elapsed
  // time + step, with NO dependency on correlate having succeeded. It keeps
  // record_artifacts active and asks for the report, so a correlate timeout can never
  // strand collected evidence or suppress the closing synthesis.
  const edge = 240_000 - 90_000; // reserve window opens regardless of correlate state
  assert(shouldForceFinalize(edge, 3), "finalize is time/step driven, not correlate driven");
  assert(
    (FINALIZE_ACTIVE_TOOLS as readonly string[]).includes("record_artifacts"),
    "record_artifacts stays active during finalize so persistence still happens",
  );
  const fin = buildFinalizePersistDirective();
  assert(/record_artifacts/.test(fin), "finalize directive still persists un-recorded findings");
  assert(/exactly one tool call/i.test(fin), "persistence cannot end with narration only");
});

// ---- Requirement 6: request isolation --------------------------------------------

Deno.test("request isolation: the counter is pure — one request's messages don't bleed into another's", () => {
  const reqA = [assistantWithToolCalls(6, 0)]; // fanned out, persisted nothing
  const reqB = [assistantWithToolCalls(2, 0)]; // barely started
  const a = countModelMessageToolCalls(reqA);
  const b = countModelMessageToolCalls(reqB);
  assertEquals(a.toolCalls, 6);
  assertEquals(b.toolCalls, 2, "B's count is B's alone — no accumulation from A");
  // Re-counting A after B yields the same result → no shared/mutated state.
  assertEquals(countModelMessageToolCalls(reqA).toolCalls, 6);
});

Deno.test("request isolation: each request owns its own nudge latch", () => {
  // Request A crosses the threshold and gets nudged (its latch flips true).
  let latchA = false;
  const firedA = shouldNudgePersistence(6, 0, latchA);
  if (firedA) latchA = true;
  assert(firedA && latchA, "A fires and latches");
  // Request B has its OWN latch — A latching cannot suppress B.
  const latchB = false;
  assert(
    shouldNudgePersistence(6, 0, latchB),
    "B fires on its own latch regardless of A having already nudged",
  );
});

// ---- Requirement 7: NO deterministic extraction ----------------------------------

Deno.test("no deterministic extraction: the nudge only asks the MODEL to record — it creates nothing", () => {
  // The predicate is a pure boolean gate; it returns no artifact payload.
  assertEquals(typeof shouldNudgePersistence(6, 0, false), "boolean");
  // The directive explicitly forbids fabricating artifacts from narration / prose.
  const d = buildPersistenceNudgeDirective();
  assert(/narration is NOT evidence/i.test(d), "must state narration is not evidence");
  assert(/(do NOT invent|fabricate)/i.test(d), "must forbid inventing/fabricating artifacts");
  assert(/real tool output|backed by/i.test(d), "must require findings be tool-output-backed");
});
