import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useThreadArtifacts } from "@/hooks/useThreadArtifacts";
import { useThreadToolActivity } from "@/hooks/useThreadToolActivity";
import { ShieldAlert, Lock, Coins, Plus, Copy, Link2, Mail, Phone, Globe, Network, User, Hash, FileSearch } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { extractDisplaySeed, type SeedKind } from "@/lib/seed";

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

const KIND_ICON: Record<SeedKind, typeof Globe> = {
  email: Mail,
  username: User,
  phone: Phone,
  ip: Network,
  domain: Globe,
  url: Link2,
  crypto: Hash,
  other: FileSearch,
};

const KIND_LABEL: Record<SeedKind, string> = {
  email: "Email",
  username: "Username",
  phone: "Phone",
  ip: "IP address",
  domain: "Domain",
  url: "URL",
  crypto: "Wallet",
  other: "Selector",
};

// The header's "N evidence" must read the chain-verified evidence_log total, NOT
// the artifact count — they legitimately differ (one artifact can carry several
// evidence rows, and the artifact list is deduped, so it is the smaller number).
// Analysts trust this figure, so it has to be the evidence_log count. Fall back
// to the artifact count only while the integrity probe is still loading, so the
// header never flashes a false "0 evidence".
// eslint-disable-next-line react-refresh/only-export-components
export function pickEvidenceCount(
  integrity: { total: number } | null,
  artifactFallback: number,
): number {
  return integrity ? integrity.total : artifactFallback;
}

/**
 * Case command bar — Palantir/Claude workstation style.
 * Three-zone grid: left meta · centered identity · right ops.
 * Seed is the visual center of gravity, not pinned to the far left.
 */
export function WorkspaceHeader({ threadId }: { threadId: string }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { items } = useThreadArtifacts(threadId);
  const activity = useThreadToolActivity(threadId, user?.id ?? "");
  const [thread, setThread] = useState<Thread | null>(null);
  const [creating, setCreating] = useState(false);
  const [integrity, setIntegrity] = useState<{ ok: boolean; total: number; first_break: number | null } | null>(null);

  const artifactCount = items.length;
  const evidenceCount = pickEvidenceCount(integrity, artifactCount);

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
    const onThreadChange = (payload: unknown) => {
      void load();
      // When the run reaches a terminal status, re-verify the evidence chain:
      // evidence_log INSERTs missed during a realtime gap (a CPU-killed isolate
      // whose socket dropped) would otherwise leave the "N evidence" count frozen
      // on a finished run — the same self-heal useThreadArtifacts performs.
      const next = (payload as { new?: { status?: string } | null })?.new?.status;
      if (next === "finished" || next === "stopped") void loadIntegrity();
    };
    const ch = supabase
      .channel(`workspace-header-${threadId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "threads", filter: `id=eq.${threadId}` }, onThreadChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "evidence_log", filter: `thread_id=eq.${threadId}` }, () => void loadIntegrity())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [threadId, loadIntegrity]);

  // Tool log can go quiet for long stretches (MiniMax thinking / provider lag).
  // 12s was too short — header flipped to COMPLETE between tool calls mid-run.
  const ACTIVE_WINDOW_MS = 90_000;
  const [now, setNow] = useState(() => Date.now());
  // Live chat stream — authoritative "running" signal from ChatWindow.
  const [chatRunning, setChatRunning] = useState(false);
  useEffect(() => {
    setChatRunning(false);
    const onRun = (e: Event) => {
      const d = (e as CustomEvent<{ threadId?: string; running?: boolean }>).detail;
      if (!d || d.threadId !== threadId) return;
      setChatRunning(!!d.running);
    };
    window.addEventListener("proximity:run-state", onRun as EventListener);
    return () => window.removeEventListener("proximity:run-state", onRun as EventListener);
  }, [threadId]);

  const lastActivityMs = useMemo(() => {
    let max = 0;
    for (const e of activity.events) {
      const t = Date.parse(e.at);
      if (Number.isFinite(t) && t > max) max = t;
    }
    return max;
  }, [activity.events]);
  const recentlyActive = lastActivityMs > 0 && now - lastActivityMs < ACTIVE_WINDOW_MS;
  const liveRun = chatRunning || recentlyActive;
  useEffect(() => {
    if (!liveRun) return;
    const id = setInterval(() => setNow(Date.now()), 3000);
    return () => clearInterval(id);
  }, [liveRun]);

  // Priority: live stream/tool activity → Running; only then terminal/completed.
  // Never paint COMPLETE while chat is streaming or tools ran in the last 90s.
  const status: "idle" | "active" | "completed" =
    liveRun ? "active"
    : thread?.status === "finished" || thread?.status === "stopped" ? "completed"
    : artifactCount > 0 || activity.persistedTotal > 0 ? "completed"
    : "idle";

  const display = thread
    ? extractDisplaySeed(thread.seed_value, thread.seed_type)
    : { selector: "—", kind: "other" as SeedKind, title: "Investigation" };
  const KindIcon = KIND_ICON[display.kind] ?? FileSearch;

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
    <header className="relative border-b border-white/[0.06] bg-[linear-gradient(180deg,hsl(220_22%_6.5%/0.92),hsl(222_24%_4%/0.88))] backdrop-blur-xl">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />

      {/* 3-zone command bar: left balance · center identity · right ops */}
      <div className="mx-auto grid h-[3.5rem] w-full max-w-[min(100%,64rem)] grid-cols-[1fr_minmax(0,auto)_1fr] items-center gap-2 px-4 sm:px-7">
        {/* Left — case class (balances the right so center is true center) */}
        <div className="flex min-w-0 items-center gap-2 justify-self-start">
          <span className="hidden sm:inline-flex items-center gap-1.5 rounded-md border border-white/[0.07] bg-white/[0.03] px-2 py-1 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            <KindIcon className="h-3 w-3 shrink-0 opacity-80" strokeWidth={1.75} aria-hidden />
            {KIND_LABEL[display.kind]}
          </span>
          <span className="hidden md:inline text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/55">
            Case file
          </span>
        </div>

        {/* Center — investigation identity */}
        <div className="flex min-w-0 max-w-[min(100%,36rem)] flex-col items-center justify-center justify-self-center px-1">
          <button
            type="button"
            onClick={copySeed}
            title={thread?.seed_value ? `Copy ${thread.seed_value}` : undefined}
            className="group flex max-w-full items-center gap-2 rounded-lg px-2 py-0.5 text-center transition-colors hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span
              className={cn(
                "h-1.5 w-1.5 shrink-0 rounded-full",
                status === "completed" && "bg-[hsl(var(--confidence-high))] shadow-[0_0_8px_hsl(var(--confidence-high)/0.65)]",
                status === "active" && "bg-[hsl(var(--info))] shadow-[0_0_8px_hsl(var(--info)/0.55)] animate-pulse",
                status === "idle" && "bg-muted-foreground/70",
              )}
              aria-hidden
            />
            <span className="truncate font-mono text-[13px] font-medium tracking-tight text-foreground sm:text-[14px]">
              {display.title}
            </span>
            {thread?.seed_value && (
              <Copy className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
            )}
          </button>
          {status !== "idle" && (
            <div className="mt-0.5 flex items-center gap-1.5">
              <span
                className={cn(
                  "rounded-full border px-2 py-px text-[9px] font-semibold uppercase tracking-[0.16em]",
                  status === "completed" && "border-[hsl(var(--confidence-high)/0.35)] bg-[hsl(var(--confidence-high)/0.1)] text-[hsl(var(--confidence-high))]",
                  status === "active" && "border-[hsl(var(--info)/0.35)] bg-[hsl(var(--info)/0.1)] text-[hsl(var(--info))]",
                )}
              >
                {status === "active" ? "Running" : "Complete"}
              </span>
              <span className="hidden text-[10px] text-muted-foreground/70 sm:inline tabular-nums">
                {evidenceCount} evidence · {activity.persistedTotal} tools
              </span>
            </div>
          )}
        </div>

        {/* Right — ops metrics */}
        <div className="flex items-center justify-self-end gap-2 sm:gap-2.5">
          {integrityPct != null && (
            <div
              title={integrity?.ok ? `${integrity.total} evidence rows · chain valid` : `Chain break at seq ${integrity?.first_break}`}
              aria-label={integrity?.ok
                ? `Chain of custody valid — ${integrityPct}%`
                : `Chain of custody broken at sequence ${integrity?.first_break} — ${integrityPct}%`}
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2 py-1 font-mono text-[11px] tabular-nums",
                integrity?.ok
                  ? "border-[hsl(var(--confidence-high))]/35 bg-[hsl(var(--confidence-high))]/10 text-[hsl(var(--confidence-high))]"
                  : "border-destructive/40 bg-destructive/10 text-destructive",
              )}
            >
              {integrity?.ok ? <Lock className="h-3 w-3" /> : <ShieldAlert className="h-3 w-3" />}
              <span className="hidden xs:inline sm:inline">{integrityPct}%</span>
            </div>
          )}
          {(thread?.cost_micro_usd ?? 0) > 0 && (
            <div className="hidden sm:inline-flex items-center gap-1 rounded-full border border-white/[0.07] bg-white/[0.03] px-2 py-1 text-[11px] text-muted-foreground" title="Spend on this case">
              <Coins className="h-3 w-3" />
              <span className="font-mono tabular-nums text-foreground/90">{fmtUsd(thread?.cost_micro_usd)}</span>
            </div>
          )}
          <button
            onClick={createInvestigation}
            disabled={creating}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-white/10 bg-white px-2.5 text-[11px] font-semibold tracking-normal text-black transition-colors hover:bg-white/90 disabled:opacity-50"
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
