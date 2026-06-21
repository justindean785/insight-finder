import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useThreadArtifacts } from "@/hooks/useThreadArtifacts";
import { useThreadToolActivity } from "@/hooks/useThreadToolActivity";
import { Database, Wrench, ShieldAlert, AlertTriangle, Lock, Coins, Plus, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

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
 * Persistent investigation header that sits above the workspace tabs — case
 * seed, run status, and the headline metrics (artifacts, tools, breaches,
 * failures, chain integrity, spend). DB-backed so it reads the same numbers no
 * matter which workspace mode is active. Clicking the failure chip jumps to the
 * Tools tab.
 */
export function WorkspaceHeader({ threadId, onShowTools }: { threadId: string; onShowTools?: () => void }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { items } = useThreadArtifacts(threadId);
  const activity = useThreadToolActivity(threadId);
  const [thread, setThread] = useState<Thread | null>(null);
  const [creating, setCreating] = useState(false);
  const [integrity, setIntegrity] = useState<{ ok: boolean; total: number; first_break: number | null } | null>(null);

  const artifactCount = items.length;
  const breachCount = items.filter((a) => a.kind.toLowerCase() === "breach").length;

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

  const status: "idle" | "active" | "completed" =
    thread?.status === "finished" || thread?.status === "stopped" ? "completed"
    : artifactCount > 0 || activity.total > 0 ? "active"
    : "idle";
  const statusColor =
    status === "completed" ? "text-[hsl(var(--confidence-high))] border-[hsl(var(--confidence-high)/0.4)] bg-[hsl(var(--confidence-high)/0.1)]"
    : status === "active" ? "text-primary border-primary/40 bg-primary/10"
    : "text-muted-foreground border-border bg-secondary/40";

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
    <header className="border-b border-border-subtle bg-background">
      <div className="h-14 px-4 sm:px-5 flex items-center gap-3 min-w-0">
        <span className="text-eyebrow font-semibold uppercase tracking-[0.2em] text-muted-foreground shrink-0 hidden sm:inline">Case</span>
        <button onClick={copySeed} className="group flex items-center gap-1.5 min-w-0 shrink text-left" title={thread?.seed_value ?? ""}>
          <span className="font-mono text-meta text-foreground truncate max-w-[58vw] sm:max-w-[40vw]">{thread?.seed_value || "—"}</span>
          {thread?.seed_value && <Copy className="w-3 h-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />}
        </button>
        <span className={cn("shrink-0 rounded-full border px-2.5 py-1 text-eyebrow font-mono uppercase tracking-[0.16em]", statusColor)}>
          {status}
        </span>

        <div className="ml-auto flex items-center gap-3 sm:gap-4 text-data shrink-0">
          <Metric icon={Database} value={artifactCount} label="artifacts" title={`${artifactCount} artifacts`} />
          <Metric icon={Wrench} value={activity.total} label="tools" title={`${activity.total} tool calls`} />
          <Metric icon={ShieldAlert} value={breachCount} label="breaches" title={`${breachCount} breaches`} tone={breachCount > 0 ? "danger" : undefined} />
          {activity.failed > 0 && (
            <button
              onClick={onShowTools}
              title="Review failed tool calls"
              aria-label={`Review ${activity.failed} failed tool calls`}
              className="flex items-center gap-1 rounded px-1 text-destructive hover:bg-destructive/10 transition-colors"
            >
              <AlertTriangle className="w-3.5 h-3.5" />
              <span className="tabular-nums">{activity.failed}</span>
              <span className="hidden lg:inline">failed</span>
            </button>
          )}
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
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-white/10 bg-white px-2.5 text-eyebrow font-semibold uppercase tracking-[0.12em] text-black transition-colors hover:bg-white/90 disabled:opacity-50"
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

function Metric({
  icon: Icon, value, label, title, tone,
}: { icon: typeof Database; value: number; label: string; title: string; tone?: "danger" }) {
  return (
    <div className="flex items-center gap-1 text-muted-foreground" title={title}>
      <Icon className={cn("w-3.5 h-3.5", tone === "danger" && value > 0 && "text-destructive")} />
      <span className={cn("tabular-nums", tone === "danger" && value > 0 ? "text-destructive" : "text-foreground")}>{value}</span>
      <span className="hidden lg:inline">{label}</span>
    </div>
  );
}
