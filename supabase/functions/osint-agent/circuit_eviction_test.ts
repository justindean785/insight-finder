// Regression tests for the THREADS LRU bound (issue #80 / ARCH-5).
// clearThread(threadId) can be missed on error/timeout/unhandled-rejection paths
// on a warm Supabase isolate; without a cap the THREADS map grows unbounded
// (breakers/calls/suppressions Maps) → memory pressure → OOM. The LRU cap is the
// safety net. A non-empty snapshot() is the observable proxy for "this thread is
// still tracked in-memory".
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  acquire,
  clearThread,
  MAX_TRACKED_THREADS,
  recordResult,
  release,
  snapshot,
} from "./circuit.ts";

/** Give a thread observable in-memory state (a breaker entry). */
function trackThread(id: string): void {
  recordResult(id, "exa_search", `sel-${id}`, "default", { status: "http_500" });
}

/** A thread is tracked iff it has at least one breaker in its snapshot. */
function isTracked(id: string): boolean {
  return snapshot(id).length > 0;
}

Deno.test("THREADS map is bounded — oldest thread is evicted once over the cap", () => {
  const prefix = `evict-${crypto.randomUUID()}-`;
  const oldest = `${prefix}0`;
  trackThread(oldest);
  assertEquals(isTracked(oldest), true, "freshly tracked thread should be present");

  // Insert exactly enough *new* threads to push total past the cap so the
  // least-recently-used (oldest, never touched again) is evicted.
  for (let i = 1; i <= MAX_TRACKED_THREADS; i++) {
    trackThread(`${prefix}${i}`);
  }

  assertEquals(isTracked(oldest), false, "oldest untouched thread must be evicted");
  // The most recent insert must still be tracked.
  assertEquals(isTracked(`${prefix}${MAX_TRACKED_THREADS}`), true, "newest thread must be retained");

  // Cleanup.
  for (let i = 0; i <= MAX_TRACKED_THREADS; i++) clearThread(`${prefix}${i}`);
});

Deno.test("eviction is LRU, not FIFO — touching a thread protects it from eviction", () => {
  const prefix = `lru-${crypto.randomUUID()}-`;
  const keep = `${prefix}keep`;
  trackThread(keep);

  // Fill up to (cap - 1) other threads, touching `keep` along the way so it stays
  // most-recently-used rather than oldest.
  for (let i = 0; i < MAX_TRACKED_THREADS - 1; i++) {
    trackThread(`${prefix}${i}`);
    trackThread(keep); // touch — bump keep back to MRU
  }
  assertEquals(isTracked(keep), true, "touched thread still present before overflow");

  // One more *new* thread tips us over the cap. FIFO would evict `keep` (oldest
  // insertion); LRU must evict an untouched filler instead.
  trackThread(`${prefix}overflow`);
  assertEquals(isTracked(keep), true, "recently-touched thread must survive eviction (LRU, not FIFO)");

  // Cleanup.
  clearThread(keep);
  clearThread(`${prefix}overflow`);
  for (let i = 0; i < MAX_TRACKED_THREADS - 1; i++) clearThread(`${prefix}${i}`);
});

Deno.test("clearThread leaves no dangling order entry — thread is fully released", () => {
  const id = `clear-${crypto.randomUUID()}`;
  trackThread(id);
  assertEquals(isTracked(id), true);
  clearThread(id);
  assertEquals(isTracked(id), false, "clearThread must fully remove the thread");
  // Re-tracking after clear works and starts fresh.
  trackThread(id);
  assertEquals(isTracked(id), true);
  clearThread(id);
});

Deno.test("overlapping runs are refcounted — first release() must NOT wipe shared state (issue #80, Codex P2)", () => {
  const id = `overlap-${crypto.randomUUID()}`;
  // Two concurrent runs for the same thread (double-submit / retry) each acquire.
  acquire(id);
  acquire(id);
  // The shared circuit state (a provider suppression recorded by run A) must
  // survive the FIRST run finishing — otherwise run B recreates blank state and
  // re-proposes/-bills failed or premium tools mid-investigation.
  trackThread(id);
  assertEquals(isTracked(id), true, "state present after both runs acquire");

  // First run finishes → release once. State must REMAIN because run B is live.
  release(id);
  assertEquals(
    isTracked(id),
    true,
    "first release of an overlapping pair must NOT delete state still owned by the second run",
  );

  // Second (last) run finishes → release again. Now the state is torn down.
  release(id);
  assertEquals(
    isTracked(id),
    false,
    "state is released only after the LAST active run finishes",
  );
});

Deno.test("release() of a single (non-overlapping) run tears the state down", () => {
  const id = `single-${crypto.randomUUID()}`;
  acquire(id);
  trackThread(id);
  assertEquals(isTracked(id), true);
  release(id);
  assertEquals(isTracked(id), false, "single run's release must fully release the thread");
});

Deno.test("a thread with an in-flight run is never evicted by the LRU cap", () => {
  const prefix = `pin-${crypto.randomUUID()}-`;
  const pinned = `${prefix}pinned`;
  // Acquire an active run on `pinned`, then never touch it again — under plain
  // LRU it would be the oldest and get evicted, but active runs must be skipped.
  acquire(pinned);
  trackThread(pinned);

  // Overflow the cap with brand-new untouched threads.
  for (let i = 0; i <= MAX_TRACKED_THREADS; i++) trackThread(`${prefix}${i}`);

  assertEquals(
    isTracked(pinned),
    true,
    "an active (acquired) thread must not be evicted out from under its run",
  );

  // Cleanup.
  release(pinned);
  for (let i = 0; i <= MAX_TRACKED_THREADS; i++) clearThread(`${prefix}${i}`);
});
