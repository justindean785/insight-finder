import { useEffect, useRef, useState, lazy, Suspense, type ReactNode } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { ChatWindow } from "@/components/ChatWindow";
import { WorkspaceHeader, MobileCaseStrip } from "@/components/workspace/WorkspaceHeader";
import { WorkspaceTabs, type WorkspaceTab } from "@/components/workspace/WorkspaceTabs";
import { CaseSnapshotProvider } from "@/components/workspace/CaseSnapshotProvider";
import { WorkspaceUIStateProvider } from "@/components/workspace/WorkspaceUIStateProvider";
import { RecoveryBanner } from "@/components/workspace/RecoveryBanner";
import { WorkspaceStatusStrip } from "@/components/workspace/WorkspaceStatusStrip";
import { Workbench, type WorkbenchTab } from "@/components/workspace/Workbench";
import { useCaseSnapshot } from "@/hooks/useCaseSnapshot";
import { ShellTopBar } from "@/components/shell/AppShell";
// Non-default tabs are code-split: Chat (default) loads eagerly; the heavier
// Evidence/Report/Graph/Tools panels (and their markdown/graph libs) only load
// when first opened, shrinking the initial ChatPage chunk and first paint.
const OverviewTab = lazy(() => import("@/components/workspace/OverviewTab").then((m) => ({ default: m.OverviewTab })));
const EvidenceTab = lazy(() => import("@/components/workspace/EvidenceTab").then((m) => ({ default: m.EvidenceTab })));
const ToolsTab = lazy(() => import("@/components/workspace/ToolsTab").then((m) => ({ default: m.ToolsTab })));
const GraphTab = lazy(() => import("@/components/workspace/GraphTab").then((m) => ({ default: m.GraphTab })));
const ReportTab = lazy(() => import("@/components/panel/ReportTab").then((m) => ({ default: m.ReportTab })));
import { useIsMobile } from "@/hooks/use-mobile";
import { useIsWorkbenchViewport } from "@/hooks/useIsWorkbenchViewport";
import { cn } from "@/lib/utils";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { buildWorkspaceTabCounts } from "@/lib/workspace-tab-counts";
import { useCaseSheetModel } from "@/hooks/useCaseSheetModel";
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
      <WorkspaceUIStateProvider>
        <ChatWorkspace threadId={threadId} userId={user.id} />
      </WorkspaceUIStateProvider>
    </CaseSnapshotProvider>
  );
}

function ChatWorkspace({ threadId, userId }: { threadId: string; userId: string }) {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { snapshot } = useCaseSnapshot();
  const [tab, setTab] = useState<WorkspaceTab>("chat");
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
  const [evidenceReq, setEvidenceReq] = useState<{ view: string; n: number; artifactId?: string; authorityState?: string } | null>(null);
  const [toolsReq, setToolsReq] = useState<{ view: string; n: number } | null>(null);
  useEffect(() => {
    const onNav = (e: Event) => {
      const detail = (e as CustomEvent).detail as { tab?: string; section?: string; artifactId?: string; authorityState?: string };
      const t = detail?.tab ?? "";
      if (t === "overview") setTab("overview");
      else if (t === "chat") setTab("chat");
      else if (t === "report") setTab("report");
      else if (t === "graph") setTab("graph");
      else if (["custody", "audit", "issues"].includes(t)) {
        setTab("tools");
        setToolsReq((prev) => ({ view: t === "issues" ? "health" : t, n: (prev?.n ?? 0) + 1 }));
      } else if (["artifacts", "matrix", "clusters", "timeline"].includes(t) || detail?.section === "evidence") {
        setTab("evidence");
        const view = t === "matrix" ? "table"
          : t === "clusters" ? "clusters"
          : t === "timeline" ? "timeline"
          : "board";
        // `artifactId` asks the Board to reveal and open one row (the case sheet's
        // "Decide in Evidence"), whatever filter it was left on. `authorityState`
        // asks it to open on the quick filter that holds that state (the sheet's
        // Review / Quarantined / Leads counts).
        setEvidenceReq((prev) => ({ view, n: (prev?.n ?? 0) + 1, artifactId: detail?.artifactId, authorityState: detail?.authorityState }));
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
  // The Evidence number IS the case sheet's "Needs your call" count.
  const sheet = useCaseSheetModel(threadId);
  const tabCounts = buildWorkspaceTabCounts(
    snapshot?.tools.total ?? 0,
    sheet.hydrated && !sheet.reviewsUnavailable ? sheet.model.queueTotal : null,
  );

  // Panels stay mounted once visited. Switching back is instant, and each tab
  // keeps its own scroll position, filters and open drawers — the old
  // mount-on-demand panels threw all of that away on every switch.
  const [visited, setVisited] = useState<ReadonlySet<WorkspaceTab>>(() => new Set<WorkspaceTab>(["chat"]));
  useEffect(() => {
    setVisited((prev) => (prev.has(tab) ? prev : new Set(prev).add(tab)));
  }, [tab]);

  // The case sheet (3a "Case desk") sits beside the transcript and the report,
  // desktop xl+ only. It is rendered LAST inside the content container and the
  // two panels it sits beside only gain a right inset, so no existing child
  // moves or remounts: the ChatWindow's in-flight stream is untouched by it.
  // The Workbench is shared across Investigate (chat), Evidence and Report:
  // selection in Evidence must surface in the same right-hand pane, not a
  // second column. On Evidence, the drawer suppresses itself at xl+ so the
  // detail is in the Workbench's Sheet tab only. Overview / Tools / Graph
  // own their full width and have no Workbench.
  const showSheet = !isMobile && (tab === "chat" || tab === "report" || tab === "evidence");
  // The analyst can fold the sheet down to a 44px strip, like the cases rail;
  // the strip keeps the "Needs your call" count so open decisions never vanish.
  // Remembered across reloads.
  const [sheetCollapsed, setSheetCollapsed] = useState(() => {
    try { return localStorage.getItem("if:caseSheetCollapsed") === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("if:caseSheetCollapsed", sheetCollapsed ? "1" : "0"); } catch { /* ignore */ }
  }, [sheetCollapsed]);
  // Below lg (768-1023px) there is no room to dock 320px beside the content, so
  // the sheet stays folded and opens as an overlay. That open state is not
  // remembered: a reload at this width should not cover the transcript.
  const docked = useIsWorkbenchViewport();
  const [overlayOpen, setOverlayOpen] = useState(false);
  const collapsed = docked ? sheetCollapsed : !overlayOpen;
  const setCollapsed = (v: boolean) => (docked ? setSheetCollapsed(v) : setOverlayOpen(!v));
  useEffect(() => {
    if (docked || !overlayOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOverlayOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [docked, overlayOpen]);
  // A "go to Workbench tab" request (the transcript's "Open Next pivots", the Live
  // board) used to reach nothing while the rail was folded: the Workbench is not
  // mounted then, so its listener did not exist and the button did nothing. Unfold
  // the rail and hand the request to the Workbench as a prop, which survives mount.
  const [workbenchRequest, setWorkbenchRequest] = useState<{ tab: WorkbenchTab; open?: string; n: number } | null>(null);
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  useEffect(() => {
    const onJump = (e: Event) => {
      const d = (e as CustomEvent<{ tab?: WorkbenchTab; open?: string }>).detail;
      if (!d?.tab || !collapsedRef.current) return;
      setCollapsed(false);
      setWorkbenchRequest({ tab: d.tab, open: d.open, n: Date.now() });
    };
    window.addEventListener("swarmbot:workbench-tab", onJump as EventListener);
    return () => window.removeEventListener("swarmbot:workbench-tab", onJump as EventListener);
    // setCollapsed closes over `docked`; re-bind when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docked]);
  const besideSheet = (key: WorkspaceTab) =>
    showSheet && (key === "chat" || key === "report" || key === "evidence") &&
    (collapsed ? "md:right-11" : "md:right-11 lg:right-[320px] xl:right-[380px]");
  const queueCount = sheet.hydrated && !sheet.reviewsUnavailable ? sheet.model.queueTotal : null;

  const panel = (key: Exclude<WorkspaceTab, "chat">, body: ReactNode, scroll = false) =>
    visited.has(key) || tab === key ? (
      <div
        key={key}
        role="tabpanel"
        id={`workspace-tabpanel-${key}`}
        aria-labelledby={`workspace-tab-${key}`}
        hidden={tab !== key}
        className={cn("absolute inset-0", besideSheet(key), scroll && "overflow-y-auto", tab === key && "ws-panel-enter")}
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
        className={cn("absolute inset-0", besideSheet("chat"), tab === "chat" && "ws-panel-enter")}
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
      {showSheet && (
        <aside
          key="case-sheet"
          id="case-sheet"
          aria-label="Case sheet"
          className={cn(
            // Docked at lg+ (keep in step with useIsWorkbenchViewport); a folded
            // strip that opens as an overlay at md. It used to exist only at xl+,
            // so a laptop browser had no way to reach it.
            "absolute inset-y-0 right-0 hidden border-l border-border-subtle bg-card md:block",
            collapsed ? "w-11" : "w-[320px] xl:w-[380px]",
            !docked && !collapsed && "z-30 shadow-2xl",
          )}
        >
          {collapsed ? (
            <div className="flex h-full flex-col items-center gap-2 py-2">
              <Tooltip delayDuration={150}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setCollapsed(false)}
                    aria-label="Show case sheet"
                    aria-expanded={false}
                    aria-controls="case-sheet"
                    className="grid h-8 w-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
                  >
                    <PanelRightOpen className="h-4 w-4" aria-hidden />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left" className="text-xs">Show case sheet</TooltipContent>
              </Tooltip>
              {queueCount != null && queueCount > 0 && (
                <button
                  type="button"
                  onClick={() => setCollapsed(false)}
                  aria-label={`${queueCount} need${queueCount === 1 ? "s" : ""} your call — open case sheet`}
                  title={`${queueCount} need${queueCount === 1 ? "s" : ""} your call`}
                  className="grid min-h-8 min-w-8 place-items-center rounded-full border border-warning/40 bg-warning/10 px-1.5 font-mono text-data tabular-nums text-warning transition-colors hover:bg-warning/15"
                >
                  {queueCount > 99 ? "99+" : queueCount}
                </button>
              )}
            </div>
          ) : (
            <>
              <Tooltip delayDuration={150}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setCollapsed(true)}
                    aria-label="Hide case sheet"
                    aria-expanded
                    aria-controls="case-sheet"
                    className="absolute right-2 top-2 z-10 grid h-8 w-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
                  >
                    <PanelRightClose className="h-4 w-4" aria-hidden />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left" className="text-xs">Hide case sheet</TooltipContent>
              </Tooltip>
              <ErrorBoundary>
                <Workbench threadId={threadId} request={workbenchRequest} onRequestConsumed={() => setWorkbenchRequest(null)} />
              </ErrorBoundary>
            </>
          )}
        </aside>
      )}
    </div>
  );

  // ONE layout tree for both breakpoints. Switching between the mobile and
  // desktop chrome must NOT remount {content} (and the <ChatWindow> inside it):
  // a remount aborts the in-flight useChat stream and drops streamed messages.
  // {content} keeps a stable position (last child of <main>) and a stable key
  // across the flip, so React preserves the ChatWindow fiber and the live run
  // survives. The chrome slot is the SAME element type on both breakpoints for
  // the same reason, one level up. The cases rail, the phone drawer and the
  // command palette belong to AppShell, which wraps this page.
  return (
    <main className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <div key="chrome" className="shrink-0">
        {isMobile ? (
          // Phone: ONE header row — the cases drawer, then which case this is
          // and its state. Section navigation lives in the bottom tab bar
          // (below the content), where the thumb is; "New investigation"
          // lives in the cases drawer, not as the loudest control on a case.
          <ShellTopBar>
            <MobileCaseStrip />
          </ShellTopBar>
        ) : (
          <>
            <WorkspaceHeader threadId={threadId} />
            <WorkspaceTabs active={tab} onChange={setTab} counts={tabCounts} loading={!hydrated} />
          </>
        )}
        <RecoveryBanner snapshot={snapshot} onViewFailedTools={viewFailedTools} onStartNew={createNew} />
      </div>

      {content}

      {/* Desktop: the 26px status strip (custody, working rules). Keyed like
          its siblings so {content} keeps its position when the breakpoint flips. */}
      {!isMobile && <WorkspaceStatusStrip key="status-strip" />}

      {/* Phone: section navigation at the bottom. Rendered AFTER {content}
          and keyed, so {content} keeps its key and the ChatWindow inside it
          is never remounted when the breakpoint flips. */}
      {isMobile && (
        <div key="bottom-nav" className="shrink-0">
          <WorkspaceTabs active={tab} onChange={setTab} counts={tabCounts} loading={!hydrated} variant="inline" />
        </div>
      )}
    </main>
  );
}
