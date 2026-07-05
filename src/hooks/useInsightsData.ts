import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { captureError } from "@/lib/telemetry";

export type InsightsArtifactRow = {
  id: string;
  kind: string;
  source: string | null;
  confidence: number | null;
  created_at: string;
  thread_id: string;
};

export type InsightsThreadRow = {
  id: string;
  title: string | null;
  updated_at: string;
  created_at: string;
};

export type ToolUsageSummary = {
  tool_name: string;
  count: number;
  ok: number;
  failed: number;
  /** Rolling ok rate 0–100 from tool_usage_log.ok. */
  okPct: number;
};

export type InsightsData = {
  threads: InsightsThreadRow[];
  artifacts: InsightsArtifactRow[];
  memoryCount: number;
  caseCountExact: number;
  artifactCountExact: number;
  toolSummaries: ToolUsageSummary[];
  toolCallsTotal: number;
};

const ARTIFACT_CAP = 5000;
const THREAD_CAP = 500;

export function useInsightsData(userId: string | undefined, enabled: boolean) {
  const [data, setData] = useState<InsightsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    try {
      const [
        threadsRes,
        artifactsRes,
        memCountRes,
        caseCountRes,
        artifactCountRes,
        toolLogRes,
      ] = await Promise.all([
        supabase
          .from("threads")
          .select("id,title,updated_at,created_at")
          .eq("user_id", userId)
          .order("updated_at", { ascending: false })
          .limit(THREAD_CAP),
        supabase
          .from("artifacts")
          .select("id,kind,source,confidence,created_at,thread_id")
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
          .limit(ARTIFACT_CAP),
        supabase
          .from("agent_memory")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId),
        supabase
          .from("threads")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId),
        supabase
          .from("artifacts")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId),
        supabase
          .from("tool_usage_log")
          .select("tool_name,ok")
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
          .limit(3000),
      ]);

      if (threadsRes.error) throw threadsRes.error;
      if (artifactsRes.error) throw artifactsRes.error;
      if (toolLogRes.error) throw toolLogRes.error;

      const toolMap = new Map<string, ToolUsageSummary>();
      for (const row of toolLogRes.data ?? []) {
        const name = row.tool_name as string;
        const prev = toolMap.get(name) ?? { tool_name: name, count: 0, ok: 0, failed: 0, okPct: 0 };
        prev.count++;
        const ok = row.ok as boolean;
        if (ok) prev.ok++;
        else prev.failed++;
        toolMap.set(name, prev);
      }
      const toolSummaries = [...toolMap.values()]
        .map((t) => ({
          ...t,
          okPct: t.count ? Math.round((t.ok / t.count) * 100) : 0,
        }))
        .sort((a, b) => b.count - a.count);

      setData({
        threads: (threadsRes.data ?? []) as InsightsThreadRow[],
        artifacts: (artifactsRes.data ?? []) as InsightsArtifactRow[],
        memoryCount: memCountRes.count ?? 0,
        caseCountExact: caseCountRes.count ?? 0,
        artifactCountExact: artifactCountRes.count ?? 0,
        toolSummaries,
        toolCallsTotal: toolSummaries.reduce((n, t) => n + t.count, 0),
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
    const channel = supabase
      .channel(`insights-${userId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "artifacts", filter: `user_id=eq.${userId}` },
        () => void load(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "threads", filter: `user_id=eq.${userId}` },
        () => void load(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "agent_memory", filter: `user_id=eq.${userId}` },
        () => void load(),
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "tool_usage_log", filter: `user_id=eq.${userId}` },
        () => void load(),
      )
      .subscribe();
    return () => {
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
