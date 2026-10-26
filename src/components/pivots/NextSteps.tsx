import { useState } from "react";
import { ArrowRight, CheckCircle2, ChevronRight, Loader2, Sparkles } from "lucide-react";
import type { PivotRunView } from "@/lib/pivot-runs";
import { cn } from "@/lib/utils";
import type { PivotEligibility, PivotValidation, RunnablePivot } from "@/lib/pivot-schema";
import { PivotPreview, RepairNotice } from "@/components/pivots/PivotPreview";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import type { ConnectionSummary } from "@/lib/connection-summary";
import { explainPivot, pickBestPivot, requiresPreview } from "@/lib/best-pivot";

/** Queue rows shown before the rest fold behind "N more". */
const QUEUE_VISIBLE = 3;

export type NextStepItem =
  | {
    kind: "pivot";
    key: string;
    validation: PivotValidation;
    /** Null when the suggestion failed validation (it cannot run at all). */
    eligibility: PivotEligibility | null;
  }
  | {
    kind: "action";
    key: string;
    title: string;
    detail: string;
    prompt: string;
  };

/**
 * Next steps — compact action rows under the latest report.
 *
 * One column, full-size type: the old two-column grid of 11px rationales cut
 * the reason mid-sentence at exactly the width where it stopped being a reason.
 * Every Run opens an inline preview first; nothing starts from the row itself.
 *
 * ONLY RUNNABLE STEPS ARE LISTED. A report recommendation the parser could not
 * turn into a selector (a table row, a sentence, a footer) is not a step the
 * analyst can take, and listing it as a card beside real ones is what made the
 * panel read as broken: measured on production 2026-09-25, two of four cards on
 * a finished case were "Suggestion needs repair". They are still disclosed —
 * one quiet line, expandable to the same repair notice and its reasons — so
 * nothing the agent recommended is silently dropped.
 */
export function NextSteps({
  items,
  onRunPivot,
  onRunAction,
  busy = false,
  openKey,
  onOpenChange,
  connections = null,
  artifactsById,
  onOpenGraph,
  runs = [],
  onViewChanges,
}: {
  items: NextStepItem[];
  onRunPivot: (pivot: RunnablePivot) => void;
  onRunAction: (prompt: string) => void;
  busy?: boolean;
  /** Controlled open preview. The transcript re-adopts its messages after load,
   *  which can remount this list; holding the open row above it keeps a preview
   *  the analyst opened from vanishing under them. */
  openKey?: string | null;
  onOpenChange?: (key: string | null) => void;
  /** What the agent has linked so far, from the same graph the Graph tab draws. */
  connections?: ConnectionSummary | null;
  artifactsById?: ReadonlyMap<string, Artifact>;
  onOpenGraph?: () => void;
  /** Pivots this tab started, newest first (`derivePivotRunViews`). The newest
   *  one is shown above the queue as Running, then Completed with its outcome. */
  runs?: PivotRunView[];
  /** Open a row in Evidence. Wired to "View changes" on a completed pivot. */
  onViewChanges?: (artifactId: string) => void;
}) {
  const [localOpen, setLocalOpen] = useState<string | null>(null);
  const open = openKey !== undefined ? openKey : localOpen;
  const setOpen = (k: string | null) => { if (onOpenChange) onOpenChange(k); else setLocalOpen(k); };
  const [showRepair, setShowRepair] = useState(false);
  const [showAllQueue, setShowAllQueue] = useState(false);
  const latestRun = runs[0] ?? null;
  if (items.length === 0 && !latestRun) return null;
  const isRepair = (item: NextStepItem) => item.kind === "pivot" && item.validation.status === "invalid";
  const runnable = items.filter((item) => !isRepair(item));
  const repair = items.filter(isRepair);
  const best = pickBestPivot(runnable);
  const queue = best ? runnable.filter((item) => item !== best) : runnable;
  const shownQueue = showAllQueue ? queue : queue.slice(0, QUEUE_VISIBLE);
  const hiddenQueue = queue.length - shownQueue.length;

  return (
    <section aria-label="Next steps" className="ws-panel-enter w-full overflow-hidden rounded-xl border border-white/[0.08] bg-surface-1">
      <header className="flex h-10 items-center gap-2 border-b border-white/[0.06] px-4 text-data font-medium text-muted-foreground">
        <Sparkles className="h-3.5 w-3.5" aria-hidden />
        Next steps
        <span className="ml-auto font-mono tabular-nums">{runnable.length}</span>
      </header>
      {latestRun && <PivotRunStrip view={latestRun} onViewChanges={onViewChanges} />}
      {best && best.validation.status === "valid" && best.eligibility && (
        <BestPivot
          pivot={best.validation.pivot}
          eligibility={best.eligibility}
          reasons={explainPivot(best.validation.pivot, best.eligibility, artifactsById ?? new Map())}
          isOpen={open === best.key}
          busy={busy}
          onToggle={() => setOpen(open === best.key ? null : best.key)}
          onRunNow={() => onRunPivot((best.validation as { pivot: RunnablePivot }).pivot)}
        />
      )}
      {connections && <ConnectionLine summary={connections} onOpenGraph={onOpenGraph} />}
      {best && queue.length > 0 && (
        <div className="border-t border-white/[0.06] px-4 pb-1 pt-3 text-data font-medium text-muted-foreground">
          Then
        </div>
      )}
      <ul className={cn("divide-y divide-white/[0.06]", !best && "border-t border-white/[0.06]")}>
        {shownQueue.map((item) => {
          const isOpen = open === item.key;
          const pivot = item.kind === "pivot" && item.validation.status === "valid" ? item.validation.pivot : null;
          const title = pivot ? pivot.action : item.kind === "action" ? item.title : "";
          const detail = pivot ? pivot.reason : item.kind === "action" ? item.detail : "";
          const blocked = item.kind === "pivot" && item.eligibility !== null && !item.eligibility.runnable;
          return (
            <li key={item.key} className="px-4 py-3">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                    {pivot && <span className={`pivot-priority pivot-priority--${pivot.priority} shrink-0`}>{pivot.priority}</span>}
                    <span className="text-[14px] font-medium leading-snug text-foreground">{title}</span>
                    {pivot && (
                      <span className="min-w-0 max-w-full truncate font-mono text-[13px] text-foreground/80" title={pivot.target}>
                        {pivot.target}
                      </span>
                    )}
                    {pivot?.status === "searched" && (
                      <span className="rounded border border-white/10 px-1.5 text-micro text-muted-foreground">already searched</span>
                    )}
                  </div>
                  {detail && <p className="mt-1 text-[13px] leading-snug text-muted-foreground">{detail}</p>}
                  {blocked && item.kind === "pivot" && item.eligibility && (
                    <p className="mt-1 text-[13px] leading-snug text-[hsl(var(--danger))]">{item.eligibility.blockers.join(" ")}</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setOpen(isOpen ? null : item.key)}
                  disabled={blocked}
                  aria-expanded={isOpen}
                  aria-label={`${isOpen ? "Close preview for" : "Run"} ${title}${pivot ? ` on ${pivot.target}` : ""}`}
                  className={cn(
                    "inline-flex h-8 shrink-0 items-center gap-1 rounded-md border px-2.5 text-data font-medium transition-colors duration-fast [@media(pointer:coarse)]:h-11",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    blocked
                      ? "cursor-not-allowed border-white/[0.06] text-muted-foreground/60"
                      : isOpen
                        ? "border-[hsl(var(--brand)/0.5)] bg-white/[0.06] text-foreground"
                        : "border-white/12 bg-white/[0.04] text-foreground/90 hover:border-white/20 hover:bg-white/[0.08]",
                  )}
                >
                  {isOpen ? "Close" : "Run"}
                  {!isOpen && <ArrowRight className="h-3.5 w-3.5 opacity-70" aria-hidden />}
                </button>
              </div>
              {isOpen && pivot && item.kind === "pivot" && item.eligibility && (
                <PivotPreview
                  pivot={pivot}
                  eligibility={item.eligibility}
                  busy={busy}
                  onCancel={() => setOpen(null)}
                  onStart={() => { setOpen(null); onRunPivot(pivot); }}
                />
              )}
              {isOpen && item.kind === "action" && (
                <div className="ws-panel-enter mt-2 rounded-lg border border-white/[0.09] bg-surface-2/70 p-3">
                  <div className="text-data font-semibold text-foreground">This starts a new agent run on the case</div>
                  <p className="mt-1.5 text-[13px] leading-snug text-muted-foreground">
                    It sends: <span className="text-foreground/90">“{item.prompt}”</span>
                  </p>
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => { setOpen(null); onRunAction(item.prompt); }}
                      className="inline-flex h-8 items-center rounded-lg bg-white px-3 text-data font-semibold text-black transition-colors duration-fast hover:bg-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 [@media(pointer:coarse)]:h-11"
                    >
                      Send
                    </button>
                    <button
                      type="button"
                      onClick={() => setOpen(null)}
                      className="inline-flex h-8 items-center rounded-lg px-3 text-data font-medium text-muted-foreground hover:bg-white/[0.05] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:h-11"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {hiddenQueue > 0 && (
        <button
          type="button"
          onClick={() => setShowAllQueue(true)}
          className="flex w-full items-center gap-1.5 border-t border-white/[0.06] px-4 py-2.5 text-left text-[12.5px] text-faint-foreground transition-colors duration-fast hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [@media(pointer:coarse)]:min-h-11"
        >
          <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {hiddenQueue} more {hiddenQueue === 1 ? "step" : "steps"}
        </button>
      )}
      {repair.length > 0 && (
        <div className={cn(runnable.length > 0 && "border-t border-white/[0.06]")}>
          <button
            type="button"
            onClick={() => setShowRepair((v) => !v)}
            aria-expanded={showRepair}
            className="flex w-full items-center gap-1.5 px-4 py-2.5 text-left text-[12.5px] text-faint-foreground transition-colors duration-fast hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [@media(pointer:coarse)]:min-h-11"
          >
            <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 transition-transform duration-fast", showRepair && "rotate-90")} aria-hidden />
            {repair.length === 1
              ? "1 suggestion from the report couldn't be turned into a runnable step"
              : `${repair.length} suggestions from the report couldn't be turned into runnable steps`}
          </button>
          {showRepair && (
            <ul className="divide-y divide-white/[0.06] border-t border-white/[0.06]">
              {repair.map((item) =>
                item.kind === "pivot" && item.validation.status === "invalid" ? (
                  <li key={item.key} className="flex items-start gap-3 px-4 py-3 opacity-90">
                    <RepairNotice action={item.validation.action} target={item.validation.target} problems={item.validation.problems} />
                  </li>
                ) : null,
              )}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * The pivot worth running first, with the reasons it is first.
 *
 * "Run now" starts it without the preview ONLY when the eligibility check has
 * nothing to warn about. A quarantined source, a rerun or a low-confidence lead
 * carries a warning, and for those the primary action opens the same preview
 * every other row uses, so the analyst reads what the result will be worth.
 */
function BestPivot({ pivot, eligibility, reasons, isOpen, busy, onToggle, onRunNow }: {
  pivot: RunnablePivot;
  eligibility: PivotEligibility;
  reasons: string[];
  isOpen: boolean;
  busy: boolean;
  onToggle: () => void;
  onRunNow: () => void;
}) {
  const needsReview = requiresPreview(eligibility);
  return (
    <div className="px-4 py-4" data-testid="best-pivot">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-data text-muted-foreground">
        <span className={`pivot-priority pivot-priority--${pivot.priority} shrink-0`}>{pivot.priority}</span>
        <span>Best next pivot</span>
      </div>
      <div className="mt-2 text-[15px] font-medium leading-snug text-foreground">{pivot.action}</div>
      <div className="mt-1 break-all font-mono text-[18px] leading-snug text-foreground" title={pivot.target}>{pivot.target}</div>
      {reasons.length > 0 && (
        <p className="mt-2 max-w-[68ch] text-[13.5px] leading-relaxed text-muted-foreground">{reasons.join(" ")}</p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy && !needsReview}
          onClick={needsReview ? onToggle : onRunNow}
          aria-label={`${needsReview ? "Review and run" : busy ? "Runs after the current pivot" : "Run now"}: ${pivot.action} on ${pivot.target}`}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-white px-3.5 text-data font-semibold text-black transition-colors duration-fast hover:bg-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 [@media(pointer:coarse)]:h-11"
        >
          {needsReview ? "Review and run" : busy ? "Waiting for current run" : "Run now"}
          {!busy && <ArrowRight className="h-3.5 w-3.5" aria-hidden />}
        </button>
        {!needsReview && (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={isOpen}
            aria-label={`${isOpen ? "Close preview for" : "Preview"} ${pivot.action} on ${pivot.target}`}
            className="inline-flex h-9 items-center rounded-lg px-3 text-data font-medium text-muted-foreground hover:bg-white/[0.05] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:h-11"
          >
            {isOpen ? "Close preview" : "Preview"}
          </button>
        )}
      </div>
      {isOpen && (
        <PivotPreview pivot={pivot} eligibility={eligibility} busy={busy} onCancel={onToggle} onStart={onRunNow} />
      )}
    </div>
  );
}

const clock = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

/**
 * The pivot this tab last started: Running while the case runs, then Completed
 * with what changed. The count is rows created SINCE it was sent, worded that
 * way on purpose — the agent can follow other leads in the same run, so this is
 * a measurement of the window, never a claim about what the pivot found.
 */
function PivotRunStrip({ view, onViewChanges }: { view: PivotRunView; onViewChanges?: (artifactId: string) => void }) {
  const { run, phase, newRows } = view;
  const n = newRows.length;
  const rows = `${n} new ${n === 1 ? "record" : "records"}`;
  const running = phase === "running";
  return (
    <div
      role="status"
      data-testid="pivot-run"
      data-phase={phase}
      className={cn(
        "flex items-start gap-2.5 border-b border-white/[0.06] px-4 py-3",
        running ? "bg-[hsl(var(--brand)/0.06)]" : "bg-surface-2/40",
      )}
    >
      {running
        ? <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-[hsl(var(--brand))] motion-reduce:animate-none" aria-hidden />
        : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />}
      <div className="min-w-0 flex-1">
        <div className="text-data font-medium text-foreground">
          {running ? "Running" : "Pivot completed"}
          <span className="text-muted-foreground"> · {run.action} </span>
          <span className="inline-block max-w-full truncate align-bottom font-mono text-[12.5px] text-foreground/90" title={run.target}>{run.target}</span>
        </div>
        <p className="mt-0.5 text-[12.5px] text-muted-foreground">
          {running
            ? `Since ${clock(run.sentAt)} · ${n > 0 ? `${rows} so far` : "no new records yet"}`
            : n > 0 ? `${rows} since it was sent` : "No new records since it was sent"}
        </p>
      </div>
      {!running && n > 0 && onViewChanges && (
        <button
          type="button"
          onClick={() => onViewChanges(newRows[0].id)}
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-data font-medium text-foreground/90 hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:h-11"
        >
          View changes
          <ArrowRight className="h-3.5 w-3.5 opacity-70" aria-hidden />
        </button>
      )}
    </div>
  );
}

/** One line of what the agent has connected so far. Quarantined rows are named, never counted. */
function ConnectionLine({ summary, onOpenGraph }: { summary: ConnectionSummary; onOpenGraph?: () => void }) {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const parts = [
    plural(summary.entities, "entity", "entities"),
    plural(summary.links, "shared link", "shared links"),
    plural(summary.clusters, "cluster", "clusters"),
  ];
  if (summary.unlinked > 0) parts.push(`${summary.unlinked} tied to the seed only by discovery`);
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-white/[0.06] px-4 py-3 text-[13px] text-muted-foreground" data-testid="connection-line">
      <span className="font-medium text-foreground/90">Connected so far</span>
      <span className="tabular-nums">{parts.join(", ")}</span>
      {summary.withheld > 0 && (
        <span className="text-faint-foreground">{summary.withheld} withheld as unproven, not counted</span>
      )}
      {onOpenGraph && (
        <button type="button" onClick={onOpenGraph} className="ml-auto rounded-sm text-foreground/90 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Open graph
        </button>
      )}
    </div>
  );
}
