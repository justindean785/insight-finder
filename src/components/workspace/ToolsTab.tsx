import { useMemo, useState } from "react";
import { useThreadArtifacts } from "@/hooks/useThreadArtifacts";
import { useThreadToolActivity, type ToolEvent } from "@/hooks/useThreadToolActivity";
import { AuditTab } from "@/components/panel/AuditTab";
import { CustodyTab } from "@/components/panel/CustodyTab";
import { EmptyState } from "@/components/panel/EmptyState";
import {
  MetricCard, FilterChips, ToolStatusBadge, ExpandableRow, TabHeader,
  type FilterChip,
} from "@/components/ui/workspace-primitives";
import { Activity, Gauge, Lock, CheckCircle2, MinusCircle, ListChecks, Clock, type LucideIcon } from "lucide-react";
import { timeAgo } from "@/lib/time";
import { cn } from "@/lib/utils";

type ActivityFilter = "all" | "succeeded" | "skipped" | "gated" | "degraded" | "pending";

type View = "activity" | "audit" | "custody";

const VIEWS: { key: View; label: string; icon: LucideIcon }[] = [
  { key: "activity", label: "Activity", icon: Activity },
  { key: "audit", label: "Audit", icon: Gauge },
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
      <TabHeader icon={Activity} title="Tools" subtitle="Activity, audit & chain of custody">
        {/* Segmented view switcher — toggle buttons (aria-pressed), not ARIA
            tabs: these swap content in place and have no associated tabpanels. */}
        <div role="group" aria-label="Tools view" className="inline-flex items-center gap-1 rounded-xl border border-white/10 bg-white/[0.035] p-1">
          {VIEWS.map((v) => {
            const Icon = v.icon;
            const active = view === v.key;
            return (
              <button
                key={v.key}
                type="button"
                aria-pressed={active}
                onClick={() => setView(v.key)}
                title={v.label}
                aria-label={v.label}
                className={cn(
                  "inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-meta font-medium transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "bg-white text-black"
                    : "text-muted-foreground hover:text-foreground hover:bg-white/[0.05]",
                )}
              >
                <Icon className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} />
                <span className="hidden min-[420px]:inline">{v.label}</span>
              </button>
            );
          })}
        </div>
      </TabHeader>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {view === "activity" && (
          <ActivityLog
            events={activity.events}
            ok={activity.ok}
            skipped={activity.skipped}
            gated={activity.gated}
            degraded={activity.degraded}
            total={activity.total}
            hiddenFailed={activity.hiddenFailed}
            loading={activity.loading}
          />
        )}
        {view === "audit" && <div className="mx-auto max-w-5xl"><AuditTab threadId={threadId} artifacts={items} /></div>}
        {view === "custody" && <div className="mx-auto max-w-5xl"><CustodyTab threadId={threadId} /></div>}
      </div>
    </div>
  );
}

function ActivityLog({
  events, ok, skipped, gated, degraded, total, hiddenFailed, loading,
}: { events: ToolEvent[]; ok: number; skipped: number; gated: number; degraded: number; total: number; hiddenFailed: number; loading: boolean }) {
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const pending = events.filter((e) => e.status === "pending").length;

  const ordered = useMemo(() => {
    return [...events].reverse().filter((e) => {
      if (filter === "all") return true;
      return e.status === filter;
    });
  }, [events, filter]);

  if (loading) return <div className="p-4 text-data text-muted-foreground">Loading activity…</div>;
  if (total === 0) {
    return (
      <EmptyState
        icon={Activity}
        title="No visible tool activity yet"
        hint={
          hiddenFailed > 0
            ? `${hiddenFailed} tool call${hiddenFailed === 1 ? "" : "s"} recorded but not shown here. Completed, running, skipped, gated, and degraded activity appears as the agent runs lookups.`
            : "When the agent runs lookups, completed, running, skipped, gated, and degraded activity appears here."
        }
      />
    );
  }

  const filters: FilterChip<ActivityFilter>[] = [
    { key: "all", label: "All", count: total },
    { key: "succeeded", label: "Succeeded", count: ok, tone: "ok" },
    { key: "skipped", label: "Skipped", count: skipped },
    ...(gated > 0 ? [{ key: "gated" as const, label: "Gated", count: gated, tone: "warn" as const }] : []),
    ...(degraded > 0 ? [{ key: "degraded" as const, label: "Degraded", count: degraded, tone: "warn" as const }] : []),
    ...(pending > 0 ? [{ key: "pending" as const, label: "Running", count: pending }] : []),
  ];

  return (
    <div className="mx-auto max-w-4xl p-3 sm:p-4 space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <MetricCard
          label="Tools shown"
          value={total}
          icon={ListChecks}
          hint={
            hiddenFailed > 0
              ? `Visible tool calls for this case. ${hiddenFailed} more recorded but not shown.`
              : "Visible tool calls for this case."
          }
        />
        <MetricCard label="Succeeded" value={ok} icon={CheckCircle2} tone={ok > 0 ? "ok" : "neutral"} hint="Calls that returned a usable result." />
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
        <EmptyState icon={Activity} title="No visible tools match this filter" hint="Try a different status filter." />
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
