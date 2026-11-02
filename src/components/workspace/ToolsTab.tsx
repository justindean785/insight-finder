import { useEffect, useMemo, useState } from "react";
import type { ToolEvent } from "@/hooks/useThreadToolActivity";
import { useCaseSnapshot } from "@/hooks/useCaseSnapshot";
import { AuditTab } from "@/components/panel/AuditTab";
import { CustodyTab } from "@/components/panel/CustodyTab";
import { SectionHeading } from "@/components/workspace/SectionHeading";
import { ToolHealthPanel } from "@/components/panel/ToolHealthPanel";
import { EmptyState } from "@/components/panel/EmptyState";
import {
  MetricCard, ToolStatusBadge, ExpandableRow,
} from "@/components/ui/workspace-primitives";
import { CompactFilter, SubTabs, type CompactOption } from "@/components/ui/compact-controls";
import { fmtWallClock } from "@/lib/duration";
import { Activity, Gauge, Lock, HeartPulse, CheckCircle2, MinusCircle, CircleSlash, ShieldAlert, ListChecks, Clock, DatabaseZap, Timer, type LucideIcon } from "lucide-react";
import { timeAgo } from "@/lib/time";
import { toolSecondaryLine } from "@/lib/tool-display";
import { cn } from "@/lib/utils";

type ActivityFilter = "all" | "succeeded" | "empty" | "failed" | "skipped" | "gated" | "degraded" | "pending";

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
function isView(v: string): v is View {
  return v === "activity" || v === "health" || v === "audit" || v === "custody";
}

export function ToolsTab({
  threadId,
  viewRequest,
}: {
  threadId: string;
  /** Open a specific view (e.g. "health" from the recovery banner). `n` is a nonce. */
  viewRequest?: { view: string; n: number } | null;
}) {
  // Counts and rows come from the case snapshot — the SAME version the case bar
  // and the Tools tab badge print, so "48" here and "46" there cannot recur.
  const { snapshot } = useCaseSnapshot();
  const items = snapshot?.items ?? [];
  const tools = snapshot?.tools;
  const [view, setView] = useState<View>(
    viewRequest && isView(viewRequest.view) ? viewRequest.view : "activity",
  );
  useEffect(() => {
    if (viewRequest && isView(viewRequest.view)) setView(viewRequest.view);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewRequest?.n]);

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* The tab strip already names this section: the local control is the
          only thing this row needs to carry. */}
      <div className="shrink-0 border-b border-white/[0.07] bg-surface-0 px-3 py-2.5 sm:px-4">
        <div className="mx-auto max-w-6xl">
          <SectionHeading
            title="Investigation activity"
            subtitle="Outcomes first. Raw calls stay one step away."
            right={
              <SubTabs<View>
                label="Tools view"
                options={VIEWS.map((v) => ({ key: v.key, label: v.label, icon: v.icon }))}
                active={view}
                onChange={setView}
              />
            }
          />
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {view === "activity" && (
          <ActivityLog
            events={tools?.events ?? []}
            ok={tools?.ok ?? 0}
            noRecord={tools?.noRecord ?? 0}
            failed={tools?.failed ?? 0}
            skipped={tools?.skipped ?? 0}
            gated={tools?.gated ?? 0}
            degraded={tools?.degraded ?? 0}
            total={tools?.total ?? 0}
            loading={!snapshot?.hydrated}
            unavailable={Boolean(snapshot?.hydrated && tools && !tools.available)}
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
  events, ok, noRecord, failed, skipped, gated, degraded, total, loading, unavailable = false,
}: { events: ToolEvent[]; ok: number; noRecord: number; failed: number; skipped: number; gated: number; degraded: number; total: number; loading: boolean; unavailable?: boolean }) {
  // The skipped GROUP, as Health counts it: plain skips + gated (unavailable) skips.
  const skippedGroup = skipped + gated;
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const pending = events.filter((e) => e.status === "pending").length;
  /**
   * Where the money went. `charged_micro_usd` is what was ACTUALLY billed, which
   * is not the same as what a call cost to attempt: a cache hit and a gated
   * refusal both charge nothing. Reporting the charged figure per tool is the
   * only way to see that one provider is eating the run's budget — the header's
   * single aggregate cannot show that, and the paid-call cap is spent per tool.
   */
  const spend = useMemo(() => {
    // NOTE: this reports what WAS charged, not what was avoided. `cost_micro_usd`
    // is now fetched, but only as the legacy-row fallback inside
    // `effectiveChargedMicroUsd` — the cache saving is still deliberately not
    // claimed, because list price is an attributed figure and presenting it as
    // money saved would invent a number no one billed.
    // TIME IS NOT FILTERED BY SPEND. Skipping zero-charge calls here (the old
    // `if (m <= 0) continue`) meant a slow FREE call — a gated refusal that
    // still burned 12s, a free-tier tool that timed out — could not appear in a
    // panel whose entire purpose is surfacing the long tail, while the badge
    // beside the header cheerfully reported that free calls existed. It also
    // made the header total disagree with the "Time in tools" figure above it,
    // because the two were summing different populations of the same run.
    const by = new Map<string, { micro: number; calls: number; ms: number }>();
    let total = 0;
    let wallClock = 0;
    for (const e of events) {
      // Already resolved through runCost's `chargedMicroUsd` at the hook, so a
      // legacy row with no `charged_micro_usd` contributes its list price
      // instead of vanishing from the breakdown as if it were free.
      const m = Math.max(0, e.effectiveChargedMicroUsd);
      total += m;
      const cur = by.get(e.toolName) ?? { micro: 0, calls: 0, ms: 0 };
      cur.micro += m; cur.calls += 1;
      if (e.durationMs != null && Number.isFinite(e.durationMs)) {
        cur.ms += e.durationMs;
        wallClock += e.durationMs;
      }
      by.set(e.toolName, cur);
    }
    const rows = [...by.entries()]
      .map(([tool, v]) => ({ tool, ...v }))
      // Sort by TIME, then cost. On a per-call-priced tool set every row costs
      // the same, so a cost sort produces an arbitrary order; time is the axis
      // that actually separates a 310ms lookup from a 12s timeout.
      .sort((a, b) => b.ms - a.ms || b.micro - a.micro)
      .slice(0, 8);
    const freeCalls = events.filter((e) => e.effectiveChargedMicroUsd <= 0).length;
    return {
      rows,
      total,
      freeCalls,
      max: Math.max(1, ...rows.map((r) => r.micro)),
      maxMs: Math.max(1, ...rows.map((r) => r.ms)),
      // Every recorded call, not just the eight rows drawn. The header states
      // the run's wall-clock; the rows are the top of it, and a truncated sum
      // presented as a total is a wrong number, not a shorter one.
      totalMs: wallClock,
    };
  }, [events]);

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
      // "Skipped" is the whole group, matching its tile; "Gated" narrows to the sub-count.
      if (filter === "skipped") return e.status === "skipped" || e.status === "gated";
      return e.status === filter;
    });
  }, [events, filter]);

  if (loading) return <div className="p-4 text-data text-muted-foreground" role="status">Syncing tool activity…</div>;
  if (unavailable) {
    return (
      <EmptyState
        icon={Activity}
        title="Tool activity could not be read"
        hint="The tool-call ledger did not answer. Use Refresh in the case bar to try again — no figure here is a count of zero."
      />
    );
  }
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

  const filters: CompactOption<ActivityFilter>[] = [
    { key: "all", label: "All", count: events.length },
    { key: "succeeded", label: "Succeeded", count: ok, tone: "ok" },
    ...(failed > 0 ? [{ key: "failed" as const, label: "Faulted", count: failed, tone: "danger" as const }] : []),
    ...(noRecord > 0 ? [{ key: "empty" as const, label: "No record", count: noRecord }] : []),
    { key: "skipped", label: "Skipped", count: skippedGroup },
    ...(gated > 0 ? [{ key: "gated" as const, label: "Gated", count: gated, tone: "warn" as const }] : []),
    ...(degraded > 0 ? [{ key: "degraded" as const, label: "Degraded", count: degraded, tone: "warn" as const }] : []),
    ...(pending > 0 ? [{ key: "pending" as const, label: "Running", count: pending }] : []),
  ];

  return (
    <div className="mx-auto max-w-6xl p-3 sm:p-4 space-y-4">
      {/* One row on desktop however many tiles apply; two balanced columns on a
          phone, with an odd last tile spanning both instead of leaving a hole. */}
      <div className="grid grid-cols-2 gap-2.5 lg:grid-flow-col lg:auto-cols-fr [&>*:last-child:nth-child(odd)]:col-span-2 lg:[&>*:last-child:nth-child(odd)]:col-span-1">
        <MetricCard
          label="Tool calls"
          value={total}
          icon={ListChecks}
          hint={events.length < total
            ? `Every tool call recorded for this case, failures included. The list below holds the ${events.length} rows the server returned; the ledger holds more.`
            : "Every tool call recorded for this case, failures included. The same figure as the case bar and the Tools tab."}
        />
        {/* The five outcome tiles are the Health panel's five groups, computed by
            the same classifier (src/lib/tool-outcome.ts → outcomeGroup), so
            Activity and Health print the same numbers for the same rows. */}
        <MetricCard
          label="Succeeded" value={ok} icon={CheckCircle2}
          of={total || null} share={total ? ok / total : null}
          tone={ok > 0 ? "ok" : "neutral"}
          hint="Calls that returned a usable result. A clean no-record is counted under No record, as in Health."
        />
        <MetricCard
          label="No record" value={noRecord} icon={MinusCircle}
          of={total || null} share={total ? noRecord / total : null}
          hint="Ran fine, and the target has no data at this source. An expected answer, not a fault."
        />
        <MetricCard
          label="Faulted"
          value={failed}
          icon={ShieldAlert}
          of={total || null}
          share={total ? failed / total : null}
          tone={failed > 0 ? "danger" : "neutral"}
          hint="Calls that hit a config/key error, a genuine provider fault, or an opaque unknown. Each one is a coverage gap: anything the lookup would have found is missing from this case."
        />
        {/* Degraded earns its own tile whenever it is non-zero. Without it a run
            whose only non-OK rows are throttles or upstream refusals reads
            "Faulted 0 / Skipped 0" and looks perfectly clean, which is how the
            suppressed-failure problem would quietly come back in a new form. */}
        {degraded > 0 && (
          <MetricCard
            label="Degraded"
            value={degraded}
            icon={Clock}
            of={total || null}
            share={total ? degraded / total : null}
            tone="warn"
            hint="Transient, not breakage: timeouts, upstream rate limits, access denials (403) and legal blocks (451). The lookup can succeed on a retry."
          />
        )}
        <MetricCard
          label={gated > 0 ? `Skipped · ${gated} gated` : "Skipped"}
          value={skippedGroup}
          icon={CircleSlash}
          of={total || null}
          share={total ? skippedGroup / total : null}
          tone={gated > 0 ? "warn" : "neutral"}
          hint="Intentionally not run: governance, dedup, our own caps and throttles, or cancelled by the run's time budget. Gated (counted inside Skipped) = the tool was unavailable — no key, disabled, or gated."
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
            of={total || null}
            share={total ? cachedCount / total : null}
            hint="Served from cache: no provider call and no spend. Useful coverage, but the data can be older than the timestamp on the row."
          />
        )}
      </div>

      {/* Gate on having ROWS, not on money. This panel is titled "Time and
          spend by tool" and its bars encode time, so a run made entirely of
          cached / gated / free-tier calls — spend exactly 0, wall-clock very
          much not — used to hide the panel outright. That silently undid the
          point of counting free calls in the first place. */}
      {spend.rows.length > 0 && (
        <section className="panel overflow-hidden">
          {/* The bar encodes TIME, not spend.
              It used to encode spend, normalised against the largest row — and
              on a tool set where every call is priced the same, that renders
              every bar at 100%: nine identical full-width bars that look like a
              distribution and carry no information at all. Cost is still shown
              as a figure, because a figure is what a flat cost deserves.
              Wall-clock is the axis with real variance here (310ms vs a 12s
              timeout) and the resource a run actually runs out of. */}
          <div className="rule-label">
            <span>Time and spend by tool</span>
            <span className="ml-auto normal-case tracking-normal text-micro tabular-nums text-muted-foreground">
              {fmtDuration(spend.totalMs)}
              <span className="mx-1.5 text-muted-foreground/40" aria-hidden>·</span>
              {fmtMicroUsd(spend.total)}
              {spend.freeCalls > 0 && (
                <span className="ml-2 text-[hsl(var(--confidence-high))]" title="Cache hits, gated refusals and free-tier tools charge nothing.">
                  {spend.freeCalls} free
                </span>
              )}
            </span>
          </div>
          <div className="space-y-1 p-3">
            {spend.rows.map((r) => {
              const slow = r.ms >= 10_000;
              return (
                <div key={r.tool} className="grid grid-cols-[minmax(0,1fr)_3.5rem_4.5rem_2.5rem] items-center gap-x-2 gap-y-0.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_3.5rem_4.5rem_2.5rem]">
                  {/* Phone width: the name gets the whole first column and the bar
                      drops to a second row. Truncating to ~7 chars left "socialf…"
                      twice and "minimax…" twice in one list (2026-09-20). */}
                  <span className="break-all font-mono text-data text-foreground/85 sm:truncate sm:break-normal" title={r.tool}>{r.tool}</span>
                  <span className="relative order-last col-span-4 h-1.5 overflow-hidden rounded-sm bg-surface-3 sm:order-none sm:col-span-1">
                    <span
                      className="absolute inset-y-0 left-0 rounded-sm"
                      style={{
                        width: `${Math.max(3, (r.ms / spend.maxMs) * 100)}%`,
                        // A tool at or past the 10s ceiling is the finding this
                        // panel exists to surface, not a longer version of a
                        // normal row.
                        backgroundColor: slow ? "hsl(var(--warning))" : "hsl(var(--foreground) / 0.55)",
                      }}
                    />
                  </span>
                  <span
                    className={cn(
                      "text-right font-mono text-data tabular-nums",
                      slow ? "text-[hsl(var(--warning))]" : "text-foreground/90",
                    )}
                    title={slow ? "At or past the 10s ceiling — likely a timeout, not work" : undefined}
                  >
                    {fmtDuration(r.ms)}
                  </span>
                  <span className="text-right font-mono text-data tabular-nums text-muted-foreground">{fmtMicroUsd(r.micro)}</span>
                  <span className="text-right font-mono text-eyebrow tabular-nums text-muted-foreground/70">{r.calls}×</span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <CompactFilter<ActivityFilter>
        label="Filter tool activity"
        options={filters}
        primary={["all", "succeeded", "failed"]}
        active={filter}
        onChange={setFilter}
      />

      {ordered.length === 0 ? (
        <EmptyState icon={Activity} title="No visible tools match this filter" hint="Try a different status filter." />
      ) : (
        <ul className="panel divide-y divide-border-subtle/60 overflow-hidden">
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

/** Micro-USD at a precision that stays readable per row. Zero renders as null:
 *  a column of "$0.0000" on every cached or gated call is noise, and the CACHED
 *  badge already says why nothing was charged. */
function fmtMicroUsd(micro: number | null): string | null {
  if (micro == null || !Number.isFinite(micro) || micro <= 0) return null;
  const usd = micro / 1_000_000;
  if (usd < 0.001) return "<$0.001";
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * Wall-clock, at the precision an analyst actually reads it. Past a minute it
 * is `fmtWallClock`'s "5m 15s" — the same format the Overview prints, so one
 * run's time never reads "315s" on this tab and "5m 15s" on the other.
 */
function fmtDuration(ms: number | null): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return fmtWallClock(ms);
}

function ActivityRowSummary({ e }: { e: ToolEvent }) {
  const secondary = toolSecondaryLine(e);
  return (
    <div className="flex items-start gap-3 sm:items-center">
      <ToolStatusBadge status={e.status} className="mt-px shrink-0 sm:mt-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-meta text-foreground truncate">{e.displayName}</span>
          <span className="hidden font-mono text-micro text-muted-foreground shrink-0 sm:inline">{e.toolName}</span>
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
        {/* Phone width: the display name truncates to "Data Hunter — Ga…", so
            the RAW tool name gets its own line and is never hidden — it is the
            only thing that says which tool actually ran. Desktop shows it
            inline beside the display name, as before. */}
        <div className="font-mono text-micro text-muted-foreground break-all sm:hidden">{e.toolName}</div>
        {/* Title truncates once above; the REASON body carries the full provider
            string — wrap to 2 lines instead of a single-line clip (Phase C3).
            `actionLabel` is derived from `displayName` (the slice after " — ",
            or the whole string when there is no dash), so on a row with no
            reason it restates the title verbatim or as a substring. Render the
            secondary line only when it actually adds information. */}
        {secondary && (
          <div className="text-data text-muted-foreground line-clamp-2 break-words">{secondary}</div>
        )}
        {/* Cost / time / age drop under the text on a phone instead of
            squeezing the tool name down to two characters beside them. */}
        <ActivityRowMeta e={e} className="mt-1 sm:hidden" />
      </div>
      <ActivityRowMeta e={e} className="hidden shrink-0 sm:flex" />
    </div>
  );
}

function ActivityRowMeta({ e, className }: { e: ToolEvent; className?: string }) {
  const duration = fmtDuration(e.durationMs);
  const cost = fmtMicroUsd(e.effectiveChargedMicroUsd);
  // A slow failure is a different problem from a fast one: 30s says the
  // provider hung, 300ms says we never called it. Flag the long tail so the
  // distinction is visible without reading every number.
  const slow = e.durationMs != null && e.durationMs >= 10_000;
  return (
    <div className={cn("flex items-center gap-2.5 text-data tabular-nums", className)}>
      {cost && (
        <span
          className="font-mono text-muted-foreground/80"
          title={`This call was charged ${cost}. Cached calls and gated refusals cost nothing.`}
        >
          {cost}
        </span>
      )}
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
  );
}
