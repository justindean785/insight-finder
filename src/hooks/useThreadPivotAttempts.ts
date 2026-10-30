import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { summarizeAttempts, type AttemptRow, type AttemptSummary } from "@/lib/pivot-attempts";

// Per-instance channel id: several hooks subscribe to the same thread's
// tool_usage_log, and Supabase rejects a second binding on one topic.
let channelSeq = 0;

// Bounded read. A case's tool log is larger than any one pivot list needs; the
// newest rows carry the attempts the ranking cares about most.
const ROW_LIMIT = 1000;

/**
 * Prior attempts per normalized selector for one thread. SELECT-only: it reads
 * `tool_usage_log` and never invokes a tool, so rendering or re-ranking can
 * never start a paid lookup. Scoped by `thread_id`, so one case's attempts
 * cannot appear on another case's pivots.
 */
export function useThreadPivotAttempts(threadId: string): Map<string, AttemptSummary> {
  const [attempts, setAttempts] = useState<Map<string, AttemptSummary>>(() => new Map());
  const channelIdRef = useRef<number>();
  if (channelIdRef.current == null) channelIdRef.current = ++channelSeq;

  useEffect(() => {
    if (!threadId) return;
    let alive = true;
    const load = async () => {
      const { data } = await supabase
        .from("tool_usage_log")
        .select("tool_name,ok,cached,input_json")
        .eq("thread_id", threadId)
        .order("created_at", { ascending: false })
        .limit(ROW_LIMIT);
      if (!alive) return;
      setAttempts(summarizeAttempts((data ?? []) as AttemptRow[]));
    };
    void load();
    const ch = supabase
      .channel(`pivot-attempts-${threadId}-${channelIdRef.current}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "tool_usage_log", filter: `thread_id=eq.${threadId}` },
        () => void load(),
      )
      .subscribe();
    return () => { alive = false; void supabase.removeChannel(ch); };
  }, [threadId]);

  return attempts;
}
