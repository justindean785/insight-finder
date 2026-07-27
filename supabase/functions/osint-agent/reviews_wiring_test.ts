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
  assertStringIncludes(INDEX, "renderAnalystRejectionBlock(", "the DO-NOT-USE block must be rendered");
  assert(
    /baseSystemPrompt\s*=[\s\S]{0,400}analystRejectionBlock/.test(INDEX),
    "the rejection block must be concatenated into baseSystemPrompt, not computed and dropped",
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
  assert(
    /\.select\("id,kind,value,confidence,source"\)/.test(INDEX),
    "the salvage artifact select must include id for row-level verdict matching",
  );
});
