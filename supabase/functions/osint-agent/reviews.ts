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
 * FAIL-CLOSED (changed 2026-07-19 after review)
 *   Loading used to fail OPEN: a query error yielded an empty map, which silently
 *   restored the exact pre-fix behavior — a transient DB error would re-promote
 *   artifacts the analyst had marked FALSE. That is the incident, reproduced by
 *   an outage. `loadReviewsForThread` now returns an explicit ReviewLoad whose
 *   `ok:false` means "review state UNAVAILABLE". Integrity-critical callers
 *   (cache write, clustering, synthesis) MUST NOT proceed as if unreviewed — they
 *   skip the write / return a neutral "review state unavailable" result instead.
 *
 * ID *AND* VALUE ENFORCEMENT
 *   Filtering only by artifact_id is bypassable: the same rejected kind+value can
 *   be re-recorded later under a fresh id and sail through. Exclusion is therefore
 *   also enforced on a normalized kind|value key.
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

/** Canonical key for value-level exclusion. Case/whitespace-insensitive so a
 *  re-record of the same finding under a new id (or different casing/spacing)
 *  cannot bypass a FALSE verdict. */
export function normalizeArtifactKey(kind: unknown, value: unknown): string {
  const k = String(kind ?? "").trim().toLowerCase();
  const v = String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return `${k}|${v}`;
}

/** Result of loading analyst verdicts. `ok:false` means the verdicts could not be
 *  read — treat as UNAVAILABLE, never as "nothing is rejected". */
export interface RejectedRow { id: string; kind: string; value: string }

export interface ReviewLoad {
  ok: boolean;
  /** artifact_id → review state */
  byId: Map<string, string>;
  /** normalized kind|value of rejected artifacts (survives re-record under a new id) */
  rejectedKeys: Set<string>;
  /** the rejected artifacts themselves, for the authoritative DO-NOT-USE block.
   *  Resolved by the same lookup that builds rejectedKeys — no extra query. */
  rejectedRows: RejectedRow[];
  error: string | null;
}

export function emptyReviewLoad(ok: boolean, error: string | null = null): ReviewLoad {
  return { ok, byId: new Map(), rejectedKeys: new Set(), rejectedRows: [], error };
}

type QueryResult = { data: Array<Record<string, unknown>> | null; error: unknown };
type Eqable = PromiseLike<QueryResult> & { eq: (col: string, v: unknown) => Eqable };
type InAble = PromiseLike<QueryResult> & { in: (col: string, v: readonly unknown[]) => InAble };
type ReviewDb = {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, v: unknown) => Eqable;
      in: (col: string, v: readonly unknown[]) => InAble;
    };
  };
};

function errText(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

/**
 * Load analyst review verdicts for a thread.
 * Uses the service-role client (RLS grants service_role ALL on artifact_reviews).
 * FAILS CLOSED: on any error the result is `{ ok:false }` — callers must degrade
 * safely rather than continue with unfiltered data.
 */
export async function loadReviewsForThread(
  db: ReviewDb,
  threadId: string,
  userId?: string | null,
): Promise<ReviewLoad> {
  const byId = new Map<string, string>();
  const rejectedKeys = new Set<string>();
  try {
    let q = db.from("artifact_reviews").select("artifact_id,state").eq("thread_id", threadId);
    if (userId) q = q.eq("user_id", userId);
    const { data, error } = await q;
    if (error) return emptyReviewLoad(false, errText(error));
    if (!Array.isArray(data)) return emptyReviewLoad(false, "artifact_reviews returned no array");
    for (const r of data) {
      const id = typeof r?.artifact_id === "string" ? r.artifact_id : null;
      const state = typeof r?.state === "string" ? r.state : null;
      if (id && state) byId.set(id, state);
    }

    // Resolve rejected ids → normalized kind|value so a later re-record of the
    // same finding under a NEW id is still excluded. Best-effort: if this lookup
    // fails we still have id-level enforcement, so the load stays ok.
    const rejectedIds = [...byId.entries()].filter(([, s]) => REJECTED_REVIEW_STATES.has(s)).map(([id]) => id);
    const rejectedRows: RejectedRow[] = [];
    if (rejectedIds.length > 0) {
      try {
        const { data: arts, error: aErr } = await db
          .from("artifacts")
          .select("id,kind,value")
          .in("id", rejectedIds);
        if (!aErr && Array.isArray(arts)) {
          for (const a of arts) {
            rejectedKeys.add(normalizeArtifactKey(a?.kind, a?.value));
            rejectedRows.push({
              id: String(a?.id ?? ""),
              kind: String(a?.kind ?? ""),
              value: String(a?.value ?? ""),
            });
          }
        } else if (aErr) {
          console.warn("[reviews] rejected-key lookup failed (id-level enforcement still active):", errText(aErr));
        }
      } catch (e) {
        console.warn("[reviews] rejected-key lookup threw:", errText(e));
      }
    }
    return { ok: true, byId, rejectedKeys, rejectedRows, error: null };
  } catch (e) {
    console.warn("[reviews] loadReviewsForThread failed:", errText(e));
    return emptyReviewLoad(false, errText(e));
  }
}

/**
 * Filter + adjust artifact rows by analyst verdict, for any read that feeds the
 * model. Rows SHOULD carry `id` (matching artifact_reviews.artifact_id).
 *   - dismissed / wrong                  → DROPPED (analyst rejected)
 *   - same normalized kind|value as any  → DROPPED (re-record under a new id
 *     rejected artifact                    cannot bypass the verdict)
 *   - recheck                            → confidence − RECHECK_CONFIDENCE_PENALTY
 *   - confirmed / key                    → tagged review_state (kept)
 *
 * Rejected keys are the union of the DB-resolved keys and the keys of rejected
 * rows present in THIS batch, so the bypass is closed even when the id→value
 * lookup was unavailable.
 */
export function applyReviewsToArtifacts<T extends Record<string, unknown>>(
  rows: T[] | null | undefined,
  review: ReviewLoad,
): T[] {
  if (!Array.isArray(rows)) return [];
  if (!review.ok) return [];           // unavailable → surface nothing rather than everything
  if (review.byId.size === 0 && review.rejectedKeys.size === 0) return rows;

  const rejectedKeys = new Set(review.rejectedKeys);
  for (const r of rows) {
    const id = typeof r?.id === "string" ? r.id : null;
    const state = id ? review.byId.get(id) : undefined;
    if (state && REJECTED_REVIEW_STATES.has(state)) rejectedKeys.add(normalizeArtifactKey(r.kind, r.value));
  }

  const out: T[] = [];
  for (const r of rows) {
    const id = typeof r?.id === "string" ? r.id : null;
    const state = id ? review.byId.get(id) : undefined;
    if (state && REJECTED_REVIEW_STATES.has(state)) continue;
    if (rejectedKeys.has(normalizeArtifactKey(r.kind, r.value))) continue; // same value, new id
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
 * "DO NOT USE" block in a prompt — showing the model the rejected values by name
 * is stronger than silently dropping them, because it stops the model
 * re-deriving the same identity from adjacent evidence.
 */
export function rejectedArtifacts<T extends Record<string, unknown>>(
  rows: T[] | null | undefined,
  review: ReviewLoad,
): T[] {
  if (!Array.isArray(rows) || !review.ok) return [];
  if (review.byId.size === 0 && review.rejectedKeys.size === 0) return [];
  return rows.filter((r) => {
    const id = typeof r?.id === "string" ? r.id : null;
    if (id && REJECTED_REVIEW_STATES.has(review.byId.get(id) ?? "")) return true;
    return review.rejectedKeys.has(normalizeArtifactKey(r.kind, r.value));
  });
}

/**
 * Authoritative analyst-rejection block for the system prompt of ANY model turn —
 * not just salvage synthesis. Ordinary follow-up turns still carry the prior
 * (false) narrative in message history, so without this block the model can and
 * does re-assert a finding the analyst already marked FALSE.
 * Returns "" when there is nothing to say.
 */
export function renderAnalystRejectionBlock<T extends Record<string, unknown>>(
  rejected: T[] | null | undefined,
): string {
  if (!Array.isArray(rejected) || rejected.length === 0) return "";
  const lines = rejected.slice(0, 40).map((r) => {
    const kind = String(r.kind ?? "artifact");
    const value = String(r.value ?? "").slice(0, 160);
    return `  - [${kind}] ${value}`;
  });
  return [
    "",
    "## ANALYST-REJECTED — DO NOT USE (authoritative)",
    "A human analyst reviewed the items below and marked them FALSE/dismissed.",
    "They may still appear in earlier messages in this conversation. That earlier",
    "text is SUPERSEDED. You MUST NOT restate, rank, cite, or re-derive them as the",
    "subject or as supporting evidence — including by inferring the same conclusion",
    "from adjacent evidence. If asked about one, say it was rejected by the analyst.",
    ...lines,
    rejected.length > 40 ? `  …and ${rejected.length - 40} more rejected item(s).` : "",
    "",
  ].filter(Boolean).join("\n");
}

/** Neutral result for an integrity-critical path when verdicts are unavailable.
 *  Never re-promote data in this state — say so instead. */
export const REVIEW_STATE_UNAVAILABLE_NOTE =
  "Analyst review state is UNAVAILABLE (verdict lookup failed). Findings are shown " +
  "without analyst filtering suppressed — treat any prior FALSE/dismissed marks as " +
  "still in force and do not promote a rejected finding.";
