import { Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { PanelLeftOpen } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useIsMobile } from "@/hooks/use-mobile";
import { useMediaQuery } from "@/hooks/use-media-query";
import { ThreadSidebar } from "@/components/ThreadSidebar";
import { CommandPalette } from "@/components/CommandPalette";
import { FullPageLoader } from "@/components/ui/full-page-loader";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { ShellContext, useShell } from "./shell-context";

/** Rail width is persisted only for wide screens, where the expanded list fits
 *  beside the workspace. Below `WIDE` the rail starts collapsed every time. */
const COLLAPSE_KEY = "if:leftCollapsed";
const WIDE = "(min-width: 1280px)";

/**
 * The one frame every signed-in screen sits in: Cases, the case viewer, the
 * live workspace, Intelligence and Settings. It owns the cases rail, the
 * command palette (⌘K works on every one of those routes, not only inside a
 * case) and the left/right safe-area insets. Pages own their own header and
 * their own scroll container; on phones they render {@link ShellTopBar}, which
 * opens the cases drawer.
 *
 * Breakpoints:
 * - phone (<768): no rail; cases in a left drawer that closes on navigation.
 * - tablet (768–1279): a 56px icon rail. Expanding it overlays the page rather
 *   than squeezing the workspace, and Esc or a click outside closes it.
 * - wide (≥1280): the rail pushes the page, and its state is remembered.
 *
 * The page slot (`<Outlet/>`) keeps the same position and key at every
 * breakpoint. The live workspace's ChatWindow lives inside it, and remounting
 * it would abort an in-flight run.
 */
export function AppShell() {
  const { user, loading } = useAuth();
  const isMobile = useIsMobile();
  const isWide = useMediaQuery(WIDE);
  const location = useLocation();

  // Case desk (JD's prototype, 2026-11-02): the rail is a slim icon rail unless
  // the analyst has expanded it, and that choice is remembered.
  const [widePref, setWidePref] = useState(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) !== "0"; } catch { return true; }
  });
  const [tabletOpen, setTabletOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const collapsed = isWide ? widePref : !tabletOpen;
  const overlay = !isWide && tabletOpen;

  const toggleRail = useCallback(() => {
    if (isWide) {
      setWidePref((c) => {
        const next = !c;
        try { localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0"); } catch { /* ignore */ }
        return next;
      });
    } else {
      setTabletOpen((o) => !o);
    }
  }, [isWide]);

  // Navigating anywhere closes a temporary surface: the phone drawer and the
  // tablet overlay. The shell persists across routes, so nothing else would.
  useEffect(() => {
    setDrawerOpen(false);
    setTabletOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!overlay) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setTabletOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overlay]);

  // Tablet overlay focus: opening moves focus into the expanded list (its
  // collapse control), closing returns it to the rail's expand control, so a
  // keyboard user is never left on a control that just disappeared.
  const railRef = useRef<HTMLElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (isWide) { wasOpen.current = false; return; }
    if (tabletOpen === wasOpen.current) return;
    wasOpen.current = tabletOpen;
    const label = tabletOpen ? "Collapse sidebar" : "Expand sidebar";
    requestAnimationFrame(() => railRef.current?.querySelector<HTMLElement>(`button[aria-label="${label}"]`)?.focus());
  }, [tabletOpen, isWide]);

  const openNav = useCallback(() => setDrawerOpen(true), []);

  if (loading) return <FullPageLoader />;
  if (!user) return <Navigate to="/auth" replace />;

  return (
    <ShellContext.Provider value={{ openNav }}>
      <div className="relative flex h-[100dvh] w-full overflow-hidden bg-background pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
        <a
          href="#shell-main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-popover focus:px-3 focus:py-2 focus:text-sm focus:text-foreground"
        >
          Skip to content
        </a>
        <CommandPalette />

        {!isMobile && (
          <div
            key="rail"
            className={cn(
              "relative z-30 h-full shrink-0 transition-[width] duration-200 ease-out motion-reduce:transition-none",
              isWide && !collapsed ? "w-72" : "w-14",
            )}
          >
            <aside
              ref={railRef}
              aria-label="Cases"
              className={cn(
                "rail-surface absolute inset-y-0 left-0 flex min-h-0 flex-col overflow-hidden border-r border-border-subtle transition-[width] duration-200 ease-out motion-reduce:transition-none",
                collapsed ? "w-14" : "w-72",
                overlay && "shadow-[18px_0_40px_-20px_hsl(0_0%_0%/0.95)]",
              )}
            >
              <ThreadSidebar collapsed={collapsed} onToggleCollapse={toggleRail} />
            </aside>
          </div>
        )}
        {overlay && (
          <button
            key="rail-scrim"
            type="button"
            aria-label="Close cases list"
            tabIndex={-1}
            onClick={() => setTabletOpen(false)}
            className="absolute inset-0 z-20 cursor-default bg-black/40"
          />
        )}

        <div key="page" id="shell-main" tabIndex={-1} className="relative z-10 flex h-full min-w-0 flex-1 flex-col outline-none">
          {/* Route chunks load here, so changing screens keeps the rail on
              screen instead of swapping the whole frame for a loader. */}
          <Suspense fallback={<FullPageLoader fullScreen={false} className="flex-1" />}>
            <Outlet />
          </Suspense>
        </div>

        {isMobile && (
          <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
            <SheetContent
              side="left"
              // Opened from the page's own top-bar button, not a Radix trigger, so
              // Radix has nowhere to return focus. Send it back to that button.
              onCloseAutoFocus={(e) => {
                e.preventDefault();
                document.querySelector<HTMLElement>('#shell-main button[aria-label="Open cases"]')?.focus();
              }}
              className="rail-surface w-[82vw] max-w-[300px] overflow-hidden border-r border-border-subtle p-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] sm:max-w-[300px] [&>button]:hidden"
            >
              {/* Radix requires an accessible name + description on every dialog
                  surface. Visually hidden: the drawer's content is self-evident. */}
              <SheetHeader className="sr-only">
                <SheetTitle>Investigations</SheetTitle>
                <SheetDescription>Switch between your cases, or start a new investigation.</SheetDescription>
              </SheetHeader>
              <ThreadSidebar />
            </SheetContent>
          </Sheet>
        )}
      </div>
    </ShellContext.Provider>
  );
}

/**
 * Phone header row: the cases-drawer button, then whatever identifies the
 * screen. Pads itself by the top safe-area inset so the notch never covers it.
 */
export function ShellTopBar({ children, className }: { children?: ReactNode; className?: string }) {
  const { openNav } = useShell();
  return (
    <header className={cn("flex shrink-0 items-center gap-0.5 border-b border-border-subtle bg-card pl-1 pt-[env(safe-area-inset-top)]", className)}>
      <button
        type="button"
        onClick={openNav}
        aria-label="Open cases"
        className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors duration-fast hover:bg-white/[0.05] hover:text-foreground"
      >
        <PanelLeftOpen className="h-[18px] w-[18px] text-foreground/80" aria-hidden />
      </button>
      {children}
    </header>
  );
}

/** A plain screen title for {@link ShellTopBar}. It is the page's `<h1>` only
 *  when the page has no heading of its own on phones (`asHeading`); otherwise
 *  it is a label, so a screen never carries two level-one headings. */
export function ShellTopBarTitle({ children, asHeading = false }: { children: ReactNode; asHeading?: boolean }) {
  const Tag = asHeading ? "h1" : "p";
  return <Tag className="min-w-0 truncate pr-3 font-display text-[15px] font-semibold tracking-tight text-foreground">{children}</Tag>;
}
