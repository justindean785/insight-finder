import { MessagesSquare, Database, FileText, Share2, Activity, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type WorkspaceTab = "chat" | "evidence" | "report" | "graph" | "tools";

const TABS: { key: WorkspaceTab; label: string; icon: LucideIcon }[] = [
  { key: "chat", label: "Chatbot", icon: MessagesSquare },
  { key: "evidence", label: "Evidence", icon: Database },
  { key: "report", label: "Report", icon: FileText },
  { key: "graph", label: "Graph", icon: Share2 },
  { key: "tools", label: "Tools", icon: Activity },
];

/**
 * Primary workspace navigation — the five major investigation modes. These are
 * top-level app sections (not nested panel tabs): a single active mode fills the
 * main workspace. Active state is unmistakable (lit label + accent underline);
 * the bar scrolls horizontally on narrow viewports rather than wrapping.
 */
export function WorkspaceTabs({
  active,
  onChange,
  counts,
}: {
  active: WorkspaceTab;
  onChange: (t: WorkspaceTab) => void;
  counts?: Partial<Record<WorkspaceTab, { value: number; tone?: "default" | "danger" }>>;
}) {
  return (
    <div
      role="tablist"
      aria-label="Investigation workspace"
      className="flex items-stretch gap-1 px-2 sm:px-3 border-b border-border-subtle bg-background overflow-x-auto scrollbar-none"
    >
      {TABS.map((t) => {
        const Icon = t.icon;
        const isActive = active === t.key;
        const count = counts?.[t.key];
        return (
          <button
            key={t.key}
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(t.key)}
            className={cn(
              "group relative shrink-0 inline-flex items-center gap-2 h-11 px-3 sm:px-4 text-meta font-medium transition-colors",
              isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon
              className={cn(
                "w-4 h-4 shrink-0 transition-colors",
                isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground",
              )}
              strokeWidth={1.75}
            />
            <span className="tracking-tight">{t.label}</span>
            {count && count.value > 0 && (
              <span
                className={cn(
                  "ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-mono tabular-nums tracking-normal",
                  count.tone === "danger"
                    ? "bg-destructive/15 text-destructive border border-destructive/30"
                    : "bg-surface-2 text-muted-foreground border border-border-subtle",
                )}
              >
                {count.value > 99 ? "99+" : count.value}
              </span>
            )}
            {/* Active underline indicator */}
            <span
              aria-hidden
              className={cn(
                "absolute left-2 right-2 -bottom-px h-[2px] rounded-full transition-all",
                isActive ? "bg-primary opacity-100" : "bg-transparent opacity-0",
              )}
            />
          </button>
        );
      })}
    </div>
  );
}
