import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { recordAnalystFeedback, actionForReviewState } from "@/lib/analyst-feedback";
import { detectSeed } from "@/lib/seed";
import {
  isNonNewReview,
  isRejectedReview,
  recheckPrompt,
  REJECTED_REVIEW_STATES,
  type ReviewState,
  type ReviewWriteResult,
} from "@/lib/analyst-decisions";
import { toast } from "sonner";

/**
 * Analyst review states. Renamed for clarity (Nov 2026):
 *   reviewed            -> confirmed   (analyst attests this is TRUE)
 *   important           -> key         (critical lead, prioritise in report)
 *   needs_verification  -> recheck     (something looks off, needs another pass)
 *   dismissed                          (false positive, hide)
 * Old keys are migrated transparently on read.
 *
 * The SEMANTICS of each state — what it may and may not change — live in
 * `analyst-decisions.ts` (pure) so every consumer honours the same contract.
 * This module owns persistence and the hook.
 */
export type { ReviewState, ReviewWriteResult };
export { isRejectedReview, recheckPrompt, REJECTED_REVIEW_STATES };

export const REVIEW_STATES: ReviewState[] = [
  "new",
  "confirmed",
  "key",
  "recheck",
  "wrong",
  "dismissed",
];

export const REVIEW_LABEL: Record<ReviewState, string> = {
  new: "New",
  confirmed: "Confirmed true",
  recheck: "Needs another look",
  key: "Key finding",
  dismissed: "False positive",
  wrong: "Marked false (teach agent)",
};

export const REVIEW_SHORT: Record<ReviewState, string> = {
  new: "New",
  confirmed: "Confirm",
  recheck: "Recheck",
  key: "Key",
  dismissed: "Dismiss",
  wrong: "False",
};

/**
 * What each decision DOES. No decision changes a confidence number: the old
 * "+20 / +25 / −20" wording promised a scoring effect that made a human click
 * look like a second source. A decision changes authority, priority or workflow
 * state, and it reaches the agent's next run as exactly that.
 */
export const REVIEW_HELP: Record<ReviewState, string> = {
  new: "Not yet reviewed by you.",
  confirmed:
    "You accept this as true for this case. The agent treats it as settled in its next run and will not re-litigate it. Does not change its confidence score, add a source, or release a linkage quarantine.",
  recheck:
    "Something looks off. Records a verification task the agent picks up in its next run and sends this exact finding to chat for independent re-verification. Does not change the confidence score.",
  key:
    "Critical lead. Pinned above comparable leads in pivot planning and named as a priority to the agent. Priority only — not confidence, sources or corroboration.",
  dismissed:
    "False / unrelated. Leaves the working set, the pivots, tool dispatch, clusters and authoritative report sections. Kept in the evidence history.",
  wrong:
    "Wrong / incorrect data. Same as False, plus a durable lesson in agent memory so future investigations skip this lead.",
};

/** A review write in any recorded state can make a cached investigation_cache
 *  row stale: a replay would clone the artifact into a NEW thread as
 *  unreviewed, silently discarding the decision. Every non-new state invalidates. */
const CACHE_INVALIDATING_STATES: ReadonlySet<ReviewState> = new Set(["confirmed", "key", "recheck", "dismissed", "wrong"]);

export const REVIEW_CLASS: Record<ReviewState, string> = {
  new: "text-muted-foreground border-border bg-secondary/40",
  confirmed:
    "text-[hsl(var(--confidence-high))] border-[hsl(var(--confidence-high))]/40 bg-[hsl(var(--confidence-high))]/10",
  recheck:
    "text-[hsl(var(--confidence-mid))] border-[hsl(var(--confidence-mid))]/40 bg-[hsl(var(--confidence-mid))]/10",
  key: "text-primary border-primary/40 bg-primary/10",
  dismissed:
    "text-muted-foreground border-border bg-secondary/40 line-through opacity-60",
  wrong:
    "text-destructive border-destructive/40 bg-destructive/10 line-through",
};

const LEGACY_KEY = (threadId: string) => `proximity:review:${threadId}`;
const EVT = "proximity:review-changed";

/**
 * Flag → chatbot: switch the workspace to the Chat tab and auto-send a scoped
 * re-investigation of one artifact. Reuses the same two buses the Pivots tab
 * and command palette already ride:
 *   - `swarmbot:navigate` { tab: "chat" }  → ChatPage flips to the Chat tab
 *   - `proximity:run-pivot` { prompt }     → ChatWindow.sendText() fires the run
 * ChatWindow stays mounted across tab switches, so the send lands even though
 * the user was on the Evidence tab a tick earlier.
 *
 * Do not call this directly from a Recheck button — use `startRecheck`, which
 * launches only AFTER the verdict has persisted.
 */
export function launchRecheckInChat(
  threadId: string,
  artifact: { value: string; kind?: string },
) {
  window.dispatchEvent(
    new CustomEvent("swarmbot:navigate", { detail: { tab: "chat" } }),
  );
  window.dispatchEvent(
    new CustomEvent("proximity:run-pivot", {
      detail: {
        threadId,
        value: artifact.value,
        type: artifact.kind,
        prompt: recheckPrompt(artifact.value, artifact.kind),
      },
    }),
  );
}

/**
 * The Recheck action: persist the verdict, THEN launch the follow-up run.
 *
 * THE BUG THIS FIXES: both Recheck buttons fired `void review.set(...)` and
 * `launchRecheckInChat(...)` on the same tick, so the chat run started before
 * the row existed — and started anyway when the write failed. The run then
 * depended entirely on the chat message; the agent's next ordinary turn had no
 * durable record that a verification was requested.
 *
 * Now the persisted `recheck` row IS the durable task (the edge function names
 * it in the ANALYST DECISIONS block on every turn), and the chat launch is
 * strictly downstream of the commit. A failed write returns the failure and
 * launches nothing.
 */
export async function startRecheck(input: {
  set: (id: string, state: ReviewState, ctx?: ReviewCtx) => Promise<ReviewWriteResult>;
  threadId: string;
  artifact: { id: string; value: string; kind?: string };
  ctx?: ReviewCtx;
}): Promise<ReviewWriteResult> {
  const result = await input.set(input.artifact.id, "recheck", input.ctx);
  if (!result.ok) return result;
  launchRecheckInChat(input.threadId, { value: input.artifact.value, kind: input.artifact.kind });
  return result;
}

/**
 * Is a 7-day investigation_cache hit still safe to replay verbatim?
 *
 * THE BUG THIS FIXES: ChatWindow.tsx's cache replay clones cached artifacts
 * and re-displays the cached assistant narrative WITHOUT ever calling
 * osint-agent — so no backend review-filtering (see reviews.ts on the edge
 * function) ever runs on this path. A cache row is snapshotted at run
 * completion, before the analyst has reviewed anything; if the analyst later
 * marks a finding dismissed/wrong, the cache still holds (and will replay for
 * up to 7 days) the stale, now-rejected narrative and artifacts.
 *
 * AND (2026-09-02): the clone lands in the new thread as a NEW artifact row with
 * NO review — so a confirmed or key decision on the origin was silently
 * discarded on replay, and a recheck task vanished. There is no review-lineage
 * transfer yet, so ANY recorded decision on the origin (or on a clone of it)
 * makes the entry inadmissible: the live run re-reads the origin thread's
 * decisions through the edge function instead.
 *
 * Call this BEFORE rendering a cache hit, keyed on the row's origin_thread_id
 * (cache_version 2+; see index.ts). Fails CLOSED (matches the backend's
 * reviews.ts loadReviewsForThread, which also fails closed as of 2026-07-19 —
 * a transient review-load error must never be treated as "nothing rejected"):
 * if we can't prove the cached narrative is still analyst-clean, treat the
 * hit as unsafe and fall through to a live run. The cost of a false "unsafe"
 * is one extra live run; the cost of a false "safe" is exactly the incident
 * this fix exists for.
 */
export async function checkCachedHitSafety(
  originThreadId: string,
  userId: string,
  /** ids of the artifacts in the cached blob — used to find reviews an analyst
   *  made against a CLONE of this cache entry in some other thread. */
  cachedArtifactIds: string[] = [],
): Promise<{ safe: boolean; reviewMap: Map<string, ReviewState>; reason: string }> {
  const reviewMap = new Map<string, ReviewState>();
  try {
    // 1. Verdicts recorded against the ORIGIN thread's artifacts.
    const { data, error } = await supabase
      .from("artifact_reviews")
      .select("artifact_id,state")
      .eq("thread_id", originThreadId)
      .eq("user_id", userId);
    if (error || !Array.isArray(data)) return { safe: false, reviewMap, reason: "origin review lookup failed" };
    for (const r of data as { artifact_id: string; state: ReviewState }[]) {
      if (r.artifact_id && r.state) reviewMap.set(r.artifact_id, r.state);
    }

    // 2. Verdicts recorded against a CLONE of this cache entry in another thread.
    //    Cache eviction on review is best-effort; if it ever fails, a clone-thread
    //    "False" would otherwise be invisible here and the poisoned row would keep
    //    replaying. The read-time check must therefore be the authority, so clone
    //    verdicts are consulted even when eviction did not happen.
    const ids = cachedArtifactIds.filter(Boolean);
    if (ids.length > 0) {
      const { data: clones, error: cloneErr } = await supabase
        .from("artifacts")
        .select("id")
        .eq("user_id", userId)
        .in("metadata->>origin_artifact_id", ids);
      if (cloneErr) return { safe: false, reviewMap, reason: "clone lookup failed" };
      const cloneIds = (clones ?? []).map((c) => (c as { id?: string }).id).filter(Boolean) as string[];
      if (cloneIds.length > 0) {
        const { data: cloneReviews, error: crErr } = await supabase
          .from("artifact_reviews")
          .select("artifact_id,state")
          .eq("user_id", userId)
          .in("artifact_id", cloneIds);
        if (crErr || !Array.isArray(cloneReviews)) {
          return { safe: false, reviewMap, reason: "clone review lookup failed" };
        }
        for (const r of cloneReviews as { artifact_id: string; state: ReviewState }[]) {
          if (r.artifact_id && r.state) reviewMap.set(r.artifact_id, r.state);
        }
      }
    }

    const states = [...reviewMap.values()];
    const hasRejection = states.some((s) => REJECTED_REVIEW_STATES.has(s));
    // A `recheck` also blocks replay. Downweighting the cloned ARTIFACT is not
    // enough: replaying the cache also replays the original assistant narrative
    // verbatim, and that prose still asserts the finding the analyst flagged as
    // suspect. There is no way to "downweight" frozen text, so the only correct
    // response is to bypass the cache and regenerate live.
    const hasRecheck = states.some((s) => s === "recheck");
    // A confirmed / key decision blocks replay too: the clone would be a fresh,
    // UNREVIEWED row in the new thread, discarding the decision. Until an explicit
    // review-lineage transfer exists, a decided entry is not replayable.
    const hasDecision = states.some((s) => isNonNewReview(s));
    if (hasRejection) return { safe: false, reviewMap, reason: "analyst rejected an artifact in this cache entry" };
    if (hasRecheck) return { safe: false, reviewMap, reason: "analyst flagged recheck — stale narrative must not be replayed" };
    if (hasDecision) return { safe: false, reviewMap, reason: "analyst confirmed/key decisions would be lost on replay (no review-lineage transfer)" };
    return { safe: true, reviewMap, reason: "no analyst decisions block replay" };
  } catch {
    return { safe: false, reviewMap, reason: "review lookup threw" };
  }
}

type StateMap = Record<string, ReviewState>;
type NoteMap = Record<string, string>;

const LEGACY: Record<string, ReviewState> = {
  reviewed: "confirmed",
  important: "key",
  needs_verification: "recheck",
};

/** Module-level cache keyed by threadId so multiple hook consumers share state without refetching. */
/** Whether this thread's analyst verdicts were actually readable.
 *  `unknown` = not attempted yet; `unavailable` = the read failed and whatever is
 *  in `states` cannot be trusted to be complete. #500. */
export type ReviewAvailability = "unknown" | "ok" | "unavailable";

const cache = new Map<
  string,
  { states: StateMap; notes: NoteMap; loaded: boolean; availability: ReviewAvailability; revision: number }
>();

function ensure(threadId: string) {
  let c = cache.get(threadId);
  if (!c) { c = { states: {}, notes: {}, loaded: false, availability: "unknown", revision: 0 }; cache.set(threadId, c); }
  return c;
}

/** Every mutation bumps the thread's revision and notifies subscribers, so a
 *  consumer that memoises on `revision` recomputes on the very next render. */
function emit(threadId: string) {
  ensure(threadId).revision += 1;
  window.dispatchEvent(new CustomEvent(EVT, { detail: { threadId } }));
}

/** Pull legacy localStorage entries (if any) into the DB once per thread. */
async function migrateLegacy(threadId: string, userId: string) {
  try {
    const raw = localStorage.getItem(LEGACY_KEY(threadId));
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, string>;
    const rows: { thread_id: string; artifact_id: string; user_id: string; state: ReviewState }[] = [];
    for (const [artifactId, v] of Object.entries(parsed)) {
      const mapped = (LEGACY[v] ?? v) as ReviewState;
      if (REVIEW_STATES.includes(mapped) && mapped !== "new") {
        rows.push({ thread_id: threadId, artifact_id: artifactId, user_id: userId, state: mapped });
      }
    }
    if (rows.length) {
      await supabase.from("artifact_reviews").upsert(rows, { onConflict: "user_id,artifact_id" });
    }
    localStorage.removeItem(LEGACY_KEY(threadId));
  } catch { /* ignore */ }
}

/**
 * Best-effort eviction of this thread's seed from the 7-day investigation_cache
 * when an analyst decision changes its admissibility (any recorded state).
 * NOT the load-bearing safety guard — checkCachedHitSafety() re-checks reviews
 * at replay time regardless — this just stops a stale row from lingering
 * for up to 7 days before that read-time check would catch it anyway.
 */
async function invalidateInvestigationCache(threadId: string, userId: string) {
  try {
    const { data: thread } = await supabase
      .from("threads")
      .select("seed_value")
      .eq("id", threadId)
      .maybeSingle();
    const seedText = (thread as { seed_value?: string | null } | null)?.seed_value;
    if (!seedText) return;
    const seed = detectSeed(seedText);
    if (!seed) return;
    await supabase
      .from("investigation_cache")
      .delete()
      .eq("user_id", userId)
      .eq("seed_kind", seed.kind)
      .eq("seed_value_normalized", seed.normalized);
  } catch { /* best-effort; read-time reconciliation is the real guard */ }
}

/**
 * Decide whether an `artifact_reviews` response can be trusted, and project it.
 *
 * THE POINT OF THIS FUNCTION (#500): a failing PostgREST select resolves as
 * `{ data: null, error }` rather than throwing. Reading only `data` — `data ?? []`
 * — made a failed read indistinguishable from a thread with no reviews, so every
 * `dismissed`/`wrong` artifact silently read as unreviewed and could render as
 * CONFIRMED at the top of a report.
 *
 * "We could not read the verdicts" is not "nothing was rejected." Extracted as a
 * pure function so that decision is directly testable and the caller has exactly
 * one thing to branch on. Same shape as the backend fix in #498.
 *
 * A malformed individual ROW is tolerated — one bad row must not discard an
 * analyst's other verdicts — but a malformed RESPONSE is not.
 */
/** Deliberately a flat shape, not a discriminated union: this project compiles
 *  with `strict: false` / `strictNullChecks: false`, where narrowing on a literal
 *  boolean discriminant is unreliable. Every field is always present — on an
 *  unavailable read the maps are empty and `reason` carries why. */
export interface ReviewLoadOutcome {
  available: boolean;
  states: StateMap;
  notes: NoteMap;
  reason: string | null;
}

export function interpretReviewRows(data: unknown, error: unknown): ReviewLoadOutcome {
  if (error) {
    const msg = error && typeof error === "object" && "message" in error
      ? String((error as { message: unknown }).message)
      : String(error);
    return { available: false, states: {}, notes: {}, reason: msg.slice(0, 200) };
  }
  // A successful select returns an array, never null. Anything else is a shape we
  // do not understand, and guessing "none" is the dangerous direction.
  if (!Array.isArray(data)) {
    return { available: false, states: {}, notes: {}, reason: "artifact_reviews returned no array" };
  }

  const states: StateMap = {};
  const notes: NoteMap = {};
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const r = row as { artifact_id?: unknown; state?: unknown; note?: unknown };
    if (typeof r.artifact_id !== "string" || typeof r.state !== "string") continue;
    states[r.artifact_id] = r.state as ReviewState;
    if (typeof r.note === "string" && r.note) notes[r.artifact_id] = r.note;
  }
  return { available: true, states, notes, reason: null };
}

async function loadFromDb(threadId: string) {
  const c = ensure(threadId);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    // No session: the verdicts were not read. Say so rather than leaving the
    // caller on "unknown" forever, and keep whatever was already loaded.
    c.availability = "unavailable";
    c.loaded = true;
    emit(threadId);
    return;
  }
  await migrateLegacy(threadId, user.id);
  const { data, error } = await supabase
    .from("artifact_reviews")
    .select("artifact_id,state,note")
    .eq("thread_id", threadId)
    .eq("user_id", user.id);

  const outcome = interpretReviewRows(data, error);
  if (!outcome.available) {
    // DO NOT touch c.states / c.notes here. The pre-#500 code cleared them before
    // repopulating, so a failed RE-load destroyed verdicts that had loaded
    // correctly a moment earlier — state went from accurate to empty. Whatever is
    // cached stays; `availability` is how consumers learn not to trust it as
    // complete. `loaded` is still set so the hook does not retry-storm.
    console.warn("[review] artifact_reviews unavailable:", outcome.reason);
    c.availability = "unavailable";
    c.loaded = true;
    emit(threadId);
    return;
  }

  c.states = outcome.states;
  c.notes = outcome.notes;
  c.availability = "ok";
  c.loaded = true;
  emit(threadId);
}

/** Context captured with a verdict, for the feedback log and memory lessons. */
export type ReviewCtx = { value?: string; kind?: string; confidence?: number; source?: string };

function errMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

export function useReviewStates(threadId: string) {
  const c = ensure(threadId);
  const [map, setMap] = useState<StateMap>(c.states);
  const [notes, setNotes] = useState<NoteMap>(c.notes);
  // #500. Consumers that make an authority claim ("nothing was rejected") must be
  // able to tell a successful empty read from a failed one, and fail closed.
  const [availability, setAvailability] = useState<ReviewAvailability>(c.availability);
  // Monotonic per-thread counter, bumped on EVERY change (including a rollback).
  // Consumers that memoise derived counts or ordering must depend on it — a memo
  // keyed on the artifact list alone goes stale the moment a verdict changes.
  const [revision, setRevision] = useState<number>(c.revision);
  const loadingRef = useRef(false);

  useEffect(() => {
    setMap(ensure(threadId).states);
    setNotes(ensure(threadId).notes);
    setAvailability(ensure(threadId).availability);
    setRevision(ensure(threadId).revision);
    if (!ensure(threadId).loaded && !loadingRef.current) {
      loadingRef.current = true;
      loadFromDb(threadId).finally(() => { loadingRef.current = false; });
    }
    const onChange = (e: Event) => {
      const d = (e as CustomEvent).detail as { threadId?: string } | undefined;
      if (!d || d.threadId === threadId) {
        setMap({ ...ensure(threadId).states });
        setNotes({ ...ensure(threadId).notes });
        setAvailability(ensure(threadId).availability);
        setRevision(ensure(threadId).revision);
      }
    };
    window.addEventListener(EVT, onChange);
    return () => window.removeEventListener(EVT, onChange);
  }, [threadId]);

  const get = useCallback((id: string): ReviewState => map[id] ?? "new", [map]);
  const getNote = useCallback((id: string): string => notes[id] ?? "", [notes]);

  /**
   * Record (or reset) a verdict. RETURNS A REAL RESULT: `{ ok: true }` only after
   * the row has persisted, `{ ok: false, error }` after the optimistic state has
   * been rolled back and the analyst told. Every dependent action — launching a
   * recheck, evicting the cache, teaching memory — is strictly downstream of the
   * commit. Nothing here throws for an expected failure.
   */
  const set = useCallback(
    async (
      id: string,
      state: ReviewState | null,
      ctx?: ReviewCtx,
    ): Promise<ReviewWriteResult> => {
      const c = ensure(threadId);
      // Capture the analyst's PRIOR judgment before we mutate it — the feedback
      // event records the transition (prior → resulting), and a failed write
      // restores exactly this.
      const prior = c.states[id] ?? "new";
      const priorNote = c.notes[id];
      const rollback = () => {
        if (prior === "new") delete c.states[id]; else c.states[id] = prior;
        if (priorNote === undefined) delete c.notes[id]; else c.notes[id] = priorNote;
        emit(threadId);
      };
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        toast.error("Not signed in — the review was not recorded.");
        return { ok: false, error: "not signed in" };
      }
      if (state == null || state === "new") {
        delete c.states[id];
        delete c.notes[id];
        emit(threadId);
        const { error: delErr } = await supabase
          .from("artifact_reviews").delete().eq("artifact_id", id).eq("user_id", user.id);
        if (delErr) {
          rollback();
          console.error("[review] reset did not persist", { artifactId: id, error: delErr.message });
          toast.error(`Could not reset the review — the mark was kept. ${delErr.message}`);
          return { ok: false, error: delErr.message };
        }
        // Reset = RETRACTION. Append an immutable retract event so the resolved
        // calibration view stops selecting the now-withdrawn terminal judgment
        // (retract is the latest event → y NULL → the artifact drops out of the
        // clean calibration set). Only when there was a real judgment to withdraw.
        if (prior !== "new") {
          void recordAnalystFeedback({
            threadId,
            artifactId: id,
            action: "retract",
            priorState: prior,
            resultingState: "new",
            reason: null,
            confidenceBefore: ctx?.confidence ?? null,
            confidenceAfter: ctx?.confidence ?? null,
            sourceLineage: { source: ctx?.source ?? null, kind: ctx?.kind ?? null },
          });
          // A withdrawn decision changes cache admissibility as much as a new one.
          void invalidateInvestigationCache(threadId, user.id);
        }
        return { ok: true, state: "new" };
      }

      c.states[id] = state;
      emit(threadId);
      const { error: reviewErr } = await supabase.from("artifact_reviews").upsert(
        { thread_id: threadId, artifact_id: id, user_id: user.id, state },
        { onConflict: "user_id,artifact_id" },
      );
      // A verdict that does not persist is worse than no verdict at all: the
      // analyst believes the agent has been told, and it has not. This error was
      // previously discarded, which is how state='wrong' failed a CHECK
      // constraint on EVERY write for months while the UI showed a green mark
      // and a memory lesson was still written on the next line. 649 review rows
      // existed and not one of them was 'wrong'.
      // Roll the optimistic local state back and tell the analyst, so a silent
      // write failure can never masquerade as a recorded judgment again.
      if (reviewErr) {
        rollback();
        console.error("[review] verdict did not persist", { artifactId: id, state, error: reviewErr.message });
        toast.error(`Could not save "${state}" — the mark was not recorded. ${reviewErr.message}`);
        return { ok: false, error: reviewErr.message };
      }
      if (CACHE_INVALIDATING_STATES.has(state)) {
        void invalidateInvestigationCache(threadId, user.id);
      }
      // Ground-truth capture (instrumentation-only): append an immutable
      // feedback event. Best-effort — never blocks or breaks the review UX,
      // and changes NO confidence. Confidence is unchanged, so before == after
      // (the artifact's stored confidence at judgment time).
      const action = actionForReviewState(state);
      if (action) {
        void recordAnalystFeedback({
          threadId,
          artifactId: id,
          action,
          priorState: prior,
          resultingState: state,
          reason: c.notes[id] ?? null,
          confidenceBefore: ctx?.confidence ?? null,
          confidenceAfter: ctx?.confidence ?? null,
          sourceLineage: { source: ctx?.source ?? null, kind: ctx?.kind ?? null },
        });
      }
      // Teach the agent: when an analyst marks an artifact as factually
      // wrong, persist a durable cross-investigation lesson so future
      // runs recall it and skip the bad lead. The RESULT IS CHECKED: an RPC
      // failure resolves as { error } without throwing, so the old try/catch
      // never fired and a lost lesson looked identical to a saved one.
      let memoryTaught: boolean | undefined;
      if (state === "wrong" && ctx?.value) {
        const subject = String(ctx.value).trim().toLowerCase();
        if (subject) {
          const kindHint = ctx.kind ? ` (${ctx.kind})` : "";
          const entry = {
            kind: "lesson",
            subject,
            subject_kind: ctx.kind ?? null,
            related_values: [],
            content:
              `Analyst marked "${ctx.value}"${kindHint} as FALSE / incorrect data. ` +
              `Do NOT re-propose this artifact in future investigations for the same user. ` +
              `Treat as a confirmed false positive even if a tool surfaces it again.`,
            confidence: 95,
          };
          try {
            const { error: memErr } = await supabase.rpc("save_agent_memories", {
              _user_id: user.id,
              _thread_id: threadId,
              _entries: [entry],
            });
            memoryTaught = !memErr;
            if (memErr) {
              console.warn("[review] memory lesson did not persist", { artifactId: id, error: memErr.message });
              toast.warning(`Marked false, but the agent lesson was not saved. ${memErr.message}`);
            }
          } catch (e) {
            memoryTaught = false;
            console.warn("[review] memory lesson threw", { artifactId: id, error: errMessage(e) });
            toast.warning("Marked false, but the agent lesson was not saved.");
          }
        }
      }
      return memoryTaught === undefined ? { ok: true, state } : { ok: true, state, memoryTaught };
    },
    [threadId],
  );

  /**
   * Attach a note. Adding a note to an unreviewed artifact implicitly confirms it
   * (existing product behavior). Returns a real result and rolls back both the
   * note and the implicit confirmation if the write fails.
   */
  const setNote = useCallback(
    async (
      id: string,
      note: string,
      ctx?: ReviewCtx,
    ): Promise<ReviewWriteResult> => {
      const c = ensure(threadId);
      const priorNote = c.notes[id];
      const existing = c.states[id];
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        toast.error("Not signed in — the note was not saved.");
        return { ok: false, error: "not signed in" };
      }
      const trimmed = note.trim();
      if (trimmed) c.notes[id] = trimmed; else delete c.notes[id];
      // Need a row to attach a note to; default to "confirmed" if none exists yet.
      const stateToWrite = existing ?? "confirmed";
      const implicitlyConfirmed = !existing;
      if (implicitlyConfirmed) c.states[id] = stateToWrite;
      emit(threadId);
      const { error: noteErr } = await supabase.from("artifact_reviews").upsert(
        { thread_id: threadId, artifact_id: id, user_id: user.id, state: stateToWrite, note: trimmed || null },
        { onConflict: "user_id,artifact_id" },
      );
      if (noteErr) {
        if (priorNote === undefined) delete c.notes[id]; else c.notes[id] = priorNote;
        if (implicitlyConfirmed) delete c.states[id];
        emit(threadId);
        console.error("[review] note did not persist", { artifactId: id, error: noteErr.message });
        toast.error(`Could not save the note. ${noteErr.message}`);
        return { ok: false, error: noteErr.message };
      }
      // Capture the implicit confirm as a ground-truth event so the event log +
      // calibration views match what the product shows.
      if (implicitlyConfirmed) {
        void invalidateInvestigationCache(threadId, user.id);
        void recordAnalystFeedback({
          threadId,
          artifactId: id,
          action: "confirm",
          priorState: "new",
          resultingState: "confirmed",
          reason: trimmed || null,
          confidenceBefore: ctx?.confidence ?? null,
          confidenceAfter: ctx?.confidence ?? null,
          sourceLineage: { source: ctx?.source ?? null, kind: ctx?.kind ?? null },
        });
      }
      return { ok: true, state: stateToWrite };
    },
    [threadId],
  );

  /** Clear every verdict on the thread. Optimistic, rolled back on failure. */
  const clear = useCallback(async (): Promise<ReviewWriteResult> => {
    const c = ensure(threadId);
    const snapshot = { states: { ...c.states }, notes: { ...c.notes } };
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      toast.error("Not signed in — reviews were not cleared.");
      return { ok: false, error: "not signed in" };
    }
    c.states = {}; c.notes = {};
    emit(threadId);
    const { error: clearErr } = await supabase
      .from("artifact_reviews").delete().eq("thread_id", threadId).eq("user_id", user.id);
    if (clearErr) {
      c.states = snapshot.states; c.notes = snapshot.notes;
      emit(threadId);
      console.error("[review] clear did not persist", { threadId, error: clearErr.message });
      toast.error(`Could not clear reviews — they were kept. ${clearErr.message}`);
      return { ok: false, error: clearErr.message };
    }
    if (Object.keys(snapshot.states).length > 0) void invalidateInvestigationCache(threadId, user.id);
    return { ok: true, state: "new" };
  }, [threadId]);

  return { map, notes, availability, revision, get, getNote, set, setNote, clear };
}
