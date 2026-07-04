import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  useEdgesState,
  useNodesState,
  type ReactFlowInstance,
  type Edge,
  type Node,
  type NodeProps,
} from "reactflow";
import "reactflow/dist/style.css";
import { supabase } from "@/integrations/supabase/client";
import { useThreadArtifacts } from "@/hooks/useThreadArtifacts";
import { GROUP_LABEL, type Group } from "@/lib/intel";
import {
  buildEntityGraph,
  type EdgeType,
  type EntityGraph,
  type GraphNode as EntityNodeModel,
} from "@/lib/entity-graph";
import { ConfidenceMeter } from "@/components/investigation/primitives";
import { CopyButton } from "@/components/ui/workspace-primitives";
import { EmptyState } from "@/components/panel/EmptyState";
import { Activity, AlertTriangle, Share2, Sparkles, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { captureError } from "@/lib/telemetry";

// Restrained group palette — same vocabulary as the Evidence board so a glance
// triages identically across tabs.
const GROUP_COLOR: Record<Group, string> = {
  identity: "hsl(var(--info))",
  contact: "hsl(var(--brain-cyan))",
  social: "hsl(var(--accent))",
  infrastructure: "hsl(var(--confidence-mid))",
  breach: "hsl(var(--danger))",
  web: "hsl(var(--confidence-high))",
  crypto: "hsl(var(--warning))",
  other: "hsl(var(--muted-foreground))",
};

// How each edge class is drawn. The WHY ("reason") rides in edge.data and is
// surfaced in the detail panel + as a native title tooltip — never invented:
// every edge comes from buildEntityGraph's shared-selector analysis.
const EDGE_STYLE: Record<EdgeType, { stroke: string; dashed: boolean; baseOpacity: number }> = {
  identity: { stroke: "hsl(var(--info))", dashed: false, baseOpacity: 0.55 },
  "shared-infra": { stroke: "hsl(var(--confidence-mid))", dashed: true, baseOpacity: 0.4 },
  "seed-discovery": { stroke: "hsl(var(--foreground))", dashed: false, baseOpacity: 0.14 },
};
const EDGE_LABEL: Record<EdgeType, string> = {
  identity: "Identity link",
  "shared-infra": "Shared infrastructure",
  "seed-discovery": "Discovered in run",
};

function shorten(s: string, n = 22): string {
  return s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s;
}

type EntityNodeData = {
  label: string;
  group: Group;
  kind: string;
  value: string;
  confidence: number;
  isSeed: boolean;
  conflict: boolean;
  degree: number;
};

/** A single graph node — group-colored chip; seed is the bright hub; a
 *  breach/conflict node carries the restrained destructive accent. */
const EntityNode = memo(function EntityNode({ data, selected }: NodeProps<EntityNodeData>) {
  const color = data.conflict ? "hsl(var(--danger))" : GROUP_COLOR[data.group];
  if (data.isSeed) {
    return (
      <div
        className={cn(
          "flex flex-col items-center gap-0.5 rounded-xl border px-3.5 py-2 text-center shadow-[0_0_28px_-6px_hsl(var(--info)/0.8)]",
          "border-[hsl(var(--info))] bg-[hsl(var(--info))] text-black",
          selected && "ring-2 ring-foreground ring-offset-2 ring-offset-background",
        )}
      >
        <Handle type="target" position={Position.Top} className="!h-1 !w-1 !border-0 !bg-transparent !opacity-0" isConnectable={false} />
        <span className="font-mono text-[11px] font-bold leading-none">{data.label}</span>
        <span className="font-mono text-[8px] uppercase tracking-[0.16em] opacity-70">{data.kind} · seed</span>
        <Handle type="source" position={Position.Bottom} className="!h-1 !w-1 !border-0 !bg-transparent !opacity-0" isConnectable={false} />
      </div>
    );
  }
  return (
    <div
      className={cn(
        "group flex items-center gap-1.5 rounded-lg border bg-surface-1/90 px-2.5 py-1.5 backdrop-blur-sm transition-shadow",
        "border-white/10 shadow-[0_8px_24px_-16px_rgba(0,0,0,0.9)]",
        data.conflict && "border-[hsl(var(--danger)/0.55)]",
        selected && "ring-2 ring-foreground",
      )}
      style={{ boxShadow: selected ? `0 0 0 1px ${color}, 0 10px 30px -16px ${color}` : undefined }}
      title={`${data.kind}: ${data.value} · confidence ${data.confidence}`}
    >
      <Handle type="target" position={Position.Top} className="!h-1 !w-1 !border-0 !bg-transparent !opacity-0" isConnectable={false} />
      <span className="h-2 w-2 shrink-0 rounded-[3px]" style={{ backgroundColor: color }} />
      <span className="max-w-[140px] truncate font-mono text-[11px] text-foreground/90">{data.label}</span>
      {data.confidence > 0 && (
        <span className="font-mono text-[9px] tabular-nums text-muted-foreground">{data.confidence}</span>
      )}
      <Handle type="source" position={Position.Bottom} className="!h-1 !w-1 !border-0 !bg-transparent !opacity-0" isConnectable={false} />
    </div>
  );
});

const nodeTypes = { entity: EntityNode };

function toRfNodes(graph: EntityGraph, hidden: Set<Group>): Node<EntityNodeData>[] {
  return graph.nodes
    .filter((n) => n.isSeed || !hidden.has(n.group))
    .map((n) => ({
      id: n.id,
      type: "entity",
      position: { x: n.x, y: n.y },
      data: {
        label: n.label,
        group: n.group,
        kind: n.kind,
        value: n.art?.value ?? n.label,
        confidence: n.confidence,
        isSeed: n.isSeed,
        conflict: n.conflict,
        degree: n.degree,
      },
      // Seed stays put; discovered nodes are draggable for manual arrangement.
      draggable: !n.isSeed,
    }));
}

function toRfEdges(graph: EntityGraph, hidden: Set<Group>, selected: string | null): Edge[] {
  const visible = new Set(graph.nodes.filter((n) => n.isSeed || !hidden.has(n.group)).map((n) => n.id));
  return graph.edges
    .filter((e) => visible.has(e.source) && visible.has(e.target))
    .map((e) => {
      const s = EDGE_STYLE[e.type];
      const incident = selected != null && (e.source === selected || e.target === selected);
      const dimmed = selected != null && !incident;
      const stroke = e.bridge ? "hsl(var(--warning))" : s.stroke;
      const width = (e.bridge ? 2 : 1) + e.strength * 2;
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        type: "straight",
        data: { reason: e.reason, kind: e.type, bridge: e.bridge },
        style: {
          stroke,
          strokeWidth: incident ? width + 0.8 : width,
          strokeDasharray: s.dashed ? "5 6" : undefined,
          opacity: dimmed ? 0.06 : incident ? 0.95 : s.baseOpacity,
        },
        // Native tooltip = the auditable WHY, with no extra UI.
        label: undefined,
        // reason is shown in the detail panel; keep edges visually clean.
      } as Edge;
    });
}

export function GraphTab({ threadId }: { threadId: string }) {
  const { items } = useThreadArtifacts(threadId);
  const [seed, setSeed] = useState<{ value: string | null; type: string | null } | null>(null);
  const [hidden, setHidden] = useState<Set<Group>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    supabase.from("threads").select("seed_value,seed_type").eq("id", threadId).maybeSingle()
      .then(({ data, error }) => {
        if (error) { captureError(error, "GraphTab.seedFetch", { threadId }); return; }
        if (alive) setSeed(data ? { value: data.seed_value, type: data.seed_type } : null);
      });
    return () => { alive = false; };
  }, [threadId]);

  useEffect(() => { setSelected(null); setHidden(new Set()); }, [threadId]);

  // The real link-analysis model: edges from genuinely shared selectors
  // (email/phone/handle/ip/…), identity clusters, cross-cluster bridges, and a
  // deterministic layout — all computed in src/lib/entity-graph.ts.
  const graph = useMemo<EntityGraph>(
    () => buildEntityGraph(items, seed?.value ?? null, seed?.type ?? null),
    [items, seed],
  );

  const presentGroups = useMemo(() => {
    const seen = new Set<Group>();
    for (const n of graph.nodes) if (!n.isSeed) seen.add(n.group);
    return (Object.keys(GROUP_COLOR) as Group[]).filter((g) => seen.has(g));
  }, [graph]);

  const groupCounts = useMemo(() => {
    const m = new Map<Group, number>();
    for (const n of graph.nodes) if (!n.isSeed) m.set(n.group, (m.get(n.group) ?? 0) + 1);
    return m;
  }, [graph]);

  const nodeById = useMemo(() => {
    const m = new Map<string, EntityNodeModel>();
    for (const n of graph.nodes) m.set(n.id, n);
    return m;
  }, [graph]);

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<EntityNodeData>([]);
  const [rfEdges, setRfEdges] = useEdgesState([]);

  // React Flow's `fitView` prop only fits on the FIRST render — but nodes are
  // populated asynchronously (after artifacts load), so that initial fit runs on
  // an empty set and leaves the viewport off the nodes (blank canvas). Frame the
  // graph imperatively once nodes exist, once per case.
  const rfRef = useRef<ReactFlowInstance | null>(null);
  const fittedThread = useRef<string | null>(null);
  const onRfInit = useCallback(
    (inst: ReactFlowInstance) => {
      rfRef.current = inst;
      requestAnimationFrame(() => {
        if (rfNodes.length > 0) {
          fittedThread.current = threadId;
          inst.fitView({ padding: 0.2 });
        }
      });
    },
    [rfNodes.length, threadId],
  );

  // Node positions resync on graph/hidden only — so selecting a node (which only
  // restyles edges) never resets a manual drag arrangement.
  useEffect(() => { setRfNodes(toRfNodes(graph, hidden)); }, [graph, hidden, setRfNodes]);
  useEffect(() => { setRfEdges(toRfEdges(graph, hidden, selected)); }, [graph, hidden, selected, setRfEdges]);

  // Fit once the (async) nodes for a case are present; re-fits when the case
  // changes. Group-filter toggles keep the same threadId so they don't re-fit.
  useEffect(() => {
    if (!rfRef.current || rfNodes.length === 0) return;
    if (fittedThread.current === threadId) return;
    fittedThread.current = threadId;
    const raf = requestAnimationFrame(() => rfRef.current?.fitView({ padding: 0.2, duration: 250 }));
    return () => cancelAnimationFrame(raf);
  }, [rfNodes, threadId]);

  const toggleGroup = (g: Group) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g); else next.add(g);
      return next;
    });

  const selectedNode = selected ? nodeById.get(selected) ?? null : null;
  const connections = useMemo(() => {
    if (!selected) return [];
    return graph.edges
      .filter((e) => e.source === selected || e.target === selected)
      .map((e) => {
        const otherId = e.source === selected ? e.target : e.source;
        const other = nodeById.get(otherId);
        return { id: e.id, type: e.type, reason: e.reason, bridge: e.bridge, otherLabel: other?.label ?? otherId };
      });
  }, [selected, graph, nodeById]);

  if (items.length === 0) {
    return (
      <EmptyState
        icon={Share2}
        title="No entities to graph yet"
        hint="As the investigation discovers emails, usernames, domains and other identifiers, they'll appear here linked to the seed and to each other by shared selectors."
      />
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0 rounded-2xl border border-white/8 bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.015))] shadow-[0_24px_90px_-50px_rgba(0,0,0,0.98)]">
      {/* Group filters + run-level warnings */}
      <div className="shrink-0 border-b border-white/[0.08] px-2.5 py-2 sm:px-4 bg-[linear-gradient(180deg,rgba(255,255,255,0.03),transparent)]">
        <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 sm:flex-wrap sm:overflow-visible">
          {presentGroups.map((g) => {
            const off = hidden.has(g);
            return (
              <button
                key={g}
                onClick={() => toggleGroup(g)}
                aria-pressed={!off}
                className={cn(
                  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border px-2 text-data font-medium transition-colors",
                  off
                    ? "border-transparent text-muted-foreground/45 line-through hover:text-muted-foreground"
                    : "border-white/10 bg-surface-1/80 text-foreground",
                )}
                title={off ? `Show ${GROUP_LABEL[g]}` : `Hide ${GROUP_LABEL[g]}`}
              >
                <span className="h-2 w-2 rounded-[2px]" style={{ backgroundColor: GROUP_COLOR[g], opacity: off ? 0.4 : 1 }} />
                {GROUP_LABEL[g]}
                <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{groupCounts.get(g)}</span>
              </button>
            );
          })}
        </div>
        {graph.warnings.length > 0 && (
          <div className="mt-2 flex items-start gap-1.5 text-data text-[hsl(var(--warning))]">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            <span className="leading-relaxed">{graph.warnings[0]}</span>
          </div>
        )}
      </div>

      <div className="relative flex-1 min-h-0">
        <div className="pointer-events-none absolute inset-0 z-0 bg-[radial-gradient(circle_at_18%_14%,rgba(72,185,255,0.09),transparent_42%),radial-gradient(circle_at_82%_78%,rgba(255,255,255,0.06),transparent_40%)]" />
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          onInit={onRfInit}
          onNodesChange={onNodesChange}
          nodeTypes={nodeTypes}
          onNodeClick={(_, n) => setSelected(n.id)}
          onPaneClick={() => setSelected(null)}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.2}
          maxZoom={2.5}
          nodesConnectable={false}
          elementsSelectable
          proOptions={{ hideAttribution: false }}
          className="bg-[radial-gradient(circle_at_50%_40%,hsl(var(--surface-1)/0.62),transparent_72%)]"
        >
          <Background variant={BackgroundVariant.Dots} gap={26} size={1} color="hsl(var(--foreground) / 0.10)" />
          <Controls showInteractive={false} className="!rounded-lg !border !border-white/10 !bg-surface-1/90 !shadow-lg [&_button]:!border-white/10 [&_button]:!bg-transparent [&_button]:!text-foreground" />
          <MiniMap
            pannable
            zoomable
            className="!rounded-lg !border !border-white/10 !bg-surface-0/90"
            maskColor="hsl(var(--background) / 0.6)"
            nodeColor={(n) => {
              const d = n.data as EntityNodeData;
              return d?.isSeed ? "hsl(var(--info))" : d?.conflict ? "hsl(var(--danger))" : GROUP_COLOR[d?.group ?? "other"];
            }}
          />
        </ReactFlow>

        {graph.stats.realEdgeCount === 0 && (
          <div className="pointer-events-none absolute inset-0 z-[5] grid place-items-center p-4">
            <div className="max-w-md rounded-xl border border-white/10 bg-[linear-gradient(160deg,rgba(255,255,255,0.1),rgba(255,255,255,0.025)_55%)] px-4 py-3 text-center shadow-[0_20px_60px_-36px_rgba(0,0,0,0.95)] backdrop-blur-xl">
              <div className="inline-flex items-center gap-1.5 text-eyebrow uppercase tracking-[0.12em] text-[hsl(var(--warning))]">
                <AlertTriangle className="h-3.5 w-3.5" />
                No durable links yet
              </div>
              <p className="mt-1.5 text-sm text-foreground/90">
                This case has artifacts, but they do not share strong selectors yet.
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Run additional pivots or corroborate with independent sources to form graph connections.
              </p>
            </div>
          </div>
        )}

        {selectedNode && (
          <div className="absolute top-3 right-3 z-10 w-[min(22rem,calc(100%-1.5rem))] rounded-2xl border border-white/12 bg-[linear-gradient(160deg,rgba(255,255,255,0.09),rgba(255,255,255,0.03)_48%,rgba(255,255,255,0.015))] p-3 shadow-[0_30px_100px_-42px_rgba(0,0,0,0.96)] backdrop-blur-xl">
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                  style={{ backgroundColor: selectedNode.conflict ? "hsl(var(--danger))" : selectedNode.isSeed ? "hsl(var(--info))" : GROUP_COLOR[selectedNode.group] }}
                />
                <span className="truncate text-eyebrow uppercase tracking-[0.14em] text-muted-foreground">
                  {selectedNode.kind} · {selectedNode.isSeed ? "seed" : GROUP_LABEL[selectedNode.group]}
                </span>
              </div>
              <button onClick={() => setSelected(null)} aria-label="Close detail" className="shrink-0 text-muted-foreground hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-2 flex items-start gap-2">
              <span className="flex-1 break-all font-mono text-meta text-foreground">{selectedNode.art?.value ?? selectedNode.label}</span>
              <CopyButton value={selectedNode.art?.value ?? selectedNode.label} label="Copy value" />
            </div>
            {!selectedNode.isSeed && (
              <dl className="mt-3 space-y-2 text-data">
                <DetailRow label="Confidence"><ConfidenceMeter value={selectedNode.confidence} width={82} /></DetailRow>
                <DetailRow label="Connections"><span className="font-mono text-foreground/90">{connections.length}</span></DetailRow>
              </dl>
            )}
            {/* The auditable WHY behind every link — straight from shared-selector analysis. */}
            <div className="mt-3">
              <div className="text-eyebrow uppercase tracking-[0.14em] text-muted-foreground/80">Connections</div>
              {connections.length === 0 ? (
                <p className="mt-1 text-data text-muted-foreground">No links beyond the seed.</p>
              ) : (
                <ul className="mt-1.5 space-y-1.5">
                  {connections.slice(0, 8).map((c) => (
                    <li key={c.id} className="rounded-lg border border-white/8 bg-white/[0.03] p-2">
                      <div className="flex items-center gap-1.5">
                        {c.bridge && <Sparkles className="h-3 w-3 shrink-0 text-[hsl(var(--warning))]" />}
                        <span className="truncate font-mono text-data text-foreground/90">{shorten(c.otherLabel, 28)}</span>
                      </div>
                      <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                        <span className="text-foreground/70">{EDGE_LABEL[c.type]}{c.bridge ? " · bridge" : ""}</span> — {c.reason}
                      </div>
                    </li>
                  ))}
                  {connections.length > 8 && (
                    <li className="text-[11px] text-muted-foreground">+{connections.length - 8} more…</li>
                  )}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Legend + honest stats */}
      <div className="shrink-0 border-t border-white/[0.08] px-4 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 bg-[linear-gradient(0deg,rgba(255,255,255,0.03),transparent)]">
        {presentGroups.map((g) => (
          <span key={g} className={cn("inline-flex items-center gap-1.5 text-data", hidden.has(g) ? "text-muted-foreground/40" : "text-muted-foreground")}>
            <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ backgroundColor: GROUP_COLOR[g] }} />
            {GROUP_LABEL[g]}
          </span>
        ))}
        <span className="ml-auto inline-flex items-center gap-2 text-data text-muted-foreground/70">
          <Activity className="h-3.5 w-3.5" />
          {graph.stats.nodeCount} entities · {graph.stats.realEdgeCount} real links · {graph.stats.clusterCount} clusters
          {graph.stats.bridgeCount > 0 && <> · {graph.stats.bridgeCount} bridge{graph.stats.bridgeCount > 1 ? "s" : ""}</>}
        </span>
      </div>
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}
