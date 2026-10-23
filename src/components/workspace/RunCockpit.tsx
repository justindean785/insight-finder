import { useEffect, useState } from "react";
import { RuleLabel } from "@/components/ui/authority";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time";
import { buildRunCockpit, type RunCockpitInput } from "@/lib/run-cockpit";

/**
 * The run at a glance: what state it is in, how long it has gone, what it last
 * did, why it stopped and what is waiting on the analyst. Read-only — there is
 * no control here that steers the run, and every figure is one the workspace
 * already holds (see lib/run-cockpit.ts for what is deliberately left out).
 */
export function RunCockpit({ input, onOpenDecisions, onOpenTools }: {
  input: Omit<RunCockpitInput, "nowMs">;
  onOpenDecisions: () => void;
  onOpenTools: () => void;
}) {
  const live = input.run.state === "running";
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [live]);

  const c = buildRunCockpit({ ...input, nowMs: now });
  const notRecorded = <span className="text-faint-foreground">not recorded</span>;

  return (
    <section className="panel panel-flat overflow-hidden" aria-label="Run status">
      <RuleLabel
        right={
          <span className={cn("inline-flex items-center gap-1.5 text-micro", live ? "text-foreground" : "text-muted-foreground")}>
            {live && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--brand))] animate-pulse motion-reduce:animate-none" />}
            {c.stateLabel}
          </span>
        }
      >
        Run
      </RuleLabel>
      <dl className="grid gap-x-6 gap-y-2 p-3 text-data sm:grid-cols-2 lg:grid-cols-3">
        <div className="min-w-0">
          <dt className="text-micro text-muted-foreground">Elapsed</dt>
          <dd className="font-mono tabular-nums text-foreground">
            {c.elapsed ? <>{c.elapsed} <span className="font-sans text-micro text-faint-foreground">wall clock, {c.elapsedBasis}</span></> : notRecorded}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-micro text-muted-foreground">Stage</dt>
          <dd className="truncate text-foreground">{c.stage ?? notRecorded}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-micro text-muted-foreground">Last action</dt>
          <dd className="min-w-0">
            {c.lastAction ? (
              <button type="button" onClick={onOpenTools} className="block max-w-full truncate text-left text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm">
                {c.lastAction.action}
                <span className="text-micro text-faint-foreground"> · {c.lastAction.status} · {timeAgo(c.lastAction.at)}</span>
              </button>
            ) : <span className="text-faint-foreground">no calls yet</span>}
            {c.lastAction && (
              <span className="block text-micro text-faint-foreground" title="Inferred from the tool's name, not a recorded actor">
                {c.lastAction.role} role (inferred)
              </span>
            )}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-micro text-muted-foreground">Tool calls</dt>
          <dd className="font-mono tabular-nums text-foreground">
            {c.calls === null ? "—" : c.calls}
            {c.failed !== null && c.failed > 0 && <span className="text-[hsl(var(--danger))]"> · {c.failed} failed</span>}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-micro text-muted-foreground">Spend</dt>
          <dd className="font-mono tabular-nums text-foreground">{c.spend}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-micro text-muted-foreground">Waiting on you</dt>
          <dd>
            {c.pendingDecisions === null ? notRecorded : c.pendingDecisions > 0 ? (
              <button type="button" onClick={onOpenDecisions} className="text-left text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm">
                {c.pendingDecisions} need{c.pendingDecisions === 1 ? "s" : ""} your call
              </button>
            ) : <span className="text-muted-foreground">nothing</span>}
          </dd>
        </div>
      </dl>
      {c.stop && (
        <div
          className={cn(
            "border-t border-border-subtle px-3 py-2 text-data",
            c.stop.tone === "warning" ? "text-[hsl(var(--authority-review))]" : "text-muted-foreground",
          )}
          data-testid="run-cockpit-stop"
        >
          <span className="font-medium text-foreground">{c.stop.tone === "done" ? "Why it ended: " : "Why it stopped: "}</span>
          {c.stop.title}. <span className="text-muted-foreground">{c.stop.message}</span>
          {c.stop.detail && <span className="block truncate text-micro text-faint-foreground" title={c.stop.detail}>{c.stop.detail}</span>}
        </div>
      )}
    </section>
  );
}
