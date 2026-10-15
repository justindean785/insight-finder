import { useId, useState, type ReactNode } from "react";
import { Activity, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/** Settled run traffic stays available without displacing the response. */
export function RunActivity({ calls, stages, children }: {
  calls: number;
  stages: number;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  return (
    <section className="run-activity" aria-label="Run activity">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded((value) => !value)}
        className="flex min-h-11 w-full items-center gap-2 px-3 text-left text-[13px] text-muted-foreground transition-colors hover:bg-white/[0.03] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <Activity className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="font-medium">Run activity</span>
        <span className="min-w-0 flex-1 text-[12px] tabular-nums">{calls} call{calls === 1 ? "" : "s"} · {stages} stage{stages === 1 ? "" : "s"}</span>
        <span className="hidden text-[12px] sm:inline">{expanded ? "Hide details" : "Show details"}</span>
        <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 transition-transform", expanded && "rotate-90")} aria-hidden />
      </button>
      <div id={panelId} hidden={!expanded} className="space-y-1 border-t border-border-subtle p-2">
        {children}
      </div>
    </section>
  );
}
