import { useCallback, useEffect, useState } from "react";
import type { UIMessage } from "ai";
import { supabase } from "@/integrations/supabase/client";
import { Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { useThreadArtifacts } from "@/hooks/useThreadArtifacts";
import { detectSeed } from "@/lib/seed";
import { deriveToolTone } from "@/lib/tool-run";
import { timeAgo } from "@/lib/time";

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
  output?: unknown;
  text?: unknown;
  [k: string]: unknown;
}

function detectSeedType(v: string | null | undefined): string {
  if (!v) return "—";
  return detectSeed(v)?.kind ?? "—";
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
        if (deriveToolTone({
          state: p.state,
          errorText: p.errorText == null ? null : String(p.errorText),
          output: p.output,
        }) === "error") toolsFailed++;
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
  const caseCode = `SWB-${new Date().getFullYear()}-${threadId.slice(0, 4).toUpperCase()}`;
  const updatedLabel = thread?.updated_at ? timeAgo(thread.updated_at) : "—";
  const chainScore = integrity && integrity.total > 0
    ? integrity.ok
      ? "100%"
      : `${Math.max(0, Math.round(((Number(integrity.first_break ?? 1) - 1) / Math.max(integrity.total, 1)) * 100))}%`
    : "—";
  const focusLabel =
    status === "failed" ? "intervention required"
      : status === "active" ? "live collection"
      : status === "completed" ? "review ready"
      : "awaiting tasking";
  const title = thread?.title?.trim() || "Untitled investigation";

  return (
    <header className="sticky top-0 z-10 border-b border-border/70 bg-[linear-gradient(180deg,rgba(10,16,28,0.94),rgba(10,16,28,0.78))] px-6 py-3 backdrop-blur-xl">
      <div className="mx-auto flex max-w-5xl flex-col gap-3 text-xs min-w-0">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.22em] text-muted-foreground/70">
              <span>Investigation workspace</span>
              <span className="h-1 w-1 rounded-full bg-primary/60" />
              <span className="font-mono">{caseCode}</span>
              <span className="h-1 w-1 rounded-full bg-white/15" />
              <span>{focusLabel}</span>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <h1 className="min-w-0 truncate text-sm font-semibold tracking-tight text-foreground/95">
                {title}
              </h1>
              <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.16em]", statusColor)}>
                {status}
              </span>
              <span className="shrink-0 rounded-full border border-primary/25 bg-primary/[0.08] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-primary">
                {seedType}
              </span>
            </div>

            <div className="mt-2 flex items-center gap-3 min-w-0">
              <div className="min-w-0 flex-1 font-mono text-[13px] text-foreground/95 truncate" title={seed}>
                {seed || "Awaiting seed input"}
              </div>
              <div className="shrink-0 inline-flex items-center gap-1 font-mono text-[10px] text-muted-foreground/70">
                <Clock className="h-3 w-3" />
                <span title={thread?.updated_at ? new Date(thread.updated_at).toLocaleString() : ""}>
                  {updatedLabel}
                </span>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-1.5 xl:w-auto xl:justify-end">
            <HeaderChip label="Artifacts" value={String(artifactCount)} />
            <HeaderChip label="Tools" value={String(toolsRun)} />
            {breachCount > 0 && <HeaderChip label="Breaches" value={String(breachCount)} tone="bad" />}
            {toolsFailed > 0 && (
              <button onClick={showFailedTools} title="Jump to first failed tool call" className="contents">
                <HeaderChip label="Failures" value={String(toolsFailed)} tone="bad" />
              </button>
            )}
            {integrity && integrity.total > 0 && (
              <HeaderChip
                label="Chain"
                value={chainScore}
                tone={integrity.ok ? "ok" : "bad"}
              />
            )}
          </div>
        </div>

        {/* Status indicator row — minimal, no dead pills */}
        {isStreaming && (
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-primary/80">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
            </span>
            <span>Live collection in progress</span>
          </div>
        )}
      </div>
    </header>
  );
}

function HeaderChip({ label, value, tone }: {
  label: string;
  value: string;
  tone?: "ok" | "bad";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.16em]",
        tone === "ok"
          ? "border-[hsl(var(--confidence-high)/0.35)] bg-[hsl(var(--confidence-high)/0.08)] text-[hsl(var(--confidence-high))]"
          : tone === "bad"
          ? "border-destructive/35 bg-destructive/10 text-destructive/90"
          : "border-border-subtle/70 bg-black/10 text-muted-foreground/85",
      )}
    >
      <span className="text-muted-foreground/70">{label}</span>
      <span className="font-mono text-foreground/95">{value}</span>
    </span>
  );
}

