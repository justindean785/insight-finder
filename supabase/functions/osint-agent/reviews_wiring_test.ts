// reviews_wiring_test.ts — the guard that would have caught the 07-20 regression.
//
// WHY A SOURCE-LEVEL TEST: reviews.ts has thorough unit tests (reviews_test.ts) and
// every one of them PASSED for the entire week the feature was broken. The module
// was correct; nothing called it. The 07-20 emergency rollback (0595d8e / 4c92abd)
// deleted all five call sites in index.ts and left the module + its tests behind,
// so the suite stayed green while 628 analyst verdicts were silently ignored and
// the agent kept re-asserting findings the analyst had marked FALSE.
//
// Unit tests cannot catch "correct module, never invoked". This asserts the wiring
// itself. If someone deletes the call sites again — by rollback, revert, or
// refactor — this fails loudly instead of going quietly green.
import { assert, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const INDEX = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("analyst verdicts: index.ts imports the reviews module", () => {
  assertStringIncludes(
    INDEX,
    'from "./reviews.ts"',
    "index.ts must import reviews.ts — without it, analyst verdicts are dead code",
  );
});

Deno.test("analyst verdicts: the per-turn rejection block is built and injected", () => {
  // Dropping rejected rows from artifact reads is NOT sufficient on its own — a
  // follow-up turn still carries the false narrative in message history, so the
  // model re-asserts it. The supersede block must reach baseSystemPrompt, which
  // feeds the intermediate, finalize AND salvage paths.
  assertStringIncludes(INDEX, "loadReviewsForThread(", "verdicts must be loaded per turn");
  // 2026-09-02: the rejection-only block became ONE structured ANALYST DECISIONS
  // block (confirmed / key / recheck / rejected). The DO-NOT-USE half is rendered
  // inside it — reviews_test.ts pins that — so the wiring assertion follows the
  // renderer that index.ts actually calls.
  assertStringIncludes(INDEX, "renderAnalystDecisionsBlock(", "the ANALYST DECISIONS block must be rendered");
  assert(
    /baseSystemPrompt\s*=[\s\S]{0,400}analystDecisionsBlock/.test(INDEX),
    "the decisions block must be concatenated into baseSystemPrompt, not computed and dropped",
  );
});

Deno.test("analyst verdicts: the salvage path filters rejected artifacts and fails closed", () => {
  // Salvage is the dominant CPU-kill finalize path. If it synthesizes from
  // unfiltered rows, a rejected finding lands in the closing report the analyst
  // actually reads — the original incident.
  assertStringIncludes(
    INDEX,
    "applyReviewsToArtifacts(",
    "salvage must filter artifacts through analyst verdicts",
  );
  assert(
    /salvage_skipped_review_state_unavailable/.test(INDEX),
    "salvage must FAIL CLOSED when verdicts are unreadable, not synthesize unfiltered",
  );
});

Deno.test("analyst verdicts: unreadable review state is surfaced, never treated as 'nothing rejected'", () => {
  // `ok:false` means we could not read the verdicts. Silently continuing would
  // imply to the model that nothing was rejected — the worst possible default.
  assertStringIncludes(INDEX, "REVIEW_STATE_UNAVAILABLE_NOTE");
  assertStringIncludes(INDEX, "turn_review_state_unavailable");
});

Deno.test("analyst verdicts: salvage reads artifact ids so verdicts match at row level", () => {
  // applyReviewsToArtifacts matches by id first and falls back to kind|value. If
  // the select omits `id`, only the value-level path works and a per-row verdict
  // on a duplicated selector is missed.
  // Trailing columns are allowed (#479 added `metadata` for the recorded
  // confidence cap). What this guards is that `id` is still selected — pinning
  // the exact column list instead made an additive change look like a regression.
  assert(
    /\.select\("id,kind,value,confidence,source[^"]*"\)/.test(INDEX),
    "the salvage artifact select must include id for row-level verdict matching",
  );
});

const CLUSTER = await Deno.readTextFile(new URL("./lib/cluster.ts", import.meta.url));
const RECOVERY = await Deno.readTextFile(new URL("./recovery.ts", import.meta.url));

// An automated review caught the FIRST restore as incomplete: the prompt block and
// salvage were re-wired, but a rejected finding could still re-seed clustering, be
// cached into a FUTURE run, and come back in a recovery stub. Commit 021a956 was
// titled "review-filter every model/scoring/memory artifacts read" — every, not some.
Deno.test("analyst verdicts: clustering does not re-seed identity from rejected rows", () => {
  // Worst of the remaining paths: clustering is union-find, so a rejected value
  // does not merely reappear — it PULLS genuine artifacts into its cluster and can
  // be promoted as the most-likely identity.
  assertStringIncludes(CLUSTER, "loadReviewsForThread(", "clustering must load verdicts");
  // dropRejectedArtifacts, not applyReviewsToArtifacts: rejection is the only
  // decision clustering honours, and the confidence entering promotion is the
  // recorded one (cluster_rejected_clear_test.ts pins the behaviour).
  assertStringIncludes(CLUSTER, "dropRejectedArtifacts(", "clustering must filter on them");
  assertStringIncludes(CLUSTER, "clustering_skipped_review_state_unavailable", "must fail closed");
  assertStringIncludes(CLUSTER, "cluster_assignment_cleared", "a rejected row's stale cluster_id must be cleared");
});

Deno.test("analyst verdicts: recovery FAILS CLOSED on an unreadable review set", () => {
  // The old branch fell back to the RAW fetch when the verdicts could not be
  // read — the opposite of its own comment. The stub is a report the analyst
  // reads; "could not read the verdicts" must render as no listed artifacts.
  assert(
    /recoveryReviews\.ok\s*\?[\s\S]{0,300}?:\s*\[\]/.test(RECOVERY),
    "recovery must substitute [] (not the raw artifacts) when the review load is not ok",
  );
});

Deno.test("analyst verdicts: the investigation cache is filtered before it is written", () => {
  // Widest blast radius of any read. The cache is replayed into a DIFFERENT, FUTURE
  // investigation where the rejection does not apply to that thread — so a value
  // marked FALSE can resurface as prior intelligence in a run with no record of it
  // ever being rejected.
  assertStringIncludes(INDEX, "cache_skipped_review_state_unavailable", "cache must fail closed");
  assert(
    /Persist investigation cache[\s\S]{0,3000}applyReviewsToArtifacts\(/.test(INDEX),
    "the cache write must filter artifacts through analyst verdicts",
  );
});

Deno.test("analyst verdicts: the recovery stub excludes rejected findings", () => {
  // The stub is a REPORT the analyst reads, built straight from durable artifacts.
  assertStringIncludes(RECOVERY, "loadReviewsForThread(", "recovery must load verdicts");
  assert(
    /buildRecoveredAssistantText\(thread,\s*reviewedArtifacts/.test(RECOVERY),
    "the stub must be built from review-filtered artifacts, not the raw fetch",
  );
});

// ---- No confidence write-through (2026-09-02) ----
// The section this replaces pinned the OPPOSITE contract: +20 / +25 / −20 applied
// to evidence confidence on every model-facing read. That made a human verdict
// behave like a second source. The contract now: a decision is authority,
// priority or workflow state and travels as `review_state`; the number is exactly
// what the engine recorded. Pinned here beside the wiring so a "tidy-up" that
// re-adds a delta fails loudly.
import { applyReviewsToArtifacts, emptyReviewLoad } from "./reviews.ts";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

function loadWith(state: string) {
  const l = emptyReviewLoad(true);
  l.byId.set("a1", state);
  return l;
}
const row = (confidence: number) => [{ id: "a1", kind: "email", value: "x@y.z", confidence }];

Deno.test("⛔ a verdict tags review_state and leaves the NUMBER exactly as recorded", () => {
  for (const state of ["confirmed", "key", "recheck"]) {
    const out = applyReviewsToArtifacts(row(45), loadWith(state))[0];
    assertEquals(out.confidence, 45, `${state} must not move evidence confidence`);
    assertEquals(out.review_state, state);
  }
  assertEquals(applyReviewsToArtifacts(row(5), loadWith("recheck"))[0].confidence, 5, "no floor arithmetic either");
});

Deno.test("no reviews.ts export can express a confidence delta any more", async () => {
  const mod = await import("./reviews.ts") as Record<string, unknown>;
  for (const name of Object.keys(mod)) {
    assertEquals(/CONFIDENCE|Delta/i.test(name), false, `unexpected confidence export ${name}`);
  }
});
