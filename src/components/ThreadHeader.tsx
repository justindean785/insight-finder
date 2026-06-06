import { useCallback, useEffect, useState } from "react";
import type { UIMessage } from "ai";
import { supabase } from "@/integrations/supabase/client";
import { Clock } from "lucide-react";
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
    status === "failed" ? "text-destructive/90 border-destructive/35 bg-destructive/10"
      : status === "active" ? "text-primary border-primary/35 bg-primary/10"
      : status === "completed" ? "text-[hsl(var(--confidence-high))] border-[hsl(var(--confidence-high)/0.3)] bg-[hsl(var(--confidence-high)/0.08)]"
      : "text-muted-foreground border-border bg-secondary/40";

  const showFailedTools = () => {
    if (toolsFailed <= 0) return;
    window.dispatchEvent(new CustomEvent("proximity:show-failed-tools", { detail: { threadId } }));
  };

  const credits = thread?.credits_used ?? toolsRun;

  return (
    <header className="border-b border-border/70 glass px-6 py-2.5 sticky top-0 z-10">
      <div className="max-w-3xl mx-auto flex items-center gap-3 text-xs min-w-0">
        {/* Case identity */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="shrink-0 px-1.5 py-0.5 rounded-sm border border-primary/30 bg-primary/[0.07] text-primary uppercase tracking-[0.16em] text-[9px] font-semibold">{seedType}</span>
          <span className="font-mono text-[13px] text-foreground/95 truncate min-w-0" title={seed}>{seed || "no seed yet"}</span>
          <span className={cn("shrink-0 px-2 py-0.5 rounded-sm border uppercase tracking-[0.14em] text-[9px] font-semibold", statusColor)}>{status}</span>
        </div>

        {/* Instrument readout — hairline-divided glass strip */}
        <div className="shrink-0 flex items-stretch rounded-md border border-border-subtle bg-surface-0/40 divide-x divide-border-subtle overflow-hidden backdrop-blur-md">
          <Stat label="ART" value={artifactCount} />
          <Stat label="TOOLS" value={toolsRun} />
          <Stat label="BREACH" value={breachCount} tone={breachCount > 0 ? "warn" : undefined} />
          <Stat label="FAIL" value={toolsFailed} tone={toolsFailed > 0 ? "bad" : undefined} onClick={toolsFailed > 0 ? showFailedTools : undefined} title={toolsFailed > 0 ? "Jump to first failed tool call" : undefined} />
          {credits > 0 && <Stat label="CR" value={credits} />}
          {integrity && integrity.total > 0 && (
            <Stat
              label="CHAIN"
              value={integrity.ok ? "100%" : `${Math.max(0, Math.round(((Number(integrity.first_break ?? 1) - 1) / Math.max(integrity.total, 1)) * 100))}%`}
              tone={integrity.ok ? "ok" : "bad"}
              title={integrity.ok ? `${integrity.total} evidence rows · chain valid` : `Chain break at seq ${integrity.first_break}`}
            />
          )}
        </div>

        {/* Timestamp */}
        <div className="shrink-0 flex items-center gap-1 text-muted-foreground/80 font-mono text-[10px]">
          <Clock className="w-3 h-3" />
          <span title={thread?.updated_at ? new Date(thread.updated_at).toLocaleString() : ""}>
            {thread?.updated_at ? timeAgo(thread.updated_at) : "—"}
          </span>
        </div>
      </div>
    </header>
  );
}

/** Instrument-readout cell: value over a tiny uppercase label, hairline-divided. */
function Stat({ label, value, tone, onClick, title }: {
  label: string;
  value: string | number;
  tone?: "ok" | "warn" | "bad";
  onClick?: () => void;
  title?: string;
}) {
  const color =
    tone === "ok" ? "text-[hsl(var(--confidence-high))]"
      : tone === "warn" ? "text-[hsl(var(--confidence-mid))]"
      : tone === "bad" ? "text-destructive/90"
      : "text-foreground/95";
  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      onClick={onClick}
      title={title}
      className={cn(
        "px-2.5 py-1 flex flex-col items-center justify-center min-w-[46px] leading-none",
        onClick && "hover:bg-white/[0.04] cursor-pointer transition-colors",
      )}
    >
      <span className={cn("font-mono tabular-nums text-[13px] font-semibold", color)}>{value}</span>
      <span className="uppercase text-[8px] tracking-[0.14em] text-muted-foreground/60 mt-1">{label}</span>
    </Comp>
  );
}