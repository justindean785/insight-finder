import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { captureError } from "@/lib/telemetry";
import type { InsightsSummary } from "@/pages/InsightsDerived";

export type ToolUsageSummary = {
  tool_name: string;
  count: number;
  ok: number;
  failed: number;
};

export type InsightsData = {
  /** Server-aggregated over ALL rows (see get_insights_summary RPC). */
  summary: InsightsSummary;
  memoryCount: number;
  caseCountExact: number;
  artifactCountExact: number;
  toolSummaries: ToolUsageSummary[];
  toolCallsTotal: number;
};

export function useInsightsData(userId: string | undefined, enabled: boolean) {
  const [data, setData] = useState<InsightsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    try {
      // Aggregates come from the RPC (GROUP BY over every row, RLS-scoped to the
      // caller) so they aren't capped at PostgREST's 1,000-row ceiling the way
      // the old client-side row fetch was. The three headline counts stay as
      // exact `head:true` count queries.
      const [summaryRes, memCountRes, caseCountRes, artifactCountRes] = await Promise.all([
        // Cast: the RPC isn't in the generated Supabase types yet (added in the
        // same change as its migration); it's RLS-scoped to auth.uid().
        supabase.rpc("get_insights_summary" as never) as unknown as Promise<{
          data: InsightsSummary | null;
          error: { message: string } | null;
        }>,
        supabase.from("agent_memory").select("id", { count: "exact", head: true }).eq("user_id", userId),
        supabase.from("threads").select("id", { count: "exact", head: true }).eq("user_id", userId),
        supabase.from("artifacts").select("id", { count: "exact", head: true }).eq("user_id", userId),
      ]);

      if (summaryRes.error) throw new Error(summaryRes.error.message);
      const summary = summaryRes.data;
      if (!summary) throw new Error("Insights summary was empty.");

      const toolSummaries: ToolUsageSummary[] = (summary.tool_counts ?? []).map((t) => ({
        tool_name: t.tool_name,
        count: t.count,
        ok: t.ok_count,
        failed: Math.max(0, t.count - t.ok_count),
      }));

      setData({
        summary,
        memoryCount: memCountRes.count ?? 0,
        caseCountExact: caseCountRes.count ?? 0,
        artifactCountExact: artifactCountRes.count ?? 0,
        toolSummaries,
        toolCallsTotal: summary.tool_calls_total ?? 0,
      });
    } catch (e) {
      captureError(e, "insights.load");
      setError(e instanceof Error ? e.message : "Could not load insights.");
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (!enabled || !userId) return;
    let alive = true;
    void load().then(() => {
      if (!alive) return;
    });
    return () => {
      alive = false;
    };
  }, [enabled, userId, load]);

  useEffect(() => {
    if (!enabled || !userId) return;
    // Coalesce realtime bursts: an active scan can insert dozens of artifact /
    // tool-usage rows per second, and each one would otherwise fire a full
    // reload. Debounce to one reload per quiet 600ms window so the Insights view
    // stays live without hammering the DB.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleLoad = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; void load(); }, 600);
    };
    const channel = supabase
      .channel(`insights-${userId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "artifacts", filter: `user_id=eq.${userId}` },
        scheduleLoad,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "threads", filter: `user_id=eq.${userId}` },
        scheduleLoad,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "agent_memory", filter: `user_id=eq.${userId}` },
        scheduleLoad,
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "tool_usage_log", filter: `user_id=eq.${userId}` },
        scheduleLoad,
      )
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [enabled, userId, load]);

  useEffect(() => {
    if (!enabled) return;
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [enabled, load]);

  return { data, loading, error, reload: load };
}
