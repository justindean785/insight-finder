import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { normalizeTarget } from "@/lib/next-step-cards";

// Per-instance channel id (see useThreadToolActivity for why): several hooks
// subscribe to the same thread's tool_usage_log, and Supabase rejects a second
// postgres_changes binding on a channel of the same topic.
let channelSeq = 0;

// The input keys that carry a real pivot target (an identifier a tool was run
// AGAINST) — deliberately excludes free-text like `query`, `maxChars`, `scope`.
const TARGET_KEYS = [
  "email", "value", "url", "handle", "phone", "username", "domain", "ip", "wallet", "address",
];

/** Pull every target a tool call was run against out of one input_json blob. */
function collectTargets(inputJson: unknown, into: Set<string>): void {
  if (!inputJson || typeof inputJson !== "object") return;
  const obj = inputJson as Record<string, unknown>;
  // runtime.selector is the orchestrator's canonical "what did we run this on".
  const runtime = obj.runtime as Record<string, unknown> | undefined;
  const sel = runtime?.selector;
  if (typeof sel === "string" && sel.trim()) into.add(normalizeTarget(sel));
  // Belt-and-suspenders: the tool's own input args (selector can be "" for a few).
  const input = obj.input as Record<string, unknown> | undefined;
  if (input) {
    for (const k of TARGET_KEYS) {
      const v = input[k];
      if (typeof v === "string" && v.trim()) into.add(normalizeTarget(v));
    }
  }
}

/**
 * The set of normalized targets that tools have ALREADY been run against on this
 * thread, read from `tool_usage_log.input_json` (runtime.selector + input.*).
 *
 * WHY: artifacts carry no parent/seed lineage (verified: those columns are null
 * on real cases), so the pivot engine had no way to know a discovered email had
 * already been fully investigated — and kept re-suggesting "verify ownership"
 * for a target that seven tools had already hit. The tool log IS that signal.
 * The pivot engine marks these targets "searched" so the chat's "Next steps"
 * only surfaces genuinely-unrun leads; already-run ones sink to the Pivots tab.
 *
 * Stays live via a realtime subscription so the suggestions update as a running
 * investigation queries new targets.
 */
export function useThreadQueriedTargets(threadId: string): Set<string> {
  const [targets, setTargets] = useState<Set<string>>(() => new Set());
  const channelIdRef = useRef<number>();
  if (channelIdRef.current == null) channelIdRef.current = ++channelSeq;

  useEffect(() => {
    if (!threadId) return;
    let alive = true;
    const load = async () => {
      const { data } = await supabase
        .from("tool_usage_log")
        .select("input_json")
        .eq("thread_id", threadId);
      if (!alive) return;
      const set = new Set<string>();
      for (const row of (data ?? []) as { input_json: unknown }[]) {
        collectTargets(row.input_json, set);
      }
      set.delete("");
      setTargets(set);
    };
    void load();
    const ch = supabase
      .channel(`queried-targets-${threadId}-${channelIdRef.current}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "tool_usage_log", filter: `thread_id=eq.${threadId}` },
        () => void load(),
      )
      .subscribe();
    return () => { alive = false; void supabase.removeChannel(ch); };
  }, [threadId]);

  return targets;
}
