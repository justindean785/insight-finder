import { useCallback, useEffect, useRef, useState } from "react";
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

// Free-text search fields. Their whole value is a sentence, not a target, so it
// is NOT added — but a QUOTED phrase inside one is the analyst's (or the model's)
// explicit statement of what is being searched for, and it is frequently the only
// footprint a lead leaves.
//
// Without this, a run can search `"Gregory Bradley" Sacramento` five times and
// still believe that pivot untouched, because a web-search tool populates
// `input.query` and leaves `runtime.selector` empty. Quoted-phrase only, never
// the bare sentence: matching on unquoted free text would mark unrelated pivots
// searched and silently hide real leads, which is the more dangerous failure.
const QUERY_KEYS = ["query", "q", "search", "search_query"];
const QUOTED_RE = /["“”']([^"“”']{2,80})["“”']/g;

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
    for (const k of QUERY_KEYS) {
      const v = input[k];
      if (typeof v !== "string") continue;
      for (const m of v.matchAll(QUOTED_RE)) {
        const phrase = m[1]?.trim();
        if (phrase) into.add(normalizeTarget(phrase));
      }
    }
  }
}

/** Exported for tests — the parsing half, with no Supabase or React attached. */
export const __collectTargets = collectTargets;

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
export function useThreadQueriedTargetState(threadId: string, enabled = true) {
  const [targets, setTargets] = useState<Set<string>>(() => new Set());
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const generation = useRef(0);
  const invalidate = useCallback(() => { generation.current++; }, []);
  const load = useCallback(async () => {
    if (!enabled || !threadId) return;
    const token = ++generation.current;
    setStatus("loading");
    try {
      const { data, error } = await supabase.from("tool_usage_log").select("input_json").eq("thread_id", threadId);
      if (token !== generation.current) return;
      if (error || !Array.isArray(data)) throw new Error("Tool history unavailable");
      const set = new Set<string>();
      for (const row of data as { input_json: unknown }[]) collectTargets(row.input_json, set);
      set.delete("");
      setTargets(set);
      setStatus("ready");
    } catch {
      if (token === generation.current) setStatus("error");
    }
  }, [threadId, enabled]);
  useEffect(() => {
    if (!enabled || !threadId) return;
    let active = true;
    const reload = () => { if (active) void load(); };
    setTargets(new Set());
    reload();
    const ch = supabase.channel(`queried-targets-${threadId}-${++channelSeq}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "tool_usage_log", filter: `thread_id=eq.${threadId}` }, reload)
      .subscribe((state: string) => {
        if (!active) return;
        if (state === "SUBSCRIBED") reload();
        else if (state === "CHANNEL_ERROR" || state === "TIMED_OUT" || state === "CLOSED") {
          invalidate();
          setStatus("error");
        }
      });
    const onRun = (event: Event) => {
      const d = (event as CustomEvent<{ threadId?: string; running?: boolean }>).detail;
      if (d?.threadId === threadId && d.running === false) reload();
    };
    const onVisible = () => { if (document.visibilityState === "visible") reload(); };
    window.addEventListener("proximity:run-state", onRun);
    window.addEventListener("online", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      invalidate();
      void supabase.removeChannel(ch);
      window.removeEventListener("proximity:run-state", onRun);
      window.removeEventListener("online", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [threadId, enabled, load, invalidate]);
  return { targets, status, refresh: load };
}

export function useThreadQueriedTargets(threadId: string, enabled = true): Set<string> {
  return useThreadQueriedTargetState(threadId, enabled).targets;
}
