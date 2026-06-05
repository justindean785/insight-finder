import { useCallback, useEffect, useState } from "react";
import type { UIMessage } from "ai";
import { supabase } from "@/integrations/supabase/client";
import { Database, ShieldAlert, Wrench, AlertTriangle, Clock, Coins, Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import { useThreadArtifacts } from "@/hooks/useThreadArtifacts";
import { detectSeed } from "@/lib/seed";

type Thread = {
  id: string;
  title: string;
  seed_value: string | null;
  seed_type: string | null;
  credits_used: number;
  updated_at: string;
};

/** Subset of an AI SDK message part — only the fields read for tool stats. */
interface MessagePartLike {
  type?: string;
  state?: string;
  errorText?: unknown;
  text?: unknown;
  [k: string]: unknown;
}

function detectSeedType(v: string | null | undefined): string {
  if (!v) return "—";
  return detectSeed(v)?.kind ?? "—";
}

function timeAgo(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function ThreadHeader({
  threadId, messages, isStreaming = false,
}: { threadId: string; messages: UIMessage[]; isStreaming?: boolean }) {
  const [thread, setThread] = useState<Thread | null>(null);
  const { items } = useThreadArtifacts(threadId);
  const artifactCount = items.length;
  const breachCount = items.filter((a) => a.kind.toLowerCase() === "breach").length;
  const [integrity, setIntegrity] = useState<{ ok: boolean; total: number; first_break: number | null } | null>(null);

  const loadIntegrity = useCallback(async () => {
    const [{ count }, { data: v }] = await Promise.all([
      supabase.from("evidence_log").select("id", { count: "exact", head: true }).eq("thread_id", threadId),
      supabase.rpc("verify_evidence_chain", { _thread_id: threadId }),
    ]);
    const row = Array.isArray(v) ? v[0] : v;
    const total = Number(row?.total ?? count ?? 0);
    setIntegrity({ ok: !!row?.ok, total, first_break: row?.first_break ?? null });
  }, [threadId]);

  useEffect(() => {
    const load = async () => {
      const { data: t } = await supabase
        .from("threads")
        .select("id,title,seed_value,seed_type,credits_used,updated_at")
        .eq("id", threadId)
        .maybeSingle();
      setThread(t as Thread | null);
    };
    load();
    void loadIntegrity();
    const ch = supabase
      .channel(`thread-header-${threadId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "threads", filter: `id=eq.${threadId}` }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "evidence_log", filter: `thread_id=eq.${threadId}` }, () => { void loadIntegrity(); })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [threadId, loadIntegrity]);

  // Tool-call stats from in-memory messages
  let toolsRun = 0;
  let toolsFailed = 0;
  let isFailed = false;
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const p of m.parts as MessagePartLike[]) {
      if (typeof p?.type === "string" && p.type.startsWith("tool-")) {
        toolsRun++;
        if (p.state === "output-error" || p.errorText) toolsFailed++;
      }
      if (p?.type === "text" && typeof p.text === "string" && p.text.startsWith("__STATUS__:failed:")) {
        isFailed = true;
      }
    }
  }

  const seed = thread?.seed_value ?? "";
  const seedType = thread?.seed_type ?? detectSeedType(seed);
  const status: "failed" | "active" | "completed" | "idle" = isFailed
    ? "failed"
    : isStreaming
    ? "active"
    : toolsRun > 0 || artifactCount > 0
    ? "completed"
    : "idle";
  const statusColor =
    status === "failed" ? "text-destructive border-destructive/40 bg-destructive/10"
      : status === "active" ? "text-primary border-primary/40 bg-primary/10 animate-pulse-ring"
      : status === "completed" ? "text-[hsl(var(--confidence-high))] border-[hsl(var(--confidence-high)/0.4)] bg-[hsl(var(--confidence-high)/0.1)] shadow-[0_0_14px_-2px_hsl(var(--confidence-high)/0.6)]"
      : "text-muted-foreground border-border bg-secondary/40";

  const showFailedTools = () => {
    if (toolsFailed <= 0) return;
    window.dispatchEvent(new CustomEvent("proximity:show-failed-tools", { detail: { threadId } }));
  };

  return (
    <header className="border-b border-border glass px-6 py-3 sticky top-0 z-10">
      <div className="max-w-3xl mx-auto flex flex-wrap items-center gap-x-4 gap-y-2 text-xs min-w-0">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="px-1.5 py-0.5 rounded border border-primary/30 bg-primary/5 text-primary uppercase tracking-wider text-[10px] font-mono">{seedType}</span>
          <span className="font-mono text-foreground truncate min-w-0" title={seed}>{seed || "no seed yet"}</span>
        </div>
        <span className={`px-2 py-0.5 rounded-full border font-mono uppercase tracking-wider ${statusColor}`}>{status}</span>
        <div className="flex items-center gap-1 text-muted-foreground"><Database className="w-3.5 h-3.5" /> <span className="text-foreground">{artifactCount}</span> artifacts</div>
        <div className="flex items-center gap-1 text-muted-foreground"><Wrench className="w-3.5 h-3.5" /> <span className="text-foreground">{toolsRun}</span> tools</div>
        <div className="flex items-center gap-1 text-muted-foreground"><ShieldAlert className="w-3.5 h-3.5" /> <span className="text-foreground">{breachCount}</span> breaches</div>
        {integrity && integrity.total > 0 && (
          <div
            className={cn(
              "flex items-center gap-1 px-1.5 py-0.5 rounded border font-mono",
              integrity.ok
                ? "text-[hsl(var(--confidence-high))] border-[hsl(var(--confidence-high))]/40 bg-[hsl(var(--confidence-high))]/10"
                : "text-destructive border-destructive/40 bg-destructive/10",
            )}
            title={integrity.ok ? `${integrity.total} evidence rows · chain valid` : `Chain break at seq ${integrity.first_break}`}
          >
            <Lock className="w-3 h-3" />
            <span className="text-foreground">{integrity.ok ? "100" : Math.max(0, Math.round(((Number(integrity.first_break ?? 1) - 1) / Math.max(integrity.total, 1)) * 100))}%</span>
            <span className="text-[10px] uppercase tracking-wider opacity-80">integrity</span>
          </div>
        )}
        <button
          type="button"
          onClick={showFailedTools}
          disabled={toolsFailed <= 0}
          title={toolsFailed > 0 ? "Jump to first failed tool call" : "No failed calls"}
          className={cn(
            "flex items-center gap-1 text-muted-foreground rounded px-1 -mx-1",
            toolsFailed > 0 && "hover:bg-destructive/10 hover:text-destructive cursor-pointer",
          )}
        >
          <AlertTriangle className="w-3.5 h-3.5" /> <span className="text-foreground">{toolsFailed}</span> failed
        </button>
        {(thread?.credits_used ?? toolsRun) > 0 && (
          <div className="flex items-center gap-1 text-muted-foreground"><Coins className="w-3.5 h-3.5" /> <span className="text-foreground">{thread?.credits_used ?? toolsRun}</span> cr</div>
        )}
        <div className="flex items-center gap-1 text-muted-foreground ml-auto">
          <Clock className="w-3.5 h-3.5" />
          <span
            title={thread?.updated_at ? new Date(thread.updated_at).toLocaleString() : ""}
          >
            {thread?.updated_at ? timeAgo(thread.updated_at) : "—"}
          </span>
        </div>
      </div>
    </header>
  );
}