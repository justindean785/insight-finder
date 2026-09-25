import { useRef } from "react";
import type { TabCount } from "./WorkspaceTabs";

export type ViewCaseTab = "evidence" | "report" | "graph" | "tools";

const TABS: { key: ViewCaseTab; label: string }[] = [
  { key: "report", label: "Report" },
  { key: "evidence", label: "Evidence" },
  { key: "tools", label: "Tools" },
  { key: "graph", label: "Graph" },
];

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
    <div className="border-b border-border-subtle bg-surface-0 px-3">
      {/* Same `safe center` reasoning as WorkspaceTabs — see the comment there. */}
      <div className="mx-auto flex max-w-6xl justify-safe-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div role="tablist" aria-label="Case views" className="tab-rule w-max border-b-0">
          {TABS.map((t, idx) => {
            const isActive = active === t.key;
            const count = counts?.[t.key];
            return (
              <button
                key={t.key}
                ref={(el) => {
                  tabRefs.current[idx] = el;
                }}
                type="button"
                role="tab"
                aria-selected={isActive}
                tabIndex={isActive ? 0 : -1}
                onKeyDown={(e) => onKeyDown(e, idx)}
                onClick={() => onChange(t.key)}
                className="tab-rule-item h-11"
              >
                {t.label}
                {count && count.value > 0 ? (
                  <span className="tab-rule-count">{count.value > 999 ? "999+" : count.value}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
