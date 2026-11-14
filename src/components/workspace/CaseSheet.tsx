import { useMemo } from "react";
import { AlertTriangle, ArrowRight, Crosshair } from "lucide-react";
import { useCaseSheetModel } from "@/hooks/useCaseSheetModel";
import { useAgentAssessment } from "@/hooks/useAgentAssessment";
import { useCaseSnapshot } from "@/hooks/useCaseSnapshot";
import { useOptionalWorkspaceUIState } from "@/hooks/useWorkspaceUIState";
import { AuthorityChip, AuthorityCaveat } from "@/components/ui/authority";
import type { AssessmentGroup } from "@/lib/agent-assessment";
import {
  buildAssessmentSheet, GROUP_HINT, GROUP_LABEL, GROUP_ORDER, SHEET_LINKAGE_THRESHOLD, strataSegments,
  type AssessmentSheet, type CasePosture, type SheetKind,
} from "@/lib/assessment-sheet";
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

/** The posture chip is computed, so it is filled (DESIGN.md, "Stated Is Not Measured"). */
const POSTURE_TONE: Record<CasePosture["tone"], string> = {
  linked: "border-[hsl(var(--confidence-high)/0.35)] bg-[hsl(var(--confidence-high)/0.1)] text-foreground",
  contested: "border-[hsl(var(--authority-conflict)/0.4)] bg-[hsl(var(--authority-conflict)/0.1)] text-[hsl(var(--authority-conflict))]",
  held: "border-[hsl(var(--authority-quarantine)/0.4)] bg-[hsl(var(--authority-quarantine)/0.1)] text-[hsl(var(--authority-quarantine))]",
  open: "border-border-strong bg-surface-3 text-muted-foreground",
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

const SECTION = "flex flex-col gap-3.5 border-b border-border-subtle px-5 py-5";
const HEADING = "text-[13px] font-semibold text-foreground";
const SUBHEAD = "text-[12px] font-medium text-muted-foreground";
const COUNT_PILL = "ml-2 rounded-full bg-surface-3 px-1.5 font-mono text-[12px] leading-[20px] tabular-nums text-foreground";

function seedKind(type: string | null | undefined): string {
  const t = (type ?? "").trim().replace(/_/g, " ");
  return t ? `${t[0].toUpperCase()}${t.slice(1)} seed` : "Seed";
}

const KIND_ACRONYM = new Set(["ip", "url", "asn", "ssn", "mac", "dns", "id"]);

function kindLabel(kind: string): string {
  const t = kind.trim().replace(/_/g, " ");
  if (!t) return "Other";
  const [first, ...rest] = t.split(" ");
  const head = KIND_ACRONYM.has(first.toLowerCase()) ? first.toUpperCase() : `${first[0].toUpperCase()}${first.slice(1)}`;
  return [head, ...rest].join(" ");
}

const REVIEWS_UNAVAILABLE =
  "Your review decisions couldn't be loaded, so this is withheld — it could otherwise show a row you already rejected.";

/**
 * A segmented bar: one segment per group that is present, its length exactly
 * the group's share (`strataSegments`). No segment has a minimum width, so the
 * bar cannot draw a group larger than it is; the gap between segments comes
 * off the track before it is divided, so it does not change their ratio. A
 * group too small to see here is carried by the counted readout beside the
 * bar. With nothing to draw, `track` leaves an empty rail instead of no bar.
 */
function StrataBar({ counts, className, grow, track = false }: { counts: Record<AssessmentGroup, number>; className?: string; grow?: number; track?: boolean }) {
  return (
    <span
      data-strata
      className={cn("flex gap-[2px] overflow-hidden rounded-[2px]", track && "bg-[hsl(var(--film)/0.07)]", className)}
      style={grow === undefined ? undefined : { flexGrow: grow, flexBasis: 0, minWidth: 0 }}
      aria-hidden
    >
      {strataSegments(counts).map((s) => (
        <span
          key={s.group}
          data-segment={s.group}
          data-n={s.n}
          className="h-full"
          style={{ flexGrow: s.n, flexShrink: 1, flexBasis: 0, minWidth: 0, background: GROUP_FILL[s.group] }}
        />
      ))}
    </span>
  );
}

/** What kind of thing was found, and how each kind stands. Bar length is the kind's count; its segments are the groups. */
function KindBreakdown({ kinds, kindTotal }: { kinds: SheetKind[]; kindTotal: number }) {
  const max = Math.max(1, ...kinds.map((k) => k.n));
  return (
    <div className="flex flex-col gap-2" data-kinds>
      <h4 className={SUBHEAD}>
        By kind
        {kindTotal > kinds.length && <span className="font-normal text-subtle-foreground"> · top {kinds.length} of {kindTotal}</span>}
      </h4>
      <ul className="flex flex-col gap-[7px]">
        {kinds.map((k) => {
          const parts = GROUP_ORDER.filter((g) => k.counts[g] > 0).map((g) => `${k.counts[g]} ${GROUP_LABEL[g].toLowerCase()}`);
          return (
            <li
              key={k.kind}
              title={`${kindLabel(k.kind)}: ${parts.join(", ")}`}
              className="grid grid-cols-[5.75rem_minmax(0,1fr)_1.75rem] items-center gap-x-2.5 text-[12.5px] leading-none"
            >
              <span className="truncate text-muted-foreground">{kindLabel(k.kind)}</span>
              <span className="flex h-[6px]">
                <StrataBar counts={k.counts} className="h-full" grow={k.n} />
                {/* The bar's length is the count; the rest of the track stays empty. */}
                <span aria-hidden style={{ flexGrow: max - k.n, flexBasis: 0, minWidth: 0 }} />
              </span>
              <span className="text-right font-mono tabular-nums text-foreground">{k.n}</span>
              {/* The split is drawn, and `title` is pointer-only: say it for everyone else. */}
              <span className="sr-only">{parts.join(", ")}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Every linkage figure the engine holds, on one 0-100 scale, with the bar a
 * finding has to clear to count as linked. It shows what a count cannot: how
 * far the near misses are from the line.
 */
function LinkageScale({ figures }: { figures: number[] }) {
  const cleared = figures.filter((f) => f >= SHEET_LINKAGE_THRESHOLD).length;
  return (
    <div className="flex flex-col gap-1.5" data-linkage-scale>
      <p className="sr-only">
        {figures.length} {figures.length === 1 ? "finding carries" : "findings carry"} a linkage figure; {cleared} at {SHEET_LINKAGE_THRESHOLD} or higher.
      </p>
      <div className="relative h-[18px]" aria-hidden>
        <span className="absolute inset-x-0 top-[7px] h-[4px] rounded-[2px] bg-[hsl(var(--film)/0.09)]" />
        <span
          className="absolute top-[7px] h-[4px] rounded-r-[2px] bg-[hsl(var(--film)/0.2)]"
          style={{ left: `${SHEET_LINKAGE_THRESHOLD}%`, right: 0 }}
        />
        <span className="absolute top-0 h-[18px] w-px bg-[hsl(var(--border-strong))]" style={{ left: `${SHEET_LINKAGE_THRESHOLD}%` }} />
        {figures.map((f, i) => (
          <span
            key={i}
            className={cn("absolute top-[3px] h-[12px] w-[2px] -translate-x-1/2 rounded-[1px]", f >= SHEET_LINKAGE_THRESHOLD ? "bg-[hsl(var(--confidence-high))]" : "bg-[hsl(var(--confidence-low))]")}
            style={{ left: `${Math.max(0, Math.min(100, f))}%` }}
          />
        ))}
      </div>
      <div className="relative h-[14px] font-mono text-[11px] leading-none tabular-nums text-faint-foreground" aria-hidden>
        <span className="absolute left-0">0</span>
        <span className="absolute -translate-x-1/2 whitespace-nowrap font-sans text-subtle-foreground" style={{ left: `${SHEET_LINKAGE_THRESHOLD}%` }}>
          links at {SHEET_LINKAGE_THRESHOLD}
        </span>
        <span className="absolute right-0">100</span>
      </div>
    </div>
  );
}

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
  const groupCounts: Record<AssessmentGroup, number> = { supported: 0, unresolved: 0, conflict: 0, quarantined: 0 };
  for (const g of assessment?.groups ?? []) groupCounts[g.group] = g.n;
  const contested = groupCounts.conflict > 0;
  const blockerMax = Math.max(1, ...(assessment?.blockers ?? []).map((b) => b.n));

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      {/* ── Subject ───────────────────────────────────────────────────── */}
      <section aria-label="Subject" className="flex flex-col gap-3 border-b border-border-subtle bg-[hsl(var(--film)/0.018)] px-5 py-5">
        <h3 className={HEADING}>Subject</h3>
        {reviewsUnavailable ? (
          <p role="status" className="text-[13px] leading-snug text-muted-foreground">{REVIEWS_UNAVAILABLE}</p>
        ) : subject ? (
          <div className="flex items-start gap-3">
            <span
              aria-hidden
              className="grid h-12 w-12 shrink-0 place-items-center rounded-lg border border-border bg-surface-3 font-display text-[16px] font-semibold text-foreground"
            >
              {subject.initials}
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="font-display text-[19px] font-semibold leading-tight tracking-[-0.015em] text-foreground [overflow-wrap:anywhere]">
                {subject.artifact.value}
              </span>
              <span className="mt-1 text-[12.5px] leading-snug text-subtle-foreground">
                {subject.view.basis}
              </span>
              {seedValue && (
                <span className="mt-2 flex items-baseline gap-1.5 text-[12px] leading-snug text-subtle-foreground" data-seed-line>
                  <Crosshair className="h-3 w-3 shrink-0 translate-y-[1.5px]" aria-hidden />
                  <span className="min-w-0 font-mono text-muted-foreground [overflow-wrap:anywhere]">{seedValue}</span>
                </span>
              )}
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
                  className="grid h-12 w-12 shrink-0 place-items-center rounded-lg border border-dashed border-border-strong bg-surface-3 text-muted-foreground"
                >
                  <Crosshair className="h-[18px] w-[18px]" strokeWidth={1.6} />
                </span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="font-mono text-[15px] font-medium leading-snug text-foreground [overflow-wrap:anywhere]">{seedValue}</span>
                  <span className="mt-1 text-[12.5px] leading-snug text-subtle-foreground">{seedKind(seed?.type)} · the case starts here</span>
                </div>
              </div>
            )}
            <p className="text-[12.5px] leading-snug text-subtle-foreground">
              No name holds for the subject yet. Quarantined and rejected names are never used here.
            </p>
          </>
        )}
      </section>

      {/* ── Agent assessment ──────────────────────────────────────────── */}
      <section aria-label="Agent assessment" className={SECTION}>
        {/* DOM order is heading, population, posture (the population's scope note is the
            region's first tooltip). Drawn order puts the posture beside the heading, so at
            the 320px rail the population drops to its own line instead of every item wrapping. */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className={cn(HEADING, "whitespace-nowrap")}>Agent assessment</h3>
          {assessment && !reviewsUnavailable && (
            <span
              className="order-3 whitespace-nowrap font-mono text-[12px] tabular-nums text-faint-foreground"
              title="Deduped case findings across every run. The header's 'evidence logged' counts chain-of-custody entries and can be higher."
            >
              {assessment.others} {assessment.others === 1 ? "finding" : "findings"}
              {assessment.total > assessment.others && " + seed"}
            </span>
          )}
          {assessment?.posture && !reviewsUnavailable && (
            <span
              data-posture={assessment.posture.tone}
              title={assessment.posture.hint}
              className={cn("order-2 ml-auto whitespace-nowrap rounded-[5px] border px-1.5 py-px text-[11.5px] font-semibold leading-[18px]", POSTURE_TONE[assessment.posture.tone])}
            >
              {assessment.posture.word}
            </span>
          )}
        </div>
        {reviewsUnavailable ? (
          // Linkage is computed with the analyst's verdicts (a rejected row may
          // not lend linkage to its neighbours), so it fails closed with them.
          <p className="text-[13px] leading-snug text-muted-foreground">Linkage is withheld until your review decisions load.</p>
        ) : !assessment || assessment.total === 0 ? (
          <p className="text-[13px] text-muted-foreground">Nothing recorded yet.</p>
        ) : assessment.others === 0 ? (
          // The seed is the only row. "0 of 0 findings link" would be a figure about nothing.
          <p className="text-[13px] leading-snug text-muted-foreground" data-seed-only>
            Only the seed is recorded so far. Findings are assessed here as the agent records them.
          </p>
        ) : (
          <>
            <p className="flex items-end gap-2.5">
              {/* The shipped figure recipe (workspace-primitives): display face, and a zero is
                  dormant ink, not a lit figure. The light serif drew "0" as a pair of brackets. */}
              <span
                data-linked-figure
                className={cn(
                  "font-display text-[40px] font-semibold leading-[0.85] tracking-[-0.03em]",
                  assessment.linkedTotal > 0 ? "stat-figure" : "tabular-nums text-faint-foreground",
                )}
              >
                {assessment.linkedTotal}
              </span>
              <span className="pb-0.5 text-[13px] leading-snug text-muted-foreground">
                of {assessment.others} {assessment.others === 1 ? "finding" : "findings"} {assessment.linkedTotal === 1 ? "links" : "link"} to the seed
              </span>
            </p>
            {assessment.reading && (
              contested ? (
                <p
                  data-reading="contested"
                  className="flex items-start gap-2 rounded-md border border-[hsl(var(--authority-conflict)/0.28)] bg-[hsl(var(--authority-conflict)/0.07)] px-2.5 py-2 text-[13px] leading-snug text-foreground"
                >
                  <AlertTriangle className="mt-[2px] h-3.5 w-3.5 shrink-0 text-[hsl(var(--authority-conflict))]" strokeWidth={2} aria-hidden />
                  <span>{assessment.reading}</span>
                </p>
              ) : (
                <p className="text-[13px] leading-snug text-foreground">{assessment.reading}</p>
              )
            )}

            <div className="flex flex-col gap-0">
              <StrataBar counts={groupCounts} className="h-[10px]" track />
              {/* Four across needs the 380px rail. At 320px "Contradicts" ran into its divider, so
                  the readout is two by two there, each cell on one line. */}
              <ul className="mt-px grid grid-cols-2 gap-x-4 border-b border-border-subtle py-1 xl:grid-cols-4 xl:gap-x-0 xl:divide-x xl:divide-border-subtle xl:py-0">
                {GROUP_ORDER.map((group) => {
                  const n = groupCounts[group];
                  return (
                    <li key={group} title={GROUP_HINT[group]} data-group={group} className="flex min-w-0 items-baseline gap-2 py-1.5 xl:flex-col xl:items-stretch xl:gap-1.5 xl:px-2.5 xl:py-2.5 xl:first:pl-0 xl:last:pr-0">
                      <span className="flex shrink-0 items-center gap-1.5">
                        {/* Filled only when the group has findings: an empty group must not wear the colour of evidence. */}
                        <span
                          aria-hidden
                          data-present={n > 0}
                          className={cn("h-2 w-2 shrink-0 rounded-[2px]", n === 0 && "border border-border-strong")}
                          style={n > 0 ? { background: GROUP_FILL[group] } : undefined}
                        />
                        <span className={cn("font-mono text-[19px] leading-none tabular-nums", n > 0 ? "text-foreground" : "text-faint-foreground")}>{n}</span>
                      </span>
                      <span className="text-[11.5px] leading-[1.25] text-muted-foreground">{GROUP_LABEL[group]}</span>
                    </li>
                  );
                })}
              </ul>
            </div>

            {assessment.kinds.length > 1 && <KindBreakdown kinds={assessment.kinds} kindTotal={assessment.kindTotal} />}

            <div className="flex flex-col gap-2">
              <p className="text-[12px] leading-snug text-subtle-foreground">
                Scored and correlated by the agent on every run. Nothing here waits on you.
              </p>
              <button type="button" onClick={() => jumpToEvidence()} className={LINK}>
                Open Evidence, strongest linkage first <ArrowRight className="h-3 w-3" aria-hidden />
              </button>
            </div>
          </>
        )}
      </section>

      {/* ── Connections ───────────────────────────────────────────────── */}
      {assessment && assessment.others > 0 && !reviewsUnavailable && (
        <section aria-label="Connections to the seed" className={SECTION}>
          <div className="flex items-baseline">
            <h3 className={HEADING}>Connections to the seed</h3>
            <span className={COUNT_PILL}>{assessment.connectionTotal}</span>
            {assessment.connectionTotal > assessment.connections.length && (
              <span className="ml-auto text-[12px] text-subtle-foreground">showing {assessment.connections.length}</span>
            )}
          </div>

          {assessment.connections.length > 0 ? (
            <>
              <LinkageScale figures={assessment.figures} />
              <ol className="-mx-2 flex flex-col">
                {assessment.connections.map((c, i) => {
                  const clears = c.linkage >= SHEET_LINKAGE_THRESHOLD;
                  return (
                    <li key={c.artifact.id}>
                      <button
                        type="button"
                        onClick={() => onSelect(c.artifact.id)}
                        className="grid w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-2.5 rounded px-2 py-2 text-left transition-colors duration-fast hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      >
                        <span className="mt-[3px] self-start font-mono text-[11.5px] tabular-nums text-faint-foreground" aria-hidden>{i + 1}</span>
                        <span className="min-w-0">
                          <span className="block truncate font-mono text-[13px] text-foreground" title={c.artifact.value}>{c.artifact.value}</span>
                          <span className="mt-0.5 block truncate text-[12px] text-subtle-foreground" title={`${c.verdict}. ${c.reason}`}>{c.reason}</span>
                        </span>
                        <span className="flex w-16 shrink-0 flex-col items-end gap-1" title={c.verdict}>
                          <span className={cn("font-mono text-[13px] tabular-nums", clears ? "text-foreground" : "text-muted-foreground")}>{Math.round(c.linkage)}%</span>
                          <span className="h-[3px] w-full overflow-hidden rounded-full bg-[hsl(var(--film)/0.08)]" aria-hidden>
                            <i
                              className={cn("block h-full rounded-full", clears ? "bg-[hsl(var(--confidence-high))]" : "bg-[hsl(var(--confidence-low))]")}
                              style={{ width: `${Math.max(0, Math.min(100, c.linkage))}%` }}
                            />
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </>
          ) : (
            <p className="text-[13px] leading-snug text-muted-foreground">
              Nothing links to the seed yet. A finding links when it shares an email, phone, handle or infrastructure with it.
            </p>
          )}

          {assessment.blockers.length > 0 && (
            <div className="flex flex-col gap-2" data-blockers>
              <h4 className={SUBHEAD}>Why the rest does not link</h4>
              <ul className="flex flex-col gap-2.5">
                {assessment.blockers.map((b) => (
                  <li key={b.reason} className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-2.5 text-[12.5px] leading-snug">
                    <span className="text-right font-mono tabular-nums text-foreground">{b.n}</span>
                    <span className="flex min-w-0 flex-col gap-1.5">
                      <span className="text-muted-foreground">{b.reason}</span>
                      {assessment.blockers.length > 1 && (
                        <span className="h-[2px] rounded-full bg-[hsl(var(--film)/0.06)]" aria-hidden>
                          <i className="block h-full rounded-full bg-[hsl(var(--authority-weak))]" style={{ width: `${(b.n / blockerMax) * 100}%` }} />
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {assessment.groupings.length > 0 && (
            <div className="flex flex-col gap-1.5" data-groupings>
              <h4 className={SUBHEAD}>
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
      <section aria-label="Optional exception review" className="flex flex-col gap-3 px-5 py-5">
        <div>
          <div className="flex items-baseline">
            <h3 className={HEADING}>Optional exception review</h3>
            {!reviewsUnavailable && <span className={COUNT_PILL}>{queueTotal}</span>}
            {!reviewsUnavailable && queueTotal > queue.length && (
              <span className="ml-auto text-[12px] text-subtle-foreground">showing {queue.length}</span>
            )}
          </div>
          <p className="mt-1 text-[12.5px] leading-snug text-subtle-foreground">Correlation runs automatically. Review only disputed evidence or unconfirmed links; Confirm, Dismiss, and Key are optional analyst overrides.</p>
        </div>
        {reviewsUnavailable ? (
          <p className="text-[13px] leading-snug text-muted-foreground">{REVIEWS_UNAVAILABLE}</p>
        ) : queue.length === 0 ? (
          <p className="text-[13px] leading-snug text-muted-foreground">Nothing disputed or unattributed.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border-subtle border-y border-border-subtle">
            {queue.map(({ artifact, view, ask }) => {
              const prose = isProseValue(artifact.value);
              return (
                <li key={artifact.id} data-ask={ask} className="flex flex-col gap-1.5 py-3">
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
