// zero_evidence_escalation_test.ts — durability when the model never records.
//
// THE PRODUCTION FAILURE (2026-08-06, ~15:34-15:37):
//   3 × persistence_nudge_fired, record_artifact_calls: 0 each time
//   no auto_persist_step
//   run_death_forensics: elapsed_ms 120008, silent_ms 98733, artifact_count 0,
//   reason stale_recovery, "CPU Time exceeded"
//   finalize event with decision_succeeded: false
//
// An investigation ran real tools for two minutes and persisted NOTHING.
//
// ROOT CAUSE, verified in code. There are exactly two durable write paths:
// `record_artifacts` (model-invoked) and the auto-persist backstop. The backstop
// consults AUTO_PERSIST_TOOL_DENYLIST, which excludes EVERY broad search and read
// tool — google_dorks, minimax_web_search, perplexity_search, exa_search,
// osint_navigator_search, gemini_vision, jina_reader_scrape, http_fingerprint,
// firecrawl_scrape. So a run composed of those tools whose model never calls
// record_artifacts has NO durability path whatsoever, and the persistence nudge —
// advisory system-prompt text — is the entire mechanism standing between the
// analyst and total evidence loss. It fired three times and was ignored.
//
// THE FIX'S SHAPE, and its limits. The denylist conflates two reasons to skip a
// tool: "its output is not findings / is already persisted" (recording, memory,
// planner, auto-recording tools — never safe to scan) and "auto-persisting this
// blindly is noisy" (the search/read tools). Only the second group becomes
// extractable, and only in a state defined by TWO independent conditions:
//   1. the model has fanned out past the nudge threshold with ZERO
//      record_artifacts calls (request-scoped, free to evaluate), AND
//   2. the thread still holds ZERO artifacts (one DB read, inside the backstop).
// Outside that state the denylist is intact and behaviour is byte-identical.
//
// These tests pin the gate in BOTH directions: it must open when the run would
// otherwise lose everything, and it must stay shut the rest of the time.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  AUTO_PERSIST_TOOL_DENYLIST,
  ESCALATION_ELIGIBLE_TOOLS,
  MAX_ESCALATION_BUFFER,
  bufferEscalationCandidates,
  drainEscalationBuffer,
  extractFindings,
  extractStepFindings,
  type ExtractedFinding,
} from "./auto-persist-findings.ts";

/** A search-tool result in the shape these tools actually return — the generic
 *  `results[]` envelope that extractFindings' branch 3 reads tool-agnostically. */
const SEARCH_RESULT = {
  toolName: "minimax_web_search",
  input: { query: "acme-subject" },
  output: {
    ok: true,
    results: [
      { url: "https://forum.example.org/u/acme-subject", title: "profile" },
      { url: "https://records.example.net/doc/8812.pdf", title: "filing" },
    ],
  },
};

Deno.test("every escalation-eligible tool is actually on the denylist", () => {
  // Guards a vacuous set: an entry that is NOT denylisted is already extractable,
  // so listing it here would imply a gate that does nothing.
  for (const t of ESCALATION_ELIGIBLE_TOOLS) {
    assert(
      AUTO_PERSIST_TOOL_DENYLIST.has(t),
      `${t} is escalation-eligible but not denylisted — the escalation is a no-op for it`,
    );
  }
  assert(ESCALATION_ELIGIBLE_TOOLS.size > 0, "escalation set is empty — the gate can never open");
});

Deno.test("tools that are unsafe to scan are NEVER escalation-eligible", () => {
  // The correctness half of the denylist. Recording/memory/planner tools do not
  // return findings; the auto-recording tools already persisted theirs, so
  // extracting from them would double-record. No run state makes these safe.
  const NEVER = [
    "record_artifacts", "record_artifact", "record_finding_corroboration",
    "save_agent_memories", "memory_recall", "memory_save",
    "triage_seed", "plan_pivots", "minimax_plan_pivots", "minimax_correlate",
    "dork_harvest", "gemini_deep_dork",
    "attribution_check", "date_sanity_check",
  ];
  for (const t of NEVER) {
    assert(
      !ESCALATION_ELIGIBLE_TOOLS.has(t),
      `${t} must never be escalation-eligible — scanning it is wrong at any time`,
    );
  }
});

Deno.test("default behaviour is unchanged: a denylisted search tool yields nothing", () => {
  assertEquals(extractFindings("minimax_web_search", SEARCH_RESULT.output, SEARCH_RESULT.input), []);
  assertEquals(extractStepFindings([SEARCH_RESULT]), []);
  // ...and explicitly opting OUT is the same as not passing the option at all.
  assertEquals(extractStepFindings([SEARCH_RESULT], undefined, { escalated: false }), []);
});

Deno.test("escalated: a search tool's findings become extractable", () => {
  const out = extractStepFindings([SEARCH_RESULT], undefined, { escalated: true });
  assert(out.length > 0, "escalation did not recover any finding from a search tool");
  assert(
    out.every((f) => f.toolName === "minimax_web_search"),
    "escalated output attributed to the wrong tool — provenance must survive",
  );
});

Deno.test("escalated: a NEVER-eligible tool still yields nothing", () => {
  // The gate opening must not open it for everything.
  const recording = { ...SEARCH_RESULT, toolName: "record_artifacts" };
  assertEquals(extractStepFindings([recording], undefined, { escalated: true }), []);
  const autoRecorder = { ...SEARCH_RESULT, toolName: "gemini_deep_dork" };
  assertEquals(extractStepFindings([autoRecorder], undefined, { escalated: true }), []);
});

Deno.test("escalated output still goes through the normal extraction contract", () => {
  // Escalation changes WHICH TOOLS are scanned. It must not change what counts as
  // a finding: an explicit tool error yields nothing, escalated or not, so a
  // failed Wayback/search call cannot manufacture evidence.
  const failed = {
    toolName: "exa_search",
    input: { query: "x" },
    output: { ok: false, error: "upstream timeout" },
  };
  assertEquals(extractStepFindings([failed], undefined, { escalated: true }), []);
});

Deno.test("a tool timeout does not erase another tool's escalated output", () => {
  // The 2026-08-06 run carried a Wayback timeout alongside its other calls. One
  // failed result must not suppress the step's surviving findings.
  const out = extractStepFindings(
    [{ toolName: "wayback_cdx_search", input: {}, output: { ok: false, error: "timeout" } }, SEARCH_RESULT],
    undefined,
    { escalated: true },
  );
  assert(out.length > 0, "a failed peer result suppressed a good one");
});

Deno.test("escalated extraction is deterministic and de-duplicated within a step", () => {
  // Idempotency starts here: the same value surfaced twice in one step must
  // produce one candidate, so the DB-backed dedup downstream is not load-bearing
  // for the trivial case.
  const twice = [SEARCH_RESULT, { ...SEARCH_RESULT, toolName: "exa_search" }];
  const out = extractStepFindings(twice, undefined, { escalated: true });
  const values = out.map((f) => `${f.kind}:${f.value}`);
  assertEquals(
    values.length, new Set(values).size,
    "escalated extraction emitted duplicate kind:value pairs within one step",
  );
});

// ---------------------------------------------------------------------------
// The pre-nudge timeline. Review finding on the first version of this PR: the
// escalation gate can only open once persistenceNudgeCount > 0, and the nudge
// fires only after several unrecorded fan-out steps — so everything found before
// that was denied by the denylist and never held anywhere. Worse,
// buildIntermediateStepPlan narrows the nudge step's activeTools to
// ["record_artifacts"] alone, so the very step that OPENS the gate has no search
// result to extract. Without a buffer the fix only covered searches made AFTER
// the first nudge, which is not the failure it claims to close.
// ---------------------------------------------------------------------------

type Buffered = ExtractedFinding & { toolName: string };
const newBuffer = () => new Map<string, Buffered>();

/** The exact failure sequence from the 2026-08-06 forensics. */
function replayRun(steps: Array<{ toolResults: unknown[]; nudgeFired: boolean }>): {
  persisted: Buffered[];
  buffer: Map<string, Buffered>;
} {
  const buffer = newBuffer();
  let nudgeCount = 0;
  let persisted: Buffered[] = [];
  for (const step of steps) {
    if (step.nudgeFired) nudgeCount++;
    const escalated = nudgeCount > 0;
    const stepFindings = extractStepFindings(step.toolResults, undefined, { escalated });
    if (!escalated) {
      const names = (step.toolResults as Array<{ toolName?: string }>).map((r) => r?.toolName ?? "");
      if (names.some((n) => ESCALATION_ELIGIBLE_TOOLS.has(n))) {
        bufferEscalationCandidates(
          buffer,
          extractStepFindings(step.toolResults, undefined, { escalated: true })
            .filter((f) => ESCALATION_ELIGIBLE_TOOLS.has(f.toolName)),
        );
      }
    } else if (stepFindings.length > 0 || buffer.size > 0) {
      persisted = persisted.concat(drainEscalationBuffer(buffer, stepFindings));
    }
  }
  return { persisted, buffer };
}

Deno.test("pre-nudge search evidence survives a nudge step that offers only record_artifacts", () => {
  // searches → nudge step (record_artifacts only, model declines) → a later step.
  // The declined nudge step yields no extractable result at all, so without the
  // buffer this run persists nothing despite five useful searches.
  const searchStep = (i: number) => ({
    toolResults: [{
      toolName: "minimax_web_search",
      input: { query: `q${i}` },
      output: { ok: true, results: [{ url: `https://example.org/hit-${i}` }] },
    }],
    nudgeFired: false,
  });
  const declinedNudgeStep = {
    // activeTools was ["record_artifacts"]; the model declined, so the step
    // produced no tool result the backstop can read.
    toolResults: [] as unknown[],
    nudgeFired: true,
  };
  const laterBarrenStep = { toolResults: [{ toolName: "wayback_cdx_search", output: { ok: false, error: "timeout" } }], nudgeFired: false };

  const { persisted } = replayRun([
    searchStep(1), searchStep(2), searchStep(3), searchStep(4), searchStep(5),
    declinedNudgeStep,
    laterBarrenStep,
  ]);

  assert(persisted.length > 0, "five pre-nudge searches were lost — the buffer did not carry them");
  const urls = persisted.map((f) => f.value);
  for (const i of [1, 2, 3, 4, 5]) {
    assert(
      urls.some((u) => u.includes(`hit-${i}`)),
      `evidence from pre-nudge search step ${i} was not recovered`,
    );
  }
});

Deno.test("nothing is persisted while the gate stays shut", () => {
  // The buffer must be exactly that — a hold, not a write. A run that never
  // nudges must behave byte-identically to today.
  const { persisted, buffer } = replayRun([
    { toolResults: [SEARCH_RESULT], nudgeFired: false },
    { toolResults: [SEARCH_RESULT], nudgeFired: false },
  ]);
  assertEquals(persisted, []);
  assert(buffer.size > 0, "candidates should be held, ready for a gate that may still open");
});

Deno.test("draining is idempotent — a second escalated step does not re-persist", () => {
  // drainEscalationBuffer empties the buffer, so buffered rows are offered once.
  // Re-persisting them would rely entirely on the DB dedup to stay correct.
  const buffer = newBuffer();
  const step = extractStepFindings([SEARCH_RESULT], undefined, { escalated: true });
  bufferEscalationCandidates(buffer, step);
  const first = drainEscalationBuffer(buffer, []);
  assert(first.length > 0);
  assertEquals(buffer.size, 0, "buffer must be emptied by a drain");
  assertEquals(drainEscalationBuffer(buffer, []), []);
});

Deno.test("buffered candidates lead the drain, so a cap cannot truncate the oldest", () => {
  const buffer = newBuffer();
  bufferEscalationCandidates(
    buffer,
    extractStepFindings([SEARCH_RESULT], undefined, { escalated: true }),
  );
  const held = [...buffer.values()].map((f) => f.value);
  const fresh = extractStepFindings(
    [{ toolName: "exa_search", input: {}, output: { ok: true, results: [{ url: "https://example.net/fresh" }] } }],
    undefined,
    { escalated: true },
  );
  const drained = drainEscalationBuffer(buffer, fresh).map((f) => f.value);
  assertEquals(drained.slice(0, held.length), held, "the oldest evidence must lead");
});

Deno.test("the buffer is bounded and de-duplicated", () => {
  const buffer = newBuffer();
  const many: Buffered[] = Array.from({ length: MAX_ESCALATION_BUFFER + 25 }, (_, i) => ({
    kind: "url", value: `https://example.org/n-${i}`, toolName: "exa_search",
  }));
  const first = bufferEscalationCandidates(buffer, many);
  assertEquals(buffer.size, MAX_ESCALATION_BUFFER, "buffer exceeded its ceiling");
  assertEquals(first.dropped, 25, "overflow must be reported, not silently swallowed");
  // Re-offering the same values adds nothing.
  const again = bufferEscalationCandidates(buffer, many.slice(0, 10));
  assertEquals(again.added, 0);
});

Deno.test("the index.ts call site wires the buffer on both sides", () => {
  // Source-level, like the gate assertion below: the buffer's value is entirely in
  // WHERE it is filled and drained, which is call-site structure rather than a pure
  // function. A buffer that is filled but never drained loses exactly the evidence
  // it was added to save, and both halves pass their unit tests in isolation.
  const src = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));
  assert(
    /bufferEscalationCandidates\(escalationBuffer/.test(src),
    "pre-nudge candidates are never buffered",
  );
  assert(
    /drainEscalationBuffer\(escalationBuffer, stepFindings\)/.test(src),
    "the buffer is filled but never drained into the persist call",
  );
  assert(
    /if \(!escalated\) \{[\s\S]{0,700}?bufferEscalationCandidates/.test(src),
    "buffering must happen on the PRE-gate path — that is the evidence at risk",
  );
  assert(
    /escalationBuffer\.clear\(\)/.test(src),
    "the stand-down path must release the buffer rather than carry it for the run",
  );
});

Deno.test("the index.ts call site gates escalation on BOTH conditions", () => {
  // Source-level, in the spirit of reviews_wiring_test.ts: the two-condition gate
  // is the whole safety argument, and it lives at the call site rather than in a
  // pure function, so it cannot be asserted any other way. If someone drops the
  // `seen.size` half, escalated rows start landing on threads that already have
  // evidence — the noise case this design explicitly refuses.
  const src = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));
  assert(
    /const escalated = persistenceNudgeCount > 0/.test(src),
    "condition 1 missing: escalation must require the persistence nudge to have fired",
  );
  assert(
    /if \(escalated && seen\.size > 0\)/.test(src),
    "condition 2 missing: escalation must stand down when the thread already holds artifacts",
  );
  assert(
    /extractStepFindings\([\s\S]{0,120}\{ escalated \}/.test(src),
    "the escalation flag is computed but never threaded into extractStepFindings",
  );
  assert(
    src.includes("auto_persist_escalated") && src.includes("auto_persist_escalation_stood_down"),
    "both escalation outcomes must be observable in structured logs",
  );
});
