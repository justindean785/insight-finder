import { useMemo, useState } from "react";
import { useThreadArtifacts } from "@/hooks/useThreadArtifacts";
import { useThreadToolActivity, type ToolEvent } from "@/hooks/useThreadToolActivity";
import { AuditTab } from "@/components/panel/AuditTab";
import { FailedSkippedTab } from "@/components/panel/FailedSkippedTab";
import { CustodyTab } from "@/components/panel/CustodyTab";
import { EmptyState } from "@/components/panel/EmptyState";
import {
  MetricCard, FilterChips, ToolStatusBadge, ExpandableRow,
  type FilterChip,
} from "@/components/ui/workspace-primitives";
import { Activity, Gauge, AlertTriangle, Lock, CheckCircle2, XCircle, MinusCircle, ListChecks, Clock, type LucideIcon } from "lucide-react";
import { timeAgo } from "@/lib/time";
import { cn } from "@/lib/utils";

type ActivityFilter = "all" | "succeeded" | "failed" | "skipped" | "gated" | "degraded" | "pending";

type View = "activity" | "audit" | "issues" | "custody";

const VIEWS: { key: View; label: string; icon: LucideIcon }[] = [
  { key: "activity", label: "Activity", icon: Activity },
  { key: "audit", label: "Audit", icon: Gauge },
  { key: "issues", label: "Failures", icon: AlertTriangle },
  { key: "custody", label: "Custody", icon: Lock },
];

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
        {view === "activity" && (
          <ActivityLog
            events={activity.events}
            ok={activity.ok}
            failed={activity.failed}
            skipped={activity.skipped}
            gated={activity.gated}
            degraded={activity.degraded}
            total={activity.total}
            loading={activity.loading}
          />
        )}
        {view === "audit" && <div className="mx-auto max-w-5xl"><AuditTab threadId={threadId} artifacts={items} /></div>}
        {view === "issues" && <div className="mx-auto max-w-5xl"><FailedSkippedTab threadId={threadId} /></div>}
        {view === "custody" && <div className="mx-auto max-w-5xl"><CustodyTab threadId={threadId} /></div>}
      </div>
    </div>
  );
}

function ActivityLog({
  events, ok, failed, skipped, gated, degraded, total, loading,
}: { events: ToolEvent[]; ok: number; failed: number; skipped: number; gated: number; degraded: number; total: number; loading: boolean }) {
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const pending = events.filter((e) => e.status === "pending").length;

  // Newest first, but always float failures to the top so troubleshooting is
  // the first thing an analyst sees.
  const ordered = useMemo(() => {
    const byFilter = events.filter((e) => {
      if (filter === "all") return true;
      return e.status === filter;
    });
    return [...byFilter].reverse().sort((a, b) => {
      const af = a.status === "failed" ? 0 : 1;
      const bf = b.status === "failed" ? 0 : 1;
      return af - bf;
    });
  }, [events, filter]);

  if (loading) return <div className="p-4 text-data text-muted-foreground">Loading activity…</div>;
  if (total === 0) {
    return (
      <EmptyState
        icon={Activity}
        title="No tool activity yet"
        hint="Once the agent runs lookups, every call lands here with its status, reason, and timing — failures float to the top."
      />
    );
  }

  const filters: FilterChip<ActivityFilter>[] = [
    { key: "all", label: "All", count: total },
    { key: "succeeded", label: "Succeeded", count: ok, tone: "ok" },
    { key: "failed", label: "Failed", count: failed, tone: failed > 0 ? "danger" : "neutral" },
    { key: "skipped", label: "Skipped", count: skipped },
    ...(gated > 0 ? [{ key: "gated" as const, label: "Gated", count: gated, tone: "warn" as const }] : []),
    ...(degraded > 0 ? [{ key: "degraded" as const, label: "Degraded", count: degraded, tone: "warn" as const }] : []),
    ...(pending > 0 ? [{ key: "pending" as const, label: "Running", count: pending }] : []),
  ];

  return (
    <div className="mx-auto max-w-4xl p-3 sm:p-4 space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <MetricCard label="Total tools" value={total} icon={ListChecks} hint="Every tool call recorded for this case." />
        <MetricCard label="Succeeded" value={ok} icon={CheckCircle2} tone={ok > 0 ? "ok" : "neutral"} hint="Calls that returned a usable result." />
        <MetricCard label="Failed" value={failed} icon={XCircle} tone={failed > 0 ? "danger" : "neutral"} hint="Calls that errored or returned ok:false." />
        <MetricCard
          label={gated > 0 ? "Skipped / Gated" : "Skipped"}
          value={gated > 0 ? `${skipped}/${gated}` : skipped}
          icon={MinusCircle}
          tone={gated > 0 ? "warn" : "neutral"}
          hint="Skipped = deduped/no-op. Gated = blocked by a triage, policy, or budget gate (an intentional decision, not a fault)."
        />
      </div>

      <FilterChips<ActivityFilter>
        ariaLabel="Filter tool activity by status"
        options={filters}
        active={filter}
        onChange={setFilter}
      />

      {ordered.length === 0 ? (
        <EmptyState icon={Activity} title="No tools match this filter" hint="Try a different status filter." />
      ) : (
        <ul className="rounded-xl border border-border-subtle bg-surface-1 divide-y divide-border-subtle/60 overflow-hidden">
          {ordered.map((e) => (
            <li key={e.id}>
              {e.reason ? (
                <ExpandableRow
                  summary={<ActivityRowSummary e={e} />}
                >
                  <div className="rounded-lg border border-border-subtle bg-surface-2/40 px-3 py-2 text-data text-muted-foreground leading-relaxed">
                    <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">Reason</span>
                    <div className="mt-1 text-foreground/90 break-words">{e.reason}</div>
                    <div className="mt-2 font-mono text-[10px] text-muted-foreground/60 break-all">id: {e.id}</div>
                  </div>
                </ExpandableRow>
              ) : (
                <div className="px-3 py-2.5">
                  <ActivityRowSummary e={e} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ActivityRowSummary({ e }: { e: ToolEvent }) {
  return (
    <div className="flex items-center gap-3">
      <ToolStatusBadge status={e.status} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-meta text-foreground truncate">{e.displayName}</span>
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70 shrink-0">{e.toolName}</span>
        </div>
        <div className="text-data text-muted-foreground truncate">{e.reason ?? e.actionLabel}</div>
      </div>
      <div className="flex items-center gap-1 shrink-0 text-data text-muted-foreground tabular-nums">
        <Clock className="w-3 h-3" />
        {timeAgo(e.at)}
      </div>
    </div>
  );
}
