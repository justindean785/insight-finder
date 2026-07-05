import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { AppNav } from "@/components/AppNav";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import {
  ArrowRight,
  FileSearch,
  MessageSquare,
  Plus,
  Search,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { isActiveThreadStatus } from "@/lib/thread-status";
import { captureError } from "@/lib/telemetry";
import { toast } from "sonner";

type CaseRow = {
  id: string;
  title: string | null;
  updated_at: string;
  created_at: string;
  status: string | null;
  seed_type: string | null;
  seed_value: string | null;
};

type CaseMetrics = {
  artifacts: number;
  toolCalls: number;
};

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

function statusLabel(status: string | null): { text: string; tone: string } {
  if (isActiveThreadStatus(status)) {
    return { text: "Running", tone: "text-[hsl(var(--intel-blue))] border-[hsl(var(--intel-blue)/0.35)] bg-[hsl(var(--intel-blue)/0.08)]" };
  }
  if (status === "stopped") {
    return { text: "Stopped", tone: "text-warning border-warning/30 bg-warning/10" };
  }
  return { text: "Finished", tone: "text-muted-foreground border-white/10 bg-white/[0.03]" };
}

export default function CasesPage() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [cases, setCases] = useState<CaseRow[]>([]);
  const [metrics, setMetrics] = useState<Map<string, CaseMetrics>>(new Map());
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const [threadsRes, artifactsRes, toolsRes] = await Promise.all([
        supabase
          .from("threads")
          .select("id,title,updated_at,created_at,status,seed_type,seed_value")
          .eq("user_id", user.id)
          .order("updated_at", { ascending: false })
          .limit(200),
        supabase
          .from("artifacts")
          .select("thread_id")
          .eq("user_id", user.id)
          .limit(10000),
        supabase
          .from("tool_usage_log")
          .select("thread_id")
          .eq("user_id", user.id)
          .limit(10000),
      ]);
      if (threadsRes.error) throw threadsRes.error;
      setCases((threadsRes.data ?? []) as CaseRow[]);

      const m = new Map<string, CaseMetrics>();
      for (const a of artifactsRes.data ?? []) {
        const tid = a.thread_id as string;
        const prev = m.get(tid) ?? { artifacts: 0, toolCalls: 0 };
        prev.artifacts++;
        m.set(tid, prev);
      }
      for (const t of toolsRes.data ?? []) {
        const tid = t.thread_id as string;
        const prev = m.get(tid) ?? { artifacts: 0, toolCalls: 0 };
        prev.toolCalls++;
        m.set(tid, prev);
      }
      setMetrics(m);
    } catch (e) {
      captureError(e, "cases.load");
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
    const channel = supabase
      .channel(`cases-${user.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "threads", filter: `user_id=eq.${user.id}` },
        () => void load(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "artifacts", filter: `user_id=eq.${user.id}` },
        () => void load(),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [user, load]);

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

  if (authLoading) {
    return (
      <div className="min-h-screen grid place-items-center text-muted-foreground">Loading…</div>
    );
  }
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
          ) : filtered.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              {query ? "No cases match your search." : "No cases yet — start a new investigation."}
            </div>
          ) : (
            <ul className="divide-y divide-border-subtle/60">
              {filtered.map((c) => {
                const m = metrics.get(c.id) ?? { artifacts: 0, toolCalls: 0 };
                const st = statusLabel(c.status);
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
                          <span className={cn("text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded-full border", st.tone)}>
                            {st.text}
                          </span>
                        </div>
                        <div className="mt-1 text-[11px] text-muted-foreground font-mono flex flex-wrap gap-x-3 gap-y-0.5">
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
