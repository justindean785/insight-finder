import { lazy, Suspense, useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { useThreadArtifacts } from "@/hooks/useThreadArtifacts";
import { CaseSnapshotProvider } from "@/components/workspace/CaseSnapshotProvider";
import { useCaseSnapshot } from "@/hooks/useCaseSnapshot";
import { ShellTopBar, ShellTopBarTitle } from "@/components/shell/AppShell";
import { WorkspaceTabs } from "@/components/workspace/WorkspaceTabs";
import { CASE_VIEW_SECTIONS, type WorkspaceTab } from "@/lib/workspace-sections";
import { useIsMobile } from "@/hooks/use-mobile";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Button } from "@/components/ui/button";
import { FullPageLoader } from "@/components/ui/full-page-loader";
import { supabase } from "@/integrations/supabase/client";
import { MessageSquare, ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { extractDisplaySeed } from "@/lib/seed";
import { buildWorkspaceTabCounts } from "@/lib/workspace-tab-counts";
import { useCaseSheetModel } from "@/hooks/useCaseSheetModel";

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

type ViewCaseTab = Extract<WorkspaceTab, "evidence" | "report" | "graph" | "tools">;

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
  const isMobile = useIsMobile();
  const [tab, setTab] = useState<ViewCaseTab>("report");
  const [meta, setMeta] = useState<ThreadMeta | null>(null);
  const [metaLoading, setMetaLoading] = useState(true);
  const [metaError, setMetaError] = useState(false);

  const { items } = useThreadArtifacts(threadId ?? "");

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
        .select("id,title,status,seed_type,seed_value,updated_at,run_started_at,last_heartbeat_at")
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
      <div className="flex min-h-0 flex-1 flex-col">
        {isMobile && <ShellTopBar><ShellTopBarTitle>Case</ShellTopBarTitle></ShellTopBar>}
        <div className="grid place-items-center h-64 text-muted-foreground text-sm">Loading case…</div>
      </div>
    );
  }
  if (!metaLoading && meta === null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {isMobile && <ShellTopBar><ShellTopBarTitle>Case</ShellTopBarTitle></ShellTopBar>}
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


  // The stored title / seed_value can be the whole pasted run-prompt, which
  // overran the header and truncated mid-word. Pull the clean selector out of
  // the blob (same helper the report cover uses) for the heading, and keep the
  // full instruction as the subtitle for context.
  const caseTitle = extractDisplaySeed(meta?.seed_value ?? meta?.title, meta?.seed_type).title;
  const caseSubtitle = meta?.seed_value?.trim() || meta?.title?.trim() || "";

  return (
    <CaseSnapshotProvider threadId={threadId}>
    <div className="flex min-h-0 flex-1 flex-col">
      {isMobile && (
        <ShellTopBar>
          <ShellTopBarTitle asHeading>{caseTitle || "Untitled case"}</ShellTopBarTitle>
        </ShellTopBar>
      )}
      <div className="border-b border-border-subtle bg-surface-0 px-4 py-3 sm:px-8 sm:py-4">
        <div className="mx-auto flex max-w-6xl items-center gap-3">
          <Link
            to="/cases"
            className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="w-3.5 h-3.5" /> All cases
          </Link>
          <div className="min-w-0 flex-1">
            {!isMobile && (
              <h1 className="font-display text-lg sm:text-xl font-semibold tracking-tight truncate">
                {caseTitle || "Untitled case"}
              </h1>
            )}
            {caseSubtitle && caseSubtitle !== caseTitle && (
              <p className="text-xs text-muted-foreground font-mono truncate mt-0.5">{caseSubtitle}</p>
            )}
          </div>
          <CaseRunControls threadId={threadId} />
        </div>
      </div>

      {!isMobile && <CaseViewTabs threadId={threadId} active={tab} onChange={setTab} />}

      <main className="flex-1 min-h-0 relative mx-auto w-full max-w-6xl">
        <div
          role="tabpanel"
          id={`workspace-tabpanel-${tab}`}
          aria-labelledby={`workspace-tab-${tab}`}
          className={cn("absolute inset-0", tab === "report" ? "overflow-y-auto" : "")}
        >
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

      {/* Phone: the same bottom tab bar as the live workspace. */}
      {isMobile && (
        <div className="shrink-0">
          <CaseViewTabs threadId={threadId} active={tab} onChange={setTab} variant="inline" />
        </div>
      )}
    </div>
    </CaseSnapshotProvider>
  );
}

/**
 * "Running" and the chat link, from the live case snapshot: the run state the
 * workspace header shows. The snapshot re-reads the thread (realtime + poll) and
 * judges liveness on a fresh heartbeat, so a never-started thread (I-1) and a
 * killed run whose row is still `active` are not running, while a live run does
 * not lose the badge because this page's own one-time read has aged.
 */
function CaseRunControls({ threadId }: { threadId: string }) {
  const { snapshot } = useCaseSnapshot();
  const running = snapshot?.run.state === "running";
  return (
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
  );
}

/** Tab badges from the case snapshot — the same version the Tools and Report tabs read. */
function CaseViewTabs({ threadId, active, onChange, variant = "bar" }: {
  threadId: string;
  active: ViewCaseTab;
  onChange: (t: ViewCaseTab) => void;
  variant?: "bar" | "inline";
}) {
  const { snapshot } = useCaseSnapshot();
  // The Evidence number IS the case sheet's "Needs your call" count.
  const sheet = useCaseSheetModel(threadId);
  const tabCounts = buildWorkspaceTabCounts(
    snapshot?.tools.total ?? 0,
    sheet.hydrated && !sheet.reviewsUnavailable ? sheet.model.queueTotal : null,
  );
  return (
    <WorkspaceTabs
      sections={CASE_VIEW_SECTIONS}
      label="Case views"
      variant={variant}
      active={active}
      // CASE_VIEW_SECTIONS holds only ViewCaseTab keys.
      onChange={(t) => onChange(t as ViewCaseTab)}
      counts={tabCounts}
      loading={!snapshot?.hydrated}
    />
  );
}
