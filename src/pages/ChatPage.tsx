import { useEffect, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { useThreadArtifacts } from "@/hooks/useThreadArtifacts";
import { useThreadToolActivity } from "@/hooks/useThreadToolActivity";
import { ThreadSidebar } from "@/components/ThreadSidebar";
import { ChatWindow } from "@/components/ChatWindow";
import { WorkspaceHeader } from "@/components/workspace/WorkspaceHeader";
import { WorkspaceTabs, type WorkspaceTab } from "@/components/workspace/WorkspaceTabs";
import { EvidenceTab } from "@/components/workspace/EvidenceTab";
import { ToolsTab } from "@/components/workspace/ToolsTab";
import { GraphTab } from "@/components/workspace/GraphTab";
import { ReportTab } from "@/components/panel/ReportTab";
import { useIsMobile } from "@/hooks/use-mobile";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { PanelLeftOpen, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { CommandPalette } from "@/components/CommandPalette";

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

  const tabCounts = {
    evidence: { value: items.length },
    tools: activity.failed > 0 ? { value: activity.failed, tone: "danger" as const } : undefined,
  };

  const content = (
    <div className="flex-1 min-h-0 relative">
      {/* Chat stays mounted so streaming survives tab switches. */}
      <div className={cn("absolute inset-0", tab === "chat" ? "" : "hidden")}>
        <ChatWindow threadId={threadId} />
      </div>
      {tab === "evidence" && <div className="absolute inset-0"><EvidenceTab threadId={threadId} /></div>}
      {tab === "report" && (
        <div className="absolute inset-0 overflow-y-auto">
          <div className="mx-auto max-w-4xl"><ReportTab threadId={threadId} artifacts={items} /></div>
        </div>
      )}
      {tab === "graph" && <div className="absolute inset-0"><GraphTab threadId={threadId} /></div>}
      {tab === "tools" && <div className="absolute inset-0"><ToolsTab threadId={threadId} /></div>}
    </div>
  );

  if (isMobile) {
    return (
      <div key={threadId} className="flex flex-col h-[100dvh] w-full bg-background overflow-hidden">
        <CommandPalette />
        <header className="shrink-0 h-12 px-2 flex items-center gap-2 border-b border-border-subtle bg-background">
          <button onClick={() => setMLeft(true)} className="w-9 h-9 rounded-lg grid place-items-center glass-interactive" aria-label="Open cases">
            <PanelLeftOpen className="w-4 h-4 text-foreground/80" />
          </button>
          <span className="font-display font-semibold text-sm tracking-tight gradient-text select-none">Swarmbot</span>
          <button onClick={() => navigate("/")} className="ml-auto w-9 h-9 rounded-lg grid place-items-center glass-interactive" aria-label="New investigation">
            <Plus className="w-4 h-4 text-foreground/80" />
          </button>
        </header>
        <WorkspaceTabs active={tab} onChange={setTab} counts={tabCounts} />
        {content}
        <Sheet open={mLeft} onOpenChange={setMLeft}>
          <SheetContent side="left" className="p-0 w-[86vw] max-w-[320px] sm:max-w-[320px] border-r border-white/5 bg-[hsl(230_14%_4%)] [&>button]:hidden overflow-hidden">
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
        <WorkspaceHeader threadId={threadId} onShowTools={() => setTab("tools")} />
        <WorkspaceTabs active={tab} onChange={setTab} counts={tabCounts} />
        {content}
      </main>
    </div>
  );
}
