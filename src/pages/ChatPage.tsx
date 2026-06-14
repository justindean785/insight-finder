import { useEffect, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { ThreadSidebar } from "@/components/ThreadSidebar";
import { ResourcesPanel } from "@/components/ResourcesPanel";
import { ChatWindow } from "@/components/ChatWindow";
import { useIsMobile } from "@/hooks/use-mobile";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { PanelLeftOpen, PanelRightOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { CommandPalette } from "@/components/CommandPalette";

export default function ChatPage() {
  const { threadId } = useParams();
  const { user, loading } = useAuth();
  const isMobile = useIsMobile();
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [mLeft, setMLeft] = useState(false);
  const [mRight, setMRight] = useState(false);

  // Reset mobile sheets on thread switch
  useEffect(() => { setMLeft(false); setMRight(false); }, [threadId]);

  if (loading) return <div className="min-h-screen grid place-items-center text-muted-foreground">Loading…</div>;
  if (!user) return <Navigate to="/auth" replace />;
  if (!threadId) return <Navigate to="/" replace />;

  if (isMobile) {
    return (
      <div key={threadId} className="flex flex-col h-[100dvh] w-full bg-background overflow-hidden">
        <CommandPalette />
        <header className="sticky top-0 z-30 h-12 px-3 flex items-center justify-between gap-2 glass-card border-b border-border-subtle">
          <button
            onClick={() => setMLeft(true)}
            className="w-9 h-9 rounded-xl grid place-items-center glass-interactive"
            aria-label="Open threads"
          >
            <PanelLeftOpen className="w-4 h-4 text-foreground/80" />
          </button>
          <div className="font-display font-semibold text-sm tracking-tight gradient-text select-none">
            Swarmbot
          </div>
          <button
            onClick={() => setMRight(true)}
            className="w-9 h-9 rounded-xl grid place-items-center glass-interactive"
            aria-label="Open case panel"
          >
            <PanelRightOpen className="w-4 h-4 text-foreground/80" />
          </button>
        </header>

        <main className="flex-1 min-h-0 flex w-full overflow-hidden">
          <ChatWindow threadId={threadId} />
        </main>

        <Sheet open={mLeft} onOpenChange={setMLeft}>
          <SheetContent
            side="left"
            className="p-0 w-[86vw] max-w-[320px] sm:max-w-[320px] border-r border-white/5 bg-[hsl(230_14%_4%)] [&>button]:hidden overflow-hidden"
          >
            <ThreadSidebar />
          </SheetContent>
        </Sheet>

        <Sheet open={mRight} onOpenChange={setMRight}>
          <SheetContent
            side="right"
            className="p-0 w-[92vw] max-w-[440px] sm:max-w-[440px] border-l border-white/5 bg-[hsl(230_14%_4%)] [&>button]:hidden overflow-hidden"
          >
            <ResourcesPanel threadId={threadId} />
          </SheetContent>
        </Sheet>
      </div>
    );
  }

  return (
    <div key={threadId} className="flex min-h-screen w-full bg-background overflow-x-hidden">
      <CommandPalette />
      <aside className={cn("shrink-0 h-screen border-r border-border-subtle glass-card", leftCollapsed ? "w-14" : "w-72")}>
        <ThreadSidebar
          collapsed={leftCollapsed}
          onToggleCollapse={() => setLeftCollapsed((c) => !c)}
        />
      </aside>
      <ChatWindow threadId={threadId} />
      <aside className={cn("shrink-0 h-screen border-l border-border-subtle glass", rightCollapsed ? "w-14" : "w-[420px]")}>
        <ResourcesPanel
          threadId={threadId}
          collapsed={rightCollapsed}
          onToggleCollapse={() => setRightCollapsed((c) => !c)}
        />
      </aside>
    </div>
  );
}
