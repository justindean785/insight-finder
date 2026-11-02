import { useMemo } from "react";
import { AlertTriangle, ArrowRight, Network, Play, Radio } from "lucide-react";
import { useWorkbenchPivots } from "@/hooks/useWorkbenchPivots";
import { buildIdentityClusters, type IdentityCluster, type ReviewAdjustment } from "@/lib/intel";
import type { ToolEvent } from "@/hooks/useThreadToolActivity";
import { cn } from "@/lib/utils";

/** Recent tool calls listed in the activity section. */
const ACTIVITY_ROWS = 6;
/** Identity groups listed in the connections section. */
const CLUSTER_ROWS = 4;
/** Pivots listed before "All pivots". */
const PIVOT_ROWS = 3;

function sinceLabel(iso: string | null | undefined, now: number): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

const TONE_DOT: Record<string, string> = {
  ok: "bg-[hsl(var(--authority-verified))]",
  empty: "bg-muted-foreground/50",
  fail: "bg-destructive",
  skip: "bg-muted-foreground/30",
};

function toneOf(e: ToolEvent): keyof typeof TONE_DOT {
  if (e.status === "succeeded") return "ok";
  if (e.status === "failed" || e.status === "degraded") return "fail";
  if (e.status === "empty") return "empty";
  return "skip";
}

/** The distinct selectors an identity group is built from, strongest kinds first. */
function clusterSelectors(c: IdentityCluster): Array<{ kind: string; value: string }> {
  const out: Array<{ kind: string; value: string }> = [];
  const push = (kind: string, values: string[]) => { for (const v of values) out.push({ kind, value: v }); };
  push("email", c.emails);
  push("phone", c.phones);
  push("username", c.usernames);
  push("name", c.names);
  push("ip", c.ips);
  return out;
}

/** Plain words for the group's strength. The number is the cluster engine's own (`buildIdentityClusters`). */
function strengthWord(confidence: number): string {
  if (confidence >= 80) return "Strong link";
  if (confidence >= 60) return "Likely link";
  if (confidence >= 40) return "Possible link";
  return "Weak link";
}

/**
 * Live case board: the Workbench's default view.
 *
 * What the analyst oversees while the agent works, on one surface:
 *  1. what the agent is doing (run state + the newest tool calls, live);
 *  2. the connections the case has formed (identity groups merged on shared
 *     email / phone / handle / infrastructure, with the engine's own score and
 *     its merge reasons);
 *  3. the next pivots, from the same queue as the Next tab.
 *
 * Read-only over existing engines: no new authority, no new score, no run path
 * of its own. Every figure here is the same one another surface prints.
 */
export function LiveBoard({ threadId }: { threadId: string }) {
  const { snapshot, review, artifacts, items, seed, caseRunning } = useWorkbenchPivots(threadId);
  const now = snapshot?.capturedAt ?? Date.now();

  const reviews = useMemo(() => {
    const m: Record<string, ReviewAdjustment> = {};
    for (const a of artifacts) {
      const r = review.get(a.id);
      if (r !== "new") m[a.id] = r;
    }
    return m;
  }, [artifacts, review]);
  const report = useMemo(() => buildIdentityClusters(artifacts, seed.value, reviews), [artifacts, seed.value, reviews]);
  const linked = useMemo(
    () => report.clusters
      .filter((c) => clusterSelectors(c).length >= 2)
      .sort((a, b) => b.confidence - a.confidence || b.artifacts.length - a.artifacts.length),
    [report.clusters],
  );

  const events = snapshot?.tools?.events ?? [];
  const recent = events.slice(-ACTIVITY_ROWS).reverse();
  const runnable = items.filter(
    (it): it is Extract<typeof it, { kind: "pivot" }> & { validation: { status: "valid" } } =>
      it.kind === "pivot" && it.validation.status === "valid",
  );

  const go = (detail: Record<string, unknown>) => window.dispatchEvent(new CustomEvent("swarmbot:workbench-tab", { detail }));
  const navigate = (tab: string) => window.dispatchEvent(new CustomEvent("swarmbot:navigate", { detail: { tab } }));

  if (!snapshot?.hydrated) {
    return <div className="space-y-3 p-5" aria-busy="true"><div className="h-24 animate-pulse rounded-md bg-surface-2 motion-reduce:animate-none" aria-hidden /></div>;
  }

  return (
    <div data-live-board className="divide-y divide-white/[0.06]">
      {/* 1. Agent activity */}
      <section aria-label="Agent activity" className="px-4 py-3">
        <header className="mb-2 flex items-center gap-2">
          <span className="relative flex h-2 w-2 shrink-0" aria-hidden>
            {caseRunning && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[hsl(var(--intel-blue))] opacity-60 motion-reduce:animate-none" />}
            <span className={cn("relative inline-flex h-2 w-2 rounded-full", caseRunning ? "bg-[hsl(var(--intel-blue))]" : "bg-muted-foreground/50")} />
          </span>
          <h3 className="text-[13px] font-medium text-foreground">{caseRunning ? "Agent working" : snapshot.run?.label || "Idle"}</h3>
          <span className="ml-auto text-[12px] tabular-nums text-muted-foreground">
            {snapshot.tools?.available ? `${snapshot.tools.total} calls` : ""}
          </span>
        </header>
        {recent.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No tool has run on this case yet.</p>
        ) : (
          <ul className="space-y-1">
            {recent.map((e) => (
              <li key={e.id} className="flex min-w-0 items-center gap-2 text-[13px]">
                <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", TONE_DOT[toneOf(e)])} aria-hidden />
                <span className="min-w-0 flex-1 truncate text-foreground/90" title={e.toolName}>{e.actionLabel || e.displayName}</span>
                <span className="shrink-0 text-[12px] text-muted-foreground">{e.status === "succeeded" ? "" : e.status} {sinceLabel(e.at, now)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 2. Connections forming */}
      <section aria-label="Connections" className="px-4 py-3">
        <header className="mb-2 flex items-center gap-2">
          <Network className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          <h3 className="text-[13px] font-medium text-foreground">Connections</h3>
          <span className="text-[12px] text-muted-foreground">{linked.length} linked group{linked.length === 1 ? "" : "s"}</span>
          <button
            type="button"
            onClick={() => navigate("graph")}
            className="ml-auto inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-[12.5px] text-muted-foreground hover:bg-white/[0.04] hover:text-foreground"
          >
            Graph <ArrowRight className="h-3 w-3" aria-hidden />
          </button>
        </header>
        {report.collision && (
          <p role="note" className="mb-2 flex items-start gap-1.5 rounded-md border border-warning/30 bg-warning/[0.06] px-2.5 py-1.5 text-[12.5px] leading-snug text-warning">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            More than one identity matches the seed. Linked groups below are kept apart until a shared selector joins them.
          </p>
        )}
        {linked.length === 0 ? (
          <p className="text-[13px] leading-snug text-muted-foreground">
            No two selectors are linked yet. A link forms when the same email, phone, handle or infrastructure shows up together across records.
          </p>
        ) : (
          <ul className="space-y-2">
            {linked.slice(0, CLUSTER_ROWS).map((c) => {
              const sel = clusterSelectors(c);
              return (
                <li key={c.id} className="rounded-md border border-border-subtle bg-surface-2/50 px-2.5 py-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[12.5px] font-medium text-foreground">{strengthWord(c.confidence)}</span>
                    <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.06]" aria-hidden>
                      <div className="h-full rounded-full bg-[hsl(var(--intel-blue))]" style={{ width: `${Math.max(4, Math.min(100, c.confidence))}%` }} />
                    </div>
                    <span className="shrink-0 font-mono text-[12px] tabular-nums text-muted-foreground" title="Cluster score from shared selectors (identity cluster engine)">{Math.round(c.confidence)}</span>
                  </div>
                  <ul className="mt-1.5 flex flex-wrap gap-1">
                    {sel.slice(0, 6).map((s) => (
                      <li key={`${s.kind}:${s.value}`} className="max-w-full rounded border border-border-subtle bg-surface-1 px-1.5 py-0.5 font-mono text-[12px] text-foreground/90 [overflow-wrap:anywhere]">
                        <span className="mr-1 font-sans text-[11px] text-faint-foreground">{s.kind}</span>{s.value}
                      </li>
                    ))}
                    {sel.length > 6 && <li className="px-1 text-[12px] text-muted-foreground">+{sel.length - 6}</li>}
                  </ul>
                  {c.mergeReasons[0] && (
                    <p className="mt-1 text-[12px] leading-snug text-muted-foreground">
                      {c.mergeReasons.slice(0, 2).join(" · ")}
                      {c.sources.length > 0 && <span className="text-faint-foreground"> · {c.sources.length} tool{c.sources.length === 1 ? "" : "s"}</span>}
                    </p>
                  )}
                  {c.warnings.length > 0 && (
                    <p className="mt-1 flex items-start gap-1 text-[12px] leading-snug text-warning">
                      <AlertTriangle className="mt-px h-3 w-3 shrink-0" aria-hidden />{c.warnings[0]}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* 3. Next pivots */}
      <section aria-label="Next pivots" className="px-4 py-3">
        <header className="mb-2 flex items-center gap-2">
          <Radio className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          <h3 className="text-[13px] font-medium text-foreground">Next pivots</h3>
          <span className="text-[12px] text-muted-foreground">{runnable.length}</span>
          <button
            type="button"
            onClick={() => go({ tab: "next" })}
            className="ml-auto inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-[12.5px] text-muted-foreground hover:bg-white/[0.04] hover:text-foreground"
          >
            All <ArrowRight className="h-3 w-3" aria-hidden />
          </button>
        </header>
        {runnable.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No pivot is waiting. New ones appear as the agent records selectors.</p>
        ) : (
          <ul className="space-y-1">
            {runnable.slice(0, PIVOT_ROWS).map((it) => {
              const p = it.validation.pivot;
              return (
                <li key={it.key} className="flex min-w-0 items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-[13px] leading-snug text-foreground [overflow-wrap:anywhere]">{p.target}</div>
                    <div className="truncate text-[12px] text-muted-foreground">{p.targetType} · {p.action}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => go({ tab: "next", open: it.key })}
                    aria-label={`Preview pivot: ${p.action} ${p.target}`}
                    className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-border-subtle bg-surface-3 px-2.5 text-[12.5px] font-medium text-foreground hover:bg-surface-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Play className="h-3 w-3" aria-hidden /> Preview
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
