import { useRef } from "react";
import { Database, FileText, Share2, Activity, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TabCount } from "./WorkspaceTabs";

export type ViewCaseTab = "evidence" | "report" | "graph" | "tools";

const TABS: { key: ViewCaseTab; label: string; icon: LucideIcon }[] = [
  { key: "report", label: "Report", icon: FileText },
  { key: "evidence", label: "Evidence", icon: Database },
  { key: "tools", label: "Tools", icon: Activity },
  { key: "graph", label: "Graph", icon: Share2 },
];

function CountPill({ value, active }: { value: number; active: boolean }) {
  return (
    <span
      aria-hidden={value === 0}
      className={cn(
        "inline-flex h-[17px] min-w-[17px] items-center justify-center rounded-full px-1 font-mono text-eyebrow tabular-nums leading-none",
        value === 0
          ? "opacity-0"
          : active
            ? "bg-[hsl(var(--intel-blue)/0.22)] text-[hsl(var(--intel-blue))]"
            : "bg-surface-3 text-muted-foreground",
      )}
    >
      {value > 999 ? "999+" : value}
    </span>
  );
}

/** Read-only case viewer tabs — no chat mode. */
export function ViewWorkspaceTabs({
  active,
  onChange,
  counts,
}: {
  active: ViewCaseTab;
  onChange: (t: ViewCaseTab) => void;
  counts?: Partial<Record<ViewCaseTab, TabCount>>;
}) {
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (e: React.KeyboardEvent, idx: number) => {
    let next = idx;
    if (e.key === "ArrowRight") next = (idx + 1) % TABS.length;
    else if (e.key === "ArrowLeft") next = (idx - 1 + TABS.length) % TABS.length;
    else return;
    e.preventDefault();
    onChange(TABS[next].key);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className="border-b border-white/[0.06] bg-[linear-gradient(180deg,hsl(220_22%_6.5%/0.5),hsl(222_20%_4.5%/0.38))] px-3 py-2.5">
      <div className="mx-auto max-w-6xl flex justify-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div
          role="tablist"
          aria-label="Case views"
          className="inline-flex w-max items-center gap-1 rounded-2xl border border-white/[0.08] bg-[hsl(220_26%_9%/0.6)] p-1"
        >
          {TABS.map((t, idx) => {
            const Icon = t.icon;
            const isActive = active === t.key;
            const count = counts?.[t.key];
            return (
              <button
                key={t.key}
                ref={(el) => {
                  tabRefs.current[idx] = el;
                }}
                role="tab"
                aria-selected={isActive}
                tabIndex={isActive ? 0 : -1}
                onKeyDown={(e) => onKeyDown(e, idx)}
                onClick={() => onChange(t.key)}
                className={cn(
                  "inline-flex h-9 items-center gap-2 rounded-lg px-3.5 text-meta font-medium transition-all",
                  isActive
                    ? "bg-[hsl(var(--intel-blue)/0.16)] text-foreground shadow-[inset_0_0_0_1px_hsl(var(--intel-blue)/0.34)]"
                    : "text-muted-foreground hover:bg-white/[0.05] hover:text-foreground",
                )}
              >
                <Icon className={cn("h-4 w-4", isActive && "text-[hsl(var(--intel-blue))]")} strokeWidth={1.8} />
                {t.label}
                {count ? <CountPill value={count.value} active={isActive} /> : null}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
