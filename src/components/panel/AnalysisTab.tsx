import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { describeError, describeNamedError } from "@/lib/error-text";
import { EmptyState } from "@/components/panel/EmptyState";
import { MetricCard } from "@/components/ui/workspace-primitives";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Microscope, ShieldCheck, Layers, AlertTriangle, ArrowRight, Wrench,
  RotateCcw,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Cross-investigation analysis.
 *
 * Insights answers "how much do I have"; this answers "how good is it, and
 * where does it break down". Every number here was chosen because a real
 * account exhibited the failure it measures:
 *
 *   - A pre-classification case had 41 of 101 artifacts at EXACTLY confidence
 *     50, each with confidence_cap_applied=50 and reason_for_confidence
 *     "single source class: unknown", while `source` named three real
 *     providers. An Evidence board where most rows share one score cannot be
 *     ranked, so the HISTOGRAM and the capped share are the headline — they
 *     are what makes that collapse visible instead of merely felt.
 *   - Source classification has since landed: the newest 400 artifacts
 *     classify at 89% and spread 15-100. The metric stays because it is the
 *     regression detector for exactly that fix.
 *   - evidence_log held 4 rows for 101 artifacts, so chain-of-custody coverage
 *     is a ratio, never a checkmark.
 *   - 9% of the newest 500 tool calls failed. Those rows were suppressed from
 *     the activity feed until they were surfaced alongside this tab.
 *
 * Read-only: this presents what the pipeline already stored. It computes no
 * confidence and promotes nothing — evidence-integrity rules are untouched.
 *
 * Rows are read NEWEST-FIRST and capped. Source classification landed partway
 * through this account's history — pre-fix cases sit at "unknown"/capped-50
 * while recent ones classify at ~89% and spread 15-100 — so an unordered
 * sample would mix the two eras and report a regression that is actually
 * already fixed. Newest-first keeps this a picture of CURRENT behaviour.
 */

type ArtifactRow = {
  id: string;
  thread_id: string;
  kind: string;
  confidence: number | null;
  source: string | null;
  metadata: Record<string, unknown> | null;
};
type ToolRow = { thread_id: string; ok: boolean | null };
type ThreadRow = { id: string; title: string | null; seed_value: string | null; status: string | null };

const BANDS = [
  { min: 0, max: 19, label: "0–19", tone: "hsl(var(--danger))" },
  { min: 20, max: 39, label: "20–39", tone: "hsl(var(--warning))" },
  { min: 40, max: 59, label: "40–59", tone: "hsl(var(--confidence-mid))" },
  { min: 60, max: 79, label: "60–79", tone: "hsl(var(--confidence-high))" },
  { min: 80, max: 100, label: "80–100", tone: "hsl(var(--success))" },
];

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);

export function AnalysisTab() {
  const { user } = useAuth();
  const [artifacts, setArtifacts] = useState<ArtifactRow[]>([]);
  const [tools, setTools] = useState<ToolRow[]>([]);
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [custodyCount, setCustodyCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [a, t, th, ev] = await Promise.all([
          supabase.from("artifacts").select("id,thread_id,kind,confidence,source,metadata").order("created_at", { ascending: false }).limit(5000),
          supabase.from("tool_usage_log").select("thread_id,ok").order("created_at", { ascending: false }).limit(5000),
          supabase.from("threads").select("id,title,seed_value,status").order("updated_at", { ascending: false }).limit(500),
          supabase.from("evidence_log").select("artifact_id").order("created_at", { ascending: false }).limit(5000),
        ]);
        if (cancelled) return;
        // Name the failing query. Promise.all collapses four requests into one
        // rejection, and "artifacts denied by RLS" and "evidence_log timed out"
        // are different problems with different owners.
        const failed = ([
          ["artifacts", a.error],
          ["tool_usage_log", t.error],
          ["threads", th.error],
          ["evidence_log", ev.error],
        ] as const).filter(([, err]) => err);
        if (failed.length) {
          throw new Error(failed.map(([name, err]) => describeNamedError(name, err)).join(" · "));
        }
        setArtifacts((a.data ?? []) as ArtifactRow[]);
        setTools((t.data ?? []) as ToolRow[]);
        setThreads((th.data ?? []) as ThreadRow[]);
        setCustodyCount(new Set((ev.data ?? []).map((r: { artifact_id: string }) => r.artifact_id)).size);
      } catch (e) {
        if (!cancelled) setError(describeError(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [user, reloadKey]);

  const stats = useMemo(() => {
    const scored = artifacts.filter((a) => a.confidence != null);
    const histogram = BANDS.map((b) => ({
      ...b,
      count: scored.filter((a) => (a.confidence as number) >= b.min && (a.confidence as number) <= b.max).length,
    }));

    // Modal score — the "everything reads 50%" symptom, stated as a number.
    const freq = new Map<number, number>();
    for (const a of scored) freq.set(a.confidence!, (freq.get(a.confidence!) ?? 0) + 1);
    const [modalScore, modalCount] = [...freq.entries()].sort((x, y) => y[1] - x[1])[0] ?? [0, 0];

    const capped = artifacts.filter((a) => {
      const cap = (a.metadata as { confidence_cap_applied?: number } | null)?.confidence_cap_applied;
      return typeof cap === "number" && a.confidence != null && a.confidence >= cap;
    }).length;

    const unclassified = artifacts.filter((a) => {
      const cat = (a.metadata as { source_category?: unknown } | null)?.source_category;
      const list = Array.isArray(cat) ? cat : cat ? [cat] : [];
      return list.length === 0 || list.every((c) => String(c).toLowerCase() === "unknown");
    }).length;

    // Names >1 provider in free text, but carries no structured multi-source
    // signal — the shape that reads "single-source" on a 3-provider artifact.
    const multiNamedUnstructured = artifacts.filter((a) => {
      const md = (a.metadata ?? {}) as Record<string, unknown>;
      const structured = md.sources ?? md.corroborations ?? md.source_count;
      return (a.source ?? "").includes(",") && !structured;
    }).length;

    const failedTools = tools.filter((t) => t.ok === false).length;

    const byThread = new Map<string, { artifacts: number; capped: number; failed: number }>();
    for (const a of artifacts) {
      const e = byThread.get(a.thread_id) ?? { artifacts: 0, capped: 0, failed: 0 };
      e.artifacts++;
      const cap = (a.metadata as { confidence_cap_applied?: number } | null)?.confidence_cap_applied;
      if (typeof cap === "number" && a.confidence != null && a.confidence >= cap) e.capped++;
      byThread.set(a.thread_id, e);
    }
    for (const t of tools) {
      if (t.ok !== false) continue;
      const e = byThread.get(t.thread_id) ?? { artifacts: 0, capped: 0, failed: 0 };
      e.failed++;
      byThread.set(t.thread_id, e);
    }
    const rows = threads
      .map((th) => ({ thread: th, ...(byThread.get(th.id) ?? { artifacts: 0, capped: 0, failed: 0 }) }))
      .filter((r) => r.artifacts > 0)
      .sort((x, y) => y.artifacts - x.artifacts)
      .slice(0, 15);

    return {
      scored: scored.length, total: artifacts.length, histogram,
      modalScore, modalCount, capped, unclassified, multiNamedUnstructured,
      failedTools, toolTotal: tools.length, rows,
    };
  }, [artifacts, tools, threads]);

  if (error) {
    return (
      <div className="panel relative overflow-hidden border-[hsl(var(--authority-conflict))]/40 p-4">
        <span aria-hidden className="spine" data-authority="conflict" />
        <div className="pl-1">
          <div className="flex items-center gap-2 text-meta font-semibold text-[hsl(var(--authority-conflict))]">
            <AlertTriangle className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden />
            Analysis could not load
          </div>
          <p className="mt-1.5 text-data leading-relaxed text-muted-foreground">
            The cross-case queries did not return. Nothing is lost — this view is
            read-only and reads live tables.
          </p>
          <pre className="panel-inset mt-2.5 overflow-x-auto p-2.5 font-mono text-micro leading-relaxed text-foreground/85">{error}</pre>
          <button
            type="button"
            onClick={() => setReloadKey((n) => n + 1)}
            className="mt-2.5 inline-flex items-center gap-1.5 rounded-md border border-border-strong bg-surface-2 px-2.5 py-1 text-data font-medium text-foreground transition-colors hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Try again
          </button>
        </div>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-20 rounded-xl" />)}
        </div>
        <Skeleton className="h-56 rounded-2xl" />
      </div>
    );
  }
  if (stats.total === 0) {
    return <EmptyState icon={Microscope} title="No artifacts to analyse yet" hint="Run an investigation — this breaks down confidence, source classification, and custody coverage across every case." />;
  }

  const modalShare = pct(stats.modalCount, stats.scored);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <MetricCard
          label="Artifacts scored" value={`${stats.scored}/${stats.total}`} icon={Layers}
          tone={stats.scored === stats.total ? "ok" : "warn"}
          hint="Artifacts carrying a stored confidence value."
        />
        <MetricCard
          label="At the cap" value={`${pct(stats.capped, stats.total)}%`} icon={ShieldCheck}
          tone={pct(stats.capped, stats.total) > 50 ? "warn" : "neutral"}
          hint="Artifacts sitting at their confidence ceiling. A high share means the cap — not the evidence — is setting the score."
        />
        <MetricCard
          label="Unclassified source" value={`${pct(stats.unclassified, stats.total)}%`} icon={AlertTriangle}
          tone={pct(stats.unclassified, stats.total) > 50 ? "warn" : "neutral"}
          hint="source_category empty or 'unknown'. Unclassified sources collapse to one class, which is what pins the cap."
        />
        <MetricCard
          label="Tool failure rate" value={`${pct(stats.failedTools, stats.toolTotal)}%`} icon={Wrench}
          tone={pct(stats.failedTools, stats.toolTotal) > 15 ? "warn" : "neutral"}
          hint={`${stats.failedTools} of ${stats.toolTotal} calls failed. The Tools activity feed suppresses these.`}
        />
      </div>

      <section className="rounded-2xl border border-border-subtle/80 glass-card p-5">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <h3 className="font-display text-title font-semibold tracking-tight">Confidence distribution</h3>
          <div className="font-mono text-micro text-muted-foreground">
            {stats.scored} scored · modal score{" "}
            <span className={cn("text-foreground", modalShare >= 30 && "text-[hsl(var(--warning))]")}>
              {stats.modalScore}
            </span>{" "}
            on {modalShare}% of artifacts
          </div>
        </div>

        {modalShare >= 30 && (
          <p className="mt-2 text-data leading-5 text-[hsl(var(--warning))]">
            {modalShare}% of scored artifacts share the single value {stats.modalScore}. When most
            evidence carries one score the board cannot be ranked — check whether source
            classification is populating, since an unclassified source caps the score.
          </p>
        )}

        <div className="mt-4 space-y-2">
          {stats.histogram.map((b) => (
            <div key={b.label} className="flex items-center gap-3">
              <div className="w-16 shrink-0 font-mono text-micro text-muted-foreground tabular-nums">{b.label}</div>
              <div className="relative h-5 flex-1 overflow-hidden rounded bg-surface-2/60">
                <div
                  className="absolute inset-y-0 left-0 rounded transition-[width] duration-500 ease-premium"
                  style={{ width: `${pct(b.count, stats.scored)}%`, background: b.tone, opacity: 0.75 }}
                />
              </div>
              <div className="w-20 shrink-0 text-right font-mono text-micro tabular-nums text-muted-foreground">
                {b.count} · {pct(b.count, stats.scored)}%
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-2xl border border-border-subtle/80 glass-card p-5">
          <h3 className="font-display text-title font-semibold tracking-tight">Corroboration integrity</h3>
          <dl className="mt-3 space-y-3">
            <Row
              label="Chain-of-custody coverage"
              value={`${custodyCount}/${stats.total}`}
              detail="Artifacts with at least one evidence_log entry."
              warn={pct(custodyCount, stats.total) < 50}
            />
            <Row
              label="Multi-provider, unstructured"
              value={String(stats.multiNamedUnstructured)}
              detail="`source` names more than one provider but no structured sources[] exists, so the artifact still reads single-source."
              warn={stats.multiNamedUnstructured > 0}
            />
            <Row
              label="Unclassified source category"
              value={`${stats.unclassified}/${stats.total}`}
              detail="Collapses every provider into one 'unknown' class."
              warn={pct(stats.unclassified, stats.total) > 50}
            />
          </dl>
        </div>

        <div className="rounded-2xl border border-border-subtle/80 glass-card p-5">
          <h3 className="font-display text-title font-semibold tracking-tight">Per-case breakdown</h3>
          <p className="mt-1 text-micro text-muted-foreground">Top 15 by artifact count.</p>
          <div className="mt-3 -mx-2 overflow-x-auto">
            <table className="w-full min-w-[420px] text-data">
              <thead>
                <tr className="text-eyebrow uppercase tracking-wider text-muted-foreground">
                  <th className="px-2 py-1.5 text-left font-normal">Case</th>
                  <th className="px-2 py-1.5 text-right font-normal">Artifacts</th>
                  <th className="px-2 py-1.5 text-right font-normal">Capped</th>
                  <th className="px-2 py-1.5 text-right font-normal">Failed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle/50">
                {stats.rows.map((r) => (
                  <tr key={r.thread.id} className="hover:bg-white/[0.03]">
                    <td className="px-2 py-1.5 max-w-[220px]">
                      <Link to={`/cases/${r.thread.id}`} className="inline-flex items-center gap-1 truncate text-foreground/90 hover:text-foreground">
                        <span className="truncate">{r.thread.title?.trim() || r.thread.seed_value || "Untitled case"}</span>
                        <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
                      </Link>
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums">{r.artifacts}</td>
                    <td className={cn("px-2 py-1.5 text-right font-mono tabular-nums", pct(r.capped, r.artifacts) > 50 && "text-[hsl(var(--warning))]")}>
                      {pct(r.capped, r.artifacts)}%
                    </td>
                    <td className={cn("px-2 py-1.5 text-right font-mono tabular-nums", r.failed > 0 && "text-[hsl(var(--danger))]")}>
                      {r.failed}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}

function Row({ label, value, detail, warn }: { label: string; value: string; detail: string; warn?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <dt className="text-meta text-foreground/90">{label}</dt>
        <dd className="mt-0.5 text-micro leading-4 text-muted-foreground">{detail}</dd>
      </div>
      <div className={cn("shrink-0 font-mono text-meta tabular-nums", warn ? "text-[hsl(var(--warning))]" : "text-foreground")}>
        {value}
      </div>
    </div>
  );
}
