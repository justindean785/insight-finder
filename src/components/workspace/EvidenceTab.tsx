import { useState } from "react";
import { useThreadArtifacts } from "@/hooks/useThreadArtifacts";
import { EvidenceBoard } from "@/components/ResourcesPanel";
import { EvidenceMatrixTab } from "@/components/panel/EvidenceMatrixTab";
import { ClustersTab } from "@/components/panel/ClustersTab";
import { TimelineTab } from "@/components/panel/TimelineTab";
import { LayoutGrid, Table2, Network, Clock, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type View = "board" | "table" | "clusters" | "timeline";

const VIEWS: { key: View; label: string; icon: LucideIcon }[] = [
  { key: "board", label: "Board", icon: LayoutGrid },
  { key: "table", label: "Table", icon: Table2 },
  { key: "clusters", label: "Clusters", icon: Network },
  { key: "timeline", label: "Timeline", icon: Clock },
];

/**
 * Evidence workspace — the case evidence board. Findings grouped by category
 * (identity, contact, social, infrastructure, breach…) with confidence, source
 * and verification status, plus alternate lenses: a flat sortable table, entity
 * clusters, and a chronological timeline. Fills the full main workspace width.
 */
export function EvidenceTab({ threadId }: { threadId: string }) {
  const { items, updateLocal } = useThreadArtifacts(threadId);
  const [view, setView] = useState<View>("board");

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="shrink-0 h-11 px-3 sm:px-4 border-b border-border-subtle flex items-center gap-3 bg-[hsl(var(--surface-0))/0.98]">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-foreground leading-none">Evidence</div>
          <div className="mt-0.5 text-[10px] text-muted-foreground leading-none">
            {items.length} artifact{items.length === 1 ? "" : "s"}
          </div>
        </div>
        <div className="inline-flex shrink-0 items-center gap-1 rounded-xl border border-white/10 bg-white/[0.035] p-1">
        {VIEWS.map((v) => {
          const Icon = v.icon;
          const active = view === v.key;
          return (
            <button
              key={v.key}
              type="button"
              onClick={() => setView(v.key)}
              title={v.label}
              aria-label={`Show ${v.label.toLowerCase()} evidence view`}
              className={cn(
                "inline-flex h-7 w-8 items-center justify-center rounded-lg transition-colors",
                active
                  ? "bg-white text-black"
                  : "text-muted-foreground hover:text-foreground hover:bg-white/[0.05]",
              )}
            >
              <Icon className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} />
            </button>
          );
        })}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* The board reads its own data so it can own the detail drawer; the
            other lenses share the already-loaded artifact set. */}
        {view === "board" && (
          <div className="mx-auto max-w-5xl">
            <EvidenceBoard threadId={threadId} />
          </div>
        )}
        {view === "table" && (
          <div className="mx-auto max-w-6xl">
            <EvidenceMatrixTab artifacts={items} onLocalUpdate={updateLocal} threadId={threadId} />
          </div>
        )}
        {view === "clusters" && (
          <div className="mx-auto max-w-5xl">
            <ClustersTab threadId={threadId} artifacts={items} />
          </div>
        )}
        {view === "timeline" && (
          <div className="mx-auto max-w-4xl">
            <TimelineTab threadId={threadId} artifacts={items} />
          </div>
        )}
      </div>
    </div>
  );
}
