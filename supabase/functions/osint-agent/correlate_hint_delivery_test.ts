/**
 * Correlate hint DELIVERY — the half #530 did not close.
 *
 * #530 made the counter correct: auto-persisted artifacts now count toward the
 * trigger. Validated on build 3d5130e, thread 15ebf7d4, and the pass still never
 * ran. The measured reason is delivery, not counting:
 *
 *   14:31:59   20 artifacts land   (auto-persist; the counter bumps — #530 works)
 *   14:32-33   14 more tool calls  (fan-out; counter well past the threshold of 8)
 *   14:33:32   record_artifacts    (call 22 of 23 — the hint fires HERE)
 *   14:33:42   memory_save         (call 23; run ends)
 *
 * `correlateNudge()` rode ONLY on a `record_artifacts` result, and the model opens
 * that channel once, at the end. A correct trigger delivered through a channel the
 * model opens last is not a trigger.
 *
 * These drive the shipped `takeCorrelateHint` / `resetCorrelateCycle` — never a
 * restatement of them.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  guard,
  bumpAutoPersistedArtifacts,
  correlateDue,
  correlateNudge,
  takeCorrelateHint,
  resetCorrelateCycle,
  CORRELATE_ARTIFACT_THRESHOLD,
} from "./guard.ts";

const persisted = (n: number) => ({ inserted: n, rows: Array.from({ length: n }, () => ({ kind: "url" })) });
const hintKeys = (o: Record<string, unknown>) => Object.keys(o);

// ── THE REGRESSION: the hint must be available mid-run, not only at the end ──
Deno.test("REGRESSION 15ebf7d4: the hint is takeable as soon as the pass is due", () => {
  resetCorrelateCycle();
  bumpAutoPersistedArtifacts(persisted(20));            // the 14:31:59 batch
  assert(correlateDue(), "precondition: 20 auto-persisted artifacts make it due");
  const hint = takeCorrelateHint();
  assertEquals(hintKeys(hint), ["correlate_hint"], "it must be deliverable BEFORE any record_artifacts call");
});

Deno.test("nothing is delivered before the threshold", () => {
  resetCorrelateCycle();
  bumpAutoPersistedArtifacts(persisted(CORRELATE_ARTIFACT_THRESHOLD - 1));
  assertEquals(hintKeys(takeCorrelateHint()).length, 0);
  assertEquals(guard.correlateHintDelivered, false, "a no-op take must not burn the latch");
});

// ── THE LATCH: one directive per cycle, not a banner on every payload ───────
Deno.test("the hint is delivered at most ONCE per correlate cycle", () => {
  resetCorrelateCycle();
  bumpAutoPersistedArtifacts(persisted(20));
  assertEquals(hintKeys(takeCorrelateHint()), ["correlate_hint"], "first take delivers");
  for (let i = 0; i < 5; i++) {
    assertEquals(hintKeys(takeCorrelateHint()).length, 0, "subsequent takes stay silent");
  }
});

Deno.test("more artifacts arriving mid-cycle do NOT re-open the latch", () => {
  resetCorrelateCycle();
  bumpAutoPersistedArtifacts(persisted(20));
  takeCorrelateHint();
  bumpAutoPersistedArtifacts(persisted(50));           // fan-out keeps writing
  assertEquals(hintKeys(takeCorrelateHint()).length, 0, "still one directive, not a running commentary");
});

// ── A CORRELATE PASS RE-ARMS IT ─────────────────────────────────────────────
Deno.test("a correlate pass resets counter AND latch together", () => {
  resetCorrelateCycle();
  bumpAutoPersistedArtifacts(persisted(20));
  takeCorrelateHint();
  assertEquals(guard.correlateHintDelivered, true);
  resetCorrelateCycle();                                // what minimax_correlate does on success
  assertEquals(guard.artifactsSinceCorrelate, 0);
  assertEquals(guard.correlateHintDelivered, false, "the latch must clear with the counter, or the run goes quiet forever");
  assertEquals(correlateDue(), false, "no new evidence yet");
  bumpAutoPersistedArtifacts(persisted(20));
  assertEquals(hintKeys(takeCorrelateHint()), ["correlate_hint"], "a genuinely new batch re-arms the directive");
});

Deno.test("resetting the counter alone would silence the run — the shared reset prevents it", () => {
  // The failure this helper exists to make impossible: clearing the counter
  // without the latch leaves correlateHintDelivered stuck true for the rest of
  // the run, so no later batch can ever surface a directive again.
  resetCorrelateCycle();
  bumpAutoPersistedArtifacts(persisted(20));
  takeCorrelateHint();
  guard.artifactsSinceCorrelate = 0;                    // the OLD, direct assignment
  bumpAutoPersistedArtifacts(persisted(20));
  assertEquals(hintKeys(takeCorrelateHint()).length, 0, "documents the hazard: latch still set");
  resetCorrelateCycle();                                // the shipped helper clears both
  bumpAutoPersistedArtifacts(persisted(20));
  assertEquals(hintKeys(takeCorrelateHint()), ["correlate_hint"]);
});

// ── CONTENT / SAFETY ────────────────────────────────────────────────────────
Deno.test("the delivered payload is exactly the existing nudge — no new contract", () => {
  resetCorrelateCycle();
  bumpAutoPersistedArtifacts(persisted(20));
  const before = correlateNudge();                      // pure read, does not latch
  resetCorrelateCycle();
  bumpAutoPersistedArtifacts(persisted(20));
  assertEquals(takeCorrelateHint(), before, "delivery must not invent a different directive");
});

Deno.test("correlateNudge stays pure — reading it must not consume the latch", () => {
  resetCorrelateCycle();
  bumpAutoPersistedArtifacts(persisted(20));
  correlateNudge(); correlateNudge();
  assertEquals(guard.correlateHintDelivered, false);
  assertEquals(hintKeys(takeCorrelateHint()), ["correlate_hint"], "the take still works after reads");
});

Deno.test("the hint carries no budget, cap or scoring field", () => {
  resetCorrelateCycle();
  bumpAutoPersistedArtifacts(persisted(500));
  const hint = takeCorrelateHint();
  assertEquals(Object.keys(hint), ["correlate_hint"]);
  assertEquals(typeof hint.correlate_hint, "string");
});

Deno.test("a run that persists nothing never delivers", () => {
  resetCorrelateCycle();
  bumpAutoPersistedArtifacts(persisted(0));
  assertEquals(hintKeys(takeCorrelateHint()).length, 0);
  assertEquals(guard.correlateHintDelivered, false);
});

// ── ONE LATCH GOVERNS BOTH SURFACES (review finding, invariant (d)) ─────────
// The first version of this change left `record_artifacts` calling the UNLATCHED
// `correlateNudge()`, so the hint could be delivered twice in one cycle: once on a
// live tool result and again on the recording result. Excluding recording tools
// from the new path did nothing about the old one. Both now take through
// `takeCorrelateHint`, so the latch is authoritative across every surface.
Deno.test("both delivery surfaces share ONE latch — no double delivery per cycle", () => {
  resetCorrelateCycle();
  bumpAutoPersistedArtifacts(persisted(20));
  // Surface 1: a live tool result (cache.ts wrapper).
  assertEquals(hintKeys(takeCorrelateHint()), ["correlate_hint"]);
  // Surface 2: the record_artifacts result — must find the latch already spent.
  assertEquals(hintKeys(takeCorrelateHint()).length, 0, "record_artifacts must not re-deliver in the same cycle");
});

Deno.test("either surface may be first — the latch does not privilege one", () => {
  resetCorrelateCycle();
  bumpAutoPersistedArtifacts(persisted(20));
  const first = takeCorrelateHint();          // whichever reaches the model first
  assertEquals(hintKeys(first), ["correlate_hint"]);
  resetCorrelateCycle();
  bumpAutoPersistedArtifacts(persisted(20));
  const other = takeCorrelateHint();
  assertEquals(other, first, "the directive is identical regardless of which surface carries it");
});

// ── THE PROMPT CONTRACT MUST MATCH THE WIDENED SURFACE ─────────────────────
// Delivering the hint on a search result is inert if the system prompt still tells
// the model to honour it only on a `record_artifacts` result. That mismatch is how
// a correct mechanism ships and changes nothing — the #530 failure shape.
Deno.test("the system prompt directs the model to honour the hint on ANY tool result", async () => {
  const prompt = await Deno.readTextFile(new URL("./system-prompt.ts", import.meta.url));
  const line = prompt.split("\n").find((l) => l.includes("correlate_hint"));
  assert(line, "the prompt must still mention correlate_hint");
  assert(
    /ANY tool result carries a[^a-z]*correlate_hint/i.test(line!),
    "the directive must not be scoped to record_artifacts — that is the surface the model opens LAST",
  );
});
