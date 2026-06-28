import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * Tool health for a thread, read from the AUTHORITATIVE `tool_usage_log.outcome`
 * column (added in #143). This is the durable record of what every tool call
 * actually did — distinct from the chat-derived Activity feed — so analysts can
 * see at a glance which providers failed (e.g. a bad API key, a rejected format)
 * instead of those failures being buried in chat text.
 *
 * `outcome` buckets: 'ok' | 'failed' | 'skipped' | 'empty'. Skipped = governance
 * (budget/burst caps, gating, missing key); empty = ran fine, no record found;
 * failed = a real provider error worth an analyst's attention.
 */
export type ToolOutcome = "ok" | "failed" | "skipped" | "empty";

export interface ToolHealthRow {
  toolName: string;
  ok: number;
  failed: number;
  skipped: number;
  empty: number;
  total: number;
  /** Most recent non-empty error message for a failed call, surfaced inline. */
  lastError: string | null;
  lastStatusCode: number | null;
}

export interface ThreadToolHealth {
  rows: ToolHealthRow[];
  totals: { ok: number; failed: number; skipped: number; empty: number; total: number };
  /** Tools with at least one hard failure, worst-first. */
  failing: ToolHealthRow[];
  loading: boolean;
  error: string | null;
}

interface RawRow {
  tool_name: string | null;
  outcome: string | null;
  ok: boolean | null;
  error_msg: string | null;
  status_code: number | null;
  created_at: string | null;
}

/** Fall back to the ok flag for any pre-#143 rows that never got an outcome. */
function normalizeOutcome(r: RawRow): ToolOutcome {
  const o = (r.outcome ?? "").toLowerCase();
  if (o === "ok" || o === "failed" || o === "skipped" || o === "empty") return o;
  return r.ok ? "ok" : "failed";
}

export function aggregateToolHealth(raw: RawRow[]): Omit<ThreadToolHealth, "loading" | "error"> {
  const byTool = new Map<string, ToolHealthRow>();
  const totals = { ok: 0, failed: 0, skipped: 0, empty: 0, total: 0 };

  // created_at ascending so the last failed row we see is the most recent.
  const sorted = [...raw].sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));

  for (const r of sorted) {
    const name = r.tool_name?.trim() || "unknown";
    const outcome = normalizeOutcome(r);
    let row = byTool.get(name);
    if (!row) {
      row = { toolName: name, ok: 0, failed: 0, skipped: 0, empty: 0, total: 0, lastError: null, lastStatusCode: null };
      byTool.set(name, row);
    }
    row[outcome] += 1;
    row.total += 1;
    totals[outcome] += 1;
    totals.total += 1;
    if (outcome === "failed") {
      const msg = r.error_msg?.trim();
      if (msg) row.lastError = msg;
      if (r.status_code != null) row.lastStatusCode = r.status_code;
    }
  }

  const rows = [...byTool.values()].sort(
    (a, b) => b.failed - a.failed || b.total - a.total || a.toolName.localeCompare(b.toolName),
  );
  const failing = rows.filter((r) => r.failed > 0);
  return { rows, totals, failing };
}

export function useThreadToolHealth(threadId: string): ThreadToolHealth {
  const [state, setState] = useState<ThreadToolHealth>({
    rows: [], totals: { ok: 0, failed: 0, skipped: 0, empty: 0, total: 0 },
    failing: [], loading: true, error: null,
  });

  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    const load = async () => {
      const { data, error } = await supabase
        .from("tool_usage_log")
        .select("tool_name,outcome,ok,error_msg,status_code,created_at")
        .eq("thread_id", threadId)
        .order("created_at", { ascending: true });
      if (!alive) return;
      if (error) {
        setState((s) => ({ ...s, loading: false, error: error.message }));
        return;
      }
      // Supabase generated types lag the live schema (the `outcome` column was
      // added by migration but types.ts isn't regenerated yet), so the typed
      // select widens to SelectQueryError. Runtime data is correct — cast via
      // unknown until types.ts is regenerated.
      setState({ ...aggregateToolHealth((data ?? []) as unknown as RawRow[]), loading: false, error: null });
    };
    load();
    const ch = supabase
      .channel(`tool-health-${threadId}`)
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "tool_usage_log", filter: `thread_id=eq.${threadId}` },
        load)
      .subscribe();
    return () => { alive = false; void supabase.removeChannel(ch); };
  }, [threadId]);

  return state;
}
