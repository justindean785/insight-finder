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
  extractFindings,
  extractStepFindings,
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
