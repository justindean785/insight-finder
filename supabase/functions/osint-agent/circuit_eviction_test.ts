// Regression tests for the THREADS LRU bound (issue #80 / ARCH-5).
// clearThread(threadId) can be missed on error/timeout/unhandled-rejection paths
// on a warm Supabase isolate; without a cap the THREADS map grows unbounded
// (breakers/calls/suppressions Maps) → memory pressure → OOM. The LRU cap is the
// safety net. A non-empty snapshot() is the observable proxy for "this thread is
// still tracked in-memory".
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { recordResult, snapshot, clearThread, MAX_TRACKED_THREADS } from "./circuit.ts";

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
