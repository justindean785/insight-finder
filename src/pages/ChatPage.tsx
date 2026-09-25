import { useEffect, useState, lazy, Suspense, type ReactNode } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { ThreadSidebar } from "@/components/ThreadSidebar";
import { ChatWindow } from "@/components/ChatWindow";
import { WorkspaceHeader, MobileCaseStrip } from "@/components/workspace/WorkspaceHeader";
import { WorkspaceTabs, type WorkspaceTab } from "@/components/workspace/WorkspaceTabs";
import { CaseSnapshotProvider } from "@/components/workspace/CaseSnapshotProvider";
import { RecoveryBanner } from "@/components/workspace/RecoveryBanner";
import { useCaseSnapshot } from "@/hooks/useCaseSnapshot";
// Non-default tabs are code-split: Chat (default) loads eagerly; the heavier
// Evidence/Report/Graph/Tools panels (and their markdown/graph libs) only load
// when first opened, shrinking the initial ChatPage chunk and first paint.
const OverviewTab = lazy(() => import("@/components/workspace/OverviewTab").then((m) => ({ default: m.OverviewTab })));
const EvidenceTab = lazy(() => import("@/components/workspace/EvidenceTab").then((m) => ({ default: m.EvidenceTab })));
const ToolsTab = lazy(() => import("@/components/workspace/ToolsTab").then((m) => ({ default: m.ToolsTab })));
const GraphTab = lazy(() => import("@/components/workspace/GraphTab").then((m) => ({ default: m.GraphTab })));
const ReportTab = lazy(() => import("@/components/panel/ReportTab").then((m) => ({ default: m.ReportTab })));
import { useIsMobile } from "@/hooks/use-mobile";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { PanelLeftOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { buildWorkspaceTabCounts } from "@/lib/workspace-tab-counts";
import { CommandPalette } from "@/components/CommandPalette";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { FullPageLoader } from "@/components/ui/full-page-loader";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

/**
 * Investigation workspace. One case bar + one tab strip drive six sections —
 * Overview, Investigate, Evidence, Tools, Graph, Report — each filling the main
 * area. The chat stays mounted (just hidden) when other sections are active so
 * an in-flight run is never interrupted by switching tabs.
 *
 * Every case figure on this page — the case bar, the tab badges, and the
 * Overview / Tools / Report panels — is read from ONE `CaseSnapshotProvider`,
 * so they can never show counts from different reads side by side.
 */
export default function ChatPage() {
  const { threadId } = useParams();
  const { user, loading } = useAuth();

  if (loading) return <FullPageLoader />;
  if (!user) return <Navigate to="/auth" replace />;
  if (!threadId) return <Navigate to="/" replace />;

  return (
    <CaseSnapshotProvider key={threadId} threadId={threadId}>
      <ChatWorkspace threadId={threadId} userId={user.id} />
    </CaseSnapshotProvider>
  );
}

function ChatWorkspace({ threadId, userId }: { threadId: string; userId: string }) {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { snapshot } = useCaseSnapshot();
  const [tab, setTab] = useState<WorkspaceTab>("chat");
  // Persist the sidebar collapse across reloads — re-collapsing every session is
  // a common annoyance for a workspace tool.
  const [leftCollapsed, setLeftCollapsed] = useState(() => {
    try { return localStorage.getItem("if:leftCollapsed") === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("if:leftCollapsed", leftCollapsed ? "1" : "0"); } catch { /* ignore */ }
  }, [leftCollapsed]);
  const [mLeft, setMLeft] = useState(false);

  // "New investigation" must CREATE a fresh thread, never route through "/"
  // (IndexRedirect resumes the most-recent EXISTING thread, so navigate("/")
  // reopens the latest old case instead of starting new).
  const [creating, setCreating] = useState(false);
  const createNew = async () => {
    if (creating) return;
    setCreating(true);
    const { data, error } = await supabase.from("threads").insert({ user_id: userId }).select("id").single();
    setCreating(false);
    if (error || !data) { toast.error(error?.message ?? "Could not create investigation"); return; }
    navigate(`/chat/${data.id}`);
  };

  // A command-palette "jump to <tab>" should switch the workspace mode — and for
  // an Evidence lens (artifacts/matrix/clusters/timeline) also tell EvidenceTab
  // which lens to open, so the jump lands on the right view instead of always
  // dumping the user on the Board. The nonce forces re-honoring repeat jumps.
  const [evidenceReq, setEvidenceReq] = useState<{ view: string; n: number } | null>(null);
  const [toolsReq, setToolsReq] = useState<{ view: string; n: number } | null>(null);
  useEffect(() => {
    const onNav = (e: Event) => {
      const detail = (e as CustomEvent).detail as { tab?: string; section?: string };
      const t = detail?.tab ?? "";
      if (t === "overview") setTab("overview");
      else if (t === "chat") setTab("chat");
      else if (t === "report") setTab("report");
      else if (["custody", "audit", "issues"].includes(t)) {
        setTab("tools");
        setToolsReq((prev) => ({ view: t === "issues" ? "health" : t, n: (prev?.n ?? 0) + 1 }));
      } else if (["artifacts", "matrix", "clusters", "timeline"].includes(t) || detail?.section === "evidence") {
        setTab("evidence");
        const view = t === "matrix" ? "table"
          : t === "clusters" ? "clusters"
          : t === "timeline" ? "timeline"
          : "board";
        setEvidenceReq((prev) => ({ view, n: (prev?.n ?? 0) + 1 }));
      }
    };
    window.addEventListener("swarmbot:navigate", onNav);
    return () => window.removeEventListener("swarmbot:navigate", onNav);
  }, []);

  const viewFailedTools = () => {
    setTab("tools");
    setToolsReq((prev) => ({ view: "health", n: (prev?.n ?? 0) + 1 }));
  };

  // Tab badges read the SAME published snapshot as the case bar and the panels.
  const hydrated = Boolean(snapshot?.hydrated);
  const tabCounts = buildWorkspaceTabCounts(snapshot?.items ?? [], snapshot?.tools.total ?? 0, snapshot?.authority ?? null);

  // Panels stay mounted once visited. Switching back is instant, and each tab
  // keeps its own scroll position, filters and open drawers — the old
  // mount-on-demand panels threw all of that away on every switch.
  const [visited, setVisited] = useState<ReadonlySet<WorkspaceTab>>(() => new Set<WorkspaceTab>(["chat"]));
  useEffect(() => {
    setVisited((prev) => (prev.has(tab) ? prev : new Set(prev).add(tab)));
  }, [tab]);

  const panel = (key: Exclude<WorkspaceTab, "chat">, body: ReactNode, scroll = false) =>
    visited.has(key) || tab === key ? (
      <div
        key={key}
        role="tabpanel"
        id={`workspace-tabpanel-${key}`}
        aria-labelledby={`workspace-tab-${key}`}
        hidden={tab !== key}
        className={cn("absolute inset-0", scroll && "overflow-y-auto", tab === key && "ws-panel-enter")}
      >
        <ErrorBoundary>
          <Suspense fallback={<FullPageLoader label="Loading workspace" fullScreen={false} className="absolute inset-0" />}>
            {body}
          </Suspense>
        </ErrorBoundary>
      </div>
    ) : null;

  const content = (
    <div key="workspace-content" className="flex-1 min-h-0 relative">
      {/* Chat stays mounted so streaming survives tab switches. */}
      <div
        role="tabpanel"
        id="workspace-tabpanel-chat"
        aria-labelledby="workspace-tab-chat"
        hidden={tab !== "chat"}
        className={cn("absolute inset-0", tab === "chat" && "ws-panel-enter")}
      >
        <ChatWindow threadId={threadId} />
      </div>
      {panel("overview", <OverviewTab threadId={threadId} />)}
      {panel("evidence", <EvidenceTab threadId={threadId} viewRequest={evidenceReq} />)}
      {panel(
        "report",
        <div className="mx-auto w-full max-w-[60rem] px-4 py-3 sm:px-6"><ReportTab threadId={threadId} artifacts={snapshot?.items ?? []} printActive={tab === "report"} /></div>,
        true,
      )}
      {panel("graph", <GraphTab threadId={threadId} />)}
      {panel("tools", <ToolsTab threadId={threadId} viewRequest={toolsReq} />)}
    </div>
  );

  // ONE layout tree for both breakpoints. Switching between the mobile and
  // desktop chrome must NOT remount {content} (and the <ChatWindow> inside it):
  // a remount aborts the in-flight useChat stream and drops streamed messages.
  // {content} keeps a stable position (last child of <main>) and a stable key
  // across the flip, so React preserves the ChatWindow fiber and the live run
  // survives. The chrome slot is the SAME element type on both breakpoints for
  // the same reason, one level up.
  return (
    <div className="relative flex h-[100dvh] w-full overflow-hidden bg-background">
      <CommandPalette />

      {/* Desktop: persistent sidebar rail. Mobile uses the off-canvas Sheet below. */}
      {!isMobile && (
        <aside className={cn(
          "rail-surface relative z-10 flex h-full min-h-0 shrink-0 flex-col overflow-hidden border-r border-white/8 shadow-[8px_0_38px_-30px_rgba(0,0,0,0.95)] transition-[width] duration-200 ease-out",
          leftCollapsed ? "w-14" : "w-72",
        )}>
          <ThreadSidebar collapsed={leftCollapsed} onToggleCollapse={() => setLeftCollapsed((c) => !c)} />
        </aside>
      )}

      <main className="relative z-10 flex h-full min-w-0 flex-1 flex-col">
        <div key="chrome" className="shrink-0">
          {isMobile ? (
            // Phone: ONE header row — the cases drawer, then which case this is
            // and its state. Section navigation lives in the bottom tab bar
            // (below the content), where the thumb is; "New investigation"
            // lives in the cases drawer, not as the loudest control on a case.
            <header className="flex items-center gap-0.5 border-b border-border-subtle bg-card pl-1 pt-[env(safe-area-inset-top)]">
              <button onClick={() => setMLeft(true)} className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors duration-fast hover:bg-white/[0.05] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Open cases">
                <PanelLeftOpen className="h-[18px] w-[18px] text-foreground/80" aria-hidden />
              </button>
              <MobileCaseStrip />
            </header>
          ) : (
            <>
              <WorkspaceHeader threadId={threadId} />
              <WorkspaceTabs active={tab} onChange={setTab} counts={tabCounts} loading={!hydrated} />
            </>
          )}
          <RecoveryBanner snapshot={snapshot} onViewFailedTools={viewFailedTools} onStartNew={createNew} />
        </div>

        {content}

        {/* Phone: section navigation at the bottom. Rendered AFTER {content}
            and keyed, so {content} keeps its key and the ChatWindow inside it
            is never remounted when the breakpoint flips. */}
        {isMobile && (
          <div key="bottom-nav" className="shrink-0">
            <WorkspaceTabs active={tab} onChange={setTab} counts={tabCounts} loading={!hydrated} variant="inline" />
          </div>
        )}
      </main>

      {/* Mobile: cases live in an off-canvas overlay (does not affect layout flow). */}
      {isMobile && (
        <Sheet open={mLeft} onOpenChange={setMLeft}>
          <SheetContent side="left" className="rail-surface p-0 w-[82vw] max-w-[300px] sm:max-w-[300px] border-r border-white/8 [&>button]:hidden overflow-hidden">
            {/* Radix requires an accessible name + description on every dialog
                surface. Visually hidden — the drawer's own content is self-evident. */}
            <SheetHeader className="sr-only">
              <SheetTitle>Investigations</SheetTitle>
              <SheetDescription>Switch between your cases, or start a new investigation.</SheetDescription>
            </SheetHeader>
            <ThreadSidebar />
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
