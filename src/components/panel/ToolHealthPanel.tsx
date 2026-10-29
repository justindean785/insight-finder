import { useThreadToolHealth, type ToolHealthRow } from "@/hooks/useThreadToolHealth";
import { CANONICAL_OUTCOME_META, groupOutcomeCounts, type CanonicalOutcome } from "@/lib/tool-outcome";
import { CheckCircle2, XCircle, MinusCircle, CircleSlash, Activity, Clock, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Tool Health — per-tool rollup from the authoritative `tool_usage_log`, refined
 * through the CANONICAL outcome taxonomy (`src/lib/tool-outcome.ts`) so honest
 * distinctions the raw `outcome` column collapses are restored:
 *   • Timed-out / rate-limited / access-denied / legally-blocked calls read as
 *     DEGRADED (amber), not as red hard failures.
 *   • Governance skips (dedup, budget, in-flight, "already ran") read as SKIPPED.
 *   • Only config/key errors, genuine provider faults, and opaque unknowns are
 *     "needs attention".
 * Read-only; display of an already-recorded outcome.
 */

// Tone → tailwind text color for the summary tiles / counts.
const TONE_CLS = {
  ok: "text-conf-confirmed",
  empty: "text-muted-foreground/80",
  skipped: "text-muted-foreground",
  degraded: "text-warning",
  failed: "text-destructive",
} as const;

function StatCount({ icon: Icon, label, value, tone, hint }: {
  icon: typeof CheckCircle2; label: string; value: number;
  tone: keyof typeof TONE_CLS; hint?: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2" title={hint}>
      <Icon className={cn("h-4 w-4 shrink-0", TONE_CLS[tone])} aria-hidden />
      <div className="min-w-0">
        <div className="font-mono tabular-nums text-sm leading-none text-foreground">{value}</div>
        <div className="text-micro tracking-normal text-muted-foreground">{label}</div>
      </div>
    </div>
  );
}

// The canonical categories worth showing as an inline chip on a tool row,
// in severity order. `success`/`empty` are implied by the OK/none counts.
const CHIP_ORDER: CanonicalOutcome[] = [
  "success", "failed", "config_error", "unknown",
  "timeout", "rate_limited", "http_denied", "blocked",
  "cancelled", "skipped", "empty",
];

function HealthRow({ row }: { row: ToolHealthRow }) {
  const attention = row.needsAttention;
  return (
    <div
      className={cn(
        "rounded-xl border px-3 py-2.5 text-xs",
        attention
          ? "border-destructive/30 bg-destructive/[0.05]"
          : row.counts.timeout + row.counts.rate_limited + row.counts.http_denied + row.counts.blocked > 0
            ? "border-warning/25 bg-warning/[0.03]"
            : "border-white/8 bg-white/[0.02]",
      )}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-mono text-foreground/90 truncate" title={row.toolName}>{row.toolName}</span>
        <span className="ml-auto flex items-center gap-1.5 font-mono tabular-nums text-micro">
          {CHIP_ORDER.filter((c) => row.counts[c] > 0).map((c) => {
            const meta = CANONICAL_OUTCOME_META[c];
            return (
              <span key={c} className={TONE_CLS[meta.tone]} title={`${meta.longLabel}: ${row.counts[c]}`}>
                {meta.label} {row.counts[c]}
              </span>
            );
          })}
        </span>
      </div>
      {row.lastIssue && (
        <div
          className={cn(
            "mt-1.5 rounded-md border bg-black/30 px-2 py-1 font-mono text-micro leading-snug break-words [overflow-wrap:anywhere]",
            // An explanation on a row that does not need attention (LeakCheck 403) is information, not a fault.
            row.lastIssue.informational ? "border-warning/20 text-warning/90" : "border-destructive/30 text-foreground/90",
          )}
        >
          {row.lastIssue.statusCode != null && <span className="mr-1 opacity-70">HTTP {row.lastIssue.statusCode}</span>}
          {row.lastIssue.message}
          {row.lastIssue.detail && (
            <details className="mt-1 text-faint-foreground">
              <summary className="cursor-pointer select-none">Details</summary>
              <code className="mt-1 block whitespace-pre-wrap break-words">{row.lastIssue.detail}</code>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

export function ToolHealthPanel({ threadId }: { threadId: string }) {
  const { rows, totals, attention, loading, error } = useThreadToolHealth(threadId);

  if (loading) {
    return (
      <div className="p-3 space-y-2" aria-busy="true" aria-label="Loading tool health">
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          {[0, 1, 2, 3, 4].map((i) => <div key={i} className="h-12 rounded-xl bg-white/[0.04] animate-pulse" />)}
        </div>
        {[0, 1, 2].map((i) => <div key={i} className="h-10 rounded-xl bg-white/[0.03] animate-pulse" />)}
      </div>
    );
  }

  if (error) {
    return <div className="p-4 text-xs text-destructive">Couldn't load tool health: {error}</div>;
  }

  if (totals.total === 0) {
    return (
      <div className="p-4 text-xs text-muted-foreground space-y-1.5">
        <div className="flex items-center gap-1.5"><Activity className="h-3.5 w-3.5" /> No tool calls recorded yet.</div>
        <p>Once the agent runs tools, their health (succeeded / degraded / skipped / needs-attention) appears here.</p>
      </div>
    );
  }

  // The five tiles are `groupOutcomeCounts` — the SAME grouping the Activity
  // tally uses (useThreadToolActivity → tallyToolEvents), so the two panels
  // print the same numbers for the same rows. Define a group there, never here.
  const groups = groupOutcomeCounts(totals);
  const degraded = groups.degraded;
  const skipped = groups.skipped;
  // CALLS whose category is a hard fault. Deliberately NOT the same number as
  // the "Needs attention" section below, which counts TOOLS and also escalates
  // on repetition (REPEAT_FAILURE_FLOOR) — a tool denied 3× has zero faulted
  // calls and still belongs in that list. Both numbers were previously labelled
  // "Needs attention", so a case with 3 rapidapi 403s rendered a "0" tile
  // directly above a red "Needs attention (1)" card. They answer different
  // questions; they now say which. Keep this one a member of the five-tile
  // partition (success + empty + skipped + degraded + faulted == totals.total)
  // — swapping in the tool count silently breaks that sum.
  const faultedCalls = groups.faulted;

  return (
    <div className="p-3 space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <StatCount icon={CheckCircle2} label="Succeeded" value={groups.succeeded} tone="ok" hint="Genuine successes" />
        <StatCount icon={MinusCircle} label="No record" value={groups.no_record} tone="empty" hint="Ran fine, target has no data (expected)" />
        <StatCount icon={CircleSlash} label="Skipped" value={skipped} tone="skipped" hint="Governance / dedup / cancelled — intentionally not run" />
        <StatCount icon={Clock} label="Degraded" value={degraded} tone="degraded" hint="Timed out / rate-limited / denied / blocked — transient, not breakage" />
        <StatCount
          icon={ShieldAlert}
          label="Faulted"
          value={faultedCalls}
          tone="failed"
          hint={
            "Calls that hit a config/key error, a genuine provider fault, or an opaque unknown. " +
            "Tools to act on are listed under Needs attention below — a tool can need attention " +
            "with zero faulted calls (e.g. denied every time)."
          }
        />
      </div>

      {attention.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-micro font-semibold tracking-normal text-destructive/80 flex items-center gap-1.5">
            <XCircle className="h-3 w-3" /> Needs attention ({attention.length}) — faults, or tried repeatedly with nothing back
          </div>
          {attention.map((r) => <HealthRow key={`att-${r.toolName}`} row={r} />)}
        </div>
      )}

      {/* The escalated tools are NOT repeated here.
          "Needs attention" already renders each faulting tool with its full
          error block; listing them again at the top of "All tools" printed the
          same tool name and the same two-line provider error twice on one
          screen, which reads as two separate faults until you look closely.
          The inventory stays complete — it just starts below what was already
          escalated, and says so. */}
      <div className="space-y-1.5">
        <div className="text-micro font-semibold tracking-normal text-muted-foreground">
          {attention.length > 0
            ? `Other tools (${rows.length - attention.length})`
            : `All tools (${rows.length})`}
        </div>
        {rows
          .filter((r) => !attention.some((a) => a.toolName === r.toolName))
          .map((r) => <HealthRow key={r.toolName} row={r} />)}
      </div>
    </div>
  );
}
