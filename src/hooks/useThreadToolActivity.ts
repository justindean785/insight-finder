import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { deriveToolReason, type ToolTone, type ToolStatus } from "@/lib/tool-run";
import { toolDisplayName, toolActionLabel } from "@/lib/tool-display";
import { chargedMicroUsd as effectiveCharge } from "@/lib/runCost";
import { CANONICAL_OUTCOME_META, classifyDetailedOutcome, type CanonicalOutcome } from "@/lib/tool-outcome";

/**
 * Best-effort short reason for a non-OK tool event, for the Activity feed.
 * Reads the error text first, then any structured `reason`/`error`/`message`
 * in the output. Truncated so the activity row stays compact. (Retained for the
 * chat-part path; the thread feed now sources from tool_usage_log below.)
 */
export function toolActivityReason(
  part: { state?: string; errorText?: unknown; output?: unknown },
  tone: ToolTone,
): string | undefined {
  if (tone === "ok" || tone === "pending") return undefined;
  const fromError =
    typeof part.errorText === "string" && part.errorText.trim()
      ? part.errorText.trim()
      : "";
  const reason = fromError || deriveToolReason(part.output);
  if (!reason) return undefined;
  const clean = reason.replace(/\s+/g, " ").trim();
  return clean.length > 160 ? `${clean.slice(0, 159)}…` : clean;
}

export interface ToolEvent {
  id: string;
  /** runtime tool name, e.g. "breach_check" */
  toolName: string;
  displayName: string;
  actionLabel: string;
  tone: ToolTone;
  /** Richer operational status: succeeded/failed/skipped/gated/degraded/pending. */
  status: ToolStatus;
  /**
   * The call's ONE canonical category (`src/lib/tool-outcome.ts`). `status` is
   * derived from it, and the Health view counts it directly — so Activity and
   * Health can no longer bucket the same call differently.
   */
  category: CanonicalOutcome;
  /** Raw `error_msg`, untruncated — Health normalises it into its own message. */
  errorMsg: string | null;
  /** Provider HTTP status, when recorded. */
  statusCode: number | null;
  state?: string;
  at: string;
  /** Short failure/skip reason, when the tone is not "ok". */
  reason?: string;
  /**
   * Operational detail that was fetched and then discarded for months: the
   * SELECT above pulled six columns while `tool_usage_log` carried duration,
   * cache state and spend, so the Tools tab could not tell a 300ms "skipped, no
   * API key" from a 30s upstream timeout — the two failures an analyst treats
   * completely differently. Null when the column is absent on a legacy row.
   */
  durationMs: number | null;
  /** Served from cache: no provider call, no spend, and possibly stale data. */
  cached: boolean;
  /**
   * RAW `charged_micro_usd`, exactly as persisted. `null` means the row predates
   * charge accounting — NOT that the call was free.
   *
   * Kept nullable on purpose. Overwriting it with the reconstruction below would
   * erase provenance and make a modern, recorded $0 charge indistinguishable
   * from a legacy row we merely guessed at.
   */
  chargedMicroUsd: number | null;
  /**
   * The canonical figure any spend calculation should use: the persisted charge
   * when there is one, otherwise reconstructed from ok/cached/list-price by the
   * shared `chargedMicroUsd()` rule in runCost.ts.
   *
   * Derived HERE, at the data boundary, so no consumer has to know the schema's
   * history. The Tools tab's spend breakdown grew its own `?? 0` precisely
   * because that knowledge was left to the caller — which booked every legacy
   * paid call as free and under-reported the run. (Codex review, PR #462.)
   */
  effectiveChargedMicroUsd: number;
  /**
   * The investigation stage the runtime stamped on the call
   * (`input_json.runtime.stage`: TRIAGE, REVIEW, TARGETED_PIVOT, VERIFY,
   * REPORT). It is the stage the call was DISPATCHED in — the closest persisted
   * record of how far a run got, which is what an interrupted-run banner needs.
   */
  stage: string | null;
}

export interface ThreadToolActivity {
  events: ToolEvent[];
  /** Every persisted tool call for the thread. */
  persistedTotal: number;
  /** Activity-feed rows. Includes failures — nothing is suppressed. */
  total: number;
  /** Calls that failed outright. Shown in the feed, counted here for the badge. */
  failed: number;
  ok: number;
  skipped: number;
  gated: number;
  degraded: number;
  /** True until the FIRST load for this scope settles. Never true again after. */
  loading: boolean;
  /**
   * The most recent load failed. Whatever was already loaded is KEPT — a
   * transient failure must not repaint a real count as 0 — and consumers that
   * have nothing yet must render "unavailable", not "0 tools".
   */
  error: boolean;
  /** Epoch ms of the last SUCCESSFUL load, or null if none has completed. */
  loadedAt: number | null;
  /**
   * Force a fresh read from persistence. Resolves once that read has settled:
   * `true` if it succeeded, `false` if it failed (the last rows are kept and
   * `error` is set) — so a caller reconciling several sources can tell a
   * refresh that landed from one that only kept the old figures.
   */
  reload: () => Promise<boolean>;
}

/** One persisted tool_usage_log row (the authoritative per-call record). */
interface ActivityRow {
  id: string;
  tool_name: string;
  outcome: string | null;
  ok: boolean | null;
  error_msg: string | null;
  created_at: string;
  /** Wall-clock for the call. Distinguishes "failed fast" from "timed out". */
  duration_ms: number | null;
  /** Served from cache — no provider call, no spend. */
  cached: boolean | null;
  /** What this call actually cost, in micro-USD. 0 on a cache hit. */
  charged_micro_usd: number | null;
  /** Attributed list price. The fallback when `charged_micro_usd` is legacy-null. */
  cost_micro_usd: number | null;
  /** `input_json->runtime->>stage`, projected server-side so the whole input is not shipped. */
  stage?: string | null;
  /** Provider HTTP status, when the call recorded one. Part of the canonical category. */
  status_code?: number | null;
}

/** A policy skip that is specifically a missing key / disabled provider. */
const GATED_RE = /gated|missing.?key|not configured|disabled|unavailable|provider disabled/i;

/**
 * Map a tool_usage_log row to a display tone + operational status — THROUGH the
 * canonical taxonomy (`classifyDetailedOutcome`), the same one the Health panel
 * counts with. Pure — exported for tests.
 *
 * WHY ONE CLASSIFIER. Activity used to run its own regexes. They agreed with
 * Health on failed-vs-not-failed (the "goran kvothe" fix) but not on skipped vs
 * degraded: a circuit-breaker suppression, a burst limit, a duplicate-call guard
 * or our own paid-call cap read Degraded here and Skipped in Health. On one live
 * case the Tools tab showed "Degraded 3 · Skipped 15" in Activity and "Degraded
 * 2 · Skipped 16" in Health for the same 116 calls. Now each call has exactly one
 * category and both views count it the same way.
 *
 * Mapping (by the category's tone): ok/empty → succeeded, degraded → degraded,
 * skipped → skipped (or gated when it is a missing key / disabled provider),
 * failed (config, provider fault, unknown) → failed — what "Needs attention" is.
 */
export function classifyActivityRow(
  outcome: string | null,
  ok: boolean | null,
  errorMsg: string | null,
  statusCode: number | null = null,
): { tone: ToolTone; status: ToolStatus; category: CanonicalOutcome } {
  // Legacy rows (null outcome) fall back to the ok boolean — the same rule
  // `aggregateToolHealth` applies, so a legacy row is classified identically.
  const coarse = outcome ?? (ok === false ? "failed" : "ok");
  const category = classifyDetailedOutcome(coarse, errorMsg, statusCode);
  switch (CANONICAL_OUTCOME_META[category].tone) {
    case "ok":
    case "empty":
      return { tone: "ok", status: "succeeded", category };
    case "degraded":
      return { tone: "skip", status: "degraded", category };
    case "skipped":
      return GATED_RE.test(errorMsg ?? "")
        ? { tone: "skip", status: "gated", category }
        : { tone: "skip", status: "skipped", category };
    default:
      return { tone: "error", status: "failed", category };
  }
}

function cleanReason(errorMsg: string | null): string | undefined {
  if (!errorMsg) return undefined;
  const clean = errorMsg.replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  return clean.length > 160 ? `${clean.slice(0, 159)}…` : clean;
}

function toEvent(r: ActivityRow): ToolEvent {
  const statusCode = typeof r.status_code === "number" ? r.status_code : null;
  const { tone, status, category } = classifyActivityRow(r.outcome, r.ok, r.error_msg, statusCode);
  const rawCharged = typeof r.charged_micro_usd === "number" ? r.charged_micro_usd : null;
  return {
    id: r.id,
    toolName: r.tool_name,
    displayName: toolDisplayName(r.tool_name),
    actionLabel: toolActionLabel(r.tool_name),
    tone,
    status,
    category,
    errorMsg: r.error_msg ?? null,
    statusCode,
    at: r.created_at,
    reason: tone === "ok" ? undefined : cleanReason(r.error_msg),
    durationMs: typeof r.duration_ms === "number" ? r.duration_ms : null,
    cached: r.cached === true,
    chargedMicroUsd: rawCharged,
    // `ok: r.ok` — the same input summarizeRunCosts uses, deliberately.
    // Reconstructing from the derived tone instead would be a SECOND
    // definition of "was this call billable", which is the class of
    // divergence this extraction exists to end.
    effectiveChargedMicroUsd: effectiveCharge({
      ok: r.ok,
      cached: r.cached,
      cost_micro_usd: r.cost_micro_usd,
      charged_micro_usd: rawCharged,
    }),
    stage: typeof r.stage === "string" && r.stage.trim() ? r.stage.trim() : null,
  };
}

// ---------------------------------------------------------------------------
// ONE store per (account, thread) — shared by every consumer.
//
// WHY. Until this change every call site (workspace header, tab badges,
// Overview, Tools, Report) ran its own instance: its own SELECT, its own
// realtime channel, its own refresh triggers. They could only agree by luck.
// Production showed the header at 46 tools, the Tools tab badge at 46 and the
// Tools panel at 48 on the same screen.
//
// The deeper cause is that `tool_usage_log` is NOT in the `supabase_realtime`
// publication (only `artifacts` and `threads` are — migration 20260526140844),
// so the tool-row subscription every instance relied on never fires. The
// long-lived header/badge instances therefore froze at their mount count, while
// the Overview and Tools panels — re-created on every tab open — re-queried and
// read the true figure. A shared store fixes the first half (every surface reads
// the SAME rows); the reconcile triggers below fix the second (the rows converge
// without a tool-row event):
//
//   - a `threads` UPDATE (published): the backend pulses `last_heartbeat_at`
//     roughly every 15s for the life of a run and writes a terminal status at
//     the end, so a live run reconciles on its own heartbeat;
//   - this tab's stream ending (`proximity:run-state`);
//   - the realtime socket re-subscribing after a drop;
//   - the browser tab regaining visibility (the only signal that survives a
//     dead socket);
//   - an explicit `reload()` (the case header's Refresh control).
//
// The tool_usage_log binding is kept — should the table ever be published it
// becomes the fastest path — but on a channel of its OWN, so a server-side
// rejection of an unpublished table cannot take the `threads` binding down with
// it.
// ---------------------------------------------------------------------------

type StoreSnapshot = {
  events: ToolEvent[];
  persistedTotal: number;
  loaded: boolean;
  error: boolean;
  loadedAt: number | null;
};

type Store = StoreSnapshot & {
  key: string;
  threadId: string;
  subscribers: Set<(snap: StoreSnapshot) => void>;
  channels: ReturnType<typeof supabase.channel>[];
  refCount: number;
  inflight: Promise<boolean> | null;
  queued: Promise<boolean> | null;
  runWasActive: boolean;
  onRunState: ((event: Event) => void) | null;
  onVisible: (() => void) | null;
};

const stores = new Map<string, Store>();
// Monotonic suffix for channel topics. realtime-js hands back an EXISTING
// channel for a topic that is still disconnecting, and `subscribe()` is a no-op
// on it — so a store torn down and re-created within that window (a remount)
// would inherit a dead subscription if topics were reused.
let channelSeq = 0;

function snapshotOf(store: Store): StoreSnapshot {
  return {
    events: store.events,
    persistedTotal: store.persistedTotal,
    loaded: store.loaded,
    error: store.error,
    loadedAt: store.loadedAt,
  };
}

function publish(store: Store) {
  const snap = snapshotOf(store);
  for (const fn of store.subscribers) fn(snap);
}

/** Resolves `true` when the read succeeded, `false` when it failed. */
async function runLoad(store: Store): Promise<boolean> {
  const { data, error, count } = await supabase
    .from("tool_usage_log")
    // `outcome` is not in the generated types yet (added by migration) —
    // cast via unknown below to keep typecheck green.
    .select("id,tool_name,outcome,ok,error_msg,status_code,created_at,duration_ms,cached,charged_micro_usd,cost_micro_usd,stage:input_json->runtime->>stage", { count: "exact" })
    .eq("thread_id", store.threadId)
    .order("created_at", { ascending: true });
  // A store released while its read was in flight must not be written to —
  // and neither may one that has since been replaced under the same key.
  if (stores.get(store.key) !== store) return !error;
  if (error) {
    store.loaded = true;
    store.error = true;
    publish(store);
    return false;
  }
  const rows = (data ?? []) as unknown as ActivityRow[];
  // Failed calls are part of the record, not noise to be hidden.
  //
  // They used to be filtered out of this feed with only a count carried
  // alongside, which meant an analyst could not see WHICH tool failed or
  // why. Across this account that suppressed 2,142 of 18,393 calls, and it
  // put the tab badge (every persisted call) permanently at odds with the
  // panel (survivors only) — 9 vs 7 on a sample case. A tool that failed is
  // a coverage gap in the investigation: the thing the analyst most needs
  // to know before trusting the result.
  store.events = rows.map(toEvent);
  store.persistedTotal = count ?? rows.length;
  store.loaded = true;
  store.error = false;
  store.loadedAt = Date.now();
  publish(store);
  return true;
}

/**
 * Coalesced load. At most one read is in flight per store; a request that
 * arrives mid-read queues exactly ONE follow-up, so a burst of triggers costs
 * two reads, never N, and no trigger is lost (the follow-up starts after the
 * current read and therefore sees everything that caused it). A queued caller
 * gets the follow-up's outcome — the read that actually saw its trigger.
 */
function requestLoad(store: Store): Promise<boolean> {
  if (!store.inflight) {
    store.inflight = runLoad(store).finally(() => {
      store.inflight = null;
    });
    return store.inflight;
  }
  if (!store.queued) {
    store.queued = store.inflight.then(() => {
      store.queued = null;
      return requestLoad(store);
    });
  }
  return store.queued;
}

function acquire(key: string, threadId: string, listener: (snap: StoreSnapshot) => void): Store {
  let store = stores.get(key);
  if (!store) {
    const created: Store = {
      key,
      threadId,
      events: [],
      persistedTotal: 0,
      loaded: false,
      error: false,
      loadedAt: null,
      subscribers: new Set(),
      channels: [],
      refCount: 0,
      inflight: null,
      queued: null,
      runWasActive: false,
      onRunState: null,
      onVisible: null,
    };
    store = created;
    stores.set(key, created);
    void requestLoad(created);

    const seq = ++channelSeq;
    const resubscribeReconciler = () => {
      let subscribed = false;
      return (status: string) => {
        if (status !== "SUBSCRIBED") return;
        // A second SUBSCRIBED means the channel recovered after disconnecting.
        // Reconcile from persistence in case events were missed while down.
        if (subscribed) void requestLoad(created);
        subscribed = true;
      };
    };

    const logChannel = supabase
      .channel(`tool-activity-log-${threadId}-${seq}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "tool_usage_log", filter: `thread_id=eq.${threadId}` },
        (payload: unknown) => {
          const change = payload as { new?: { thread_id?: string }; old?: { thread_id?: string } };
          const changedThreadId = change.new?.thread_id ?? change.old?.thread_id;
          if (changedThreadId && changedThreadId !== threadId) return;
          void requestLoad(created);
        },
      )
      .subscribe(resubscribeReconciler());

    const runChannel = supabase
      .channel(`tool-activity-run-${threadId}-${seq}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "threads", filter: `id=eq.${threadId}` },
        (payload: unknown) => {
          const change = payload as { new?: { id?: string } };
          if (change.new?.id && change.new.id !== threadId) return;
          // Heartbeat, cost checkpoint or terminal status — every one of them
          // means the run moved, and this is the only published signal that
          // does. Coalescing in requestLoad keeps a 15s heartbeat to one read.
          void requestLoad(created);
        },
      )
      .subscribe(resubscribeReconciler());

    created.channels = [logChannel, runChannel];

    created.onRunState = (event: Event) => {
      const detail = (event as CustomEvent<{ threadId?: string; running?: boolean }>).detail;
      if (!detail || detail.threadId !== threadId) return;
      if (detail.running) {
        created.runWasActive = true;
      } else if (created.runWasActive) {
        created.runWasActive = false;
        void requestLoad(created);
      }
    };
    window.addEventListener("proximity:run-state", created.onRunState);

    if (typeof document !== "undefined") {
      created.onVisible = () => {
        if (document.visibilityState !== "visible") return;
        void requestLoad(created);
      };
      document.addEventListener("visibilitychange", created.onVisible);
    }
  }
  store.subscribers.add(listener);
  store.refCount += 1;
  return store;
}

function release(key: string, listener: (snap: StoreSnapshot) => void) {
  const store = stores.get(key);
  if (!store) return;
  store.subscribers.delete(listener);
  store.refCount -= 1;
  if (store.refCount > 0) return;
  for (const ch of store.channels) supabase.removeChannel(ch);
  if (store.onRunState) window.removeEventListener("proximity:run-state", store.onRunState);
  if (store.onVisible && typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", store.onVisible);
  }
  stores.delete(key);
}

/** Test/diagnostic hook: how many live stores (and so channel pairs) exist. */
export function toolActivityStoreCount(): number {
  return stores.size;
}

const EMPTY_EVENTS: ToolEvent[] = [];

/**
 * Authoritative per-thread tool activity, read from `tool_usage_log` (the same
 * source the Tool-Health panel uses) — NOT the chat message parts, which the
 * osint-agent orchestrator does not populate, so the old message-derived feed
 * always read empty.
 *
 * `accountId` scopes the store. Pass the signed-in user's id at every call
 * site: two different scopes are two different stores, and the whole point of
 * the store is that every surface on the page reads the same one. `undefined`
 * is kept for legacy callers (it is its own "unscoped" store); an explicit empty
 * string means auth is unresolved or signed out and nothing is loaded.
 */
export function useThreadToolActivity(threadId: string, accountId?: string): ThreadToolActivity {
  const scopeKey = `${accountId === undefined ? "unscoped" : accountId}:${threadId}`;
  const enabled = Boolean(threadId) && !(accountId !== undefined && !accountId);
  const [state, setState] = useState<{ scopeKey: string; snap: StoreSnapshot } | null>(null);

  useEffect(() => {
    if (!enabled) {
      setState({ scopeKey, snap: { events: EMPTY_EVENTS, persistedTotal: 0, loaded: true, error: false, loadedAt: null } });
      return;
    }
    const listener = (snap: StoreSnapshot) => setState({ scopeKey, snap });
    const store = acquire(scopeKey, threadId, listener);
    // Seed with whatever the shared store already holds, so a panel opened
    // after the header does not flash "loading" over a count that is known.
    setState({ scopeKey, snap: snapshotOf(store) });
    return () => release(scopeKey, listener);
  }, [enabled, scopeKey, threadId]);

  const reload = useCallback(() => {
    const store = stores.get(scopeKey);
    return store ? requestLoad(store) : Promise.resolve(true);
  }, [scopeKey]);

  // Effects run after render. Keying the snapshot by scope prevents one frame of
  // the previous thread/account count from leaking during that transition.
  const snap: StoreSnapshot = state && state.scopeKey === scopeKey
    ? state.snap
    : { events: EMPTY_EVENTS, persistedTotal: 0, loaded: false, error: false, loadedAt: null };
  const { events } = snap;

  let failed = 0, ok = 0, skipped = 0, gated = 0, degraded = 0;
  for (const e of events) {
    if (e.status === "failed") failed++;
    else if (e.status === "succeeded") ok++;
    else if (e.status === "skipped") skipped++;
    else if (e.status === "gated") gated++;
    else if (e.status === "degraded") degraded++;
  }

  return {
    events,
    persistedTotal: snap.persistedTotal,
    total: events.length,
    failed,
    ok,
    skipped,
    gated,
    degraded,
    loading: !snap.loaded,
    error: snap.error,
    loadedAt: snap.loadedAt,
    reload,
  };
}
