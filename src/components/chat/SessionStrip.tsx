import { Loader2, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time";

/**
 * The Investigate session strip (Case desk R5, JD's prototype 2026-11-02): one
 * 49px line above the transcript that says whether the agent is working, for
 * how long, on how many tools — and offers Stop while it is.
 *
 * Every figure is one ChatWindow already holds: `running` is useChat's own
 * streaming state settled against the server run, `elapsedLabel` the run
 * clock, `toolCount` the tool parts on the live message, `totalCalls` /
 * `lastAt` the case snapshot's ledger. Nothing here is a new path to a run.
 * The Stop control is the same `stopInvestigation` the composer's primary
 * button calls; it carries a different accessible name ("Stop run") so the
 * composer's "Stop investigation" stays the one button of that name.
 */
export function SessionStrip({
  running, stopping = false, canStop = false, title, elapsedLabel, toolCount, stages = [], totalCalls, lastAt, onStop, className,
}: {
  running: boolean;
  /** The run's stages so far, in order; the last is current while running. */
  stages?: string[];
  stopping?: boolean;
  canStop?: boolean;
  /** The run word when idle: "Complete", "Ready", "Interrupted", "Stopped". */
  title: string;
  /** "0:18" while running. */
  elapsedLabel: string;
  /** Tool parts on the live message while running. */
  toolCount: number;
  /** The case's recorded tool calls (null until read). */
  totalCalls: number | null;
  lastAt: string | null;
  onStop: () => void;
  className?: string;
}) {
  return (
    <div
      data-session-strip
      className={cn(
        "flex shrink-0 items-center justify-between gap-3 border-b border-border-subtle bg-[hsl(var(--surface-1))] px-5 text-[11px] text-subtle-foreground lg:px-7",
        // Idle, the strip only restates the header; it keeps a slimmer line. Running, it carries the stages and Stop.
        running ? "h-11" : "h-8",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="relative flex h-1.5 w-1.5 shrink-0" aria-hidden>
          {running && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[hsl(var(--confidence-high))] opacity-60 motion-reduce:animate-none" />}
          <span className={cn("relative inline-flex h-1.5 w-1.5 rounded-full", running ? "bg-[hsl(var(--confidence-high))]" : "bg-muted-foreground/50")} />
        </span>
        <b className="truncate text-[12px] font-medium text-foreground/90">{running ? "Agent investigating" : title}</b>
        {running && stages.length > 0 ? (
          <span className="hidden items-center gap-3 sm:inline-flex" data-session-plan aria-label="Run stages">
            {stages.map((st, i) => {
              const current = i === stages.length - 1;
              return (
                <span key={st} className={cn("inline-flex items-center gap-1", current ? "text-[hsl(var(--brand))]" : "text-[hsl(var(--confidence-high)/0.85)]")}>
                  <span aria-hidden>{current ? "◌" : "✓"}</span>{st}
                </span>
              );
            })}
          </span>
        ) : (
          <span className="hidden truncate text-faint-foreground sm:inline">{running ? "live session" : "AI assessment · analyst-directed"}</span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span className="font-mono tabular-nums text-faint-foreground" data-session-time>
          {running
            ? `${elapsedLabel} · ${toolCount} tool${toolCount === 1 ? "" : "s"}`
            : totalCalls === null
              ? ""
              : `${totalCalls} tool call${totalCalls === 1 ? "" : "s"}${lastAt ? ` · ${timeAgo(lastAt)}` : ""}`}
        </span>
        {canStop && (
          <button
            type="button"
            onClick={onStop}
            disabled={stopping}
            aria-label={stopping ? "Stopping the run" : "Stop run"}
            className="inline-flex h-6 items-center gap-1.5 rounded border border-[hsl(var(--brand)/0.35)] px-2 text-[11px] text-[hsl(var(--brand))] hover:bg-[hsl(var(--brand)/0.1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          >
            {stopping ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Square className="h-2.5 w-2.5 fill-current" aria-hidden />}
            {stopping ? "Stopping…" : "Stop"}
          </button>
        )}
      </div>
    </div>
  );
}
