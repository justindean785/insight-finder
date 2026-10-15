/**
 * cross-case-reviews.ts — E4: the analyst's marks carry across the user's cases.
 *
 * MEASURED PROBLEM (live DB, 2026-10-15). `loadReviewsForThread` reads
 * `artifact_reviews` with `.eq("thread_id", threadId)`, so a `dismissed` / `wrong`
 * verdict binds inside the case it was clicked in and nowhere else: 1,378 reviews
 * over 77 threads, 450 distinct (kind, value) pairs rejected, and 234 artifacts in
 * OTHER threads of the same user carrying a value the analyst had already ruled
 * out. Every new case re-proposed, re-spent on and re-reported them.
 *
 * DECISION (JD): marks apply across ALL of the user's cases by default, with a
 * per-case escape hatch. This module builds a per-user VERDICT INDEX — the most
 * recent verdict per normalized (kind, value) across the user's OTHER threads —
 * and `reviews.ts` merges it into the ordinary ReviewLoad, so every place the
 * in-thread rejection is enforced today (prompt, dispatch, salvage, cache,
 * clustering, recovery, synthesis, memory supersession) enforces the cross-case
 * one through the SAME predicates. No new enforcement surface to drift.
 *
 * THE RULES
 *   - dismissed / wrong (latest)  → rejected here too, everywhere. The prompt gets a
 *                                   COUNT only ("N values hidden by your earlier
 *                                   reviews in other cases"), never the values.
 *   - confirmed / key / recheck    → PIVOT PRIORITY context only, and only for values
 *                                   that also occur in THIS case (otherwise the model
 *                                   would be handed another subject's selectors).
 *                                   Never a label, never confidence, never
 *                                   linkage_confirmed, never a source — the same
 *                                   spirit as E3 (#721): prior conclusions are
 *                                   context, not evidence. Implemented by NOT
 *                                   touching `ReviewLoad.byId`, which is the only
 *                                   thing that tags `review_state` onto a row.
 *   - most recent wins across cases (updated_at, then created_at; a tie goes to the
 *     rejection — the conservative reading).
 *   - an in-thread verdict on the same key ALWAYS overrides the cross-case one.
 *   - a review whose note contains "this case only" or "#caseonly" does not
 *     propagate at all.
 *
 * KEYING. `type|normalizedValue`, never value alone — the "jordan.vale" hazard in
 * CLAUDE.md: `username "jordan.vale"` and `name "Jordan Vale"` must not collide.
 * The key is `normalizeArtifactKey`'s exact shape (canonical kind + trimmed,
 * lower-cased, whitespace-collapsed value) EXCEPT for phones, which fold through
 * `normPhoneE164` so 6174427629, (617) 442-7629 and +16174427629 are one number.
 * That fold lives ONLY in this index's key; persisted dedup keys are untouched.
 *
 * FAIL-SAFE, NOT FAIL-CLOSED. A failed cross-case read logs a structured warning
 * and the run continues with exactly today's in-thread behaviour. The in-thread
 * load keeps its own fail-closed semantics unchanged — a cross-case problem can
 * never turn into "review state unavailable" for the thread itself.
 *
 * READ ONCE PER RUN. The index is memoized per (user, thread) and invalidated by
 * the orchestrator at the start of every request; a TTL bounds it for the
 * sweep/recovery entry points that never invalidate.
 *
 * Kill switch, read at call time: CROSS_CASE_REVIEWS_DISABLED=true.
 */
import { canonicalKind } from "./kind-alias.ts";
import { normPhoneE164 } from "./selector-normalize.ts";

export const CROSS_CASE_REVIEWS_DISABLED_ENV = "CROSS_CASE_REVIEWS_DISABLED";

function readEnvSafe(k: string): string | undefined {
  try {
    return (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get(k);
  } catch {
    return undefined;
  }
}

export function crossCaseReviewsDisabled(env: (k: string) => string | undefined = readEnvSafe): boolean {
  return (env(CROSS_CASE_REVIEWS_DISABLED_ENV) ?? "").trim().toLowerCase() === "true";
}

const REJECTED = new Set(["dismissed", "wrong"]);
const KNOWN = new Set(["confirmed", "key", "recheck", "dismissed", "wrong"]);
const PHONE_KINDS = new Set(["phone", "phone_number", "mobile", "telephone"]);

/** The escape hatch: a note that scopes the verdict to its own case. */
const CASE_ONLY_RE = /this\s+case\s+only|#caseonly\b/i;
export function isCaseOnlyNote(note: unknown): boolean {
  return typeof note === "string" && CASE_ONLY_RE.test(note);
}

/**
 * The index key. Identical to `normalizeArtifactKey` (reviews.ts) for every kind
 * except phones; pinned by `cross_case_reviews_test.ts` so the two cannot drift.
 */
export function crossCaseKey(kind: unknown, value: unknown): string {
  const rawKind = String(kind ?? "").trim().toLowerCase();
  if (PHONE_KINDS.has(rawKind)) {
    const digits = String(value ?? "").replace(/\D/g, "");
    if (digits) return `phone|${normPhoneE164(digits) ?? digits}`;
  }
  const k = canonicalKind(kind, value);
  const v = String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return `${k}|${v}`;
}

/**
 * Every raw spelling under which a cross-case-rejected phone must be refused at
 * dispatch. `circuit.normalizeSelector("phone", …)` keeps digits AND a leading
 * "+", so +16174427629 and 6174427629 normalize to different dispatch keys; the
 * refusal set carries each plausible spelling instead. Non-phones pass through.
 */
export function dispatchSpellings(kind: string, value: string): string[] {
  if (!PHONE_KINDS.has(String(kind ?? "").trim().toLowerCase())) return [value];
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return [value];
  const out = new Set<string>([value, digits, `+${digits}`]);
  const e164 = normPhoneE164(digits);
  if (e164) {
    out.add(e164);
    out.add(e164.slice(1));
    if (e164.startsWith("+1") && e164.length === 12) out.add(e164.slice(2));
  }
  return [...out];
}

export interface CrossCaseVerdict {
  key: string;
  kind: string;
  value: string;
  state: string;
  /** the OTHER case the verdict was recorded in */
  threadId: string;
  /** ms since epoch; 0 when the row carried no usable timestamp */
  at: number;
}

export interface CrossCaseReviewRow {
  artifact_id?: unknown;
  thread_id?: unknown;
  state?: unknown;
  note?: unknown;
  updated_at?: unknown;
  created_at?: unknown;
}
export interface CrossCaseArtifactRow { id?: unknown; kind?: unknown; value?: unknown }

function ts(v: unknown): number {
  if (typeof v !== "string" && typeof v !== "number") return 0;
  const n = new Date(v).getTime();
  return Number.isFinite(n) ? n : 0;
}

/**
 * PURE: reviews (from OTHER threads) + their artifact rows → the most recent
 * verdict per key. Case-only reviews are dropped BEFORE the most-recent pass, so a
 * scoped verdict is invisible to other cases rather than shadowing an older one.
 */
export function buildCrossCaseIndex(
  reviews: readonly CrossCaseReviewRow[],
  artifactsById: ReadonlyMap<string, CrossCaseArtifactRow>,
  currentThreadId: string,
): { index: Map<string, CrossCaseVerdict>; caseOnlySkipped: number } {
  const index = new Map<string, CrossCaseVerdict>();
  let caseOnlySkipped = 0;
  for (const r of reviews) {
    const artifactId = typeof r?.artifact_id === "string" ? r.artifact_id : "";
    const threadId = typeof r?.thread_id === "string" ? r.thread_id : "";
    const state = typeof r?.state === "string" ? r.state : "";
    // A row with no thread is not attributable to another case; the current case
    // is the in-thread loader's job.
    if (!artifactId || !threadId || threadId === currentThreadId || !KNOWN.has(state)) continue;
    if (isCaseOnlyNote(r.note)) { caseOnlySkipped++; continue; }
    const art = artifactsById.get(artifactId);
    if (!art) continue;
    const kind = String(art.kind ?? "");
    const value = String(art.value ?? "");
    if (!kind || !value.trim()) continue;
    const key = crossCaseKey(kind, value);
    const at = Math.max(ts(r.updated_at), 0) || ts(r.created_at);
    const prev = index.get(key);
    if (prev) {
      if (at < prev.at) continue;
      if (at === prev.at && REJECTED.has(prev.state)) continue; // tie → rejection stands
    }
    index.set(key, { key, kind, value, state, threadId, at });
  }
  return { index, caseOnlySkipped };
}

/** What `reviews.ts` merges into a ReviewLoad. Values are present for ENFORCEMENT
 *  (dispatch keys, memory supersession) — only `confirmed` / `key` / `recheck`
 *  are ever rendered into a prompt, and only when they also occur in this case. */
export interface CrossCaseApplied {
  /** crossCaseKey of every value rejected (latest) in another case, minus in-thread overrides */
  rejectedKeys: Set<string>;
  rejected: CrossCaseVerdict[];
  /** relevance-gated to values present in THIS case */
  confirmed: CrossCaseVerdict[];
  key: CrossCaseVerdict[];
  recheck: CrossCaseVerdict[];
  /** distinct rejected values that occur among THIS case's artifacts */
  hiddenInCase: number;
  overriddenInThread: number;
  caseOnlySkipped: number;
  /** false when the index read was truncated by the page cap (still applied) */
  complete: boolean;
}

/**
 * PURE: apply the index to one thread. `inThreadKeys` are the crossCaseKeys of
 * every verdict recorded IN this thread (any state) — those always win.
 * `threadKeys` are the crossCaseKeys of this thread's artifacts, or null when that
 * read failed (then positives are withheld: relevance cannot be shown).
 */
export function applyCrossCaseIndex(
  index: ReadonlyMap<string, CrossCaseVerdict>,
  inThreadKeys: ReadonlySet<string>,
  threadKeys: ReadonlySet<string> | null,
  extra: { caseOnlySkipped?: number; complete?: boolean } = {},
): CrossCaseApplied {
  const out: CrossCaseApplied = {
    rejectedKeys: new Set(), rejected: [], confirmed: [], key: [], recheck: [],
    hiddenInCase: 0, overriddenInThread: 0,
    caseOnlySkipped: extra.caseOnlySkipped ?? 0, complete: extra.complete ?? true,
  };
  for (const v of index.values()) {
    if (inThreadKeys.has(v.key)) { out.overriddenInThread++; continue; }
    if (REJECTED.has(v.state)) {
      out.rejectedKeys.add(v.key);
      out.rejected.push(v);
      if (threadKeys?.has(v.key)) out.hiddenInCase++;
      continue;
    }
    if (!threadKeys || !threadKeys.has(v.key)) continue;
    if (v.state === "confirmed") out.confirmed.push(v);
    else if (v.state === "key") out.key.push(v);
    else if (v.state === "recheck") out.recheck.push(v);
  }
  const newest = (a: CrossCaseVerdict, b: CrossCaseVerdict) => b.at - a.at;
  out.confirmed.sort(newest); out.key.sort(newest); out.recheck.sort(newest);
  return out;
}

// ---- loader ----------------------------------------------------------------

// deno-lint-ignore no-explicit-any
export type CrossCaseDb = { from: (table: string) => any };

export const CROSS_CASE_PAGE = 1000;
export const CROSS_CASE_MAX_PAGES = 25;
/** ids per `.in()` — ~37 chars each, so ~5.5 KB of URL, far under the ~24 KB cap. */
export const CROSS_CASE_IN_CHUNK = 150;

function errText(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

/**
 * Page a query, advancing by ROWS RETURNED and stopping only on an empty page
 * (#519's pattern): a short page is not proof of the end — PostgREST's max-rows
 * cap can silently clip a page below the requested size.
 */
async function pageAll(
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<{ rows: Array<Record<string, unknown>>; complete: boolean }> {
  const rows: Array<Record<string, unknown>> = [];
  let offset = 0;
  for (let page = 0; page < CROSS_CASE_MAX_PAGES; page++) {
    const { data, error } = await build(offset, offset + CROSS_CASE_PAGE - 1);
    if (error) throw new Error(errText(error));
    if (!Array.isArray(data)) throw new Error("query returned no array");
    if (data.length === 0) return { rows, complete: true };
    rows.push(...(data as Array<Record<string, unknown>>));
    offset += data.length;
  }
  return { rows, complete: false };
}

export interface CrossCaseIndexLoad {
  ok: boolean;
  index: Map<string, CrossCaseVerdict>;
  /** crossCaseKeys of the current thread's artifacts; null when that read failed */
  threadKeys: Set<string> | null;
  caseOnlySkipped: number;
  reviewsScanned: number;
  complete: boolean;
  error: string | null;
}

export async function loadCrossCaseIndex(
  db: CrossCaseDb,
  userId: string,
  threadId: string,
): Promise<CrossCaseIndexLoad> {
  const fail = (error: string): CrossCaseIndexLoad => ({
    ok: false, index: new Map(), threadKeys: null, caseOnlySkipped: 0, reviewsScanned: 0, complete: false, error,
  });
  try {
    const revs = await pageAll((from, to) =>
      db.from("artifact_reviews")
        .select("id,artifact_id,thread_id,state,note,created_at,updated_at")
        .eq("user_id", userId)
        .neq("thread_id", threadId)
        .order("id", { ascending: true })
        .range(from, to)
    );
    // De-duplicate by review id (a page boundary that shifts under a concurrent
    // write can repeat a row; the verdict is the same either way).
    const seen = new Set<string>();
    const reviews: CrossCaseReviewRow[] = [];
    for (const r of revs.rows) {
      const id = String(r.id ?? `${r.artifact_id}|${r.thread_id}`);
      if (seen.has(id)) continue;
      seen.add(id);
      reviews.push(r);
    }

    const ids = [...new Set(reviews.map((r) => (typeof r.artifact_id === "string" ? r.artifact_id : "")).filter(Boolean))];
    const artifactsById = new Map<string, CrossCaseArtifactRow>();
    for (let i = 0; i < ids.length; i += CROSS_CASE_IN_CHUNK) {
      const chunk = ids.slice(i, i + CROSS_CASE_IN_CHUNK);
      const { data, error } = await db.from("artifacts").select("id,kind,value").in("id", chunk);
      if (error) throw new Error(errText(error));
      if (!Array.isArray(data)) throw new Error("artifacts lookup returned no array");
      for (const a of data as CrossCaseArtifactRow[]) {
        if (typeof a?.id === "string") artifactsById.set(a.id, a);
      }
    }
    const { index, caseOnlySkipped } = buildCrossCaseIndex(reviews, artifactsById, threadId);

    // This case's own values, for relevance-gating the positives and counting what
    // is hidden. Best-effort: a failure withholds positives, never rejections.
    let threadKeys: Set<string> | null = null;
    if (index.size > 0) {
      try {
        const own = await pageAll((from, to) =>
          db.from("artifacts").select("id,kind,value").eq("thread_id", threadId)
            .order("id", { ascending: true }).range(from, to)
        );
        threadKeys = new Set(own.rows.map((a) => crossCaseKey(a.kind, a.value)));
      } catch (e) {
        console.warn(JSON.stringify({
          event: "cross_case_reviews_thread_read_failed", thread_id: threadId, error: errText(e).slice(0, 200),
        }));
      }
    } else {
      threadKeys = new Set();
    }
    return {
      ok: true, index, threadKeys, caseOnlySkipped, reviewsScanned: reviews.length,
      complete: revs.complete, error: null,
    };
  } catch (e) {
    return fail(errText(e).slice(0, 300));
  }
}

// ---- memo: read once per run ------------------------------------------------

const MEMO_TTL_MS = 5 * 60_000;
const MEMO_FAIL_TTL_MS = 30_000;
const MEMO_MAX = 200;
const memo = new Map<string, { at: number; ttl: number; promise: Promise<CrossCaseIndexLoad> }>();
const memoKey = (userId: string, threadId: string) => `${userId}|${threadId}`;

/** Called by the orchestrator at the start of every request, so each run reads
 *  the index fresh exactly once. */
export function invalidateCrossCaseIndex(userId?: string | null, threadId?: string | null): void {
  if (!userId || !threadId) return;
  memo.delete(memoKey(userId, threadId));
}
/** Tests only. */
export function resetCrossCaseMemo(): void {
  memo.clear();
}

export function getCrossCaseIndex(
  db: CrossCaseDb,
  userId: string,
  threadId: string,
  now: number = Date.now(),
): Promise<CrossCaseIndexLoad> {
  const k = memoKey(userId, threadId);
  const hit = memo.get(k);
  if (hit && now - hit.at < hit.ttl) return hit.promise;
  const promise = loadCrossCaseIndex(db, userId, threadId);
  const entry = { at: now, ttl: MEMO_TTL_MS, promise };
  memo.set(k, entry);
  void promise.then((r) => {
    if (!r.ok) {
      entry.ttl = MEMO_FAIL_TTL_MS;
      console.warn(JSON.stringify({
        event: "cross_case_reviews_unavailable", thread_id: threadId, error: r.error,
        note: "continuing with in-thread analyst decisions only",
      }));
    }
  });
  if (memo.size > MEMO_MAX) {
    const oldest = memo.keys().next().value;
    if (oldest !== undefined && oldest !== k) memo.delete(oldest);
  }
  return promise;
}

/** Structured per-run log event: counts only, never a value. */
export function crossCaseLogEvent(threadId: string, applied: CrossCaseApplied | null | undefined, reason?: string) {
  return {
    event: "cross_case_reviews_applied",
    thread_id: threadId,
    enabled: !!applied,
    reason: reason ?? null,
    suppressed: applied?.rejectedKeys.size ?? 0,
    suppressed_in_case: applied?.hiddenInCase ?? 0,
    confirmed: applied?.confirmed.length ?? 0,
    key: applied?.key.length ?? 0,
    recheck: applied?.recheck.length ?? 0,
    overridden_in_thread: applied?.overriddenInThread ?? 0,
    case_only_skipped: applied?.caseOnlySkipped ?? 0,
    complete: applied?.complete ?? null,
  };
}

/** /health self-test. Pure. PRESENCE of the key proves the deployed bundle. */
export function crossCaseReviewsSelfTest(): { ok: boolean; detail: string } {
  if (crossCaseReviewsDisabled()) return { ok: true, detail: "LEGACY via CROSS_CASE_REVIEWS_DISABLED (in-thread verdicts only)" };
  const arts = new Map<string, CrossCaseArtifactRow>([
    ["a", { id: "a", kind: "phone", value: "+1 (617) 442-7629" }],
    ["b", { id: "b", kind: "username", value: "jordan.vale" }],
    ["c", { id: "c", kind: "email", value: "x@example.test" }],
    ["d", { id: "d", kind: "email", value: "x@example.test" }],
    ["e", { id: "e", kind: "email", value: "scoped@example.test" }],
  ]);
  const { index } = buildCrossCaseIndex([
    { artifact_id: "a", thread_id: "A", state: "dismissed", updated_at: "2026-01-01T00:00:00Z" },
    { artifact_id: "b", thread_id: "A", state: "wrong", updated_at: "2026-01-01T00:00:00Z" },
    { artifact_id: "c", thread_id: "A", state: "dismissed", updated_at: "2026-01-01T00:00:00Z" },
    { artifact_id: "d", thread_id: "C", state: "confirmed", updated_at: "2026-02-01T00:00:00Z" },
    { artifact_id: "e", thread_id: "A", state: "dismissed", note: "#caseonly", updated_at: "2026-01-01T00:00:00Z" },
  ], arts, "B");
  const applied = applyCrossCaseIndex(index, new Set(), new Set([crossCaseKey("email", "x@example.test")]));
  const ok = applied.rejectedKeys.has(crossCaseKey("phone", "6174427629")) &&
    applied.rejectedKeys.has(crossCaseKey("username", "jordan.vale")) &&
    !applied.rejectedKeys.has(crossCaseKey("name", "Jordan Vale")) &&
    !applied.rejectedKeys.has(crossCaseKey("email", "x@example.test")) &&
    applied.confirmed.length === 1 &&
    !applied.rejectedKeys.has(crossCaseKey("email", "scoped@example.test"));
  return ok
    ? { ok: true, detail: "dismissed/wrong carry across the user's cases (latest wins, in-thread overrides, #caseonly stays put); confirmed/key/recheck -> pivot priority only" }
    : { ok: false, detail: "cross-case verdict index misbehaving" };
}
