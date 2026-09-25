import { useMemo } from "react";
import { ArrowRight } from "lucide-react";
import { useCaseSnapshot } from "@/hooks/useCaseSnapshot";
import { useReviewStates } from "@/lib/review";
import { AuthorityChip, AuthorityCaveat } from "@/components/ui/authority";
import { AUTHORITY_LEGEND, type AuthorityState } from "@/lib/authority";
import { isProseValue } from "@/lib/evidence-bands";
import { buildCaseSheet, ASK_LABEL, type CaseSheetModel } from "@/lib/case-sheet";
import { cn } from "@/lib/utils";

/**
 * The case sheet — the right-hand column of the 3a "Case desk" layout, beside
 * the transcript and the report. It answers three questions without leaving the
 * conversation: who does the evidence name, how much of it holds, and what is
 * waiting on the analyst.
 *
 * READ-ONLY, deliberately. A row that needs a call hands off to the Evidence
 * board, where the release control ("whose is this?") and the review verdict
 * ("is this real?") already live with their confirmations. Those are two
 * different decisions with two different writers; putting inline buttons for
 * them here is its own change, not a layout change.
 *
 * Every figure comes from `buildCaseSheet`, which only calls the engine's
 * `authorityFor` / `pickSubjectName` over the snapshot's rows.
 */

const HINT = new Map(AUTHORITY_LEGEND.map((e) => [e.state, e.hint]));

function fill(state: AuthorityState): string {
  // Quarantine keeps its hatch and never gets a hue of its own.
  return state === "quarantined"
    ? "repeating-linear-gradient(45deg, hsl(var(--authority-quarantine)) 0 2px, hsl(var(--surface-4)) 2px 4px)"
    : `hsl(var(--authority-${state}))`;
}

function jumpToEvidence() {
  window.dispatchEvent(new CustomEvent("swarmbot:navigate", { detail: { tab: "artifacts" } }));
}

export function CaseSheetView({ model, hydrated }: { model: CaseSheetModel; hydrated: boolean }) {
  if (!hydrated) {
    return (
      <div className="space-y-3 p-5" aria-busy="true">
        <p className="sr-only">Case sheet — syncing case</p>
        <div className="h-12 animate-pulse rounded-md bg-surface-2 motion-reduce:animate-none" aria-hidden />
        <div className="h-20 animate-pulse rounded-md bg-surface-2 motion-reduce:animate-none" aria-hidden />
      </div>
    );
  }

  const { subject, total, distribution, queue, queueTotal } = model;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      {/* ── Subject ───────────────────────────────────────────────────── */}
      <section aria-label="Subject" className="flex flex-col gap-2.5 border-b border-border-subtle px-5 py-4">
        <h3 className="text-[12px] font-medium text-faint-foreground">Subject</h3>
        {subject ? (
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-border bg-surface-3 text-[15px] font-semibold text-muted-foreground"
            >
              {subject.initials}
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[17px] font-semibold tracking-[-0.01em] text-foreground" title={subject.artifact.value}>
                {subject.artifact.value}
              </span>
              <span className="truncate text-[12.5px] text-subtle-foreground" title={subject.view.basis}>
                {subject.view.basis}
              </span>
            </div>
            <AuthorityChip view={subject.view} size="md" className="shrink-0" />
          </div>
        ) : (
          <p className="text-[13px] leading-snug text-muted-foreground">
            No name holds for the subject yet. Quarantined and rejected names are never used here.
          </p>
        )}
      </section>

      {/* ── Evidence ──────────────────────────────────────────────────── */}
      <section aria-label="Evidence" className="flex flex-col gap-3 border-b border-border-subtle px-5 py-4">
        <div className="flex items-baseline">
          <h3 className="text-[13px] font-semibold text-foreground">Evidence</h3>
          <span className="ml-auto font-mono text-[12px] tabular-nums text-faint-foreground">
            {total} {total === 1 ? "item" : "items"}
          </span>
        </div>
        {total === 0 ? (
          <p className="text-[13px] text-muted-foreground">Nothing recorded yet.</p>
        ) : (
          <>
            <div className="flex h-2 gap-0.5 overflow-hidden rounded" aria-hidden>
              {distribution.map((d) => (
                <span key={d.state} className="h-2" style={{ width: `${(d.n / total) * 100}%`, background: fill(d.state) }} />
              ))}
            </div>
            <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5">
              {distribution.map((d) => (
                <li key={d.state} className="flex items-center gap-2 text-[12.5px] text-muted-foreground" title={HINT.get(d.state)}>
                  <span aria-hidden className="h-2 w-2 shrink-0 rounded-sm" style={{ background: fill(d.state) }} />
                  {d.short}
                  <span className="ml-auto font-mono tabular-nums text-foreground">{d.n}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {/* ── Needs your call ───────────────────────────────────────────── */}
      <section aria-label="Needs your call" className="flex flex-col gap-2 px-3.5 py-4">
        <div className="flex items-baseline px-1.5">
          <h3 className="text-[13px] font-semibold text-foreground">Needs your call</h3>
          <span className="ml-2 rounded-full bg-surface-3 px-1.5 font-mono text-[11.5px] leading-[18px] tabular-nums text-foreground">
            {queueTotal}
          </span>
          {queueTotal > queue.length && (
            <span className="ml-auto text-[12px] text-faint-foreground">showing {queue.length}</span>
          )}
        </div>
        {queue.length === 0 ? (
          <p className="px-1.5 text-[13px] leading-snug text-muted-foreground">
            Nothing disputed or unattributed.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {queue.map(({ artifact, view, ask }) => {
              const prose = isProseValue(artifact.value);
              return (
                <li
                  key={artifact.id}
                  data-ask={ask}
                  className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-surface-2 p-3"
                >
                  <div className="flex items-start gap-2">
                    <span
                      title={artifact.value}
                      className={cn(
                        "min-w-0 flex-1 text-foreground",
                        prose
                          ? "text-[12.5px] leading-[1.45] [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden"
                          : "truncate font-mono text-[12.5px]",
                      )}
                    >
                      {artifact.value}
                    </span>
                    <AuthorityChip view={view} className="shrink-0" />
                  </div>
                  <AuthorityCaveat view={view} />
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] text-faint-foreground">{ASK_LABEL[ask]}</span>
                    <button
                      type="button"
                      onClick={jumpToEvidence}
                      className="ml-auto inline-flex h-[26px] items-center gap-1 rounded-md bg-secondary px-2.5 text-[12px] font-medium text-foreground transition-colors duration-fast hover:bg-surface-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      Decide in Evidence <ArrowRight className="h-3 w-3" aria-hidden />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

export function CaseSheet({ threadId }: { threadId: string }) {
  const { snapshot } = useCaseSnapshot();
  const review = useReviewStates(threadId);
  const items = snapshot?.items;
  const tally = snapshot?.authority;
  const model = useMemo(
    () => buildCaseSheet(items ?? [], review.map, tally ?? {
      verified: 0, infrastructure: 0, probable: 0, review: 0, weak: 0, quarantined: 0, conflict: 0, failed: 0,
    }),
    // `review.revision` bumps on every verdict change, including a rollback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, tally, review.map, review.revision],
  );
  return <CaseSheetView model={model} hydrated={Boolean(snapshot?.hydrated) && review.availability !== "unknown"} />;
}
