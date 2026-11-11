import { useMemo } from "react";
import { ArrowRight, Crosshair } from "lucide-react";
import { useCaseSheetModel } from "@/hooks/useCaseSheetModel";
import { useAgentAssessment } from "@/hooks/useAgentAssessment";
import { useCaseSnapshot } from "@/hooks/useCaseSnapshot";
import { useOptionalWorkspaceUIState } from "@/hooks/useWorkspaceUIState";
import { AuthorityChip, AuthorityCaveat } from "@/components/ui/authority";
import type { AssessmentGroup } from "@/lib/agent-assessment";
import { buildAssessmentSheet, GROUP_HINT, type AssessmentSheet } from "@/lib/assessment-sheet";
import { isProseValue } from "@/lib/evidence-bands";
import { ASK_LABEL, type CaseSheetModel } from "@/lib/case-sheet";
import { cn } from "@/lib/utils";

/**
 * The case sheet — the right-hand column of the "Case desk" layout, shown on
 * the Workbench's Finding tab while no finding is selected. It answers, without
 * leaving the conversation: what did the case start from, how much of the
 * evidence does the agent link to it, what connects, and why the rest does not.
 *
 * THE AGENT'S ASSESSMENT LEADS; THE ANALYST'S REVIEW IS THE EXCEPTION. The rail
 * used to draw the authority ladder's tally, where a single-source row reads
 * "Review" — which made an automatic scoring system look like a manual review
 * queue. It now reads the R2 assessment (`useAgentAssessment`), the same one the
 * Overview and the transcript's "Connections identified" card read. The
 * authority ladder still governs the Evidence board; it is not repeated here.
 *
 * READ-ONLY, deliberately. A row that needs a call hands off to the Evidence
 * board, where the release control ("whose is this?") and the review verdict
 * ("is this real?") live with their confirmations.
 *
 * Every figure comes from `buildCaseSheet` (subject, exception queue) and
 * `buildAssessmentSheet` (groups, connections), neither of which computes a
 * score of its own.
 */

/** Quarantine keeps its hatch and never gets a hue of its own (DESIGN.md). */
const GROUP_FILL: Record<AssessmentGroup, string> = {
  supported: "hsl(var(--confidence-high))",
  unresolved: "hsl(var(--authority-weak))",
  conflict: "hsl(var(--authority-conflict))",
  quarantined: "repeating-linear-gradient(45deg, hsl(var(--authority-quarantine)) 0 2px, hsl(var(--surface-4)) 2px 4px)",
};

function jumpToEvidence(artifactId?: string) {
  // Carries the row, so Evidence can reveal it even under a filter that hides
  // quarantined rows — the ones this sheet most often hands off.
  window.dispatchEvent(new CustomEvent("swarmbot:navigate", { detail: { tab: "artifacts", artifactId } }));
}

function openWorkbenchTab(tab: "pivots" | "connections") {
  window.dispatchEvent(new CustomEvent("swarmbot:workbench-tab", { detail: { tab } }));
}

const LINK =
  "inline-flex w-fit items-center gap-1 rounded text-[12.5px] font-medium text-foreground underline-offset-2 transition-colors duration-fast hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function seedKind(type: string | null | undefined): string {
  const t = (type ?? "").trim().replace(/_/g, " ");
  return t ? `${t[0].toUpperCase()}${t.slice(1)} seed` : "Seed";
}

const REVIEWS_UNAVAILABLE =
  "Your review decisions couldn't be loaded, so this is withheld — it could otherwise show a row you already rejected.";

export function CaseSheetView({
  model,
  hydrated,
  reviewsUnavailable = false,
  assessment = null,
  seed = null,
  onSelect = jumpToEvidence,
}: {
  model: CaseSheetModel;
  hydrated: boolean;
  /** The agent's assessment, or null when there is none to show (no rows yet). */
  assessment?: AssessmentSheet | null;
  /** What the case started from. Shown as the anchor when no name holds. */
  seed?: { value: string | null; type: string | null } | null;
  /** Opens one finding. Defaults to the Evidence handoff. */
  onSelect?: (artifactId: string) => void;
  /**
   * The analyst's verdicts failed to load. The subject and the queue are both
   * decided BY those verdicts (a rejected name must never be the subject), so
   * both fail closed rather than render from an empty map.
   */
  reviewsUnavailable?: boolean;
}) {
  if (!hydrated) {
    return (
      <div className="space-y-3 p-5" aria-busy="true">
        <p className="sr-only">Case sheet — syncing case</p>
        <div className="h-12 animate-pulse rounded-md bg-surface-2 motion-reduce:animate-none" aria-hidden />
        <div className="h-20 animate-pulse rounded-md bg-surface-2 motion-reduce:animate-none" aria-hidden />
      </div>
    );
  }

  const { subject, queue, queueTotal } = model;
  const seedValue = seed?.value?.trim() || null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      {/* ── Subject ───────────────────────────────────────────────────── */}
      <section aria-label="Subject" className="flex flex-col gap-2.5 border-b border-border-subtle px-5 py-5">
        <h3 className="text-[13px] font-semibold text-foreground">Subject</h3>
        {reviewsUnavailable ? (
          <p role="status" className="text-[13px] leading-snug text-muted-foreground">{REVIEWS_UNAVAILABLE}</p>
        ) : subject ? (
          <div className="flex items-start gap-3">
            <span
              aria-hidden
              className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-border bg-surface-3 text-[15px] font-semibold text-muted-foreground"
            >
              {subject.initials}
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-[17px] font-semibold leading-snug tracking-[-0.01em] text-foreground [overflow-wrap:anywhere]">
                {subject.artifact.value}
              </span>
              <span className="mt-0.5 text-[12.5px] leading-snug text-subtle-foreground">
                {subject.view.basis}
              </span>
            </div>
            <button
              type="button"
              onClick={() => jumpToEvidence(subject.artifact.id)}
              aria-label={`Open ${subject.artifact.value} in Evidence (${subject.view.label})`}
              className="shrink-0 rounded-full transition-opacity duration-fast hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <AuthorityChip view={subject.view} size="md" />
            </button>
          </div>
        ) : (
          <>
            {seedValue && (
              <div className="flex items-start gap-3" data-seed-anchor>
                <span
                  aria-hidden
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-dashed border-border bg-surface-3 text-muted-foreground"
                >
                  <Crosshair className="h-4 w-4" />
                </span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="font-mono text-[15px] font-medium leading-snug text-foreground [overflow-wrap:anywhere]">{seedValue}</span>
                  <span className="mt-0.5 text-[12.5px] leading-snug text-subtle-foreground">{seedKind(seed?.type)} · the case starts here</span>
                </div>
              </div>
            )}
            <p className="text-[13px] leading-snug text-muted-foreground">
              No name holds for the subject yet. Quarantined and rejected names are never used here.
            </p>
          </>
        )}
      </section>

      {/* ── Agent assessment ──────────────────────────────────────────── */}
      <section aria-label="Agent assessment" className="flex flex-col gap-3 border-b border-border-subtle px-5 py-5">
        <div className="flex items-baseline">
          <h3 className="text-[13px] font-semibold text-foreground">Agent assessment</h3>
          {assessment && !reviewsUnavailable && (
            <span
              className="ml-auto font-mono text-[12px] tabular-nums text-faint-foreground"
              title="Deduped case findings across every run. The header's 'evidence logged' counts chain-of-custody entries and can be higher."
            >
              {assessment.others} {assessment.others === 1 ? "finding" : "findings"}
              {assessment.total > assessment.others && " + seed"}
            </span>
          )}
        </div>
        {reviewsUnavailable ? (
          // Linkage is computed with the analyst's verdicts (a rejected row may
          // not lend linkage to its neighbours), so it fails closed with them.
          <p className="text-[13px] leading-snug text-muted-foreground">Linkage is withheld until your review decisions load.</p>
        ) : !assessment || assessment.total === 0 ? (
          <p className="text-[13px] text-muted-foreground">Nothing recorded yet.</p>
        ) : (
          <>
            <p className="flex items-baseline gap-2">
              <span className="text-[28px] font-semibold leading-none tracking-[-0.02em] tabular-nums text-foreground">{assessment.linkedTotal}</span>
              <span className="text-[12.5px] leading-snug text-muted-foreground">
                of {assessment.others} {assessment.others === 1 ? "finding" : "findings"} {assessment.linkedTotal === 1 ? "links" : "link"} to the seed
              </span>
            </p>
            {assessment.reading && <p className="text-[13px] leading-snug text-foreground/90">{assessment.reading}</p>}
            <div className="flex h-2 gap-0.5 overflow-hidden rounded" aria-hidden>
              {assessment.groups.map((g) => (
                <span key={g.group} className="h-2" style={{ width: `${(g.n / Math.max(1, assessment.others)) * 100}%`, background: GROUP_FILL[g.group] }} />
              ))}
            </div>
            <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5">
              {assessment.groups.map((g) => (
                <li key={g.group} title={GROUP_HINT[g.group]} data-group={g.group} className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
                  <span aria-hidden className="h-2 w-2 shrink-0 rounded-sm" style={{ background: GROUP_FILL[g.group] }} />
                  {g.label}
                  <span className="ml-auto font-mono tabular-nums text-foreground">{g.n}</span>
                </li>
              ))}
            </ul>
            <p className="text-[12px] leading-snug text-subtle-foreground">
              Scored and correlated by the agent on every run. Nothing here waits on you.
            </p>
            <button type="button" onClick={() => jumpToEvidence()} className={LINK}>
              Open Evidence, strongest linkage first <ArrowRight className="h-3 w-3" aria-hidden />
            </button>
          </>
        )}
      </section>

      {/* ── Connections ───────────────────────────────────────────────── */}
      {assessment && assessment.total > 0 && !reviewsUnavailable && (
        <section aria-label="Connections to the seed" className="flex flex-col gap-3 border-b border-border-subtle px-5 py-5">
          <div className="flex items-baseline">
            <h3 className="text-[13px] font-semibold text-foreground">Connections to the seed</h3>
            <span className="ml-2 rounded-full bg-surface-3 px-1.5 font-mono text-[12px] leading-[20px] tabular-nums text-foreground">{assessment.connectionTotal}</span>
            {assessment.connectionTotal > assessment.connections.length && (
              <span className="ml-auto text-[12px] text-subtle-foreground">showing {assessment.connections.length}</span>
            )}
          </div>

          {assessment.connections.length > 0 ? (
            <ul className="-mx-2 flex flex-col">
              {assessment.connections.map((c) => (
                <li key={c.artifact.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(c.artifact.id)}
                    className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 rounded px-2 py-2 text-left transition-colors duration-fast hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-[13px] text-foreground" title={c.artifact.value}>{c.artifact.value}</span>
                      <span className="mt-0.5 block truncate text-[12px] text-subtle-foreground" title={`${c.verdict}. ${c.reason}`}>{c.reason}</span>
                    </span>
                    <span className="flex w-14 shrink-0 flex-col items-end gap-1" title={c.verdict}>
                      <span className="font-mono text-[12.5px] tabular-nums text-foreground">{Math.round(c.linkage)}%</span>
                      <span className="h-[3px] w-full overflow-hidden rounded-full bg-white/[0.08]" aria-hidden>
                        <i className="block h-full rounded-full bg-[hsl(var(--confidence-high))]" style={{ width: `${Math.max(0, Math.min(100, c.linkage))}%` }} />
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] leading-snug text-muted-foreground">
              Nothing links to the seed yet. A finding links when it shares an email, phone, handle or infrastructure with it.
            </p>
          )}

          {assessment.blockers.length > 0 && (
            <div className="flex flex-col gap-1.5" data-blockers>
              <h4 className="text-[12px] font-medium text-muted-foreground">Why the rest does not link</h4>
              <ul className="flex flex-col gap-1.5">
                {assessment.blockers.map((b) => (
                  <li key={b.reason} className="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-2 text-[12.5px] leading-snug">
                    <span className="text-right font-mono tabular-nums text-foreground">{b.n}</span>
                    <span className="text-muted-foreground">{b.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {assessment.groupings.length > 0 && (
            <div className="flex flex-col gap-1.5" data-groupings>
              <h4 className="text-[12px] font-medium text-muted-foreground">
                Linked to each other, not to the seed
                {assessment.groupingTotal > assessment.groupings.length && <span className="font-normal text-subtle-foreground"> · {assessment.groupingTotal} groups</span>}
              </h4>
              <ul className="-mx-2 flex flex-col">
                {assessment.groupings.map((g) => (
                  <li key={g.id}>
                    <button
                      type="button"
                      onClick={() => onSelect(g.firstArtifactId)}
                      className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 rounded px-2 py-1.5 text-left transition-colors duration-fast hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] text-foreground" title={g.label}>{g.label}</span>
                        {g.reason && <span className="mt-0.5 block truncate text-[12px] text-subtle-foreground" title={g.reason}>{g.reason}</span>}
                      </span>
                      <span className="shrink-0 font-mono text-[12px] tabular-nums text-muted-foreground">{g.size} findings</span>
                    </button>
                  </li>
                ))}
              </ul>
              <p className="text-[12px] leading-snug text-subtle-foreground">One selector joining a group to the seed links every finding in it.</p>
            </div>
          )}

          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            <button type="button" onClick={() => openWorkbenchTab("connections")} className={LINK}>
              Open the connection map <ArrowRight className="h-3 w-3" aria-hidden />
            </button>
            <button type="button" onClick={() => openWorkbenchTab("pivots")} className={LINK}>
              Next pivots <ArrowRight className="h-3 w-3" aria-hidden />
            </button>
          </div>
        </section>
      )}

      {/* ── Optional exception review ────────────────────────────────── */}
      <section aria-label="Optional exception review" className="flex flex-col gap-3 px-3.5 py-5">
        <div className="px-1.5">
          <div className="flex items-baseline">
            <h3 className="text-[13px] font-semibold text-foreground">Optional exception review</h3>
            {!reviewsUnavailable && (
              <span className="ml-2 rounded-full bg-surface-3 px-1.5 font-mono text-[12px] leading-[20px] tabular-nums text-foreground">
                {queueTotal}
              </span>
            )}
            {!reviewsUnavailable && queueTotal > queue.length && (
              <span className="ml-auto text-[12px] text-subtle-foreground">showing {queue.length}</span>
            )}
          </div>
          <p className="mt-1 text-[12.5px] leading-snug text-subtle-foreground">Correlation runs automatically. Review only disputed evidence or unconfirmed links; Confirm, Dismiss, and Key are optional analyst overrides.</p>
        </div>
        {reviewsUnavailable ? (
          <p className="px-1.5 text-[13px] leading-snug text-muted-foreground">{REVIEWS_UNAVAILABLE}</p>
        ) : queue.length === 0 ? (
          <p className="px-1.5 text-[13px] leading-snug text-muted-foreground">Nothing disputed or unattributed.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {queue.map(({ artifact, view, ask }) => {
              const prose = isProseValue(artifact.value);
              return (
                <li
                  key={artifact.id}
                  data-ask={ask}
                  className="flex flex-col gap-2 rounded-md border border-border-subtle bg-surface-2 px-3 py-2.5"
                >
                  <div className="flex items-start gap-2">
                    <span
                      title={artifact.value}
                      className={cn(
                        "min-w-0 flex-1 text-foreground",
                        prose
                          ? "text-[13px] leading-[1.5] [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden"
                          : "font-mono text-[13px] leading-snug [overflow-wrap:anywhere]",
                      )}
                    >
                      {artifact.value}
                    </span>
                    <AuthorityChip view={view} className="shrink-0" />
                  </div>
                  <AuthorityCaveat view={view} />
                  <p className="text-[12.5px] leading-snug text-muted-foreground">{ASK_LABEL[ask]}</p>
                  <button
                    type="button"
                    onClick={() => jumpToEvidence(artifact.id)}
                    className="-mx-1 inline-flex h-7 w-fit items-center gap-1 whitespace-nowrap rounded px-1 text-[12.5px] font-medium text-foreground underline-offset-2 transition-colors duration-fast hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:h-11"
                  >
                    Decide in Evidence <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                  </button>
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
  const { model, hydrated, reviewsUnavailable } = useCaseSheetModel(threadId);
  const { snapshot } = useCaseSnapshot();
  const { report } = useAgentAssessment(threadId);
  const ui = useOptionalWorkspaceUIState();
  const items = snapshot?.items;
  const assessment = useMemo(() => (report ? buildAssessmentSheet(report, items ?? []) : null), [report, items]);
  const seedValue = snapshot?.seed.value ?? null;
  const seedType = snapshot?.seed.type ?? null;
  const seed = useMemo(() => ({ value: seedValue, type: seedType }), [seedValue, seedType]);
  // Inside the workspace a finding opens in this same panel; standalone it hands off to Evidence.
  const select = ui?.select;
  return (
    <CaseSheetView
      model={model}
      hydrated={hydrated}
      reviewsUnavailable={reviewsUnavailable}
      assessment={assessment}
      seed={seed}
      onSelect={select ?? jumpToEvidence}
    />
  );
}
