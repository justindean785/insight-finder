/**
 * rejected-cluster-sweep — make an analyst rejection bind on the persisted
 * cluster columns WITHOUT waiting for the thread to be re-run.
 *
 * `applyClusteringToThread` clears cluster_id / subject_id on rejected rows,
 * but its only caller is the finalize tail of a run. A Dismiss recorded on a
 * finished thread therefore left the row a member of the subject's cluster on
 * every surface keyed on the persisted columns until the analyst typed another
 * message. Measured 2026-09-02: 216 rejected rows across the corpus still held
 * a cluster_id. The frontend excludes them client-side; the graph, the
 * clustering pass of a later run, and anything reading the columns did not.
 *
 * This sweep runs from the health probe (hit by pg_cron every minute), is
 * bounded per call, idempotent, and CONVERGES: once nothing is stale the cost
 * is one indexed read of the rejected reviews, and a short in-isolate memo then
 * skips even that for a while. It reuses `dropRejectedArtifacts` (so alias
 * twins of a rejected selector clear too) and `clearStaleClusterAssignments`
 * (so it clears by the same definition finalize uses). Fail-closed per thread:
 * an unreadable review set clears nothing on that thread.
 *
 * Kill switch: REJECTED_CLUSTER_SWEEP_DISABLED=true|1.
 */
import { REJECTED_REVIEW_STATES, dropRejectedArtifacts, loadReviewsForThread } from "../reviews.ts";
import { clearStaleClusterAssignments } from "./cluster.ts";

// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = { from(table: string): any };

export type SweepResult = {
  ok: boolean;
  /** rejected-review rows read */
  reviews: number;
  /** rows that still held an assignment when the sweep looked */
  stale: number;
  /** threads touched this call */
  threads: number;
  /** assignments cleared this call */
  cleared: number;
  errors: number;
  skipped: "disabled" | "recently_clean" | null;
};

const CLEAN_MEMO_MS = 10 * 60 * 1000;
let lastCleanAt = 0;

/** Test seam: forget the "recently clean" memo. */
export function resetSweepMemo(): void { lastCleanAt = 0; }

export function sweepDisabled(): boolean {
  const env = (globalThis as { Deno?: { env?: { get?(k: string): string | undefined } } }).Deno?.env;
  const v = env?.get?.("REJECTED_CLUSTER_SWEEP_DISABLED");
  return v === "true" || v === "1";
}

const chunk = <T>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

export async function sweepRejectedClusterAssignments(
  admin: DbLike,
  opts: { maxThreads?: number; reviewPage?: number; now?: number; ignoreMemo?: boolean } = {},
): Promise<SweepResult> {
  const res: SweepResult = { ok: true, reviews: 0, stale: 0, threads: 0, cleared: 0, errors: 0, skipped: null };
  if (sweepDisabled()) return { ...res, skipped: "disabled" };
  const now = opts.now ?? Date.now();
  if (!opts.ignoreMemo && lastCleanAt && now - lastCleanAt < CLEAN_MEMO_MS) return { ...res, skipped: "recently_clean" };
  const maxThreads = opts.maxThreads ?? 5;
  const reviewPage = opts.reviewPage ?? 2000;

  // 1. Every rejected review (bounded page). One indexed read in steady state.
  const { data: revs, error: rErr } = await admin.from("artifact_reviews")
    .select("artifact_id,thread_id,user_id,state")
    .in("state", Array.from(REJECTED_REVIEW_STATES))
    .limit(reviewPage);
  if (rErr || !Array.isArray(revs)) return { ...res, ok: false, errors: 1 };
  res.reviews = revs.length;
  if (revs.length === 0) { lastCleanAt = now; return res; }

  // 2. Which of those artifacts still hold an assignment?
  const byArtifact = new Map<string, { thread: string; user: string | null }>();
  for (const r of revs as Array<Record<string, unknown>>) {
    const id = typeof r.artifact_id === "string" ? r.artifact_id : "";
    if (!id || byArtifact.has(id)) continue;
    byArtifact.set(id, { thread: String(r.thread_id ?? ""), user: typeof r.user_id === "string" ? r.user_id : null });
  }
  const stale: Array<Record<string, unknown>> = [];
  for (const ids of chunk(Array.from(byArtifact.keys()), 300)) {
    const { data, error } = await admin.from("artifacts")
      .select("id,thread_id,cluster_id,subject_id,metadata")
      .in("id", ids)
      .or("cluster_id.not.is.null,subject_id.not.is.null");
    if (error || !Array.isArray(data)) { res.errors++; continue; }
    for (const row of data as Array<Record<string, unknown>>) stale.push(row);
  }
  res.stale = stale.length;
  if (stale.length === 0 && res.errors === 0) { lastCleanAt = now; return res; }

  // 3. Per thread (bounded): re-derive the kept set with the SAME review load and
  //    filter finalize uses, over the thread's assigned rows, so alias twins of a
  //    rejected selector clear as well. Fail-closed on an unreadable review set.
  const threads = new Map<string, string | null>();
  for (const row of stale) {
    const t = String(row.thread_id ?? "");
    if (!t || threads.has(t)) continue;
    const owner = Array.from(byArtifact.values()).find((v) => v.thread === t)?.user ?? null;
    threads.set(t, owner);
  }
  for (const [threadId, userId] of Array.from(threads.entries()).slice(0, maxThreads)) {
    res.threads++;
    try {
      const reviews = await loadReviewsForThread(admin as unknown as Parameters<typeof loadReviewsForThread>[0], threadId, userId);
      if (!reviews.ok) { res.errors++; continue; }
      const { data, error } = await admin.from("artifacts")
        .select("id,kind,value,cluster_id,subject_id,metadata")
        .eq("thread_id", threadId)
        .or("cluster_id.not.is.null,subject_id.not.is.null");
      if (error || !Array.isArray(data)) { res.errors++; continue; }
      const rows = data as Array<Record<string, unknown>>;
      const keptIds = new Set(dropRejectedArtifacts(rows, reviews).map((r) => String(r.id ?? "")));
      const cleared = await clearStaleClusterAssignments(admin, rows, keptIds);
      res.cleared += cleared;
      if (cleared) {
        console.log(JSON.stringify({ event: "cluster_assignment_cleared", thread_id: threadId, cleared, reason: "analyst_rejected", via: "health_sweep" }));
      }
    } catch (e) {
      res.errors++;
      console.warn("[rejected-cluster-sweep] thread failed:", threadId, String(e).slice(0, 160));
    }
  }
  res.ok = res.errors === 0;
  return res;
}

export function describeSweep(r: SweepResult): string {
  if (r.skipped === "disabled") return "disabled (REJECTED_CLUSTER_SWEEP_DISABLED)";
  if (r.skipped === "recently_clean") return "clean (memo)";
  const base = r.stale === 0
    ? `clean: ${r.reviews} rejected review(s), 0 stale assignment(s)`
    : `cleared ${r.cleared} of ${r.stale} stale assignment(s) across ${r.threads} thread(s)`;
  return r.errors ? `${base}; ${r.errors} error(s)` : base;
}
