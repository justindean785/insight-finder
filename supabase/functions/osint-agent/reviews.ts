/**
 * reviews.ts — make analyst decisions (public.artifact_reviews) bind on the agent.
 *
 * THE BUG THIS FIXES (original, 2026-07-19)
 *   The analyst's Confirm/False/Recheck marks are written to `artifact_reviews`
 *   by the frontend (src/lib/review.ts) but were NEVER read by any edge function
 *   (0 references). Every path that re-reads artifacts to feed the model — the
 *   salvage synthesis, the 7-day investigation_cache, the cluster engine, and
 *   stale-run recovery — pulled raw rows and treated a `dismissed`/`wrong`
 *   artifact identically to a confirmed one. Result: findings the analyst marked
 *   FALSE reappeared as the "most likely subject."
 *
 * THE SECOND BUG (2026-09-02)
 *   Only the REJECTION half ever propagated, and it propagated as a confidence
 *   delta. Confirm and Key never reached model context at all, Recheck only
 *   reached it as "-20 confidence", and the cache/cluster/salvage reads applied
 *   +20/+25 to evidence confidence for a human verdict that is not a second
 *   source. Analyst decisions are now four SEPARATE concepts, none of which is
 *   evidence confidence:
 *
 *     confirmed  → an analyst-accepted PROPOSITION (context; do not re-litigate)
 *     key        → an investigative PRIORITY (context + pivot ranking)
 *     recheck    → a durable VERIFICATION TASK (context; pivot task)
 *     dismissed  → REJECTED: excluded from everything the model sees, from
 *     wrong        dispatch, clustering, synthesis and authoritative sections,
 *                  by artifact id AND normalized kind|value. Preserved forensically.
 *
 *   `applyReviewsToArtifacts` therefore no longer touches `confidence`. Engine
 *   confidence, caps, source independence and corroboration are computed at
 *   RECORD time and are left exactly as recorded.
 *
 * FAIL-CLOSED (changed 2026-07-19 after review)
 *   Loading used to fail OPEN: a query error yielded an empty map, which silently
 *   restored the exact pre-fix behavior — a transient DB error would re-promote
 *   artifacts the analyst had marked FALSE. That is the incident, reproduced by
 *   an outage. `loadReviewsForThread` now returns an explicit ReviewLoad whose
 *   `ok:false` means "review state UNAVAILABLE". Integrity-critical callers
 *   (cache write, clustering, synthesis, recovery) MUST NOT proceed as if
 *   unreviewed — they skip the write / return a neutral "review state
 *   unavailable" result instead.
 *
 * ID *AND* VALUE ENFORCEMENT
 *   Filtering only by artifact_id is bypassable: the same rejected kind+value can
 *   be re-recorded later under a fresh id and sail through. Exclusion is therefore
 *   also enforced on a normalized kind|value key.
 */
import { canonicalKind } from "./lib/kind-alias.ts";


/** Verdicts that mean "the analyst rejected this — do not use it." */
export const REJECTED_REVIEW_STATES: ReadonlySet<string> = new Set(["dismissed", "wrong"]);

/** Every recorded verdict. Anything else in the column is ignored as unknown. */
export const KNOWN_REVIEW_STATES: ReadonlySet<string> = new Set([
  "confirmed", "key", "recheck", "dismissed", "wrong",
]);

export function isRejectedReview(state: string | null | undefined): boolean {
  return !!state && REJECTED_REVIEW_STATES.has(state);
}

/** Canonical key for value-level exclusion. Case/whitespace-insensitive so a
 *  re-record of the same finding under a new id (or different casing/spacing)
 *  cannot bypass a FALSE verdict. */
export function normalizeArtifactKey(kind: unknown, value: unknown): string {
  // Canonical kind (lib/kind-alias.ts): a Dismiss on the `ip_address` twin of a
  // selector binds on its `ip` twin too, and vice versa.
  const k = canonicalKind(kind, value);
  const v = String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return `${k}|${v}`;
}

/** Result of loading analyst verdicts. `ok:false` means the verdicts could not be
 *  read — treat as UNAVAILABLE, never as "nothing is rejected". */
export interface RejectedRow { id: string; kind: string; value: string }

/** A reviewed artifact, resolved to its row so a decision can be NAMED in
 *  context. `quarantined` is carried so a confirmed row that is still
 *  `subject_unlinked` can be described honestly (confirmation does not release
 *  linkage quarantine). */
export interface ReviewedRow {
  id: string;
  kind: string;
  value: string;
  state: string;
  note: string | null;
  quarantined: boolean;
}

export interface ReviewLoad {
  ok: boolean;
  /** artifact_id → review state */
  byId: Map<string, string>;
  /** artifact_id → analyst note (only when one was written) */
  noteById: Map<string, string>;
  /** normalized kind|value of rejected artifacts (survives re-record under a new id) */
  rejectedKeys: Set<string>;
  /** the rejected artifacts themselves, for the authoritative DO-NOT-USE block.
   *  Resolved by the same lookup that builds rejectedKeys — no extra query. */
  rejectedRows: RejectedRow[];
  /** every reviewed artifact resolved to its row (confirmed / key / recheck /
   *  rejected), for the ANALYST DECISIONS block. */
  reviewedRows: ReviewedRow[];
  error: string | null;
}

export function emptyReviewLoad(ok: boolean, error: string | null = null): ReviewLoad {
  return {
    ok, byId: new Map(), noteById: new Map(), rejectedKeys: new Set(),
    rejectedRows: [], reviewedRows: [], error,
  };
}

type QueryResult = { data: Array<Record<string, unknown>> | null; error: unknown };
type Eqable = PromiseLike<QueryResult> & { eq: (col: string, v: unknown) => Eqable };
type InAble = PromiseLike<QueryResult> & { in: (col: string, v: readonly unknown[]) => InAble };
export type ReviewDb = {
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

function isQuarantinedMeta(meta: unknown): boolean {
  if (!meta || typeof meta !== "object") return false;
  const m = meta as Record<string, unknown>;
  return m.subject_unlinked === true && m.linkage_confirmed !== true;
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
  const noteById = new Map<string, string>();
  const rejectedKeys = new Set<string>();
  try {
    let q = db.from("artifact_reviews").select("artifact_id,state,note").eq("thread_id", threadId);
    if (userId) q = q.eq("user_id", userId);
    const { data, error } = await q;
    if (error) return emptyReviewLoad(false, errText(error));
    if (!Array.isArray(data)) return emptyReviewLoad(false, "artifact_reviews returned no array");
    for (const r of data) {
      const id = typeof r?.artifact_id === "string" ? r.artifact_id : null;
      const state = typeof r?.state === "string" ? r.state : null;
      if (id && state && KNOWN_REVIEW_STATES.has(state)) {
        byId.set(id, state);
        if (typeof r?.note === "string" && r.note.trim()) noteById.set(id, r.note.trim().slice(0, 300));
      }
    }

    // Resolve reviewed ids → rows. For REJECTED ids this yields the normalized
    // kind|value keys, so a later re-record of the same finding under a NEW id
    // is still excluded. For every other verdict it yields the row the decision
    // is ABOUT, so the prompt can name it. Best-effort: if this lookup fails we
    // still have id-level enforcement, so the load stays ok.
    const reviewedIds = [...byId.keys()];
    const rejectedRows: RejectedRow[] = [];
    const reviewedRows: ReviewedRow[] = [];
    if (reviewedIds.length > 0) {
      try {
        const { data: arts, error: aErr } = await db
          .from("artifacts")
          .select("id,kind,value,metadata")
          .in("id", reviewedIds);
        if (!aErr && Array.isArray(arts)) {
          for (const a of arts) {
            const id = String(a?.id ?? "");
            const state = byId.get(id);
            if (!state) continue;
            const row: ReviewedRow = {
              id,
              kind: String(a?.kind ?? ""),
              value: String(a?.value ?? ""),
              state,
              note: noteById.get(id) ?? null,
              quarantined: isQuarantinedMeta(a?.metadata),
            };
            reviewedRows.push(row);
            if (REJECTED_REVIEW_STATES.has(state)) {
              rejectedKeys.add(normalizeArtifactKey(row.kind, row.value));
              rejectedRows.push({ id, kind: row.kind, value: row.value });
            }
          }
        } else if (aErr) {
          console.warn("[reviews] reviewed-row lookup failed (id-level enforcement still active):", errText(aErr));
        }
      } catch (e) {
        console.warn("[reviews] reviewed-row lookup threw:", errText(e));
      }
    }
    return { ok: true, byId, noteById, rejectedKeys, rejectedRows, reviewedRows, error: null };
  } catch (e) {
    console.warn("[reviews] loadReviewsForThread failed:", errText(e));
    return emptyReviewLoad(false, errText(e));
  }
}

/**
 * The REJECTION predicate over persisted rows, with no confidence arithmetic
 * whatsoever.
 *
 * Extracted for #479's authoritative Evidence Record, which needs the analyst's
 * rejection authority — a finding marked `dismissed`/`wrong` may not be
 * republished under an "authoritative" heading — and is now the ONLY thing
 * `applyReviewsToArtifacts` adds a review tag on top of. There is exactly ONE
 * rejection predicate in this file, so the surfaces cannot drift.
 *
 * Fails closed: an unavailable review load surfaces NOTHING, because "we could
 * not read the verdicts" and "nothing was rejected" are different facts.
 */
export function dropRejectedArtifacts<T extends Record<string, unknown>>(
  rows: T[] | null | undefined,
  review: ReviewLoad,
): T[] {
  if (!Array.isArray(rows)) return [];
  if (!review.ok) return [];           // unavailable → surface nothing rather than everything
  if (review.byId.size === 0 && review.rejectedKeys.size === 0) return rows;

  // Union of the DB-resolved rejected keys and the keys of rejected rows present
  // in THIS batch, so a re-record of the same finding under a new id is excluded
  // even when the id→value lookup was unavailable.
  const rejectedKeys = new Set(review.rejectedKeys);
  for (const r of rows) {
    const id = typeof r?.id === "string" ? r.id : null;
    const state = id ? review.byId.get(id) : undefined;
    if (state && REJECTED_REVIEW_STATES.has(state)) rejectedKeys.add(normalizeArtifactKey(r.kind, r.value));
  }

  return rows.filter((r) => {
    const id = typeof r?.id === "string" ? r.id : null;
    const state = id ? review.byId.get(id) : undefined;
    // DELIBERATE REDUNDANCY, measured: mutating this line away leaves every test
    // green, because the seeding loop above already added THIS row's own
    // kind|value key. Kept anyway — it is the direct expression of the analyst's
    // verdict, and without it the whole rejection depends on one normalisation
    // function agreeing with itself. On the path that decides whether a finding
    // the analyst called false gets republished as "authoritative", that is a
    // single point of failure worth not having. Do not "simplify" it away.
    if (state && REJECTED_REVIEW_STATES.has(state)) return false;
    return !rejectedKeys.has(normalizeArtifactKey(r.kind, r.value)); // same value, new id
  });
}

/**
 * Filter + TAG artifact rows by analyst verdict, for any read that feeds the
 * model. Rows SHOULD carry `id` (matching artifact_reviews.artifact_id).
 *   - dismissed / wrong                  → DROPPED (analyst rejected)
 *   - same normalized kind|value as any  → DROPPED (re-record under a new id
 *     rejected artifact                    cannot bypass the verdict)
 *   - confirmed / key / recheck          → tagged `review_state` (kept)
 *
 * NO CONFIDENCE ARITHMETIC. This used to add +20/+25 for confirmed/key and
 * subtract 20 for recheck. A verdict is authority, priority or workflow state —
 * it is not a second source, so it may not move the number the engine recorded.
 * Consumers that need the decision read `review_state`; consumers that need
 * evidence strength read `confidence`, which is exactly what was persisted.
 */
export function applyReviewsToArtifacts<T extends Record<string, unknown>>(
  rows: T[] | null | undefined,
  review: ReviewLoad,
): T[] {
  const kept = dropRejectedArtifacts(rows, review);
  // Nothing to tag — and this preserves the historical identity return for the
  // "no verdicts at all" case.
  if (review.byId.size === 0) return kept;

  const out: T[] = [];
  for (const r of kept) {
    const id = typeof r?.id === "string" ? r.id : null;
    const state = id ? review.byId.get(id) : undefined;
    out.push(state ? { ...r, review_state: state } : r);
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

const DECISION_LINE_CAP = 40;

function decisionLines(rows: ReviewedRow[], withNote = true): string[] {
  const lines = rows.slice(0, DECISION_LINE_CAP).map((r) => {
    const kind = String(r.kind || "artifact");
    const value = String(r.value ?? "").slice(0, 160);
    const note = withNote && r.note ? ` — analyst note: ${r.note.slice(0, 160)}` : "";
    const q = r.quarantined ? " [still subject_unlinked: linkage NOT released by this decision]" : "";
    return `  - [${kind}] ${value}${q}${note}`;
  });
  if (rows.length > DECISION_LINE_CAP) lines.push(`  …and ${rows.length - DECISION_LINE_CAP} more.`);
  return lines;
}

/**
 * Authoritative analyst-rejection block — the DO-NOT-USE half of the decisions
 * block, kept as its own renderer because the salvage/recovery paths and the
 * wiring tests reference it directly. Returns "" when there is nothing to say.
 */
export function renderAnalystRejectionBlock<T extends { kind?: unknown; value?: unknown }>(
  rejected: T[] | null | undefined,
): string {
  if (!Array.isArray(rejected) || rejected.length === 0) return "";
  const lines = rejected.slice(0, DECISION_LINE_CAP).map((r) => {
    const kind = String(r.kind ?? "artifact");
    const value = String(r.value ?? "").slice(0, 160);
    return `  - [${kind}] ${value}`;
  });
  return [
    "",
    "### ANALYST-REJECTED / unrelated — DO NOT USE (authoritative)",
    "A human analyst reviewed the items below and marked them FALSE / unrelated.",
    "They may still appear in earlier messages in this conversation. That earlier",
    "text is SUPERSEDED. You MUST NOT restate, rank, cite, pivot on, or re-derive",
    "them as the subject or as supporting evidence — including by inferring the",
    "same conclusion from adjacent evidence, and including under a different",
    "spelling or a fresh tool result. The runtime refuses tool calls on them.",
    "If asked about one, say it was rejected by the analyst.",
    ...lines,
    rejected.length > DECISION_LINE_CAP ? `  …and ${rejected.length - DECISION_LINE_CAP} more rejected item(s).` : "",
    "",
  ].filter(Boolean).join("\n");
}

/**
 * ONE structured `ANALYST DECISIONS` block for the system prompt of ANY model
 * turn — not just salvage synthesis. Ordinary follow-up turns still carry the
 * prior narrative in message history, so without this block the model can and
 * does re-assert a finding the analyst already marked FALSE, ignores the one the
 * analyst asked to re-verify, and treats a Key lead like any other selector.
 *
 * Four sections, four separate concepts. The header states the one rule that
 * governs all of them: a decision never changes evidence confidence, source
 * independence or corroboration. Returns "" when the analyst has decided nothing.
 */
export function renderAnalystDecisionsBlock(review: ReviewLoad): string {
  if (!review.ok) return "";
  const rows = review.reviewedRows;
  if (rows.length === 0 && review.rejectedRows.length === 0) return "";
  const confirmed = rows.filter((r) => r.state === "confirmed");
  const key = rows.filter((r) => r.state === "key");
  const recheck = rows.filter((r) => r.state === "recheck");
  // Rejected rows come from the same lookup; fall back to rejectedRows for a load
  // whose reviewedRows are empty (older callers / partial lookups).
  const rejected = rows.length > 0
    ? rows.filter((r) => REJECTED_REVIEW_STATES.has(r.state))
    : review.rejectedRows.map((r) => ({ ...r, state: "dismissed", note: null, quarantined: false }));

  const out: string[] = [
    "",
    "## ANALYST DECISIONS (authoritative — recorded by a human analyst)",
    "These are decisions about AUTHORITY, PRIORITY and WORKFLOW. None of them changes",
    "evidence confidence, source independence or corroboration: keep every recorded",
    "confidence, cap and source count exactly as persisted. A confirmation is not a",
    "second source. A priority is not a higher confidence. A recheck is not a lower one.",
  ];
  if (confirmed.length) {
    out.push(
      "",
      "### Confirmed by the analyst (accepted propositions)",
      "Treat each as accepted for THIS investigation: do not re-litigate, re-verify or",
      "hedge it unless NEW evidence contradicts it. Build on it. It still carries its",
      "recorded confidence and source count — do not label it CONFIRMED on the strength",
      "of the analyst's click alone, and a row marked subject_unlinked stays unlinked:",
      "confirmation does not release linkage quarantine.",
      ...decisionLines(confirmed),
    );
  }
  if (key.length) {
    out.push(
      "",
      "### Key priorities (investigate these first)",
      "When planning the next pivots, rank work on these selectors ABOVE comparable",
      "ordinary selectors. This is investigative priority only — it is not evidence",
      "strength, and it does not add a source class or corroboration.",
      ...decisionLines(key),
    );
  }
  if (recheck.length) {
    out.push(
      "",
      "### Recheck tasks (verification requested)",
      "The analyst asked for another look. For each: run FRESH, INDEPENDENT tools or",
      "sources to confirm or refute it, then report whether it holds up and at what",
      "confidence. Do not restate prior findings as verification. This is a task, not",
      "a downgrade — the recorded confidence is unchanged until new evidence lands.",
      ...decisionLines(recheck),
    );
  }
  if (rejected.length) {
    out.push(renderAnalystRejectionBlock(rejected).trimEnd());
  }
  out.push("");
  return out.join("\n");
}

/** Neutral result for an integrity-critical path when verdicts are unavailable.
 *  Never re-promote data in this state — say so instead. */
export const REVIEW_STATE_UNAVAILABLE_NOTE =
  "Analyst review state is UNAVAILABLE (verdict lookup failed). Findings are shown " +
  "without analyst filtering suppressed — treat any prior FALSE/dismissed marks as " +
  "still in force and do not promote a rejected finding.";
