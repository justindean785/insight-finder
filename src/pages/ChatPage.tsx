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
      <div
        key={threadId}
        className="relative flex h-[100dvh] w-full flex-col overflow-hidden bg-[radial-gradient(circle_at_top,rgba(72,157,255,0.12),transparent_34%),linear-gradient(180deg,rgba(10,16,28,0.98),rgba(5,8,16,1))]"
      >
        <CommandPalette />
        <div className="pointer-events-none absolute inset-x-0 top-0 z-0 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent" />
        <header className="sticky top-0 z-30 border-b border-border-subtle/80 bg-[linear-gradient(180deg,rgba(9,14,24,0.96),rgba(9,14,24,0.86))] backdrop-blur-xl">
          <div className="flex h-14 items-center justify-between gap-2 px-3">
            <button
              onClick={() => setMLeft(true)}
              className="grid h-10 w-10 place-items-center rounded-xl border border-border-subtle/80 bg-white/[0.03] text-foreground/80 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition-colors hover:border-primary/35 hover:text-primary"
              aria-label="Open threads"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </button>
            <div className="min-w-0 flex-1 text-center">
              <div className="text-[9px] font-medium uppercase tracking-[0.28em] text-muted-foreground/70">
                Investigation workspace
              </div>
              <div className="font-display text-sm font-semibold tracking-tight text-foreground select-none">
                Swarmbot console
              </div>
            </div>
            <button
              onClick={() => setMRight(true)}
              className="grid h-10 w-10 place-items-center rounded-xl border border-border-subtle/80 bg-white/[0.03] text-foreground/80 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition-colors hover:border-primary/35 hover:text-primary"
              aria-label="Open case panel"
            >
              <PanelRightOpen className="h-4 w-4" />
            </button>
          </div>
          <div className="flex items-center justify-between border-t border-border-subtle/60 px-3 py-2 text-[10px] uppercase tracking-[0.22em] text-muted-foreground/65">
            <span>Thread {threadId.slice(0, 4).toUpperCase()}</span>
            <span>Analyst mobile deck</span>
          </div>
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
    <div
      key={threadId}
      className="relative flex h-[100dvh] w-full overflow-hidden bg-[radial-gradient(circle_at_top,rgba(72,157,255,0.12),transparent_24%),linear-gradient(180deg,rgba(7,11,20,1),rgba(5,8,16,1))]"
    >
      <CommandPalette />
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent" />
        <div className="absolute inset-y-0 left-[calc(18rem)] hidden w-px bg-gradient-to-b from-transparent via-white/10 to-transparent xl:block" />
        <div className="absolute inset-y-0 right-[430px] hidden w-px bg-gradient-to-b from-transparent via-white/10 to-transparent 2xl:block" />
      </div>
      <aside
        className={cn(
          "relative shrink-0 h-screen border-r border-border-subtle/80 bg-[linear-gradient(180deg,rgba(9,15,25,0.98),rgba(7,11,20,0.98))] transition-[width] duration-300",
          leftCollapsed ? "w-14" : "w-72",
        )}
      >
        <ThreadSidebar
          collapsed={leftCollapsed}
          onToggleCollapse={() => setLeftCollapsed((c) => !c)}
        />
      </aside>
      <div className="relative flex-1 min-w-0 h-screen overflow-hidden border-x border-white/5 bg-[linear-gradient(180deg,rgba(10,16,28,0.68),rgba(7,10,18,0.82))]">
        <div className="pointer-events-none absolute inset-x-6 top-3 z-20 flex items-center justify-between text-[10px] uppercase tracking-[0.24em] text-muted-foreground/45">
          <span>Investigation workspace</span>
          <span>Live analysis stream</span>
        </div>
        <ChatWindow threadId={threadId} />
      </div>
      <aside
        className={cn(
          "relative shrink-0 h-screen border-l border-border-subtle/80 bg-[linear-gradient(180deg,rgba(8,13,23,0.98),rgba(6,10,18,0.98))] transition-[width] duration-300",
          rightCollapsed ? "w-14" : "w-full md:w-[430px]",
        )}
      >
        <ResourcesPanel
          threadId={threadId}
          collapsed={rightCollapsed}
          onToggleCollapse={() => setRightCollapsed((c) => !c)}
        />
      </aside>
    </div>
  );
}
