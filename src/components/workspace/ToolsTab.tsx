import { useMemo, useState } from "react";
import { useThreadArtifacts } from "@/hooks/useThreadArtifacts";
import { useThreadToolActivity, type ToolEvent } from "@/hooks/useThreadToolActivity";
import { AuditTab } from "@/components/panel/AuditTab";
import { CustodyTab } from "@/components/panel/CustodyTab";
import { ToolHealthPanel } from "@/components/panel/ToolHealthPanel";
import { EmptyState } from "@/components/panel/EmptyState";
import {
  MetricCard, FilterChips, ToolStatusBadge, ExpandableRow, TabHeader,
  type FilterChip,
} from "@/components/ui/workspace-primitives";
import { Activity, Gauge, Lock, HeartPulse, CheckCircle2, XCircle, MinusCircle, ListChecks, Clock, DatabaseZap, Timer, type LucideIcon } from "lucide-react";
import { timeAgo } from "@/lib/time";
import { toolSecondaryLine } from "@/lib/tool-display";
import { cn } from "@/lib/utils";

type ActivityFilter = "all" | "succeeded" | "failed" | "skipped" | "gated" | "degraded" | "pending";

type View = "activity" | "health" | "audit" | "custody";

const VIEWS: { key: View; label: string; icon: LucideIcon }[] = [
  { key: "activity", label: "Activity", icon: Activity },
  { key: "health", label: "Health", icon: HeartPulse },
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
            failed={activity.failed}
            skipped={activity.skipped}
            gated={activity.gated}
            degraded={activity.degraded}
            total={activity.total}
            loading={activity.loading}
          />
        )}
        {view === "health" && <div className="mx-auto max-w-5xl"><ToolHealthPanel threadId={threadId} /></div>}
        {view === "audit" && <div className="mx-auto max-w-5xl"><AuditTab threadId={threadId} artifacts={items} /></div>}
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
  const { totalMs, slowCount, cachedCount } = useMemo(() => {
    let total = 0, slow = 0, cached = 0;
    for (const e of events) {
      if (e.durationMs != null && Number.isFinite(e.durationMs)) {
        total += e.durationMs;
        if (e.durationMs >= 10_000) slow++;
      }
      if (e.cached) cached++;
    }
    return { totalMs: total, slowCount: slow, cachedCount: cached };
  }, [events]);

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
          "When the agent runs lookups, completed, failed, running, skipped, gated, and degraded activity appears here."
        }
      />
    );
  }

  const filters: FilterChip<ActivityFilter>[] = [
    { key: "all", label: "All", count: total },
    { key: "succeeded", label: "Succeeded", count: ok, tone: "ok" },
    ...(failed > 0 ? [{ key: "failed" as const, label: "Failed", count: failed, tone: "danger" as const }] : []),
    { key: "skipped", label: "Skipped", count: skipped },
    ...(gated > 0 ? [{ key: "gated" as const, label: "Gated", count: gated, tone: "warn" as const }] : []),
    ...(degraded > 0 ? [{ key: "degraded" as const, label: "Degraded", count: degraded, tone: "warn" as const }] : []),
    ...(pending > 0 ? [{ key: "pending" as const, label: "Running", count: pending }] : []),
  ];

  return (
    <div className="mx-auto max-w-4xl p-3 sm:p-4 space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <MetricCard
          label="Tools shown"
          value={total}
          icon={ListChecks}
          hint="Every tool call recorded for this case, failures included."
        />
        <MetricCard label="Succeeded" value={ok} icon={CheckCircle2} tone={ok > 0 ? "ok" : "neutral"} hint="Calls that returned a usable result." />
        <MetricCard
          label="Failed"
          value={failed}
          icon={XCircle}
          tone={failed > 0 ? "danger" : "neutral"}
          hint="Calls that errored outright. Each one is a coverage gap: the lookup did not happen, so anything it would have found is missing from this case."
        />
        {/* Degraded earns its own tile whenever it is non-zero. Without it a run
            whose only non-OK rows are throttles or upstream refusals reads
            "Failed 0 / Skipped 0" and looks perfectly clean, which is how the
            suppressed-failure problem would quietly come back in a new form. */}
        {degraded > 0 && (
          <MetricCard
            label="Degraded"
            value={degraded}
            icon={Clock}
            tone="warn"
            hint="Transient, not breakage: our own throttles and caps, upstream rate limits, denials and timeouts. The lookup can succeed on a retry."
          />
        )}
        <MetricCard
          label={gated > 0 ? "Skipped / Gated" : "Skipped"}
          value={gated > 0 ? `${skipped}/${gated}` : skipped}
          icon={MinusCircle}
          tone={gated > 0 ? "warn" : "neutral"}
          hint="Skipped = deduped/no-op. Gated = blocked by a triage, policy, or budget gate (an intentional decision, not a fault)."
        />
        {/* Time spent is the other half of "what did this run cost". A case
            that burned four minutes on two hung providers reads as healthy on
            counts alone; these two tiles are the only place that shows it. */}
        {totalMs > 0 && (
          <MetricCard
            label="Time in tools"
            value={fmtDuration(totalMs) ?? "—"}
            icon={Timer}
            tone={slowCount > 0 ? "warn" : "neutral"}
            hint={
              slowCount > 0
                ? `Total wall-clock across every recorded call. ${slowCount} call${slowCount === 1 ? "" : "s"} took 10s or longer — long-running calls are usually an upstream hang, not a fast refusal.`
                : "Total wall-clock across every recorded call."
            }
          />
        )}
        {cachedCount > 0 && (
          <MetricCard
            label="Cached"
            value={cachedCount}
            icon={DatabaseZap}
            hint="Served from cache: no provider call and no spend. Useful coverage, but the data can be older than the timestamp on the row."
          />
        )}
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
                    <span className="font-mono text-micro tracking-normal text-muted-foreground/70">Reason</span>
                    <div className="mt-1 text-foreground/90 break-words">{e.reason}</div>
                    <div className="mt-2 font-mono text-eyebrow text-muted-foreground/60 break-all">id: {e.id}</div>
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

/** Wall-clock, at the precision an analyst actually reads it. */
function fmtDuration(ms: number | null): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

function ActivityRowSummary({ e }: { e: ToolEvent }) {
  const duration = fmtDuration(e.durationMs);
  // A slow failure is a different problem from a fast one: 30s says the
  // provider hung, 300ms says we never called it. Flag the long tail so the
  // distinction is visible without reading every number.
  const slow = e.durationMs != null && e.durationMs >= 10_000;
  return (
    <div className="flex items-center gap-3">
      <ToolStatusBadge status={e.status} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-meta text-foreground truncate">{e.displayName}</span>
          <span className="font-mono text-eyebrow uppercase tracking-wider text-muted-foreground/70 shrink-0">{e.toolName}</span>
          {e.cached && (
            <span
              title="Served from cache — no provider call was made and nothing was charged. The data may be older than this timestamp."
              className="inline-flex shrink-0 items-center gap-1 rounded border border-border-subtle bg-surface-2 px-1.5 py-px font-mono text-eyebrow uppercase tracking-wider text-muted-foreground"
            >
              <DatabaseZap className="h-2.5 w-2.5" strokeWidth={2} aria-hidden />
              Cached
            </span>
          )}
        </div>
        {/* Title truncates once above; the REASON body carries the full provider
            string — wrap to 2 lines instead of a single-line clip (Phase C3).
            `actionLabel` is derived from `displayName` (the slice after " — ",
            or the whole string when there is no dash), so on a row with no
            reason it restates the title verbatim or as a substring. Render the
            secondary line only when it actually adds information. */}
        {toolSecondaryLine(e) && (
          <div className="text-data text-muted-foreground line-clamp-2 break-words">{toolSecondaryLine(e)}</div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2.5 text-data tabular-nums">
        {duration && (
          <span
            className={cn("font-mono", slow ? "text-[hsl(var(--confidence-mid))]" : "text-muted-foreground/70")}
            title={slow ? `${duration} — long-running; likely an upstream hang rather than a fast refusal` : `Took ${duration}`}
          >
            {duration}
          </span>
        )}
        <span className="flex items-center gap-1 text-muted-foreground">
          <Clock className="w-3 h-3" aria-hidden />
          {timeAgo(e.at)}
        </span>
      </div>
    </div>
  );
}
