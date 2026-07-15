import { lazy, Suspense, useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { useThreadArtifacts } from "@/hooks/useThreadArtifacts";
import { useThreadToolActivity } from "@/hooks/useThreadToolActivity";
import { AppNav } from "@/components/AppNav";
import { ViewWorkspaceTabs, type ViewCaseTab } from "@/components/workspace/ViewWorkspaceTabs";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Button } from "@/components/ui/button";
import { FullPageLoader } from "@/components/ui/full-page-loader";
import { supabase } from "@/integrations/supabase/client";
import { MessageSquare, ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { isActiveThreadStatus } from "@/lib/thread-status";
import { extractDisplaySeed } from "@/lib/seed";

const EvidenceTab = lazy(() =>
  import("@/components/workspace/EvidenceTab").then((m) => ({ default: m.EvidenceTab })),
);
const ToolsTab = lazy(() =>
  import("@/components/workspace/ToolsTab").then((m) => ({ default: m.ToolsTab })),
);
const GraphTab = lazy(() =>
  import("@/components/workspace/GraphTab").then((m) => ({ default: m.GraphTab })),
);
const ReportTab = lazy(() =>
  import("@/components/panel/ReportTab").then((m) => ({ default: m.ReportTab })),
);

type ThreadMeta = {
  id: string;
  title: string | null;
  status: string | null;
  seed_type: string | null;
  seed_value: string | null;
  updated_at: string;
};

export default function CaseViewPage() {
  const { threadId } = useParams();
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [tab, setTab] = useState<ViewCaseTab>("report");
  const [meta, setMeta] = useState<ThreadMeta | null>(null);
  const [metaLoading, setMetaLoading] = useState(true);
  const [metaError, setMetaError] = useState(false);

  const { items } = useThreadArtifacts(threadId ?? "");
  const activity = useThreadToolActivity(threadId ?? "", user?.id ?? "");

  useEffect(() => {
    setTab("report");
  }, [threadId]);

  useEffect(() => {
    if (!user || !threadId) return;
    let alive = true;
    setMetaLoading(true);
    setMetaError(false);
    (async () => {
      const { data, error } = await supabase
        .from("threads")
        .select("id,title,status,seed_type,seed_value,updated_at")
        .eq("id", threadId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (!alive) return;
      // A network/DB error is NOT the same as a missing row — don't tell the
      // user their case "doesn't exist" when the fetch simply failed.
      if (error) { setMetaError(true); setMeta(null); }
      else setMeta((data as ThreadMeta) ?? null);
      setMetaLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [user, threadId]);

  if (loading) return <FullPageLoader />;
  if (!user) return <Navigate to="/auth" replace />;
  if (!threadId) return <Navigate to="/cases" replace />;
  if (metaLoading) {
    return (
      <div className="min-h-screen bg-background">
        <AppNav />
        <div className="grid place-items-center h-64 text-muted-foreground text-sm">Loading case…</div>
      </div>
    );
  }
  if (!metaLoading && meta === null) {
    return (
      <div className="min-h-screen bg-background">
        <AppNav />
        <main className="mx-auto max-w-lg px-6 py-16 text-center">
          <h1 className="font-display text-xl font-semibold">{metaError ? "Couldn't load this case" : "Case not found"}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {metaError
              ? "Something went wrong loading this case. Check your connection and try again."
              : "This case doesn't exist or belongs to another account."}
          </p>
          <Button className="mt-6" variant="outline" onClick={() => (metaError ? window.location.reload() : navigate("/cases"))}>
            {metaError ? "Retry" : "Back to cases"}
          </Button>
        </main>
      </div>
    );
  }

  const breachCount = items.filter((a) => a.kind.toLowerCase() === "breach").length;
  const tabCounts = {
    evidence: { value: items.length, alert: breachCount },
    tools: { value: activity.persistedTotal, alert: 0 },
  };

  const running = isActiveThreadStatus(meta?.status ?? null);
  // The stored title / seed_value can be the whole pasted run-prompt, which
  // overran the header and truncated mid-word. Pull the clean selector out of
  // the blob (same helper the report cover uses) for the heading, and keep the
  // full instruction as the subtitle for context.
  const caseTitle = extractDisplaySeed(meta?.seed_value ?? meta?.title, meta?.seed_type).title;
  const caseSubtitle = meta?.seed_value?.trim() || meta?.title?.trim() || "";

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <AppNav />
      <div className="border-b border-white/[0.06] bg-[linear-gradient(180deg,hsl(220_22%_6.5%/0.6),hsl(222_20%_4.5%/0.46))] px-4 sm:px-8 py-4">
        <div className="mx-auto max-w-6xl flex flex-col sm:flex-row sm:items-center gap-3">
          <Link
            to="/cases"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="w-3.5 h-3.5" /> All cases
          </Link>
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-lg sm:text-xl font-semibold tracking-tight truncate">
              {caseTitle || "Untitled case"}
            </h1>
            {caseSubtitle && caseSubtitle !== caseTitle && (
              <p className="text-xs text-muted-foreground font-mono truncate mt-0.5">{caseSubtitle}</p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {running && (
              <span className="text-eyebrow font-mono uppercase tracking-wider px-2 py-1 rounded-full border border-[hsl(var(--intel-blue)/0.35)] bg-[hsl(var(--intel-blue)/0.08)] text-[hsl(var(--intel-blue))]">
                Running
              </span>
            )}
            <Button asChild variant="cta" size="sm" className="rounded-lg gap-1.5">
              <Link to={`/chat/${threadId}`}>
                <MessageSquare className="w-3.5 h-3.5" />
                {running ? "Open live chat" : "Continue in chat"}
              </Link>
            </Button>
          </div>
        </div>
      </div>

      <ViewWorkspaceTabs active={tab} onChange={setTab} counts={tabCounts} />

      <main className="flex-1 min-h-0 relative mx-auto w-full max-w-6xl">
        <div className={cn("absolute inset-0", tab === "report" ? "overflow-y-auto" : "")}>
          <Suspense fallback={<FullPageLoader fullScreen={false} className="h-48" />}>
            {tab === "evidence" && (
              <ErrorBoundary>
                <EvidenceTab threadId={threadId} />
              </ErrorBoundary>
            )}
            {tab === "report" && (
              <ErrorBoundary>
                <div className="mx-auto max-w-4xl px-4 py-4">
                  <ReportTab threadId={threadId} artifacts={items} />
                </div>
              </ErrorBoundary>
            )}
            {tab === "graph" && (
              <ErrorBoundary>
                <GraphTab threadId={threadId} />
              </ErrorBoundary>
            )}
            {tab === "tools" && (
              <ErrorBoundary>
                <ToolsTab threadId={threadId} />
              </ErrorBoundary>
            )}
          </Suspense>
        </div>
      </main>
    </div>
  );
}
