import { useMemo } from "react";
// One number, everywhere. See src/lib/display-confidence.ts.
import { effectiveConfidence, effectiveConfidenceOrZero } from "@/lib/display-confidence";
import { useThreadArtifacts, type Artifact } from "@/hooks/useThreadArtifacts";
import { useThreadToolActivity } from "@/hooks/useThreadToolActivity";
import { useReviewStates } from "@/lib/review";
import { authorityFor, tallyAuthority, LEDGER_SORT_RANK, AUTHORITY_LEGEND, type AuthorityState } from "@/lib/authority";
import { AuthorityChip, AuthoritySpine, AuthorityCaveat, RuleLabel } from "@/components/ui/authority";
import { TabHeader } from "@/components/ui/workspace-primitives";
import { readableSourceLabel } from "@/lib/tool-display";
import { timeAgo } from "@/lib/time";
import { cn } from "@/lib/utils";
import { fmtWallClock } from "@/lib/duration";
import {
  LayoutDashboard, Unlink, AlertTriangle, XCircle, ShieldCheck, Timer,
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

const DIST: { state: AuthorityState; short: string }[] = [
  { state: "verified", short: "Verified" },
  { state: "infrastructure", short: "Infra" },
  { state: "probable", short: "Probable" },
  { state: "review", short: "Review" },
  { state: "conflict", short: "Conflict" },
  { state: "quarantined", short: "Quarantined" },
  { state: "weak", short: "Leads" },
  { state: "failed", short: "Excluded" },
];

const HINT = new Map(AUTHORITY_LEGEND.map((e) => [e.state, e.hint]));

function jump(tab: string) {
  window.dispatchEvent(new CustomEvent("swarmbot:navigate", { detail: { tab } }));
}

/** A single instrument reading. Big number, small label, optional action. */
function Stat({
  icon: Icon, label, value, sub, tone, onClick, title,
}: {
  icon: LucideIcon; label: string; value: string | number; sub?: string;
  tone?: string; onClick?: () => void; title?: string;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      {...(onClick ? { type: "button" as const, onClick } : {})}
      title={title}
      data-interactive={onClick ? "true" : undefined}
      className={cn(
        "panel stat-tile px-3 py-2.5 text-left transition-colors",
        onClick && "hover:border-border-strong hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      <span className="flex items-center gap-1.5 text-eyebrow uppercase tracking-[0.12em] text-muted-foreground">
        <Icon className={cn("h-3 w-3 shrink-0", tone)} strokeWidth={2} aria-hidden />
        {label}
      </span>
      <span className={cn("mt-1.5 block font-display text-h2 font-semibold leading-none", tone ? "tabular-nums" : "stat-figure", tone)}>{value}</span>
      {sub && <span className="mt-1 block truncate text-micro text-muted-foreground">{sub}</span>}
    </Tag>
  );
}

export function OverviewTab({ threadId }: { threadId: string }) {
  const { items } = useThreadArtifacts(threadId);
  const activity = useThreadToolActivity(threadId);
  const review = useReviewStates(threadId);

  const tally = useMemo(() => tallyAuthority(items, review.get), [items, review]);
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
  const unresolved = useMemo(() => {
    return [...items]
      .map((a) => ({ a, v: authorityFor(a, review.get(a.id)) }))
      .filter((x) => x.v.state === "quarantined" || x.v.state === "conflict")
      .sort((x, y) => LEDGER_SORT_RANK[x.v.state] - LEDGER_SORT_RANK[y.v.state])
      .slice(0, 5);
  }, [items, review]);

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

  const maxDist = Math.max(1, ...DIST.map((d) => tally[d.state]));

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <TabHeader icon={LayoutDashboard} title="Overview" subtitle={`${total} artifact${total === 1 ? "" : "s"} · ${activity.persistedTotal} tool call${activity.persistedTotal === 1 ? "" : "s"}`} />

      <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4">
        {/* ── Instrument row ───────────────────────────────────────────── */}
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
          <Stat
            icon={ShieldCheck} label="Verified" value={tally.verified}
            tone="text-[hsl(var(--authority-verified))]"
            sub="corroborated or analyst-confirmed"
            title={HINT.get("verified")} onClick={() => jump("artifacts")}
          />
          <Stat
            icon={AlertTriangle} label="Conflict" value={tally.conflict}
            tone={tally.conflict > 0 ? "text-[hsl(var(--authority-conflict))]" : undefined}
            sub="contradicts the case"
            title={HINT.get("conflict")} onClick={() => jump("artifacts")}
          />
          <Stat
            icon={Unlink} label="Quarantined" value={tally.quarantined}
            tone={tally.quarantined > 0 ? "text-[hsl(var(--authority-quarantine))]" : undefined}
            sub="linkage unproven"
            title={HINT.get("quarantined")} onClick={() => jump("artifacts")}
          />
          {/* NEVER sum these. `failed` is breakage — the lookup did not happen
              and whatever it would have found is missing. `degraded` is
              transient — our own throttles, upstream rate limits, timeouts —
              and can succeed on a retry. ToolsTab keeps them as separate tiles
              for that reason, and an Overview that adds them under the word
              "failed" both overstates breakage and destroys the distinction an
              analyst uses to decide whether to re-run. This is the
              suppressed-failure problem in a new direction. */}
          <Stat
            icon={XCircle} label="Coverage gaps"
            value={activity.degraded > 0 ? `${activity.failed}/${activity.degraded}` : activity.failed}
            tone={activity.failed > 0 ? "text-destructive" : activity.degraded > 0 ? "text-[hsl(var(--confidence-mid))]" : undefined}
            sub={activity.degraded > 0 ? "failed / degraded" : "failed lookups"}
            title={
              `${activity.failed} failed — the lookup did not happen, so anything it would have found is missing from this case.` +
              (activity.degraded > 0
                ? ` ${activity.degraded} degraded — throttles, upstream rate limits, denials and timeouts; these can succeed on a retry.`
                : "")
            }
            onClick={() => jump("issues")}
          />
          <Stat
            icon={Timer} label="Time in tools"
            // `Math.round(ms / 60_000)` reported 87s as "1m" — a 31% understatement,
            // and every value from 30s to 89s collapsed onto the same label while
            // the Tools tab showed the true "87s" for the same run. Carry the
            // remainder: a wall-clock figure in an evidence tool should not round
            // away half a minute of it.
            // Round to whole seconds FIRST, then split. Rounding the remainder
            // separately let it reach 60 and print "1m 60s" (119.6s did exactly
            // that), and "60s" just under the minute mark.
            value={fmtWallClock(toolMs)}
            sub={cached > 0 ? `${cached} served from cache` : "wall-clock across the run"}
            title="Total wall-clock across every recorded call."
            onClick={() => jump("issues")}
          />
        </div>

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

          {/* ── Needs a decision ───────────────────────────────────────── */}
          <section className="panel overflow-hidden">
            <RuleLabel
              right={
                unresolved.length > 0 ? (
                  <button type="button" onClick={() => jump("artifacts")} className="inline-flex items-center gap-1 text-micro text-muted-foreground hover:text-foreground">
                    Open <ArrowRight className="h-3 w-3" aria-hidden />
                  </button>
                ) : undefined
              }
            >
              Needs a decision
            </RuleLabel>
            {unresolved.length === 0 ? (
              <p className="p-3 text-data text-muted-foreground">
                Nothing disputed or unattributable. Conflicts and quarantined selectors would appear here.
              </p>
            ) : (
              <ul>
                {unresolved.map(({ a, v }) => (
                  <li key={a.id} className="relative border-b border-border-subtle px-3 py-2 pl-4 last:border-b-0">
                    <AuthoritySpine state={v.state} />
                    <div className="flex items-center gap-2">
                      <span className="mono-value min-w-0 flex-1 truncate text-data text-foreground/95" title={a.value}>{a.value}</span>
                      <AuthorityChip view={v} />
                    </div>
                    <AuthorityCaveat view={v} className="mt-1" />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          {/* ── Strongest findings ─────────────────────────────────────── */}
          <section className="panel overflow-hidden lg:col-span-2">
            <RuleLabel right={<span className="text-micro tabular-nums text-muted-foreground/70">{strongest.length} of {tally.verified + tally.infrastructure + tally.probable}</span>}>
              Strongest supported findings
            </RuleLabel>
            {strongest.length === 0 ? (
              <p className="p-3 text-data text-muted-foreground">No corroborated findings yet.</p>
            ) : (
              <ul>
                {strongest.map(({ a, v }) => (
                  <li key={a.id} className="relative grid grid-cols-[minmax(0,1fr)_auto_3rem] items-center gap-2 border-b border-border-subtle px-3 py-1.5 pl-4 last:border-b-0">
                    <AuthoritySpine state={v.state} />
                    <span className="mono-value min-w-0 truncate text-data text-foreground/95" title={a.value}>{a.value}</span>
                    <AuthorityChip view={v} />
                    <span className="text-right text-data font-semibold tabular-nums text-foreground/80">{effectiveConfidence(a) ?? "—"}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* ── Failed / degraded lookups ──────────────────────────────── */}
          <section className="panel overflow-hidden">
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
        </div>

        {/* ── Latest evidence ──────────────────────────────────────────── */}
        <section className="panel overflow-hidden">
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
                  <li key={a.id} className="relative grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 border-b border-border-subtle px-3 py-1.5 pl-4 last:border-b-0">
                    <AuthoritySpine state={v.state} />
                    <span className="mono-value min-w-0 truncate text-data text-foreground/90" title={a.value}>{a.value}</span>
                    <AuthorityChip view={v} />
                    <span className="shrink-0 text-eyebrow tabular-nums text-muted-foreground/70">{timeAgo(a.created_at)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
