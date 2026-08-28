import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { buildTimelineItems, type TimelineEventType } from "@/lib/intel";
import { useThreadMessages } from "@/hooks/useThreadMessages";
import { captureError } from "@/lib/telemetry";
import { Database, ShieldQuestion, Wrench, XCircle, RotateCcw, FileCheck, Flag, Clock } from "lucide-react";
import { EmptyState } from "./EmptyState";
import { isVacuous } from "@/lib/timeline-explanation";

const ICON: Record<TimelineEventType, React.ComponentType<{ className?: string }>> = {
  seed: Flag,
  triage: ShieldQuestion,
  tool_result: Wrench,
  artifact: Database,
  cache_replay: RotateCcw,
  failed: XCircle,
  report: FileCheck,
};

const COLOR: Record<TimelineEventType, string> = {
  seed: "text-primary border-primary/40 bg-primary/10",
  triage: "text-[hsl(var(--confidence-mid))] border-[hsl(var(--confidence-mid))]/40 bg-[hsl(var(--confidence-mid))]/10",
  tool_result: "text-foreground border-border bg-secondary/40",
  artifact: "text-foreground border-border bg-secondary/40",
  cache_replay: "text-muted-foreground border-border bg-secondary/40",
  failed: "text-destructive border-destructive/40 bg-destructive/10",
  report: "text-[hsl(var(--confidence-high))] border-[hsl(var(--confidence-high))]/40 bg-[hsl(var(--confidence-high))]/10",
};

export function TimelineTab({ threadId, artifacts }: { threadId: string; artifacts: Artifact[] }) {
  const [seed, setSeed] = useState<{ value: string | null; type: string | null; createdAt: string | null } | null>(null);

  useEffect(() => {
    // Guard against a thread-switch race: a slow response for thread A must not
    // overwrite the seed after the user has already switched to thread B.
    let alive = true;
    supabase
      .from("threads")
      .select("seed_value,seed_type,created_at")
      .eq("id", threadId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!alive) return;
        if (error) { captureError(error, "TimelineTab.seedFetch", { threadId }); return; }
        const d = data as { seed_value: string | null; seed_type: string | null; created_at: string } | null;
        if (d) setSeed({ value: d.seed_value, type: d.seed_type, createdAt: d.created_at });
      });
    return () => { alive = false; };
  }, [threadId]);

  const messages = useThreadMessages(threadId);

  const items = useMemo(
    () => buildTimelineItems(artifacts, seed, messages),
    [artifacts, seed, messages],
  );

  if (items.length === 0) {
    return <EmptyState icon={Clock} title="Timeline is empty" hint="Tool calls, artifacts, and report milestones will stream in here." />;
  }

  return (
    <div className="p-3 text-xs">
      <ol className="relative border-l border-border pl-4 space-y-3">
        {items.map((it, i) => {
          const Icon = ICON[it.type];
          const d = new Date(it.time);
          const day = Number.isFinite(d.getTime()) ? d.toLocaleDateString() : null;
          const prev = i > 0 ? new Date(items[i - 1].time) : null;
          const prevDay = prev && Number.isFinite(prev.getTime()) ? prev.toLocaleDateString() : null;
          // The DATE belongs to the day, not to every row in it. A run happens
          // inside a few minutes, so stamping "8/9/2026, 3:14:00 AM" on all
          // forty rows repeats the date forty times and buries the only part
          // that varies — the time.
          const newDay = day !== null && day !== prevDay;
          // "via hunter_verify" under a row already TITLED hunter_verify is the
          // same string twice, two lines apart.
          const showSource = it.source && it.source !== it.title;
          // Drop explanations that only restate the row type ("Tool returned."
          // beneath a row labelled TOOL RESULT). A description that adds nothing
          // still costs a line and a scan stop on every entry.
          const explanation = it.explanation && !isVacuous(it.explanation, it.title) ? it.explanation : null;
          return (
            <li key={it.id} className="relative">
              {newDay && (
                <div className="mb-1.5 font-mono text-eyebrow uppercase tracking-[0.14em] text-muted-foreground/70">
                  {day}
                </div>
              )}
              <span className="absolute -left-[22px] top-1 grid place-items-center w-4 h-4 rounded-full bg-background border border-border">
                <Icon className="w-2.5 h-2.5 text-muted-foreground" />
              </span>
              <div className="rounded-md border border-border bg-card/40 px-2.5 py-2 space-y-0.5">
                <div className="flex items-center justify-between gap-2">
                  <span className={"px-1.5 py-0.5 rounded border font-mono text-eyebrow uppercase tracking-wider " + COLOR[it.type]}>
                    {it.type.replace("_", " ")}
                  </span>
                  <span className="text-data font-mono tabular-nums text-muted-foreground">
                    {Number.isFinite(d.getTime()) ? d.toLocaleTimeString() : "—"}
                  </span>
                </div>
                <div className="font-mono text-foreground break-all">{it.title}</div>
                <div className="text-eyebrow tracking-normal text-muted-foreground">
                  {it.kind ?? "—"}
                  {showSource ? ` · via ${it.source}` : ""}
                  {it.confidence != null ? ` · ${it.confidence}%` : ""}
                </div>
                {explanation && <div className="text-muted-foreground">{explanation}</div>}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
