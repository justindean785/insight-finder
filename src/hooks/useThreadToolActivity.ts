import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { deriveToolTone, deriveToolStatus, deriveToolReason, type ToolTone, type ToolStatus } from "@/lib/tool-run";
import { toolDisplayName, toolActionLabel } from "@/lib/tool-display";

/**
 * Best-effort short reason for a non-OK tool event, for the Activity feed.
 * Reads the error text first, then any structured `reason`/`error`/`message`
 * in the output. Truncated so the activity row stays compact.
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
  /** raw tool type, e.g. "tool-breach_check" → toolName "breach_check" */
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
  failed: number;
  ok: number;
  skipped: number;
  gated: number;
  degraded: number;
  loading: boolean;
}

interface PartLike {
  type?: string;
  state?: string;
  errorText?: unknown;
  output?: unknown;
  [k: string]: unknown;
}

/**
 * Reads the persisted message stream for a thread and projects it into a flat,
 * chronological list of tool-call events plus rollup counts. DB-backed (not the
 * live in-memory chat state) so it powers the workspace header and the Tools /
 * Activity tab from any tab, and stays fresh via a realtime subscription.
 */
export function useThreadToolActivity(threadId: string): ThreadToolActivity {
  const [events, setEvents] = useState<ToolEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const channelIdRef = useRef<number>();
  if (channelIdRef.current == null) channelIdRef.current = ++channelSeq;

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const { data } = await supabase
        .from("messages")
        .select("id,role,parts,created_at")
        .eq("thread_id", threadId)
        .order("created_at");
      if (!alive) return;
      const out: ToolEvent[] = [];
      for (const row of (data ?? []) as { id: string; role: string; parts: unknown; created_at: string }[]) {
        if (row.role !== "assistant" || !Array.isArray(row.parts)) continue;
        let i = 0;
        for (const p of row.parts as PartLike[]) {
          if (typeof p?.type !== "string" || !p.type.startsWith("tool-")) continue;
          const toolName = p.type.slice("tool-".length);
          const tone = deriveToolTone(p);
          out.push({
            id: `${row.id}:${i++}`,
            toolName,
            displayName: toolDisplayName(toolName),
            actionLabel: toolActionLabel(toolName),
            tone,
            status: deriveToolStatus(p),
            state: p.state,
            at: row.created_at,
            reason: toolActivityReason(p, tone),
          });
        }
      }
      setEvents(out);
      setLoading(false);
    };
    load();
    const ch = supabase
      .channel(`tool-activity-${threadId}-${channelIdRef.current}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "messages", filter: `thread_id=eq.${threadId}` }, load)
      .subscribe();
    return () => { alive = false; supabase.removeChannel(ch); };
  }, [threadId]);

  return {
    events,
    total: events.length,
    failed: events.filter((e) => e.status === "failed").length,
    ok: events.filter((e) => e.status === "succeeded").length,
    skipped: events.filter((e) => e.status === "skipped").length,
    gated: events.filter((e) => e.status === "gated").length,
    degraded: events.filter((e) => e.status === "degraded").length,
    loading,
  };
}
