import { ArrowRight } from "lucide-react";
import { useCaseSheetModel } from "@/hooks/useCaseSheetModel";
import { AuthorityChip, AuthorityCaveat } from "@/components/ui/authority";
import { AUTHORITY_LEGEND, type AuthorityState } from "@/lib/authority";
import { isProseValue } from "@/lib/evidence-bands";
import { ASK_LABEL, type CaseSheetModel } from "@/lib/case-sheet";
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

function jumpToEvidence(artifactId?: string) {
  // Carries the row, so Evidence can reveal it even under a filter that hides
  // quarantined rows — the ones this sheet most often hands off.
  window.dispatchEvent(new CustomEvent("swarmbot:navigate", { detail: { tab: "artifacts", artifactId } }));
}

// Review opens the board's "Needs review" filter, which also lists Conflict rows,
// so its count there runs higher than here. Say so rather than surprise.
const ALSO_CONFLICT = "the Needs review view also lists Conflict rows";

function jumpToState(authorityState: AuthorityState) {
  // Opens Evidence on the quick filter that holds these rows (the Board picks it).
  window.dispatchEvent(new CustomEvent("swarmbot:navigate", { detail: { tab: "artifacts", authorityState } }));
}

const REVIEWS_UNAVAILABLE =
  "Your review decisions couldn't be loaded, so this is withheld — it could otherwise show a row you already rejected.";

export function CaseSheetView({
  model,
  hydrated,
  reviewsUnavailable = false,
}: {
  model: CaseSheetModel;
  hydrated: boolean;
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

  const { subject, total, distribution, queue, queueTotal } = model;
  const reviewCount = distribution.find((d) => d.state === "review")?.n ?? 0;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      {/* ── Subject ───────────────────────────────────────────────────── */}
      <section aria-label="Subject" className="flex flex-col gap-2.5 border-b border-border-subtle px-5 py-4">
        <h3 className="text-[12px] font-medium text-faint-foreground">Subject</h3>
        {reviewsUnavailable ? (
          <p role="status" className="text-[13px] leading-snug text-muted-foreground">{REVIEWS_UNAVAILABLE}</p>
        ) : subject ? (
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
          <p className="text-[13px] leading-snug text-muted-foreground">
            No name holds for the subject yet. Quarantined and rejected names are never used here.
          </p>
        )}
      </section>

      {/* ── Evidence ──────────────────────────────────────────────────── */}
      <section aria-label="Evidence" className="flex flex-col gap-3 border-b border-border-subtle px-5 py-4">
        <div className="flex items-baseline">
          <h3 className="text-[13px] font-semibold text-foreground">Evidence</h3>
          {/* Scope in the label, not only a tooltip: this is the deduped case-artifact count, a different
              population from the header's "evidence logged" (chain-of-custody entries) and a report's
              "N artifacts" (raw rows). All three are correct; unlabeled they read as one number disagreeing. */}
          <span
            className="ml-auto font-mono text-[12px] tabular-nums text-faint-foreground"
            title="Deduped case artifacts across every run. The header's 'evidence logged' counts chain-of-custody entries and can be higher."
          >
            {total} {total === 1 ? "artifact" : "artifacts"}
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
                <li key={d.state} title={HINT.get(d.state)}>
                  <button
                    type="button"
                    onClick={() => jumpToState(d.state)}
                    aria-label={`Show ${d.n} ${d.short} in Evidence${d.state === "review" ? ` (${ALSO_CONFLICT})` : ""}`}
                    className="-mx-1 flex w-[calc(100%+0.5rem)] items-center gap-2 rounded px-1 text-left text-[12.5px] text-muted-foreground transition-colors duration-fast hover:bg-surface-3 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span aria-hidden className="h-2 w-2 shrink-0 rounded-sm" style={{ background: fill(d.state) }} />
                    {d.short}
                    <span className="ml-auto font-mono tabular-nums text-foreground">{d.n}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {/* ── Optional exception review ────────────────────────────────── */}
      <section aria-label="Optional exception review" className="flex flex-col gap-3 px-3.5 py-4">
        <div className="px-1.5">
          <div className="flex items-baseline">
            <h3 className="text-[14px] font-semibold text-foreground">Optional exception review</h3>
            {!reviewsUnavailable && (
              <span className="ml-2 rounded-full bg-surface-3 px-1.5 font-mono text-[12px] leading-[20px] tabular-nums text-foreground">
                {queueTotal}
              </span>
            )}
            {!reviewsUnavailable && queueTotal > queue.length && (
              <span className="ml-auto text-[12px] text-subtle-foreground">showing {queue.length}</span>
            )}
          </div>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">Correlation runs automatically. Review only disputed evidence or unconfirmed links; Confirm, Dismiss, and Key are optional analyst overrides.</p>
        </div>
        {reviewsUnavailable ? (
          <p className="px-1.5 text-[13px] leading-snug text-muted-foreground">{REVIEWS_UNAVAILABLE}</p>
        ) : queue.length === 0 ? (
          <div className="flex flex-col gap-1.5 px-1.5">
            <p className="text-[13px] leading-snug text-muted-foreground">Nothing disputed or unattributed.</p>
            {/* "Review" in the bar above is a different queue — single-source rows
                waiting on a second source, not a decision — and reading "0" right
                under "Review 28" looked like a contradiction. Say so, and link it. */}
            {reviewCount > 0 && (
              <button
                type="button"
                onClick={() => jumpToState("review")}
                aria-label={`${reviewCount} ${reviewCount === 1 ? "row awaits" : "rows await"} a second source, not a decision. Opens Evidence; ${ALSO_CONFLICT}`}
                title={`Opens Evidence; ${ALSO_CONFLICT}`}
                className="inline-flex w-fit items-center gap-1 rounded text-[12.5px] text-foreground/90 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {reviewCount} {reviewCount === 1 ? "row awaits" : "rows await"} a second source, not a decision
                <ArrowRight className="h-3 w-3" aria-hidden />
              </button>
            )}
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {queue.map(({ artifact, view, ask }) => {
              const prose = isProseValue(artifact.value);
              return (
                <li
                  key={artifact.id}
                  data-ask={ask}
                  className="flex flex-col gap-2.5 rounded-lg border border-border-subtle bg-surface-2 p-3.5"
                >
                  <div className="flex items-start gap-2">
                    <span
                      title={artifact.value}
                      className={cn(
                        "min-w-0 flex-1 text-foreground",
                        prose
                          ? "text-[13px] leading-[1.5] [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden"
                          : "truncate font-mono text-[13px]",
                      )}
                    >
                      {artifact.value}
                    </span>
                    <AuthorityChip view={view} className="shrink-0" />
                  </div>
                  <AuthorityCaveat view={view} />
                  <p className="text-[12.5px] leading-relaxed text-muted-foreground">{ASK_LABEL[ask]}</p>
                  <button
                    type="button"
                    onClick={() => jumpToEvidence(artifact.id)}
                    className="inline-flex h-9 w-full items-center justify-between gap-2 whitespace-nowrap rounded-md border border-border bg-secondary px-3 text-[12.5px] font-medium text-foreground transition-colors duration-fast hover:bg-surface-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:h-11"
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
  return <CaseSheetView model={model} hydrated={hydrated} reviewsUnavailable={reviewsUnavailable} />;
}
