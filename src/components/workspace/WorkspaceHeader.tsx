import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useThreadArtifacts } from "@/hooks/useThreadArtifacts";
import { useThreadToolActivity } from "@/hooks/useThreadToolActivity";
import { ShieldAlert, Lock, Coins, Plus, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { extractDisplaySeed } from "@/lib/seed";

type Thread = {
  id: string;
  seed_value: string | null;
  seed_type: string | null;
  status: "active" | "finished" | "stopped" | null;
  credits_used: number;
  cost_micro_usd: number | null;
};

function fmtUsd(micro: number | null | undefined): string {
  const usd = Number(micro ?? 0) / 1_000_000;
  if (usd <= 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * Persistent investigation header — the case IDENTITY bar. It carries the seed,
 * run status, chain-of-custody integrity, and spend. The per-section counts
 * (artifacts, tool calls) and their alerts live on the workspace tabs instead,
 * so every number appears in exactly one place.
 */
export function WorkspaceHeader({ threadId }: { threadId: string }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { items } = useThreadArtifacts(threadId);
  const activity = useThreadToolActivity(threadId);
  const [thread, setThread] = useState<Thread | null>(null);
  const [creating, setCreating] = useState(false);
  const [integrity, setIntegrity] = useState<{ ok: boolean; total: number; first_break: number | null } | null>(null);

  const artifactCount = items.length;

  const loadIntegrity = useCallback(async () => {
    const [{ count }, { data: v }] = await Promise.all([
      supabase.from("evidence_log").select("id", { count: "exact", head: true }).eq("thread_id", threadId),
      supabase.rpc("verify_evidence_chain", { _thread_id: threadId }),
    ]);
    const row = Array.isArray(v) ? v[0] : v;
    setIntegrity({ ok: !!row?.ok, total: Number(row?.total ?? count ?? 0), first_break: row?.first_break ?? null });
  }, [threadId]);

  useEffect(() => {
    const load = async () => {
      const { data } = await supabase
        .from("threads")
        .select("id,seed_value,seed_type,status,credits_used,cost_micro_usd")
        .eq("id", threadId)
        .maybeSingle();
      setThread(data as Thread | null);
    };
    load();
    void loadIntegrity();
    const ch = supabase
      .channel(`workspace-header-${threadId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "threads", filter: `id=eq.${threadId}` }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "evidence_log", filter: `thread_id=eq.${threadId}` }, () => void loadIntegrity())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [threadId, loadIntegrity]);

  // A case only reads "active" while work is actually happening. Older code kept
  // any case with >=1 artifact/tool call pinned to "active" forever whenever its
  // thread.status was never advanced to finished/stopped (the known stuck-active
  // bug). Instead we treat a case as "completed" once it has produced evidence
  // but has had no tool activity within a short recency window — reloading a done
  // investigation now settles to "completed" rather than a permanent pulse.
  const ACTIVE_WINDOW_MS = 12_000;
  const [now, setNow] = useState(() => Date.now());
  const lastActivityMs = useMemo(() => {
    let max = 0;
    for (const e of activity.events) {
      const t = Date.parse(e.at);
      if (Number.isFinite(t) && t > max) max = t;
    }
    return max;
  }, [activity.events]);
  const recentlyActive = lastActivityMs > 0 && now - lastActivityMs < ACTIVE_WINDOW_MS;
  // Only tick while a run is plausibly live, so the pulse can settle to
  // "completed" once activity goes quiet; idle/old cases never spin a timer.
  useEffect(() => {
    if (!recentlyActive) return;
    const id = setInterval(() => setNow(Date.now()), 3000);
    return () => clearInterval(id);
  }, [recentlyActive]);

  // The DB thread status is the source of truth for whether a run is live:
  // `active` MUST win over the recency/artifact heuristic, otherwise a normal
  // >12s model-thinking gap during a live run collapses the pill to COMPLETED
  // (the "green COMPLETED while still running" bug). A `failed*` status
  // (e.g. failed_context_limit) reads as its own error state, never green.
  const rawStatus = thread?.status ?? null;
  const status: "idle" | "active" | "completed" | "failed" =
    rawStatus === "active" ? "active"
    : typeof rawStatus === "string" && rawStatus.startsWith("failed") ? "failed"
    : rawStatus === "finished" || rawStatus === "stopped" || rawStatus === "completed" ? "completed"
    : recentlyActive ? "active"
    : artifactCount > 0 || activity.total > 0 ? "completed"
    : "idle";
  const statusColor =
    status === "failed" ? "text-destructive border-destructive/40 bg-destructive/10"
    : status === "completed" ? "text-[hsl(var(--confidence-high))] border-[hsl(var(--confidence-high)/0.4)] bg-[hsl(var(--confidence-high)/0.1)]"
    : status === "active" ? "text-primary border-primary/40 bg-primary/10"
    : "text-muted-foreground border-border bg-secondary/40";
  const dotColor =
    status === "failed" ? "bg-destructive shadow-[0_0_8px_hsl(var(--destructive)/0.6)]"
    : status === "completed" ? "bg-[hsl(var(--confidence-high))] shadow-[0_0_8px_hsl(var(--confidence-high)/0.7)]"
    : status === "active" ? "bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.5)] animate-pulse"
    : "bg-muted-foreground";

  const integrityPct = integrity && integrity.total > 0
    ? (integrity.ok ? 100 : Math.max(0, Math.round(((Number(integrity.first_break ?? 1) - 1) / Math.max(integrity.total, 1)) * 100)))
    : null;

  const createInvestigation = async () => {
    if (!user || creating) return;
    setCreating(true);
    const { data, error } = await supabase.from("threads").insert({ user_id: user.id }).select("id").single();
    setCreating(false);
    if (error || !data) { toast.error(error?.message ?? "Could not create investigation"); return; }
    navigate(`/chat/${data.id}`);
  };

  const copySeed = () => {
    if (!thread?.seed_value) return;
    navigator.clipboard.writeText(thread.seed_value).then(
      () => toast.success("Copied"), () => toast.error("Copy failed"),
    );
  };

  return (
    <header className="relative border-b border-white/[0.06] bg-[linear-gradient(180deg,hsl(220_24%_7%/0.72),hsl(222_22%_4.5%/0.62))] backdrop-blur-xl">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[hsl(var(--intel-blue)/0.45)] to-transparent" />
      <div className="h-14 px-4 sm:px-5 flex items-center gap-3 min-w-0">
        <span
          className={cn("h-2 w-2 shrink-0 rounded-full", dotColor)}
          aria-hidden
        />
        <button onClick={copySeed} className="group flex items-center gap-1.5 min-w-0 shrink text-left" title={thread?.seed_value ?? ""}>
          <span className="font-mono text-meta text-foreground truncate max-w-[58vw] sm:max-w-[42vw]">{thread ? extractDisplaySeed(thread.seed_value, thread.seed_type).title : "—"}</span>
          {thread?.seed_value && <Copy className="w-3 h-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />}
        </button>
        {status !== "idle" && (
          <span className={cn("shrink-0 rounded-full border px-2.5 py-1 text-eyebrow font-mono uppercase tracking-[0.16em]", statusColor)}>
            {status}
          </span>
        )}

        <div className="ml-auto flex items-center gap-3 sm:gap-4 text-data shrink-0">
          {integrityPct != null && (
            <div
              title={integrity?.ok ? `${integrity.total} evidence rows · chain valid` : `Chain break at seq ${integrity?.first_break}`}
              aria-label={integrity?.ok
                ? `Chain of custody valid — ${integrityPct}%`
                : `Chain of custody broken at sequence ${integrity?.first_break} — ${integrityPct}%`}
              className={cn(
                "flex items-center gap-1 rounded-full border px-2 py-1 font-mono tabular-nums",
                integrity?.ok
                  ? "text-[hsl(var(--confidence-high))] border-[hsl(var(--confidence-high))]/40 bg-[hsl(var(--confidence-high))]/10"
                  : "text-destructive border-destructive/40 bg-destructive/10",
              )}
            >
              {/* Glyph carries the state too, so it isn't color-only. */}
              {integrity?.ok ? <Lock className="w-3 h-3" /> : <ShieldAlert className="w-3 h-3" />}
              {integrityPct}%
            </div>
          )}
          {(thread?.cost_micro_usd ?? 0) > 0 && (
            <div className="hidden md:flex items-center gap-1 text-muted-foreground" title="Spend on this case">
              <Coins className="w-3.5 h-3.5" />
              <span className="font-mono text-foreground tabular-nums">{fmtUsd(thread?.cost_micro_usd)}</span>
            </div>
          )}
          <button
            onClick={createInvestigation}
            disabled={creating}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-white/10 bg-white px-2.5 text-micro font-semibold tracking-normal text-black transition-colors hover:bg-white/90 disabled:opacity-50"
            title="Start a new investigation"
            aria-label="Start a new investigation"
          >
            <Plus className="h-3.5 w-3.5" />
            <span className="hidden lg:inline">{creating ? "Creating" : "New"}</span>
          </button>
        </div>
      </div>
    </header>
  );
}
