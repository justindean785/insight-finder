import { useCallback, useEffect, useState } from "react";
import type { UIMessage } from "ai";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Database, ShieldAlert, Wrench, AlertTriangle, Clock, Coins, Lock, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { useThreadArtifacts } from "@/hooks/useThreadArtifacts";
import { deriveToolTone } from "@/lib/tool-run";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";

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
  const navigate = useNavigate();
  const { user } = useAuth();
  const [thread, setThread] = useState<Thread | null>(null);
  const [creating, setCreating] = useState(false);
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
        if (deriveToolTone(p) === "error") toolsFailed++;
      }
      if (p?.type === "text" && typeof p.text === "string" && p.text.startsWith("__STATUS__:failed:")) {
        isFailed = true;
      }
    }
  }

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

  const createInvestigation = async () => {
    if (!user || creating) return;
    setCreating(true);
    const { data, error } = await supabase
      .from("threads")
      .insert({ user_id: user.id })
      .select("id")
      .single();
    setCreating(false);
    if (error || !data) {
      toast.error(error?.message ?? "Could not create investigation");
      return;
    }
    navigate(`/chat/${data.id}`);
  };

  return (
    <header className="sticky top-0 z-10 border-b border-border-subtle bg-background/95 backdrop-blur">
      <div className="h-10 px-4 sm:px-5 flex items-center gap-x-3 text-data min-w-0">
        <span className={`shrink-0 rounded-full border px-2 py-0.5 font-mono uppercase tracking-[0.1em] ${statusColor}`}>
          {status}
        </span>
        <div className="flex items-center gap-1 text-muted-foreground shrink-0">
          <Database className="w-3 h-3" />
          <span className="text-foreground tabular-nums">{artifactCount}</span>
          <span className="hidden sm:inline">artifacts</span>
        </div>
        <div className="flex items-center gap-1 text-muted-foreground shrink-0">
          <Wrench className="w-3 h-3" />
          <span className="text-foreground tabular-nums">{toolsRun}</span>
          <span className="hidden sm:inline">tools</span>
        </div>
        {breachCount > 0 && (
          <div className="flex items-center gap-1 text-[hsl(var(--danger))] shrink-0" title={`${breachCount} breach artifacts`}>
            <ShieldAlert className="w-3 h-3" />
            <span className="tabular-nums">{breachCount}</span>
            <span className="hidden sm:inline">breaches</span>
          </div>
        )}
        {toolsFailed > 0 && (
          <button
            type="button"
            onClick={showFailedTools}
            title="Jump to first failed tool call"
            className="flex items-center gap-1 text-muted-foreground rounded px-1 shrink-0 hover:bg-destructive/10 hover:text-destructive cursor-pointer"
          >
            <AlertTriangle className="w-3 h-3" />
            <span className="tabular-nums">{toolsFailed}</span>
            <span className="hidden sm:inline">failed</span>
          </button>
        )}
        {integrity && integrity.total > 0 && (
          <div
            className={cn(
              "flex items-center gap-1 rounded-full border px-1.5 py-0.5 font-mono shrink-0",
              integrity.ok
                ? "text-[hsl(var(--confidence-high))] border-[hsl(var(--confidence-high))]/40 bg-[hsl(var(--confidence-high))]/10"
                : "text-destructive border-destructive/40 bg-destructive/10",
            )}
            title={integrity.ok ? `${integrity.total} evidence rows · chain valid` : `Chain break at seq ${integrity.first_break}`}
          >
            <Lock className="w-3 h-3" />
            <span className="tabular-nums">{integrity.ok ? "100%" : Math.max(0, Math.round(((Number(integrity.first_break ?? 1) - 1) / Math.max(integrity.total, 1)) * 100)) + "%"}</span>
          </div>
        )}
        {(thread?.credits_used ?? 0) > 0 && (
          <div className="hidden md:flex items-center gap-1 text-muted-foreground shrink-0">
            <Coins className="w-3 h-3" />
            <span className="text-foreground tabular-nums">{thread?.credits_used}</span>
            <span>cr</span>
          </div>
        )}
        <div className="ml-auto flex items-center gap-3 shrink-0">
          <div className="hidden sm:flex items-center gap-1 text-muted-foreground">
            <Clock className="w-3 h-3" />
            <span title={thread?.updated_at ? new Date(thread.updated_at).toLocaleString() : "No activity yet"}>
              {thread?.updated_at ? timeAgo(thread.updated_at) : "—"}
            </span>
          </div>
          <button
            type="button"
            onClick={createInvestigation}
            disabled={creating}
            className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-white/10 bg-white px-2.5 text-eyebrow font-semibold uppercase tracking-[0.1em] text-black transition-colors hover:bg-white/90 disabled:opacity-50"
            aria-label="Start a new investigation"
            title="Start a new investigation"
          >
            <Plus className="h-3.5 w-3.5" />
            <span className="hidden lg:inline">{creating ? "Creating" : "New"}</span>
          </button>
        </div>
      </div>
    </header>
  );
}
