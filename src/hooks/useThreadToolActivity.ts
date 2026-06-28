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
}

export interface ThreadToolActivity {
  events: ToolEvent[];
  total: number;
  hiddenFailed: number;
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
}

const GATED_RE = /gated|missing.?key|not configured|disabled|unavailable|provider disabled/i;
const DEGRADED_RE = /degraded|suppressed|rate.?limit|burst|budget|concurrency|cycle limit|duplicate call/i;

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
  if (oc === "skipped") {
    const err = errorMsg ?? "";
    if (GATED_RE.test(err)) return { tone: "skip", status: "gated" };
    if (DEGRADED_RE.test(err)) return { tone: "skip", status: "degraded" };
    return { tone: "skip", status: "skipped" };
  }
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
export function useThreadToolActivity(threadId: string): ThreadToolActivity {
  const [events, setEvents] = useState<ToolEvent[]>([]);
  const [hiddenFailed, setHiddenFailed] = useState(0);
  const [loading, setLoading] = useState(true);
  const channelIdRef = useRef<number>();
  if (channelIdRef.current == null) channelIdRef.current = ++channelSeq;

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const { data } = await supabase
        .from("tool_usage_log")
        // `outcome` is not in the generated types yet (added by migration) —
        // cast via unknown below to keep typecheck green.
        .select("id,tool_name,outcome,ok,error_msg,created_at")
        .eq("thread_id", threadId)
        .order("created_at", { ascending: true });
      if (!alive) return;
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
        };
      });
      // Failed calls stay in the log but are suppressed from the beta-facing
      // feed (the Tool-Health panel surfaces failures explicitly); carry the
      // count so the surface acknowledges hidden activity instead of reading
      // empty.
      setHiddenFailed(out.filter((event) => event.status === "failed").length);
      setEvents(out.filter((event) => event.status !== "failed"));
      setLoading(false);
    };
    load();
    const ch = supabase
      .channel(`tool-activity-${threadId}-${channelIdRef.current}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "tool_usage_log", filter: `thread_id=eq.${threadId}` }, load)
      .subscribe();
    return () => { alive = false; supabase.removeChannel(ch); };
  }, [threadId]);

  return {
    events,
    total: events.length,
    hiddenFailed,
    ok: events.filter((e) => e.status === "succeeded").length,
    skipped: events.filter((e) => e.status === "skipped").length,
    gated: events.filter((e) => e.status === "gated").length,
    degraded: events.filter((e) => e.status === "degraded").length,
    loading,
  };
}
