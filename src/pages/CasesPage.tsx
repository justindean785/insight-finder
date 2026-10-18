import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { AppNav } from "@/components/AppNav";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { FullPageLoader } from "@/components/ui/full-page-loader";
import { Input } from "@/components/ui/input";
import {
  ArrowRight,
  FileSearch,
  MessageSquare,
  Plus,
  Search,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { deriveRunState, RUN_STATE_LABEL, type CaseRunState } from "@/lib/case-snapshot";
import { captureError } from "@/lib/telemetry";
import { loadCaseMetrics } from "@/lib/case-metrics";
import { toast } from "sonner";

type CaseRow = {
  id: string;
  title: string | null;
  updated_at: string;
  created_at: string;
  status: string | null;
  seed_type: string | null;
  seed_value: string | null;
  // Run markers: an "active" row with neither of these never started (I-1).
  run_started_at: string | null;
  last_heartbeat_at: string | null;
  // Written by server recovery: a `finished` row carrying either did not finish normally (I-2).
  recovered_at: string | null;
  recovery_reason: string | null;
};

import type { CaseMetrics } from "@/lib/case-metrics";

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const diff = Date.now() - t;
  const s = Math.max(1, Math.round(diff / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

/** While a row shows Running, re-read this often: the case snapshot's own live-poll interval. */
const RUNNING_REREAD_MS = 30_000;

const STATUS_CHIP: Record<CaseRunState, { text: string; tone: string }> = {
  running: { text: "Running", tone: "text-[hsl(var(--intel-blue))] border-[hsl(var(--intel-blue)/0.35)] bg-[hsl(var(--intel-blue)/0.08)]" },
  draft: { text: "Draft", tone: "text-muted-foreground border-white/10 bg-white/[0.03]" },
  stopped: { text: "Stopped", tone: "text-warning border-warning/30 bg-warning/10" },
  interrupted: { text: RUN_STATE_LABEL.interrupted, tone: "text-[hsl(var(--warning))] border-[hsl(var(--warning)/0.45)] bg-[hsl(var(--warning)/0.1)]" },
  completed: { text: "Finished", tone: "text-muted-foreground border-white/10 bg-white/[0.03]" },
};

/**
 * The same run state the workspace header shows (`deriveRunState`), so the list
 * and the case can never disagree about one run.
 *
 * Takes the ROW, not just the status. `active` alone cannot tell a live run from
 * a never-started thread (born `active` from the column default: a Draft, I-1),
 * nor from a run whose isolate was killed (still `active`, heartbeat lapsed:
 * Interrupted). A `finished` row carrying a recovery marker is Interrupted too,
 * never Finished (I-2).
 *
 * `nowMs` is when the rows were READ, not render time: a heartbeat is only as
 * fresh as the read that returned it, so judging old rows against a later clock
 * would turn a live run Interrupted on any re-render (typing in search).
 */
function statusLabel(row: CaseRow, nowMs: number): { text: string; tone: string } {
  return STATUS_CHIP[deriveRunState({ thread: row, chatRunning: false, nowMs })];
}

export default function CasesPage() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [cases, setCases] = useState<CaseRow[]>([]);
  // When `cases` was read: the clock its run states are judged against.
  const [casesReadAt, setCasesReadAt] = useState(() => Date.now());
  const [metrics, setMetrics] = useState<Map<string, CaseMetrics>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Whether `metrics` has ever held real counts. Until it has, a counts failure is
  // an error even on a background refresh: rows with 0/0 counts would mislead.
  const metricsLoadedRef = useRef(false);
  // The last read's counts failed: the list is not current (new cases held back,
  // or an error shown). Keeps the timed re-read below running until counts load.
  const [countsStale, setCountsStale] = useState(false);
  // Reads overlap (realtime, the timer, a retry). A read publishes unless a NEWER
  // read already has: an older read finishing late must not overwrite newer rows,
  // yet a read must not be dropped just because a newer one STARTED (that one may
  // fail, or be superseded in turn), or the list would never publish.
  const loadSeqRef = useRef(0);
  const publishedSeqRef = useRef(0);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");

  // Only the first load shows the full skeleton; realtime refreshes update the
  // list in place (silent) so a live scan doesn't flash back to skeleton.
  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!user) return;
    const seq = ++loadSeqRef.current;
    if (!opts?.silent) setLoading(true);
    try {
      // Counts are aggregated in Postgres (get_case_metrics). Tallying fetched
      // ROWS in the browser silently under-reported once an account passed the
      // row cap — see src/lib/case-metrics.ts for the measured production case.
      const [{ threadsRes, readAt }, metricsRes] = await Promise.all([
        supabase
          .from("threads")
          .select("id,title,updated_at,created_at,status,seed_type,seed_value,run_started_at,last_heartbeat_at,recovered_at,recovery_reason")
          .eq("user_id", user.id)
          .order("updated_at", { ascending: false })
          .limit(200)
          // Stamp the rows when THEY arrive: a slow counts call must not age a live heartbeat.
          .then((res) => ({ threadsRes: res, readAt: Date.now() })),
        loadCaseMetrics(supabase).then(
          (map) => ({ map }),
          (failure: unknown) => ({ failure }),
        ),
      ]);
      if (seq <= publishedSeqRef.current) return; // a newer read already published
      // A failed threads read leaves the flag as it was: the list is no more current.
      if (threadsRes.error) throw threadsRes.error;
      setCountsStale("failure" in metricsRes);
      if ("failure" in metricsRes) {
        // No counts yet is an error: zeros would mislead. Once counts have loaded, a
        // background re-read keeps the last good counts but still applies the thread
        // rows, so a dead run's label does not wait on an unrelated RPC.
        if (!opts?.silent || !metricsLoadedRef.current) throw metricsRes.failure;
        captureError(metricsRes.failure, "cases.metrics");
      }
      const rows = (threadsRes.data ?? []) as CaseRow[];
      publishedSeqRef.current = seq;
      setError(null);
      if ("map" in metricsRes) {
        metricsLoadedRef.current = true;
        setMetrics(metricsRes.map);
        setCases(rows);
      } else {
        // Counts are stale: refresh the rows already on screen (their run state)
        // but add none the cached counts never covered — a new case would read 0/0.
        const fresh = new Map(rows.map((r) => [r.id, r]));
        setCases((prev) => prev.map((r) => fresh.get(r.id) ?? r));
      }
      setCasesReadAt(readAt);
    } catch (e) {
      captureError(e, "cases.load");
      // Surface the failure instead of silently rendering the "no cases" empty
      // state — for a foreground load, or for any read while nothing has published
      // yet; a failed background refresh keeps the list already shown, no flash.
      // Never over a newer read's result.
      if (seq > publishedSeqRef.current && (!opts?.silent || publishedSeqRef.current === 0)) {
        setError(e instanceof Error ? e.message : "Could not load your cases.");
      }
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (authLoading || !user) return;
    void load();
  }, [authLoading, user, load]);

  useEffect(() => {
    if (!user) return;
    // Coalesce realtime bursts (a live scan writes rows rapidly) into a single
    // silent refresh so we don't fire a 3-query storm per artifact insert.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load({ silent: true }), 600);
    };
    const channel = supabase
      .channel(`cases-${user.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "threads", filter: `user_id=eq.${user.id}` },
        schedule,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "artifacts", filter: `user_id=eq.${user.id}` },
        schedule,
      )
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [user, load]);

  // A run that dies stops writing, so no realtime event will ever re-read its
  // row, and the label above is judged as of the last read. While any row shows
  // Running, re-read on a timer so a dead run turns Interrupted once its
  // heartbeat lapses. Also while counts are stale, so whatever a counts outage
  // held back appears once they load. Stops by itself when neither holds.
  const anyRunning = useMemo(
    () => cases.some((c) => deriveRunState({ thread: c, chatRunning: false, nowMs: casesReadAt }) === "running"),
    [cases, casesReadAt],
  );
  useEffect(() => {
    if (!user || !(anyRunning || countsStale)) return;
    const id = setInterval(() => {
      if (document.visibilityState !== "hidden") void load({ silent: true });
    }, RUNNING_REREAD_MS);
    return () => clearInterval(id);
  }, [user, anyRunning, countsStale, load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return cases;
    return cases.filter((c) => {
      const hay = `${c.title ?? ""} ${c.seed_value ?? ""} ${c.seed_type ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [cases, query]);

  const startCase = async () => {
    if (!user || creating) return;
    setCreating(true);
    try {
      const { data, error } = await supabase
        .from("threads")
        .insert({ user_id: user.id })
        .select("id")
        .single();
      if (error) throw error;
      if (data) navigate(`/chat/${data.id}`);
    } catch (e) {
      toast.error("Couldn't start a new case", {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setCreating(false);
    }
  };

  if (authLoading) return <FullPageLoader />;
  if (!user) return <Navigate to="/auth" replace />;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <AppNav />
      <main className="mx-auto max-w-6xl px-4 sm:px-8 py-8 pb-16">
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
          <div>
            <div className="text-eyebrow uppercase tracking-[0.26em] text-primary/80">Cases</div>
            <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight">All investigations</h1>
            <p className="mt-2 text-sm text-muted-foreground max-w-xl">
              Browse every case you&apos;ve run. Open a case to review evidence, tools, and reports — without
              jumping into the chat agent.
            </p>
          </div>
          <Button onClick={startCase} disabled={creating} variant="cta" className="h-10 rounded-xl gap-2 shrink-0">
            <Plus className="w-4 h-4" />
            {creating ? "Starting…" : "New investigation"}
          </Button>
        </div>

        <div className="mt-6 relative max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by title or seed…"
            className="pl-9 h-10 rounded-xl bg-white/[0.03] border-white/10"
          />
        </div>

        <div className="mt-6 rounded-2xl border border-border-subtle/80 glass-card overflow-hidden">
          {loading ? (
            <div className="p-4 space-y-3">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : error && cases.length === 0 ? (
            <div className="p-8 text-center text-sm">
              <p className="text-danger">{error}</p>
              <button
                onClick={() => void load()}
                className="mt-3 inline-flex items-center rounded-lg border border-border-subtle px-3 py-1.5 text-xs text-foreground hover:bg-white/[0.04]"
              >
                Retry
              </button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              {query ? "No cases match your search." : "No cases yet — start a new investigation."}
            </div>
          ) : (
            <ul className="divide-y divide-border-subtle/60">
              {filtered.map((c) => {
                const m = metrics.get(c.id) ?? { artifacts: 0, toolCalls: 0 };
                const st = statusLabel(c, casesReadAt);
                return (
                  <li key={c.id}>
                    <Link
                      to={`/cases/${c.id}`}
                      className="flex items-center gap-3 px-4 py-4 hover:bg-white/[0.03] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                    >
                      <div className="w-9 h-9 rounded-xl border border-white/10 bg-white/[0.04] grid place-items-center shrink-0">
                        <FileSearch className="w-4 h-4 text-[hsl(var(--intel-blue))]" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium text-foreground truncate max-w-[min(100%,20rem)]">
                            {c.title?.trim() || "Untitled case"}
                          </span>
                          <span className={cn("text-eyebrow font-mono uppercase tracking-wider px-2 py-0.5 rounded-full border", st.tone)}>
                            {st.text}
                          </span>
                        </div>
                        <div className="mt-1 text-micro text-muted-foreground font-mono flex flex-wrap gap-x-3 gap-y-0.5">
                          <span>{m.artifacts} artifacts</span>
                          <span>{m.toolCalls} tool calls</span>
                          <span>Updated {relativeTime(c.updated_at)}</span>
                        </div>
                      </div>
                      <ArrowRight className="w-4 h-4 text-muted-foreground/60 shrink-0" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <p className="mt-4 text-xs text-muted-foreground">
          Showing your cases only ({cases.length.toLocaleString()} total).{" "}
          <Link to="/chat" className="text-[hsl(var(--intel-blue))] hover:underline inline-flex items-center gap-1">
            <MessageSquare className="w-3 h-3" /> Resume agent chat
          </Link>
        </p>
      </main>
    </div>
  );
}
