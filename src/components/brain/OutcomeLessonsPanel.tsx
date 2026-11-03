import { useMemo } from "react";
import { AlertTriangle, Lightbulb, Wrench } from "lucide-react";
import { useToolObservations } from "@/hooks/useToolObservations";
import { deriveOutcomeLessons } from "@/lib/outcome-lessons";
import {
  FAILURE_CLASS_LABEL,
  OBSERVATION_RECENT_DAYS,
  OBSERVATION_WINDOW_DAYS,
} from "@/lib/tool-observation-classes";
import { OBSERVATION_ROW_LIMIT } from "@/hooks/useToolObservations";

/** Live-call lessons for Patterns. Mounted only while that tab is active. */
export function OutcomeLessonsPanel({ userId }: { userId: string }) {
  const state = useToolObservations(userId);
  const lessons = useMemo(() => deriveOutcomeLessons(state.summary), [state.summary]);
  const windowLabel = state.truncated
    ? `newest ${OBSERVATION_ROW_LIMIT.toLocaleString()} live calls`
    : `${OBSERVATION_WINDOW_DAYS}-day live-call window`;

  return (
    <section aria-labelledby="outcome-lessons-title" data-testid="outcome-lessons" className="overflow-hidden rounded-xl border border-border-subtle bg-surface-1/40">
      <div className="border-b border-border-subtle/60 px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Lightbulb className="h-4 w-4 text-primary" strokeWidth={1.75} aria-hidden />
          <h2 id="outcome-lessons-title" className="text-sm font-medium text-foreground">Live outcome lessons</h2>
          <span className="w-full pl-6 font-mono text-data text-muted-foreground sm:ml-auto sm:w-auto sm:pl-0">{windowLabel}</span>
        </div>
        <p className="mt-1.5 max-w-[75ch] text-xs leading-relaxed text-muted-foreground">
          Adaptations are derived only after at least 60% of 5 or more real attempts fail across 2 or more cases in the last {OBSERVATION_RECENT_DAYS} days. They guide source selection and retries, never evidence confidence or identity.
        </p>
      </div>

      {state.loading ? (
        <p className="px-4 py-5 text-xs text-muted-foreground" role="status">Reading live tool outcomes…</p>
      ) : state.error ? (
        <p className="px-4 py-5 text-xs text-muted-foreground" role="alert">
          Live outcomes could not be read ({state.error}). No derived lesson is shown.
        </p>
      ) : state.summary.totals.attempts === 0 ? (
        <p className="px-4 py-5 text-xs text-muted-foreground">No real live-call attempts are recorded in this window.</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-x-5 gap-y-1 border-b border-border-subtle/40 px-4 py-2.5 text-xs text-muted-foreground">
            <span><strong className="font-medium text-foreground">{state.summary.totals.attempts.toLocaleString()}</strong> real attempts</span>
            <span><strong className="font-medium text-foreground">{state.summary.totals.tools.toLocaleString()}</strong> tools observed</span>
            <span><strong className="font-medium text-foreground">{lessons.length}</strong> adaptations</span>
          </div>
          {lessons.length === 0 ? (
            <p className="px-4 py-5 text-xs leading-relaxed text-muted-foreground">
              No tool meets the cross-case failure threshold. Stored lessons and patterns remain below; no new adaptation is inferred.
            </p>
          ) : (
            <ul className="divide-y divide-border-subtle/40">
              {lessons.map((lesson) => (
                <li key={lesson.id} data-testid="outcome-lesson" className="px-4 py-3.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Wrench className="h-3.5 w-3.5 text-primary" strokeWidth={1.75} aria-hidden />
                    <h3 className="font-mono text-xs text-foreground">{lesson.tool}</h3>
                    {lesson.failureClass && (
                      <span className="rounded-full border border-border-subtle px-2 py-0.5 text-micro text-muted-foreground">
                        {FAILURE_CLASS_LABEL[lesson.failureClass]}
                      </span>
                    )}
                  </div>
                  <p className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[hsl(var(--brain-status-warn))]" strokeWidth={1.75} aria-hidden />
                    {lesson.observation}
                  </p>
                  <p className="mt-1.5 text-xs leading-relaxed text-foreground"><span className="font-medium">Next-run adaptation:</span> {lesson.adaptation}</p>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
