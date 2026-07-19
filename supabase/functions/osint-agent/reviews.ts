/**
 * reviews.ts — make analyst verdicts (public.artifact_reviews) visible to the agent.
 *
 * THE BUG THIS FIXES
 *   The analyst's Confirm/False/Recheck marks are written to `artifact_reviews`
 *   by the frontend (src/lib/review.ts) but were NEVER read by any edge function
 *   (0 references). Every path that re-reads artifacts to feed the model — the
 *   salvage synthesis, the 7-day investigation_cache, the cluster engine, and
 *   stale-run recovery — pulled raw rows and treated a `dismissed`/`wrong`
 *   artifact identically to a confirmed one. Result: findings the analyst marked
 *   FALSE reappeared as the "most likely subject."
 *
 * STATES (mirror src/lib/review.ts):
 *   confirmed | key    → keep (any boost is applied elsewhere)
 *   recheck            → analyst flagged suspect → downweight confidence
 *   dismissed | wrong  → analyst REJECTED → exclude from everything the model sees
 *
 * All functions are best-effort and fail OPEN: a review-load error must never
 * break a run (it degrades to the prior, unfiltered behavior).
 */

/** Verdicts that mean "the analyst rejected this — do not use it." */
export const REJECTED_REVIEW_STATES: ReadonlySet<string> = new Set(["dismissed", "wrong"]);
/**
 * Confidence subtracted from an artifact the analyst flagged `recheck`.
 * MUST match the canonical delta in src/lib/review.ts
 * (REVIEW_CONFIDENCE_DELTA.recheck = -20) — that frontend constant is what an
 * analyst actually sees applied to a `recheck`-flagged artifact everywhere
 * else in the product, so the backend must apply the identical penalty.
 */
export const RECHECK_CONFIDENCE_PENALTY = 20;

export function isRejectedReview(state: string | null | undefined): boolean {
  return !!state && REJECTED_REVIEW_STATES.has(state);
}

type QueryResult = { data: Array<Record<string, unknown>> | null; error: unknown };
type Eqable = PromiseLike<QueryResult> & { eq: (col: string, v: unknown) => Eqable };
type ReviewDb = { from: (table: string) => { select: (cols: string) => { eq: (col: string, v: unknown) => Eqable } } };

/**
 * Load analyst review verdicts for a thread → Map<artifact_id, state>.
 * Uses the service-role client (RLS grants service_role ALL on artifact_reviews).
 * Fails open: any error yields an empty map.
 */
export async function loadReviewsForThread(
  db: ReviewDb,
  threadId: string,
  userId?: string | null,
): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  try {
    let q = db.from("artifact_reviews").select("artifact_id,state").eq("thread_id", threadId);
    if (userId) q = q.eq("user_id", userId);
    const { data, error } = await q;
    if (error || !Array.isArray(data)) return m;
    for (const r of data) {
      const id = typeof r?.artifact_id === "string" ? r.artifact_id : null;
      const state = typeof r?.state === "string" ? r.state : null;
      if (id && state) m.set(id, state);
    }
  } catch (e) {
    console.warn("[reviews] loadReviewsForThread failed:", (e as Error)?.message ?? e);
  }
  return m;
}

/**
 * Filter + adjust artifact rows by analyst verdict, for any read that feeds the
 * model. Rows MUST carry `id` (matching artifact_reviews.artifact_id).
 *   - dismissed / wrong → DROPPED (analyst rejected)
 *   - recheck           → confidence − RECHECK_CONFIDENCE_PENALTY, tagged review_state
 *   - confirmed / key    → tagged review_state (kept)
 * When the review map is empty this is a no-op (returns the rows unchanged).
 */
export function applyReviewsToArtifacts<T extends Record<string, unknown>>(
  rows: T[] | null | undefined,
  reviewMap: Map<string, string>,
): T[] {
  if (!Array.isArray(rows)) return [];
  if (reviewMap.size === 0) return rows;
  const out: T[] = [];
  for (const r of rows) {
    const id = typeof r?.id === "string" ? r.id : null;
    const state = id ? reviewMap.get(id) : undefined;
    if (state && REJECTED_REVIEW_STATES.has(state)) continue; // analyst rejected → exclude
    if (state === "recheck") {
      const c = typeof r.confidence === "number" ? r.confidence : Number(r.confidence) || 0;
      out.push({ ...r, confidence: Math.max(0, c - RECHECK_CONFIDENCE_PENALTY), review_state: state });
    } else if (state) {
      out.push({ ...r, review_state: state });
    } else {
      out.push(r);
    }
  }
  return out;
}

/**
 * The artifacts the analyst REJECTED (dismissed/wrong), for an explicit
 * "DO NOT USE" block in a synthesis prompt — showing the model the rejected
 * values by name is stronger than silently dropping them, because it stops the
 * model re-deriving the same identity from adjacent evidence.
 */
export function rejectedArtifacts<T extends Record<string, unknown>>(
  rows: T[] | null | undefined,
  reviewMap: Map<string, string>,
): T[] {
  if (!Array.isArray(rows) || reviewMap.size === 0) return [];
  return rows.filter((r) => {
    const id = typeof r?.id === "string" ? r.id : null;
    return id ? REJECTED_REVIEW_STATES.has(reviewMap.get(id) ?? "") : false;
  });
}
