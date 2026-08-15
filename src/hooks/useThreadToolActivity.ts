import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { deriveToolReason, type ToolTone, type ToolStatus } from "@/lib/tool-run";
import { toolDisplayName, toolActionLabel } from "@/lib/tool-display";

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

// Per-instance channel id. Several components subscribe to the same thread at
// once (header, tab badges, Tools view); Supabase rejects a second
// postgres_changes binding on a channel of the same topic, so each hook
// instance needs its own uniquely-named channel.
let channelSeq = 0;

export interface ToolEvent {
  id: string;
  /** runtime tool name, e.g. "breach_check" */
  toolName: string;
  displayName: string;
  actionLabel: string;
  tone: ToolTone;
  /** Richer operational status: succeeded/failed/skipped/gated/degraded/pending. */
  status: ToolStatus;
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
  /** Micro-USD actually charged. 0 on a cache hit. */
  chargedMicroUsd: number | null;
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
  loading: boolean;
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
}

interface ActivityState {
  scopeKey: string;
  events: ToolEvent[];
  persistedTotal: number;
  loading: boolean;
}

const GATED_RE = /gated|missing.?key|not configured|disabled|unavailable|provider disabled/i;
/**
 * Transient, non-fault conditions.
 *
 * Beyond the original rate/budget terms this now covers the three shapes the
 * Health panel already classified as Degraded/Denied while Activity was still
 * calling them failures:
 *   - our OWN throttles: "internal paid-call cap reached (12 this run) —
 *     internal throttle, not a provider limit". The row states outright that it
 *     is not a provider limit, and Activity labelled it FAILED anyway.
 *   - upstream refusals: "reddit request failed (403)" — Denied, not breakage.
 *   - timeouts, which are transient by definition.
 * A genuine provider fault (5xx, unparseable error) still falls through to
 * `failed`, which is what "Needs attention" is for.
 */
const DEGRADED_RE =
  /degraded|suppressed|rate.?limit|burst|budget|concurrency|cycle limit|duplicate call|cap reached|internal throttle|paid-call cap|quota|denied|blocked|forbidden|timed?.?out|timeout|\b40[39]\b|\b429\b/i;

/**
 * Map a tool_usage_log row to a display tone + operational status. The log's
 * `outcome` (`ok`/`skipped`/`empty`/`failed`, written by classifyToolOutcome in
 * the edge function) is the authoritative source; legacy rows with a null
 * outcome fall back to the `ok` boolean. Pure — exported for tests.
 */
export function classifyActivityRow(
  outcome: string | null,
  ok: boolean | null,
  errorMsg: string | null,
): { tone: ToolTone; status: ToolStatus } {
  const oc = (outcome ?? (ok ? "ok" : "failed")).toLowerCase();
  if (oc === "ok" || oc === "empty") return { tone: "ok", status: "succeeded" };

  // The gate/degradation check applies to EVERY non-OK outcome, not just
  // `skipped`. Consulting it only for `skipped` is why the Activity feed and
  // the Health panel disagreed about the same rows: an internal paid-call cap
  // and a reddit 403 both fell straight through to `failed` here, while Health
  // correctly reported them as Degraded/Denied and "Needs attention 0". One
  // call must not read FAILED in one panel and Degraded in the panel beside it.
  const err = errorMsg ?? "";
  if (GATED_RE.test(err)) return { tone: "skip", status: "gated" };
  if (DEGRADED_RE.test(err)) return { tone: "skip", status: "degraded" };
  if (oc === "skipped") return { tone: "skip", status: "skipped" };

  // Nothing matched: a genuine fault. This is what "Needs attention" means.
  return { tone: "error", status: "failed" };
}

function cleanReason(errorMsg: string | null): string | undefined {
  if (!errorMsg) return undefined;
  const clean = errorMsg.replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  return clean.length > 160 ? `${clean.slice(0, 159)}…` : clean;
}

/**
 * Authoritative per-thread tool activity, read from `tool_usage_log` (the same
 * source the Tool-Health panel uses) — NOT the chat message parts, which the
 * osint-agent orchestrator does not populate, so the old message-derived feed
 * always read empty. Stays fresh via a realtime subscription on the log.
 */
export function useThreadToolActivity(threadId: string, accountId?: string): ThreadToolActivity {
  const scopeKey = `${accountId === undefined ? "unscoped" : accountId}:${threadId}`;
  const [state, setState] = useState<ActivityState>({
    scopeKey: "",
    events: [],
    persistedTotal: 0,
    loading: true,
  });
  const channelIdRef = useRef<number>();
  if (channelIdRef.current == null) channelIdRef.current = ++channelSeq;

  useEffect(() => {
    let alive = true;
    let loadSeq = 0;
    let subscribed = false;
    let runWasActive = false;

    const emptyState = (): ActivityState => ({
      scopeKey,
      events: [],
      persistedTotal: 0,
      loading: true,
    });
    setState(emptyState());

    // An explicitly supplied empty account means auth is unresolved/signed out.
    // Do not let an old account's count survive while the session changes.
    if (!threadId || (accountId !== undefined && !accountId)) {
      setState((current) => ({ ...current, loading: false }));
      return () => { alive = false; };
    }

    const load = async () => {
      const requestSeq = ++loadSeq;
      const { data, error, count } = await supabase
        .from("tool_usage_log")
        // `outcome` is not in the generated types yet (added by migration) —
        // cast via unknown below to keep typecheck green.
        .select("id,tool_name,outcome,ok,error_msg,created_at,duration_ms,cached,charged_micro_usd", { count: "exact" })
        .eq("thread_id", threadId)
        .order("created_at", { ascending: true });
      if (!alive || requestSeq !== loadSeq) return;
      if (error) {
        setState({ ...emptyState(), loading: false });
        return;
      }
      const rows = (data ?? []) as unknown as ActivityRow[];
      const out: ToolEvent[] = rows.map((r) => {
        const { tone, status } = classifyActivityRow(r.outcome, r.ok, r.error_msg);
        return {
          id: r.id,
          toolName: r.tool_name,
          displayName: toolDisplayName(r.tool_name),
          actionLabel: toolActionLabel(r.tool_name),
          tone,
          status,
          at: r.created_at,
          reason: tone === "ok" ? undefined : cleanReason(r.error_msg),
          durationMs: typeof r.duration_ms === "number" ? r.duration_ms : null,
          cached: r.cached === true,
          chargedMicroUsd: typeof r.charged_micro_usd === "number" ? r.charged_micro_usd : null,
        };
      });
      // Failed calls are part of the record, not noise to be hidden.
      //
      // They used to be filtered out of this feed with only a count carried
      // alongside, which meant an analyst could not see WHICH tool failed or
      // why. Across this account that suppressed 2,142 of 18,393 calls, and it
      // put the tab badge (every persisted call) permanently at odds with the
      // panel (survivors only) — 9 vs 7 on a sample case. A tool that failed is
      // a coverage gap in the investigation: the thing the analyst most needs
      // to know before trusting the result.
      setState({
        scopeKey,
        events: out,
        persistedTotal: count ?? rows.length,
        loading: false,
      });
    };
    void load();

    const reloadForThread = (payload: unknown) => {
      const change = payload as {
        new?: { thread_id?: string };
        old?: { thread_id?: string };
      };
      const changedThreadId = change.new?.thread_id ?? change.old?.thread_id;
      if (changedThreadId && changedThreadId !== threadId) return;
      void load();
    };

    const reloadOnCompletion = (payload: unknown) => {
      const change = payload as { new?: { id?: string; status?: string | null } };
      if (change.new?.id && change.new.id !== threadId) return;
      if (change.new?.status === "finished" || change.new?.status === "stopped") {
        void load();
      }
    };

    const ch = supabase
      .channel(`tool-activity-${threadId}-${channelIdRef.current}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "tool_usage_log", filter: `thread_id=eq.${threadId}` }, reloadForThread)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "threads", filter: `id=eq.${threadId}` }, reloadOnCompletion)
      .subscribe((status) => {
        if (status !== "SUBSCRIBED") return;
        // A second SUBSCRIBED means the channel recovered after disconnecting.
        // Reconcile from persistence in case tool-row events were missed.
        if (subscribed) void load();
        subscribed = true;
      });

    const onRunState = (event: Event) => {
      const detail = (event as CustomEvent<{ threadId?: string; running?: boolean }>).detail;
      if (!detail || detail.threadId !== threadId) return;
      if (detail.running) {
        runWasActive = true;
      } else if (runWasActive) {
        runWasActive = false;
        void load();
      }
    };
    window.addEventListener("proximity:run-state", onRunState);

    return () => {
      alive = false;
      window.removeEventListener("proximity:run-state", onRunState);
      supabase.removeChannel(ch);
    };
  }, [accountId, scopeKey, threadId]);

  // Effects reset after render. Keying the returned snapshot prevents one frame
  // of the previous thread/account count from leaking during that transition.
  const current = state.scopeKey === scopeKey
    ? state
    : { scopeKey, events: [], persistedTotal: 0, loading: true };
  const { events, persistedTotal, loading } = current;

  return {
    events,
    persistedTotal,
    total: events.length,
    failed: events.filter((e) => e.status === "failed").length,
    ok: events.filter((e) => e.status === "succeeded").length,
    skipped: events.filter((e) => e.status === "skipped").length,
    gated: events.filter((e) => e.status === "gated").length,
    degraded: events.filter((e) => e.status === "degraded").length,
    loading,
  };
}
