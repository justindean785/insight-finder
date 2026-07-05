import { Link, useLocation } from "react-router-dom";
import { SwarmMark } from "@/components/ui/swarm-mark";
import {
  Home,
  MessageSquare,
  BarChart3,
  Brain,
  FolderOpen,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

const NAV: Array<{ to: string; label: string; icon: LucideIcon; match: (p: string) => boolean }> = [
  { to: "/", label: "Home", icon: Home, match: (p) => p === "/" },
  { to: "/cases", label: "Cases", icon: FolderOpen, match: (p) => p.startsWith("/cases") },
  { to: "/chat", label: "Chat", icon: MessageSquare, match: (p) => p.startsWith("/chat") },
  { to: "/insights", label: "Insights", icon: BarChart3, match: (p) => p.startsWith("/insights") },
  { to: "/brain", label: "Brain", icon: Brain, match: (p) => p.startsWith("/brain") },
];

export function AppNav({ className }: { className?: string }) {
  const { pathname } = useLocation();

  return (
    <header
      className={cn(
        "sticky top-0 z-20 border-b border-border-subtle glass-card",
        className,
      )}
    >
      <div className="mx-auto max-w-6xl px-4 sm:px-8 h-14 flex items-center gap-3">
        <Link to="/" aria-label="Home" className="flex items-center gap-2.5 shrink-0">
          <div className="w-8 h-8 rounded-lg border border-white/10 bg-white/[0.035] grid place-items-center">
            <SwarmMark className="w-4 h-4" />
          </div>
          <div className="font-display text-sm font-semibold tracking-tight hidden xs:block sm:block">
            Insight Finder
          </div>
        </Link>
        <nav className="ml-2 sm:ml-4 flex items-center gap-0.5 sm:gap-1 text-xs overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {NAV.map(({ to, label, icon: Icon, match }) => {
            const active = match(pathname);
            return (
              <Link
                key={to}
                to={to}
                className={cn(
                  "inline-flex items-center gap-1.5 px-2 sm:px-2.5 py-1.5 rounded-md whitespace-nowrap transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                  active
                    ? "bg-white/[0.06] text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-white/[0.04]",
                )}
              >
                <Icon className="w-3.5 h-3.5 shrink-0" />
                {label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
