import { useThreadToolHealth, type ToolHealthRow } from "@/hooks/useThreadToolHealth";
import { CheckCircle2, XCircle, MinusCircle, CircleSlash, Activity } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Tool Health — per-tool rollup from the authoritative `tool_usage_log.outcome`
 * record. Surfaces tools that FAILED (bad key, rejected format, upstream error)
 * which would otherwise only appear buried in chat. Read-only; display of an
 * already-recorded outcome (no scoring/classification here).
 */

function StatCount({ icon: Icon, label, value, tone }: {
  icon: typeof CheckCircle2; label: string; value: number;
  tone: "ok" | "failed" | "skipped" | "empty";
}) {
  const toneCls = {
    ok: "text-conf-confirmed",
    failed: "text-destructive",
    skipped: "text-muted-foreground",
    empty: "text-muted-foreground/80",
  }[tone];
  return (
    <div className="flex items-center gap-2 rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2">
      <Icon className={cn("h-4 w-4 shrink-0", toneCls)} aria-hidden />
      <div className="min-w-0">
        <div className="font-mono tabular-nums text-sm leading-none text-foreground">{value}</div>
        <div className="text-micro tracking-normal text-muted-foreground">{label}</div>
      </div>
    </div>
  );
}

function HealthRow({ row }: { row: ToolHealthRow }) {
  const hasFailure = row.failed > 0;
  return (
    <div
      className={cn(
        "rounded-xl border px-3 py-2.5 text-xs",
        hasFailure ? "border-destructive/30 bg-destructive/[0.05]" : "border-white/8 bg-white/[0.02]",
      )}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-mono text-foreground/90 truncate" title={row.toolName}>{row.toolName}</span>
        <span className="ml-auto flex items-center gap-2 font-mono tabular-nums text-micro">
          {row.ok > 0 && <span className="text-conf-confirmed" title="succeeded"><CheckCircle2 className="inline h-3 w-3 mr-0.5" />{row.ok}</span>}
          {row.failed > 0 && <span className="text-destructive" title="failed"><XCircle className="inline h-3 w-3 mr-0.5" />{row.failed}</span>}
          {row.skipped > 0 && <span className="text-muted-foreground" title="skipped (governance)"><CircleSlash className="inline h-3 w-3 mr-0.5" />{row.skipped}</span>}
          {row.empty > 0 && <span className="text-muted-foreground/80" title="empty (no record found)"><MinusCircle className="inline h-3 w-3 mr-0.5" />{row.empty}</span>}
        </span>
      </div>
      {hasFailure && row.lastError && (
        <div className="mt-1.5 rounded-md border border-destructive/20 bg-black/30 px-2 py-1 font-mono text-micro leading-snug text-destructive/90 break-words [overflow-wrap:anywhere]">
          {row.lastStatusCode != null && <span className="mr-1 opacity-70">HTTP {row.lastStatusCode}</span>}
          {row.lastError}
        </div>
      )}
    </div>
  );
}

export function ToolHealthPanel({ threadId }: { threadId: string }) {
  const { rows, totals, failing, loading, error } = useThreadToolHealth(threadId);

  if (loading) {
    return (
      <div className="p-3 space-y-2" aria-busy="true" aria-label="Loading tool health">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-12 rounded-xl bg-white/[0.04] animate-pulse" />)}
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
        <p>Once the agent runs tools, their health (succeeded / failed / skipped / empty) appears here.</p>
      </div>
    );
  }

  return (
    <div className="p-3 space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <StatCount icon={CheckCircle2} label="Succeeded" value={totals.ok} tone="ok" />
        <StatCount icon={XCircle} label="Failed" value={totals.failed} tone="failed" />
        <StatCount icon={CircleSlash} label="Skipped" value={totals.skipped} tone="skipped" />
        <StatCount icon={MinusCircle} label="Empty" value={totals.empty} tone="empty" />
      </div>

      {failing.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-micro font-semibold tracking-normal text-destructive/80 flex items-center gap-1.5">
            <XCircle className="h-3 w-3" /> Failing tools ({failing.length}) — need attention
          </div>
          {failing.map((r) => <HealthRow key={`fail-${r.toolName}`} row={r} />)}
        </div>
      )}

      <div className="space-y-1.5">
        <div className="text-micro font-semibold tracking-normal text-muted-foreground">All tools ({rows.length})</div>
        {rows.map((r) => <HealthRow key={r.toolName} row={r} />)}
      </div>
    </div>
  );
}
