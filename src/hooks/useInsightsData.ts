import { useCallback, useEffect, useRef, useState } from "react";
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

type InsightsLoadState = {
  userId: string | undefined;
  data: InsightsData | null;
  loading: boolean;
  error: string | null;
};

export function useInsightsData(userId: string | undefined, enabled: boolean) {
  const [state, setState] = useState<InsightsLoadState>({
    userId,
    data: null,
    loading: Boolean(enabled && userId),
    error: null,
  });
  const requestGeneration = useRef(0);
  const activeController = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (!userId) return;
    const generation = ++requestGeneration.current;
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;

    setState((previous) => ({
      userId,
      data: previous.userId === userId ? previous.data : null,
      loading: true,
      error: null,
    }));

    try {
      // Aggregates come from the RPC (GROUP BY over every row, RLS-scoped to the
      // caller) so they aren't capped at PostgREST's 1,000-row ceiling the way
      // the old client-side row fetch was. The three headline counts stay as
      // exact `head:true` count queries.
      const [summaryRes, memCountRes, caseCountRes, artifactCountRes] = await Promise.all([
        // Cast: the RPC isn't in the generated Supabase types yet (added in the
        // same change as its migration); it's RLS-scoped to auth.uid().
        (supabase.rpc("get_insights_summary" as never) as unknown as {
          abortSignal: (signal: AbortSignal) => Promise<{
            data: InsightsSummary | null;
            error: { message: string } | null;
          }>;
        }).abortSignal(controller.signal),
        supabase.from("agent_memory").select("id", { count: "exact", head: true }).eq("user_id", userId).abortSignal(controller.signal),
        supabase.from("threads").select("id", { count: "exact", head: true }).eq("user_id", userId).abortSignal(controller.signal),
        supabase.from("artifacts").select("id", { count: "exact", head: true }).eq("user_id", userId).abortSignal(controller.signal),
      ]);

      if (controller.signal.aborted || generation !== requestGeneration.current) return;
      if (summaryRes.error) throw new Error(summaryRes.error.message);
      const summary = summaryRes.data;
      if (!summary) throw new Error("Insights summary was empty.");

      const toolSummaries: ToolUsageSummary[] = (summary.tool_counts ?? []).map((t) => ({
        tool_name: t.tool_name,
        count: t.count,
        ok: t.ok_count,
        failed: Math.max(0, t.count - t.ok_count),
      }));

      setState({
        userId,
        data: {
          summary,
          memoryCount: memCountRes.count ?? 0,
          caseCountExact: caseCountRes.count ?? 0,
          artifactCountExact: artifactCountRes.count ?? 0,
          toolSummaries,
          toolCallsTotal: summary.tool_calls_total ?? 0,
        },
        loading: false,
        error: null,
      });
    } catch (e) {
      if (controller.signal.aborted || generation !== requestGeneration.current) return;
      captureError(e, "insights.load");
      setState({
        userId,
        data: null,
        loading: false,
        error: e instanceof Error ? e.message : "Could not load insights.",
      });
    } finally {
      if (generation === requestGeneration.current && activeController.current === controller) {
        activeController.current = null;
      }
    }
  }, [userId]);

  useEffect(() => {
    requestGeneration.current++;
    activeController.current?.abort();
    activeController.current = null;

    setState((previous) => ({
      userId,
      data: enabled && userId && previous.userId === userId ? previous.data : null,
      loading: Boolean(enabled && userId),
      error: null,
    }));

    if (!enabled || !userId) return;
    void load();
    return () => {
      requestGeneration.current++;
      activeController.current?.abort();
      activeController.current = null;
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

  const stateMatchesUser = state.userId === userId;
  return {
    data: stateMatchesUser ? state.data : null,
    loading: !enabled || !userId ? false : stateMatchesUser ? state.loading : true,
    error: stateMatchesUser ? state.error : null,
    reload: load,
  };
}
