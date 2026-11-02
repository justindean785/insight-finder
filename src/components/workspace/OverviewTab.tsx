import { useMemo } from "react";
// One number, everywhere. See src/lib/display-confidence.ts.
import { effectiveConfidence, effectiveConfidenceOrZero } from "@/lib/display-confidence";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import type { ToolEvent } from "@/hooks/useThreadToolActivity";
import { useCaseSnapshot } from "@/hooks/useCaseSnapshot";
import { useReviewStates } from "@/lib/review";
import { isProseValue } from "@/lib/evidence-bands";
import { authorityFor, LEDGER_SORT_RANK, AUTHORITY_LEGEND, AUTHORITY_DISTRIBUTION, type AuthorityState, type CaveatKind } from "@/lib/authority";
import { AuthorityChip, AuthoritySpine, AuthorityCaveat, RuleLabel } from "@/components/ui/authority";
import { SectionHeading } from "@/components/workspace/SectionHeading";
import { useAgentAssessment } from "@/hooks/useAgentAssessment";
import { readableSourceLabel } from "@/lib/tool-display";
import { timeAgo } from "@/lib/time";
import { cn } from "@/lib/utils";
import { fmtWallClock } from "@/lib/duration";
import { buildDecisionQueue } from "@/lib/decision-queue";
import { RunCockpit } from "@/components/workspace/RunCockpit";
import { useCaseSheetModel } from "@/hooks/useCaseSheetModel";
import { groupSharedCaveats } from "@/lib/shared-caveats";
import { detectNameConflict } from "@/lib/name-conflict";
import { NameConflictNotice } from "@/components/workspace/NameConflictNotice";
import { summarizeLatestRun, type LatestRunSummary } from "@/lib/latest-run";
import {
  Unlink, AlertTriangle, XCircle, ShieldCheck, Timer, CheckCircle2,
  DatabaseZap, Activity, ArrowRight, type LucideIcon,
} from "lucide-react";

/**
 * Command Center — the case-level operational view the workspace never had.
 *
 * WHY IT EXISTS. The five existing tabs each answer a narrow question
 * (what was found / what ran / how it connects / what to write), and none of
 * them answers "what is the state of this case". An analyst returning to a case
 * with 300 artifacts had exactly two options: scroll the whole Evidence board,
 * or read the entire chat transcript. This puts the eight questions worth asking
 * on one screen:
 *
 *   who is the subject · what is strongest · what is disputed · what cannot be
 *   attributed · what did the agent just do · which tools failed · what changed
 *   recently · what should I inspect next
 *
 * IT COMPUTES NOTHING. Every number is `tallyAuthority` / `authorityFor` over
 * the same artifacts the ledger renders, and every tool figure comes from
 * `useThreadToolActivity`. There is no scoring here and no second opinion about
 * confidence — if a number disagrees with the Evidence tab, that is a bug in
 * this file, not a different model.
 */

const DIST = AUTHORITY_DISTRIBUTION;

const HINT = new Map(AUTHORITY_LEGEND.map((e) => [e.state, e.hint]));

function jump(tab: string) {
  window.dispatchEvent(new CustomEvent("swarmbot:navigate", { detail: { tab } }));
}

/**
 * The run, in one line.
 *
 * This replaced a bank of five tiles, and the reason is worth keeping. Three of
 * them counted verified, conflict and quarantined artifacts -- figures the case
 * bar already carries in its own strip AND that the authority distribution
 * below states far better, with all eight states and each one's share of the
 * case. One screen, three copies of the same three numbers, and the page opened
 * on the least useful of them.
 *
 * What survives is the other axis: what the run itself cost. Those figures
 * appear nowhere else on the page, they fit on one line, and a line is the
 * right weight for context that sits under the decision it informs.
 *
 * A figure at zero recedes to reference ink rather than vanishing -- "0 failed"
 * is a real reading and the analyst should be able to see the run was clean.
 */
function RunStrip({
  calls, failed, degraded, cached, wall, onJump,
}: {
  calls: number; failed: number; degraded: number; cached: number;
  wall: string; onJump: () => void;
}) {
  const figures: { value: string | number; label: string; tone?: string; dim?: boolean }[] = [
    { value: calls, label: calls === 1 ? "call" : "calls", dim: calls === 0 },
    { value: failed, label: "failed", tone: failed > 0 ? "text-[hsl(var(--danger))]" : undefined, dim: failed === 0 },
    { value: degraded, label: "degraded", tone: degraded > 0 ? "text-[hsl(var(--authority-review))]" : undefined, dim: degraded === 0 },
    { value: cached, label: "cached", dim: cached === 0 },
    { value: wall, label: "in tools" },
  ];
  return (
    <button
      type="button"
      onClick={onJump}
      aria-label={`Run summary: ${calls} calls, ${failed} failed, ${degraded} degraded, ${cached} cached, ${wall} in tools. Open Tools.`}
      className="-mx-1 flex w-full flex-wrap items-baseline gap-x-6 gap-y-1.5 rounded-md px-1 py-1.5 text-left text-data transition-colors duration-fast hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {figures.map((f) => (
        <span key={f.label} className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
          <span className={cn("font-mono tabular-nums", f.tone ?? (f.dim ? "text-faint-foreground" : "text-foreground"))}>
            {f.value}
          </span>
          <span className={f.dim && !f.tone ? "text-faint-foreground" : "text-subtle-foreground"}>{f.label}</span>
        </span>
      ))}
    </button>
  );
}

/**
 * An artifact's value, set the way the evidence ledger already sets it.
 *
 * `value` holds two different kinds of thing. A SELECTOR is compared character
 * by character, so it belongs in the data face on one line, truncated -- you
 * read the head of an address to recognise it. A FINDING is a sentence the
 * extractor wrote into the same column ("CONTRADICTION: 1110 Sample Ave is NOT
 * linked to James Harker. The reverse-address lookup returned 31 records and
 * the ..."), and truncating that to forty monospace characters is how the most
 * important row on the page went unread.
 *
 * `ArtifactRow` settled this in the ledger and these three lists never adopted
 * it, so Overview truncated every kind alike -- most visibly once Latest
 * evidence moved to half width. Same predicate, same two modes, so a row reads
 * the same on both surfaces.
 */
/** What the latest run added, so an analyst returning to a case sees the delta before the totals. */
function LatestRunStrip({ summary, live }: { summary: LatestRunSummary; live: boolean }) {
  const { added, supported, conflict, quarantined, other } = summary;
  const started = new Date(summary.startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const parts = [
    supported > 0 && { n: supported, word: "supported", tone: "text-subtle-foreground" },
    conflict > 0 && { n: conflict, word: "in conflict", tone: "text-[hsl(var(--authority-conflict))]" },
    quarantined > 0 && { n: quarantined, word: "quarantined", tone: "text-subtle-foreground" },
    // Review, weak and failed rows, so the parts always sum to `added`.
    other > 0 && { n: other, word: "other", tone: "text-subtle-foreground" },
  ].filter(Boolean) as Array<{ n: number; word: string; tone: string }>;
  return (
    <section
      aria-label="Latest run"
      data-overview-latest-run
      className="panel panel-flat flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 text-data"
    >
      <span className="font-medium text-foreground">Latest run</span>
      <span className="text-faint-foreground">
        started <time dateTime={summary.startedAt}>{started}</time>
      </span>
      <span aria-hidden className="text-muted-foreground/40">·</span>
      {added === 0 ? (
        <span className="text-muted-foreground">No new records{live ? " yet" : ""}</span>
      ) : (
        <span className="text-muted-foreground">
          <span className="font-mono tabular-nums text-foreground">{added}</span> new record{added === 1 ? "" : "s"}{live ? " so far" : ""}
          {parts.length > 0 && ": "}
          {parts.map((p, i) => (
            <span key={p.word}>
              {i > 0 && ", "}
              <span className={cn("font-mono tabular-nums", p.tone)}>{p.n}</span> {p.word}
            </span>
          ))}
        </span>
      )}
      <button
        type="button"
        onClick={() => jump("artifacts")}
        className="ml-auto inline-flex h-7 items-center rounded-md px-2 text-micro font-medium text-muted-foreground transition-colors duration-fast hover:bg-white/[0.04] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Open Evidence
      </button>
    </section>
  );
}

function ArtifactValue({ value, className }: { value: string; className?: string }) {
  const prose = isProseValue(value);
  return (
    <span
      title={value}
      className={cn(
        "min-w-0 text-foreground",
        prose
          ? "text-[12.5px] leading-[1.45] [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden"
          : "mono-value truncate text-data",
        className,
      )}
    >
      {value}
    </span>
  );
}

const NO_ITEMS: Artifact[] = [];
const NO_EVENTS: ToolEvent[] = [];
const NO_TALLY: Record<AuthorityState, number> = {
  verified: 0, infrastructure: 0, probable: 0, review: 0, weak: 0, quarantined: 0, conflict: 0, failed: 0,
};

export function OverviewTab({ threadId }: { threadId: string }) {
  // Case desk R6: the "at a glance" line counts the R2 assessment's groups —
  // the same reading the Finding panel, the ledger chips and the transcript
  // cards show, so the four surfaces cannot disagree on what is supported.
  const assessment = useAgentAssessment(threadId);
  // Every figure on this tab comes from the case snapshot — the same published
  // version the case bar and the tab badges print. The Overview used to open its
  // own tool-activity read on every visit, which is why it said 48 while the
  // long-lived header still said 46.
  const { snapshot } = useCaseSnapshot();
  const items = snapshot?.items ?? NO_ITEMS;
  const tools = snapshot?.tools;
  const activity = useMemo(() => ({
    events: tools?.events ?? NO_EVENTS,
    persistedTotal: tools?.total ?? 0,
    failed: tools?.failed ?? 0,
    degraded: tools?.degraded ?? 0,
  }), [tools]);
  const review = useReviewStates(threadId);
  // "Waiting on you" is the Evidence badge's own number, from the same model.
  const sheet = useCaseSheetModel(threadId);

  // `tallyAuthority` over the snapshot's own rows, computed once by the provider.
  const tally = snapshot?.authority ?? NO_TALLY;
  const total = items.length;

  /** Strongest supported findings — the top of the same ladder the ledger sorts by. */
  const strongest = useMemo(() => {
    return [...items]
      .map((a) => ({ a, v: authorityFor(a, review.get(a.id)) }))
      .filter((x) => x.v.state === "verified" || x.v.state === "infrastructure" || x.v.state === "probable")
      .sort((x, y) => {
        const r = LEDGER_SORT_RANK[x.v.state] - LEDGER_SORT_RANK[y.v.state];
        return r !== 0 ? r : effectiveConfidenceOrZero(y.a) - effectiveConfidenceOrZero(x.a);
      })
      .slice(0, 6);
  }, [items, review]);

  /** What cannot be attributed, and what is actively disputed. */
  const queue = useMemo(() => {
    const candidates = items
      .map((a) => ({ a, v: authorityFor(a, review.get(a.id)) }))
      .filter((x) => x.v.state === "quarantined" || x.v.state === "conflict")
      .map((x) => ({
        item: x,
        state: x.v.state as "quarantined" | "conflict",
        metadata: x.a.metadata,
        confidence: effectiveConfidenceOrZero(x.a),
      }));
    return buildDecisionQueue(candidates);
  }, [items, review]);
  const unresolved = queue.shown;
  const nameConflict = useMemo(() => detectNameConflict(items), [items]);
  const sharedCaveats = useMemo(
    () => groupSharedCaveats(unresolved.map(({ a, v }) => ({ id: a.id, caveat: v.caveat, caveatKind: v.caveatKind }))),
    [unresolved],
  );

  const failures = useMemo(
    () => activity.events.filter((e) => e.status === "failed" || e.status === "degraded").slice(-5).reverse(),
    [activity.events],
  );

  const recent = useMemo(
    () => [...items].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, 5),
    [items],
  );

  const toolMs = useMemo(
    () => activity.events.reduce((n, e) => n + (e.durationMs ?? 0), 0),
    [activity.events],
  );
  const cached = useMemo(() => activity.events.filter((e) => e.cached).length, [activity.events]);

  /**
   * Which source classes appear in this case, counted off the persisted
   * metadata.
   *
   * NOT a corroboration or independence measure, and deliberately not labelled
   * as one. These are the classes the backend recorded; nothing here
   * establishes that two of them are INDEPENDENT — mirrors of one leak, a
   * broker reselling another broker, and two wrappers over the same upstream
   * all count as separate classes by this tally while proving nothing twice.
   * `countIndependentClasses` (backend, `record_finding`) is the only thing that
   * decides independence, and it does so per finding at write time. Presenting
   * this spread as "the corroboration base" would re-inflate exactly the claim
   * the write-layer cap exists to hold down.
   */
  const classes = useMemo(() => {
    const c = new Map<string, number>();
    for (const a of items) {
      const m = (a.metadata ?? {}) as Record<string, unknown>;
      const raw = typeof m.source_class === "string" ? m.source_class
        : Array.isArray(m.source_category) ? String(m.source_category[0] ?? "")
        : typeof m.source_category === "string" ? m.source_category : "";
      const k = raw || a.source || "unknown";
      c.set(k, (c.get(k) ?? 0) + 1);
    }
    return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [items]);

  const latestRun = useMemo(
    () => summarizeLatestRun(items, snapshot?.run.startedAt ?? null, (a) => authorityFor(a, review.get(a.id)).state),
    [items, snapshot?.run.startedAt, review],
  );

  const maxDist = Math.max(1, ...DIST.map((d) => tally[d.state]));

  // Until every source has answered, no tile may print a number: a "0 verified"
  // that is really "not read yet" is exactly the false reading this tab exists
  // to prevent.
  if (!snapshot?.hydrated) {
    return (
      <div className="h-full min-h-0 overflow-y-auto" aria-busy="true">
        <SectionHeading title="The case, at a glance" subtitle="Syncing the case…" />
        <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4">
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5" aria-hidden>
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="panel h-[74px] animate-pulse motion-reduce:animate-none" />
            ))}
          </div>
          <div className="panel h-40 animate-pulse motion-reduce:animate-none" aria-hidden />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      {/* The case bar and tab strip already carry these counts; the heading
          stays for screen-reader navigation only. */}
      <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4">
        <SectionHeading
          title="The case, at a glance"
          subtitle="What the collected evidence supports — and what it doesn't."
          right={<span className="text-[11px] tabular-nums text-faint-foreground">{total} artifact{total === 1 ? "" : "s"} · {activity.persistedTotal} tool call{activity.persistedTotal === 1 ? "" : "s"}</span>}
        />
        {assessment.report && (
          <p className="flex flex-wrap items-center gap-x-2 rounded-[7px] border border-[hsl(var(--brand)/0.25)] bg-[linear-gradient(110deg,hsl(var(--brand)/0.08),hsl(var(--surface-1)))] px-3.5 py-2.5 text-[12px] text-muted-foreground" data-assessment-summary>
            <CheckCircle2 className="h-4 w-4 shrink-0 text-[hsl(var(--brand))]" aria-hidden />
            <span><b className="font-medium text-foreground">{assessment.report.counts.supported}</b> supported finding{assessment.report.counts.supported === 1 ? "" : "s"}</span>
            <span aria-hidden className="text-faint-foreground">·</span>
            <span><b className="font-medium text-foreground">{assessment.report.counts.unresolved}</b> unresolved lead{assessment.report.counts.unresolved === 1 ? "" : "s"}</span>
            <span aria-hidden className="text-faint-foreground">·</span>
            <span><b className="font-medium text-foreground">{assessment.report.counts.conflict}</b> contradiction{assessment.report.counts.conflict === 1 ? "" : "s"}</span>
            {assessment.report.counts.quarantined > 0 && (
              <>
                <span aria-hidden className="text-faint-foreground">·</span>
                <span><b className="font-medium text-foreground">{assessment.report.counts.quarantined}</b> quarantined</span>
              </>
            )}
          </p>
        )}

        {/* rowState, not state: until the row is re-read, startedAt is the previous run's. */}
        {latestRun && <LatestRunStrip summary={latestRun} live={snapshot.run.rowState === "running"} />}

        {/* ── Case assessment leads ─────────────────────────────────────
            Register item 8: lead with what is SUPPORTED (what the engine
            has adjudicated) then what is OPEN (what needs a decision).
            Run diagnostics (RunCockpit, RunStrip) are demoted below the
            Authority distribution — they describe the run that produced
            the case, which is secondary to the case itself.

            Previously the first panel on the Overview was the decision
            queue; a case with a long queue read as a list of problems
            before anything supported was visible. */}
        {/* G-3: "The case, at a glance" two-card lead. Left: compact
            working assessment (what the engine supports). Right: what
            could change the case (strongest open contradiction). Both
            cards read from the same selectors the fuller sections below
            use, so the two can never disagree. */}
        <div className="grid gap-4 md:grid-cols-2" data-overview-lead="case-at-a-glance">
          <section className="panel panel-flat overflow-hidden" data-overview-card="working-assessment">
            <RuleLabel right={<span className="text-micro tabular-nums text-muted-foreground/70">{strongest.length} of {tally.verified + tally.infrastructure + tally.probable}</span>}>
              Working assessment
            </RuleLabel>
            {strongest.length === 0 ? (
              <p className="p-5 text-data text-muted-foreground">No corroborated findings yet. The decision queue below is a good place to start.</p>
            ) : (
              <ul>
                {strongest.slice(0, 4).map(({ a, v }) => (
                  <li key={a.id} className="relative grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 border-b border-border-subtle py-1.5 pl-5 pr-5 last:border-b-0">
                    <AuthoritySpine state={v.state} />
                    <ArtifactValue value={a.value} className="min-w-0" />
                    <AuthorityChip view={v} />
                  </li>
                ))}
              </ul>
            )}
            {strongest.length > 4 && (
              <p className="border-t border-border-subtle px-5 py-1.5 text-micro text-muted-foreground">
                +{strongest.length - 4} more supported findings below.
              </p>
            )}
          </section>

          <section className="panel panel-flat overflow-hidden" data-overview-card="what-could-change">
            <RuleLabel right={unresolved.length > 0 ? <span className="text-micro tabular-nums text-muted-foreground/70">{unresolved.length}</span> : undefined}>
              What could change the case
            </RuleLabel>
            {unresolved.length === 0 ? (
              <p className="p-5 text-data text-muted-foreground">
                No open contradictions. New disputes will appear here as the investigation records them.
              </p>
            ) : (
              <ul>
                {unresolved.slice(0, 2).map(({ a, v }) => (
                  <li key={a.id} className="relative border-b border-border-subtle py-1.5 pl-5 pr-5 last:border-b-0">
                    <AuthoritySpine state={v.state} />
                    <div className="flex items-start gap-2">
                      <ArtifactValue value={a.value} className="min-w-0 flex-1" />
                      <AuthorityChip view={v} />
                    </div>
                    <AuthorityCaveat view={v} className="mt-0.5 line-clamp-2 text-micro" />
                  </li>
                ))}
                {unresolved.length > 2 && (
                  <li className="px-5 py-1.5 text-micro text-muted-foreground">
                    +{unresolved.length - 2} more awaiting your call below.
                  </li>
                )}
              </ul>
            )}
          </section>
        </div>

        {nameConflict && <NameConflictNotice conflict={nameConflict} onOpen={() => jump("artifacts")} />}

        {/* ── Needs a decision ───────────────────────────────────────── */}
        <section className="panel panel-primary overflow-hidden">
          <RuleLabel
            right={
              unresolved.length > 0 || queue.heldBack > 0 ? (
                <button type="button" onClick={() => jump("artifacts")} className="inline-flex items-center gap-1 text-micro text-muted-foreground hover:text-foreground">
                  Open <ArrowRight className="h-3 w-3" aria-hidden />
                </button>
              ) : undefined
            }
          >
            Needs a decision
          </RuleLabel>
          {/* Every row the queue holds, named by reason. A partition: the counts
              sum to the full queue, so no row is hidden by being grouped. */}
          {queue.groups.length > 1 && (
            <ul className="border-b border-border-subtle px-3 py-2" aria-label="Queue by reason" data-testid="decision-groups">
              {queue.groups.map((g) => (
                <li key={g.key} className="flex items-baseline gap-2 text-micro text-muted-foreground" title={g.label}>
                  <span className="w-6 shrink-0 text-right tabular-nums text-foreground">{g.count}</span>
                  <span className="min-w-0 flex-1 truncate">{g.label}</span>
                  {g.heldBack && <span className="shrink-0 text-faint-foreground">held back</span>}
                </li>
              ))}
            </ul>
          )}
          {unresolved.length === 0 ? (
            <p className="p-3 text-data text-muted-foreground">
              {queue.heldBack > 0
                ? "Nothing disputed or awaiting attribution."
                : "Nothing disputed or unattributable. Conflicts and quarantined selectors would appear here."}
            </p>
          ) : (
            <>
              {/* A reason shared by several cards is said once here; each card
                  keeps a pointer and the full text for screen readers. */}
              {sharedCaveats.shared.map((s) => (
                <div key={s.caveat} className="border-b border-border-subtle px-3 py-2" data-testid="shared-caveat">
                  <span className="text-micro font-medium text-muted-foreground">
                    {s.count} rows below share this reason
                  </span>
                  <AuthorityCaveat view={{ caveat: s.caveat, caveatKind: s.caveatKind as CaveatKind }} className="mt-0.5" />
                </div>
              ))}
              <ul>
                {unresolved.map(({ a, v }) => {
                  const shared = sharedCaveats.byRow.get(a.id);
                  return (
                    <li key={a.id} className="relative border-b border-border-subtle px-3 py-2 pl-4 last:border-b-0">
                      <AuthoritySpine state={v.state} />
                      <div className="flex items-start gap-2">
                        <ArtifactValue value={a.value} className="flex-1" />
                        <AuthorityChip view={v} />
                      </div>
                      {shared ? (
                        <p className="mt-1 text-micro text-faint-foreground">
                          <span aria-hidden>Shared reason, above</span>
                          <span className="sr-only">{shared.caveat}</span>
                        </p>
                      ) : (
                        <AuthorityCaveat view={v} className="mt-1" />
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          {(queue.more > 0 || queue.heldBack > 0) && (
            <p className="border-t border-border-subtle px-3 py-2 text-micro text-muted-foreground" data-testid="decision-queue-footer">
              {queue.more > 0 && <span>+{queue.more} more to decide. </span>}
              {queue.heldBack > 0 && (
                <span>
                  {queue.heldBack} breach/corpus row{queue.heldBack === 1 ? "" : "s"} held back — they belong to other
                  people in the same dataset and stay quarantined on the Evidence board.
                </span>
              )}
            </p>
          )}
        </section>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          {/* ── Authority distribution ─────────────────────────────────── */}
          <section className="panel overflow-hidden">
            <RuleLabel right={<span className="text-micro tabular-nums text-muted-foreground/70">{total}</span>}>
              Authority distribution
            </RuleLabel>
            <div className="space-y-1 p-3">
              {DIST.filter((d) => tally[d.state] > 0).map((d) => (
                <div key={d.state} className="grid grid-cols-[7rem_minmax(0,1fr)_2.5rem] items-center gap-2">
                  <span className="truncate text-data text-muted-foreground" title={HINT.get(d.state)}>{d.short}</span>
                  <span className="relative h-2 overflow-hidden rounded-sm bg-surface-3">
                    <span
                      className="absolute inset-y-0 left-0 rounded-sm"
                      style={{
                        width: `${Math.max(2, (tally[d.state] / maxDist) * 100)}%`,
                        background: d.state === "quarantined"
                          // Hatched, matching the spine: this bar is not a rung
                          // on the confidence ladder and must not read as one.
                          ? "repeating-linear-gradient(45deg, hsl(var(--authority-quarantine)) 0 3px, hsl(var(--authority-quarantine)/0.2) 3px 6px)"
                          : `hsl(var(--authority-${d.state}))`,
                      }}
                    />
                  </span>
                  <span className="text-right text-data font-semibold tabular-nums text-foreground/90">{tally[d.state]}</span>
                </div>
              ))}
            </div>
            {classes.length > 0 && (
              <>
                <RuleLabel right={<span className="text-micro tabular-nums text-muted-foreground/70">{classes.length} present</span>}>
                  <span title="Which source classes appear in this case. A spread of classes is not proof of independent corroboration — mirrors, resellers and wrappers over one upstream all count separately here.">
                    Source classes
                  </span>
                </RuleLabel>
                <div className="flex flex-wrap gap-1.5 p-3">
                  {classes.map(([k, n]) => (
                    <span key={k} className="inline-flex items-center gap-1 rounded border border-border-subtle bg-surface-2 px-1.5 py-px font-mono text-eyebrow text-muted-foreground">
                      {readableSourceLabel(k)}
                      <span className="tabular-nums text-foreground/70">{n}</span>
                    </span>
                  ))}
                </div>
              </>
            )}
          </section>

          {/* ── Strongest findings ─────────────────────────────────────── */}
          <section className="panel panel-flat overflow-hidden">
            <RuleLabel right={<span className="text-micro tabular-nums text-muted-foreground/70">{strongest.length} of {tally.verified + tally.infrastructure + tally.probable}</span>}>
              Strongest supported findings
            </RuleLabel>
            {strongest.length === 0 ? (
              <p className="p-3 text-data text-muted-foreground">No corroborated findings yet.</p>
            ) : (
              <ul>
                {strongest.map(({ a, v }) => (
                  <li key={a.id} className="relative grid grid-cols-[minmax(0,1fr)_auto_3rem] items-start gap-2 border-b border-border-subtle px-3 py-1.5 pl-4 last:border-b-0">
                    <AuthoritySpine state={v.state} />
                    <ArtifactValue value={a.value} />
                    <AuthorityChip view={v} />
                    <span className="text-right text-data font-semibold tabular-nums text-foreground/80">{effectiveConfidence(a) ?? "—"}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* ── Run diagnostics (secondary) ──────────────────────────────
            Register item 8: demoted from the top of the page. The run
            that produced the case is secondary to the case itself; its
            state, stop reason and tool activity appear below the
            findings and distribution. */}
        <RunCockpit
          input={{
            run: snapshot.run,
            tools: snapshot.tools,
            spendText: snapshot.spend.text,
            pendingDecisions: sheet.hydrated && !sheet.reviewsUnavailable ? sheet.model.queueTotal : null,
          }}
          onOpenDecisions={() => jump("artifacts")}
          onOpenTools={() => jump("issues")}
        />

        <RunStrip
          calls={activity.persistedTotal}
          failed={activity.failed}
          degraded={activity.degraded}
          cached={cached}
          wall={fmtWallClock(toolMs)}
          onJump={() => jump("issues")}
        />

        <div className="grid gap-4 lg:grid-cols-2">
          {/* ── Failed / degraded lookups ──────────────────────────────── */}
          <section className="panel panel-flat overflow-hidden">
            <RuleLabel
              right={
                <button type="button" onClick={() => jump("issues")} className="inline-flex items-center gap-1 text-micro text-muted-foreground hover:text-foreground">
                  Tools <ArrowRight className="h-3 w-3" aria-hidden />
                </button>
              }
            >
              Coverage gaps
            </RuleLabel>
            {failures.length === 0 ? (
              <p className="p-3 text-data text-muted-foreground">Every recorded lookup returned.</p>
            ) : (
              <ul>
                {failures.map((e) => (
                  <li key={e.id} className="border-b border-border-subtle px-3 py-2 last:border-b-0">
                    <div className="flex items-center gap-2">
                      <XCircle className={cn("h-3 w-3 shrink-0", e.status === "failed" ? "text-destructive" : "text-[hsl(var(--confidence-mid))]")} aria-hidden />
                      <span className="min-w-0 flex-1 truncate font-mono text-eyebrow uppercase tracking-wider text-foreground/85">{e.toolName}</span>
                      {e.durationMs != null && (
                        <span className="shrink-0 font-mono text-eyebrow tabular-nums text-muted-foreground/70">
                          {e.durationMs >= 1000 ? `${Math.round(e.durationMs / 1000)}s` : `${e.durationMs}ms`}
                        </span>
                      )}
                    </div>
                    {e.reason && <p className="mt-0.5 line-clamp-2 text-micro leading-snug text-muted-foreground">{e.reason}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* ── Latest evidence ──────────────────────────────────────────── */}
          <section className="panel panel-flat overflow-hidden">
            <RuleLabel right={<Activity className="h-3 w-3 text-muted-foreground/60" aria-hidden />}>
              Latest evidence
            </RuleLabel>
            {recent.length === 0 ? (
              <p className="p-3 text-data text-muted-foreground">Nothing recorded yet.</p>
            ) : (
              <ul>
                {recent.map((a: Artifact) => {
                  const v = authorityFor(a, review.get(a.id));
                  return (
                    <li key={a.id} className="relative grid grid-cols-[minmax(0,1fr)_auto_auto] items-start gap-2 border-b border-border-subtle px-3 py-1.5 pl-4 last:border-b-0">
                      <AuthoritySpine state={v.state} />
                      <ArtifactValue value={a.value} />
                      <AuthorityChip view={v} />
                      <span className="shrink-0 text-eyebrow tabular-nums text-muted-foreground/70">{timeAgo(a.created_at)}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
        <p className="text-[12px] leading-relaxed text-faint-foreground" data-assessment-boundaries>
          <span className="font-medium text-muted-foreground">Assessment boundaries.</span> Scores are the case engines' figures — recorded, capped confidence and
          identity-cluster linkage — not calibrated probabilities. Analyst review is recorded separately from the machine assessment and overrides it on every surface.
        </p>
      </div>
    </div>
  );
}
