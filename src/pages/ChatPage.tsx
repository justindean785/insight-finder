import { useEffect, useState, lazy, Suspense } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { useThreadArtifacts } from "@/hooks/useThreadArtifacts";
import { useThreadToolActivity } from "@/hooks/useThreadToolActivity";
import { ThreadSidebar } from "@/components/ThreadSidebar";
import { ChatWindow } from "@/components/ChatWindow";
import { WorkspaceHeader } from "@/components/workspace/WorkspaceHeader";
import { WorkspaceTabs, type WorkspaceTab } from "@/components/workspace/WorkspaceTabs";
// Non-default tabs are code-split: Chat (default) loads eagerly; the heavier
// Evidence/Report/Graph/Tools panels (and their markdown/graph libs) only load
// when first opened, shrinking the initial ChatPage chunk and first paint.
const EvidenceTab = lazy(() => import("@/components/workspace/EvidenceTab").then((m) => ({ default: m.EvidenceTab })));
const ToolsTab = lazy(() => import("@/components/workspace/ToolsTab").then((m) => ({ default: m.ToolsTab })));
const GraphTab = lazy(() => import("@/components/workspace/GraphTab").then((m) => ({ default: m.GraphTab })));
const ReportTab = lazy(() => import("@/components/panel/ReportTab").then((m) => ({ default: m.ReportTab })));
import { useIsMobile } from "@/hooks/use-mobile";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { PanelLeftOpen, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { CommandPalette } from "@/components/CommandPalette";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

/**
 * Investigation workspace. A persistent header + top-level tab bar drive five
 * major modes — Chatbot, Evidence, Report, Graph, Tools — each filling the main
 * area. The chat stays mounted (just hidden) when other modes are active so an
 * in-flight run is never interrupted by switching tabs.
 */
export default function ChatPage() {
  const { threadId } = useParams();
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [tab, setTab] = useState<WorkspaceTab>("chat");
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [mLeft, setMLeft] = useState(false);

  // Reset to the conversation when switching cases.
  useEffect(() => { setTab("chat"); setMLeft(false); }, [threadId]);

  // "New investigation" must CREATE a fresh thread, never route through "/"
  // (IndexRedirect resumes the most-recent EXISTING thread, so navigate("/")
  // reopens the latest old case instead of starting new).
  const [creating, setCreating] = useState(false);
  const createNew = async () => {
    if (!user || creating) return;
    setCreating(true);
    const { data, error } = await supabase.from("threads").insert({ user_id: user.id }).select("id").single();
    setCreating(false);
    if (error || !data) { toast.error(error?.message ?? "Could not create investigation"); return; }
    navigate(`/chat/${data.id}`);
  };

  // A command-palette "jump to <tab>" should switch the workspace mode.
  useEffect(() => {
    const onNav = (e: Event) => {
      const detail = (e as CustomEvent).detail as { tab?: string; section?: string };
      const t = detail?.tab ?? "";
      if (["report"].includes(t)) setTab("report");
      else if (["custody", "audit", "issues"].includes(t)) setTab("tools");
      else if (["map", "timeline", "clusters", "pivots", "matrix"].includes(t)) setTab("evidence");
      else if (["artifacts", "overview"].includes(t) || detail?.section === "evidence") setTab("evidence");
    };
    window.addEventListener("swarmbot:navigate", onNav);
    return () => window.removeEventListener("swarmbot:navigate", onNav);
  }, []);

  // Counts for the tab bar badges. threadId is always defined past the guards
  // below, but the hooks must run unconditionally — they no-op on "".
  const { items } = useThreadArtifacts(threadId ?? "");
  const activity = useThreadToolActivity(threadId ?? "");

  if (loading) return <div className="min-h-screen grid place-items-center text-muted-foreground">Loading…</div>;
  if (!user) return <Navigate to="/auth" replace />;
  if (!threadId) return <Navigate to="/" replace />;

  // Tab badges own the section counts; alerts (breaches, failed tool calls)
  // ride along as a red dot so a tab number always means "items in this tab".
  const breachCount = items.filter((a) => a.kind.toLowerCase() === "breach").length;
  const tabCounts = {
    evidence: { value: items.length, alert: breachCount },
    tools: { value: activity.total, alert: activity.failed },
  };

  const content = (
    <div className="flex-1 min-h-0 relative">
      {/* Chat stays mounted so streaming survives tab switches. */}
      <div
        role="tabpanel"
        id="workspace-tabpanel-chat"
        aria-labelledby="workspace-tab-chat"
        className={cn("absolute inset-0", tab === "chat" ? "" : "hidden")}
      >
        <ChatWindow threadId={threadId} />
      </div>
      {tab !== "chat" && (
        <Suspense fallback={<div className="absolute inset-0 grid place-items-center text-muted-foreground text-sm">Loading workspace…</div>}>
          {tab === "evidence" && <div role="tabpanel" id="workspace-tabpanel-evidence" aria-labelledby="workspace-tab-evidence" className="absolute inset-0"><EvidenceTab threadId={threadId} /></div>}
          {tab === "report" && (
            <div role="tabpanel" id="workspace-tabpanel-report" aria-labelledby="workspace-tab-report" className="absolute inset-0 overflow-y-auto">
              <div className="mx-auto max-w-4xl"><ReportTab threadId={threadId} artifacts={items} /></div>
            </div>
          )}
          {tab === "graph" && <div role="tabpanel" id="workspace-tabpanel-graph" aria-labelledby="workspace-tab-graph" className="absolute inset-0"><GraphTab threadId={threadId} /></div>}
          {tab === "tools" && <div role="tabpanel" id="workspace-tabpanel-tools" aria-labelledby="workspace-tab-tools" className="absolute inset-0"><ToolsTab threadId={threadId} /></div>}
        </Suspense>
      )}
    </div>
  );

  if (isMobile) {
    return (
      <div key={threadId} className="flex flex-col h-[100dvh] w-full bg-background overflow-hidden">
        <CommandPalette />
        <header className="shrink-0 h-14 px-2 flex items-center gap-2 border-b border-border-subtle bg-surface-0">
          <button onClick={() => setMLeft(true)} className="shrink-0 w-9 h-9 rounded-xl grid place-items-center border border-white/10 bg-white/[0.035] text-muted-foreground transition-all duration-500 ease-premium hover:text-foreground hover:bg-white/[0.06] active:scale-[0.97]" aria-label="Open cases">
            <PanelLeftOpen className="w-4 h-4 text-foreground/80" />
          </button>
          <Link
            to="/"
            aria-label="Home"
            className="hidden min-[430px]:inline shrink-0 font-display font-semibold text-sm tracking-tight text-foreground select-none hover:text-foreground/80 transition-colors"
          >
            Swarmbot
          </Link>
          <WorkspaceTabs active={tab} onChange={setTab} counts={tabCounts} variant="inline" />
          <button onClick={createNew} disabled={creating} className="shrink-0 w-9 h-9 rounded-xl grid place-items-center border border-white/10 bg-white text-black transition-all duration-500 ease-premium hover:bg-white/90 active:scale-[0.97] disabled:opacity-60" aria-label="New investigation">
            <Plus className="w-4 h-4 text-black" />
          </button>
        </header>
        {content}
        <Sheet open={mLeft} onOpenChange={setMLeft}>
          <SheetContent side="left" className="p-0 w-[82vw] max-w-[300px] sm:max-w-[300px] border-r border-white/8 bg-[hsl(var(--surface-0))] [&>button]:hidden overflow-hidden">
            <ThreadSidebar />
          </SheetContent>
        </Sheet>
      </div>
    );
  }

  return (
    <div key={threadId} className="flex h-screen w-full bg-background overflow-hidden">
      <CommandPalette />
      <aside className={cn("shrink-0 h-screen border-r border-border-subtle glass-card", leftCollapsed ? "w-14" : "w-72")}>
        <ThreadSidebar collapsed={leftCollapsed} onToggleCollapse={() => setLeftCollapsed((c) => !c)} />
      </aside>
      <main className="flex-1 min-w-0 h-screen flex flex-col">
        <WorkspaceHeader threadId={threadId} />
        <WorkspaceTabs active={tab} onChange={setTab} counts={tabCounts} />
        {content}
      </main>
    </div>
  );
}
