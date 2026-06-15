import { useState } from "react";
import { useThreadArtifacts } from "@/hooks/useThreadArtifacts";
import { useThreadToolActivity, type ToolEvent } from "@/hooks/useThreadToolActivity";
import { AuditTab } from "@/components/panel/AuditTab";
import { FailedSkippedTab } from "@/components/panel/FailedSkippedTab";
import { CustodyTab } from "@/components/panel/CustodyTab";
import { Activity, Gauge, AlertTriangle, Lock, CheckCircle2, XCircle, MinusCircle, Clock, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type View = "activity" | "audit" | "issues" | "custody";

const VIEWS: { key: View; label: string; icon: LucideIcon }[] = [
  { key: "activity", label: "Activity", icon: Activity },
  { key: "audit", label: "Audit", icon: Gauge },
  { key: "issues", label: "Failures", icon: AlertTriangle },
  { key: "custody", label: "Custody", icon: Lock },
];

function timeAgo(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * Tools / Activity workspace — the operational record kept separate from the
 * findings. Chronological tool-call log, the cost/coverage audit, the failure
 * register, and the evidence chain-of-custody. This is where runtime detail
 * lives instead of being buried in chat messages.
 */
export function ToolsTab({ threadId }: { threadId: string }) {
  const { items } = useThreadArtifacts(threadId);
  const activity = useThreadToolActivity(threadId);
  const [view, setView] = useState<View>("activity");

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="shrink-0 px-3 sm:px-4 py-2 border-b border-border-subtle flex items-center gap-1">
        {VIEWS.map((v) => {
          const Icon = v.icon;
          const active = view === v.key;
          const danger = v.key === "issues" && activity.failed > 0;
          return (
            <button
              key={v.key}
              onClick={() => setView(v.key)}
              className={cn(
                "inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-meta font-medium transition-colors",
                active
                  ? "bg-surface-1 text-foreground border border-white/10"
                  : "text-muted-foreground hover:text-foreground hover:bg-surface-1 border border-transparent",
              )}
            >
              <Icon className={cn("w-3.5 h-3.5 shrink-0", danger && !active && "text-destructive")} strokeWidth={1.75} />
              {v.label}
              {danger && (
                <span className="font-mono text-[10px] tabular-nums text-destructive">{activity.failed}</span>
              )}
            </button>
          );
        })}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {view === "activity" && <ActivityLog events={activity.events} ok={activity.ok} failed={activity.failed} skipped={activity.skipped} loading={activity.loading} />}
        {view === "audit" && <div className="mx-auto max-w-5xl"><AuditTab threadId={threadId} artifacts={items} /></div>}
        {view === "issues" && <div className="mx-auto max-w-5xl"><FailedSkippedTab threadId={threadId} /></div>}
        {view === "custody" && <div className="mx-auto max-w-5xl"><CustodyTab threadId={threadId} /></div>}
      </div>
    </div>
  );
}

function ActivityLog({
  events, ok, failed, skipped, loading,
}: { events: ToolEvent[]; ok: number; failed: number; skipped: number; loading: boolean }) {
  if (loading) return <div className="p-4 text-data text-muted-foreground">Loading activity…</div>;
  if (events.length === 0) {
    return (
      <div className="p-6 text-data text-muted-foreground max-w-md">
        No tool calls yet. Once the agent runs lookups, every call lands here with its result and timing.
      </div>
    );
  }
  // Newest first for a live operational feed.
  const ordered = [...events].reverse();
  return (
    <div className="mx-auto max-w-4xl p-3 sm:p-4 space-y-3">
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Succeeded" value={ok} icon={CheckCircle2} tone="ok" />
        <Stat label="Failed" value={failed} icon={XCircle} tone={failed > 0 ? "danger" : "muted"} />
        <Stat label="Skipped" value={skipped} icon={MinusCircle} tone="muted" />
      </div>
      <ul className="rounded-xl border border-border-subtle bg-surface-1 divide-y divide-border-subtle/60 overflow-hidden">
        {ordered.map((e) => {
          const tone =
            e.tone === "error" ? "text-destructive" :
            e.tone === "skip" ? "text-muted-foreground" :
            e.tone === "pending" ? "text-primary" :
            "text-[hsl(var(--confidence-high))]";
          const Dot =
            e.tone === "error" ? XCircle :
            e.tone === "skip" ? MinusCircle :
            CheckCircle2;
          return (
            <li key={e.id} className="flex items-center gap-3 px-3 py-2.5">
              <Dot className={cn("w-4 h-4 shrink-0", tone)} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-meta text-foreground truncate">{e.displayName}</span>
                  <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70 shrink-0">{e.toolName}</span>
                </div>
                <div className="text-data text-muted-foreground truncate">{e.actionLabel}</div>
              </div>
              <div className="flex items-center gap-1 shrink-0 text-data text-muted-foreground tabular-nums">
                <Clock className="w-3 h-3" />
                {timeAgo(e.at)}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Stat({
  label, value, icon: Icon, tone,
}: { label: string; value: number; icon: LucideIcon; tone: "ok" | "danger" | "muted" }) {
  const color =
    tone === "ok" ? "text-[hsl(var(--confidence-high))]" :
    tone === "danger" ? "text-destructive" :
    "text-muted-foreground";
  return (
    <div className="rounded-lg border border-border-subtle bg-surface-1 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-eyebrow uppercase tracking-[0.1em] text-muted-foreground">
        <Icon className={cn("w-3 h-3", color)} /> {label}
      </div>
      <div className={cn("mt-1 text-2xl font-display font-semibold tabular-nums leading-none", color)}>{value}</div>
    </div>
  );
}
