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
      <div className="shrink-0 px-3 sm:px-4 py-2 border-b border-border-subtle flex items-center gap-1">
        {VIEWS.map((v) => {
          const Icon = v.icon;
          const active = view === v.key;
          return (
            <button
              key={v.key}
              onClick={() => setView(v.key)}
              className={cn(
                "inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-meta font-medium transition-colors",
                active
                  ? "bg-surface-1 text-foreground border border-white/10"
                  : "text-muted-foreground hover:text-foreground hover:bg-surface-1 border border-transparent",
              )}
            >
              <Icon className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} />
              {v.label}
            </button>
          );
        })}
        <span className="ml-auto text-data font-mono tabular-nums text-muted-foreground pr-1">
          {items.length} artifact{items.length === 1 ? "" : "s"}
        </span>
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
