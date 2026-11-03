import { useMemo } from "react";
import { AlertTriangle, ArrowRight, Link2 } from "lucide-react";
import { useAgentAssessment } from "@/hooks/useAgentAssessment";
import { useOptionalCaseSnapshot } from "@/hooks/useCaseSnapshot";
import { useOptionalWorkspaceUIState } from "@/hooks/useWorkspaceUIState";
import { formatDelta, LINKAGE_ATTENTION_BELOW } from "@/lib/agent-assessment";
import { cn } from "@/lib/utils";

const CONNECTION_ROWS = 3;

/**
 * The transcript's inline assessment cards (Case desk R5): "Connections
 * identified" — the rows the R2 engine links to the subject, strongest first,
 * each with its linkage figure and the change since the previous assessment —
 * and a contradiction callout for the first row that contradicts the case
 * record. Both read the SAME assessment the Finding panel and the Evidence
 * ledger show, so the transcript cannot say one thing and the ledger another.
 *
 * Clicking a row selects it (the Finding tab opens on it); "Inspect evidence"
 * goes to the Evidence tab. Read-only over the engine: no new score, no run.
 * Rendered only once a case has artifacts and no run is streaming, so a live
 * run's narration is never interleaved with a stale card.
 */
export function AgentAssessmentCards({ threadId, className }: { threadId: string; className?: string }) {
  const assessment = useAgentAssessment(threadId);
  const snapshot = useOptionalCaseSnapshot()?.snapshot ?? null;
  const ui = useOptionalWorkspaceUIState();
  const items = useMemo(() => snapshot?.items ?? [], [snapshot?.items]);
  const byId = useMemo(() => new Map(items.map((a) => [a.id, a] as const)), [items]);

  const connections = useMemo(() => {
    const r = assessment.report;
    if (!r) return [];
    return r.items
      .filter((a) => a.group === "supported" && !a.isSeed && a.subjectLinkage !== null && byId.has(a.artifactId))
      .sort((a, b) => (b.subjectLinkage ?? 0) - (a.subjectLinkage ?? 0) || a.artifactId.localeCompare(b.artifactId))
      .slice(0, CONNECTION_ROWS);
  }, [assessment.report, byId]);

  const conflict = useMemo(() => {
    const r = assessment.report;
    if (!r) return null;
    return r.items.find((a) => a.group === "conflict" && byId.has(a.artifactId)) ?? null;
  }, [assessment.report, byId]);

  if (!assessment.report || (connections.length === 0 && !conflict)) return null;

  const select = (id: string) => {
    if (ui) { ui.rememberOpener(`chat-connection-${id}`); ui.select(id); }
    else window.dispatchEvent(new CustomEvent("swarmbot:navigate", { detail: { tab: "artifacts", artifactId: id } }));
  };

  return (
    <div className={cn("flex flex-col gap-3", className)} data-assessment-cards>
      {connections.length > 0 && (
        <section aria-label="Connections identified" className="overflow-hidden rounded-[7px] border border-border bg-[hsl(var(--surface-1))]">
          <header className="flex items-center gap-2 border-b border-border-subtle bg-[hsl(var(--surface-2))] px-3 py-2.5 text-[11px] text-muted-foreground">
            <Link2 className="h-3.5 w-3.5 text-[hsl(var(--confidence-high))]" aria-hidden />
            <span>Connections identified</span>
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent("swarmbot:navigate", { detail: { tab: "artifacts" } }))}
              className="ml-auto inline-flex items-center gap-1 text-[11px] text-subtle-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Inspect evidence <ArrowRight className="h-3 w-3" aria-hidden />
            </button>
          </header>
          <ul>
            {connections.map((c) => {
              const a = byId.get(c.artifactId)!;
              const l = c.subjectLinkage ?? 0;
              const d = assessment.delta(c.artifactId);
              const change = d ? formatDelta(d.linkage) : null;
              return (
                <li key={c.artifactId} className="border-b border-border-subtle last:border-0">
                  <button
                    type="button"
                    id={`chat-connection-${c.artifactId}`}
                    onClick={() => select(c.artifactId)}
                    className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5 text-left text-[12px] text-foreground/90 hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-mono" title={a.value}>{a.value}</span>
                      <small className="mt-0.5 block truncate text-[11px] text-subtle-foreground">{c.reasons[0] ?? a.kind}</small>
                    </span>
                    <span className={cn("shrink-0 text-right text-[12px] tabular-nums", l < LINKAGE_ATTENTION_BELOW ? "text-[hsl(var(--warning))]" : "text-[hsl(var(--confidence-high))]")}>
                      {Math.round(l)}% linkage
                      {change && <small className="ml-1 text-[11px]">{(d?.linkage ?? 0) > 0 ? "↑" : "↓"} {Math.abs(Math.round(d?.linkage ?? 0))}</small>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {conflict && (
        <div
          role="note"
          aria-label="Contradiction"
          className="rounded-lg border border-[hsl(var(--warning)/0.25)] bg-[hsl(var(--warning)/0.08)] px-3.5 py-3 text-[13px] leading-relaxed text-[hsl(var(--warning))]"
        >
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
            <strong className="font-semibold">Contradiction</strong>
            <span className="text-[hsl(var(--warning)/0.8)]">·</span>
            <button
              type="button"
              onClick={() => select(conflict.artifactId)}
              className="-ml-1 inline-flex min-h-11 items-center rounded px-1 font-mono [overflow-wrap:anywhere] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8"
            >
              {byId.get(conflict.artifactId)!.value}
            </button>
          </div>
          <p className="mt-1 pl-[22px] text-muted-foreground">{conflict.opposing[0] ?? conflict.verdict}</p>
        </div>
      )}
    </div>
  );
}
