import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useThreadArtifacts, type Artifact } from "@/hooks/useThreadArtifacts";
import { groupForKind, GROUP_LABEL, GROUP_ORDER, type Group } from "@/lib/intel";
import { ConfidenceMeter } from "@/components/investigation/primitives";
import { CopyButton } from "@/components/ui/workspace-primitives";
import { EmptyState } from "@/components/panel/EmptyState";
import {
  Activity,
  GitBranch,
  Layers3,
  Maximize2,
  Move,
  RotateCcw,
  Share2,
  SlidersHorizontal,
  X,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { captureError } from "@/lib/telemetry";

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

type Shape = "circle" | "square" | "triangle" | "diamond" | "hexagon";
const GROUP_SHAPE: Record<Group, Shape> = {
  identity: "circle",
  contact: "diamond",
  social: "triangle",
  infrastructure: "square",
  breach: "hexagon",
  web: "diamond",
  crypto: "hexagon",
  other: "circle",
};

type LayoutMode = "radial" | "cluster" | "timeline";
type DetailMode = "compact" | "standard" | "full";
type DragState =
  | { kind: "node"; id: string }
  | { kind: "pan" }
  | null;

interface GraphNode {
  id: string;
  label: string;
  group: Group;
  x: number;
  y: number;
  baseX: number;
  baseY: number;
  r: number;
  sourceKey: string;
  sourceLabel: string;
  art: Artifact;
}

interface GraphEdge {
  id: string;
  from: string;
  to: string;
  group: Group;
  relation: "seed" | "source" | "kind";
  strength: number;
}

const W = 1120;
const H = 760;
const CX = W / 2;
const CY = H / 2;

function shorten(s: string, n = 22): string {
  return s.length > n ? s.slice(0, n - 1) + "..." : s;
}

function metadataOf(a: Artifact): Record<string, unknown> {
  return a.metadata && typeof a.metadata === "object" && !Array.isArray(a.metadata)
    ? a.metadata as Record<string, unknown>
    : {};
}

function sourceLabel(a: Artifact): string {
  const meta = metadataOf(a);
  const platform = typeof meta.platform === "string" ? meta.platform : "";
  const breach = typeof meta.breach_source === "string" ? meta.breach_source : "";
  const provider = typeof meta.provider === "string" ? meta.provider : "";
  return platform || breach || provider || a.source || "unknown";
}

function sourceKey(a: Artifact): string {
  return sourceLabel(a).toLowerCase().trim() || "unknown";
}

function createdMs(a: Artifact): number {
  const n = new Date(a.created_at).getTime();
  return Number.isFinite(n) ? n : 0;
}

function confidenceRadius(confidence: number | null): number {
  return 7 + Math.min(8, Math.round((confidence ?? 0) / 14));
}

function NodeGlyph({ shape, x, y, r, fill, stroke, active }: {
  shape: Shape;
  x: number;
  y: number;
  r: number;
  fill: string;
  stroke: string;
  active: boolean;
}) {
  const common = { fill, fillOpacity: active ? 1 : 0.86, stroke, strokeWidth: active ? 2.6 : 1.4 } as const;
  switch (shape) {
    case "square":
      return <rect x={x - r} y={y - r} width={r * 2} height={r * 2} rx={2} {...common} />;
    case "triangle":
      return <polygon points={`${x},${y - r * 1.22} ${x - r * 1.12},${y + r} ${x + r * 1.12},${y + r}`} {...common} />;
    case "diamond":
      return <polygon points={`${x},${y - r * 1.28} ${x + r * 1.28},${y} ${x},${y + r * 1.28} ${x - r * 1.28},${y}`} {...common} />;
    case "hexagon": {
      const pts = Array.from({ length: 6 }, (_, i) => {
        const a = (Math.PI / 3) * i - Math.PI / 6;
        return `${x + Math.cos(a) * r * 1.16},${y + Math.sin(a) * r * 1.16}`;
      }).join(" ");
      return <polygon points={pts} {...common} />;
    }
    default:
      return <circle cx={x} cy={y} r={r} {...common} />;
  }
}

function layoutPoint(
  layout: LayoutMode,
  group: Group,
  groupIndex: number,
  groupCount: number,
  itemIndex: number,
  itemCount: number,
  artifact: Artifact,
  timelineIndex: number,
): { x: number; y: number } {
  if (layout === "cluster") {
    const cols = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(groupCount))));
    const row = Math.floor(groupIndex / cols);
    const col = groupIndex % cols;
    const cellW = 250;
    const cellH = 190;
    const originX = CX - ((cols - 1) * cellW) / 2 + col * cellW;
    const originY = 185 + row * cellH;
    const ring = 42 + Math.floor(itemIndex / 8) * 28;
    const angle = (itemIndex / Math.max(itemCount, 1)) * Math.PI * 2;
    return { x: originX + Math.cos(angle) * ring, y: originY + Math.sin(angle) * ring };
  }

  if (layout === "timeline") {
    const orderedIndex = timelineIndex;
    const lane = GROUP_ORDER.indexOf(group);
    const x = 110 + (orderedIndex % 18) * 52;
    const y = 120 + Math.max(0, lane) * 72 + Math.floor(orderedIndex / 18) * 34;
    return { x, y: Math.min(H - 86, y + (createdMs(artifact) % 17)) };
  }

  const sectorCount = Math.max(groupCount, 1);
  const base = (groupIndex / sectorCount) * Math.PI * 2 - Math.PI / 2;
  const spread = (Math.PI * 2) / sectorCount;
  const ring = 205 + (itemIndex % 4) * 68 + Math.floor(itemIndex / 18) * 24;
  const frac = itemCount > 1 ? (itemIndex / (itemCount - 1) - 0.5) : 0;
  const angle = base + frac * spread * 0.74;
  return { x: CX + Math.cos(angle) * ring, y: CY + Math.sin(angle) * ring };
}

function selectVisibleItems(items: Artifact[], density: number): Artifact[] {
  const sortedItems = [...items].sort((a, b) => createdMs(a) - createdMs(b));
  const maxItems = Math.max(8, Math.round(sortedItems.length * (density / 100)));
  if (sortedItems.length <= maxItems) return sortedItems;

  const selected = new Map<string, Artifact>();
  const add = (artifact: Artifact) => {
    if (selected.size < maxItems) selected.set(artifact.id, artifact);
  };

  const newestFirst = [...sortedItems].reverse();
  const seenGroups = new Set<Group>();
  for (const artifact of newestFirst) {
    const group = groupForKind(artifact.kind);
    if (seenGroups.has(group)) continue;
    add(artifact);
    seenGroups.add(group);
  }

  const newestTarget = Math.max(seenGroups.size, Math.ceil(maxItems * 0.58));
  for (const artifact of newestFirst) {
    if (selected.size >= newestTarget) break;
    add(artifact);
  }

  const strongestFirst = [...sortedItems].sort((a, b) => {
    const confidenceDelta = (b.confidence ?? 0) - (a.confidence ?? 0);
    if (confidenceDelta !== 0) return confidenceDelta;
    return createdMs(b) - createdMs(a);
  });
  for (const artifact of strongestFirst) {
    if (selected.size >= maxItems) break;
    add(artifact);
  }

  return Array.from(selected.values()).sort((a, b) => createdMs(a) - createdMs(b));
}

export function GraphTab({ threadId }: { threadId: string }) {
  const { items } = useThreadArtifacts(threadId);
  const [seed, setSeed] = useState<{ value: string | null; type: string | null } | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<Group>>(new Set());
  const [zoom, setZoom] = useState(1);
  const [layout, setLayout] = useState<LayoutMode>("radial");
  const [detail, setDetail] = useState<DetailMode>("standard");
  const [density, setDensity] = useState(72);
  const [showSourceEdges, setShowSourceEdges] = useState(true);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [offsets, setOffsets] = useState<Record<string, { x: number; y: number }>>({});
  const [drag, setDrag] = useState<DragState>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    let alive = true;
    supabase.from("threads").select("seed_value,seed_type").eq("id", threadId).maybeSingle()
      .then(({ data, error }) => {
        if (error) { captureError(error, "GraphTab.seedFetch", { threadId }); return; }
        if (alive) setSeed(data ? { value: data.seed_value, type: data.seed_type } : null);
      });
    return () => { alive = false; };
  }, [threadId]);

  useEffect(() => {
    setSelected(null);
    setHidden(new Set());
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setOffsets({});
  }, [threadId]);

  useEffect(() => {
    setOffsets({});
    setSelected(null);
  }, [layout]);

  const { nodes, edges, presentGroups, groupCounts } = useMemo(() => {
    const visibleItems = selectVisibleItems(items, density);
    const timelineIndexById = new Map(visibleItems.map((artifact, index) => [artifact.id, index]));
    const byGroup = new Map<Group, Artifact[]>();
    for (const a of visibleItems) {
      const g = groupForKind(a.kind);
      (byGroup.get(g) ?? byGroup.set(g, []).get(g)!).push(a);
    }

    const groups = GROUP_ORDER.filter((g) => (byGroup.get(g)?.length ?? 0) > 0);
    const counts = new Map<Group, number>(groups.map((g) => [g, byGroup.get(g)!.length]));
    const visibleGroups = groups.filter((g) => !hidden.has(g));
    const graphNodes: GraphNode[] = [];

    visibleGroups.forEach((g, groupIndex) => {
      const list = byGroup.get(g)!;
      list.forEach((a, itemIndex) => {
        const base = layoutPoint(
          layout,
          g,
          groupIndex,
          visibleGroups.length,
          itemIndex,
          list.length,
          a,
          timelineIndexById.get(a.id) ?? itemIndex,
        );
        const offset = offsets[a.id] ?? { x: 0, y: 0 };
        graphNodes.push({
          id: a.id,
          label: shorten(a.value, detail === "compact" ? 16 : 24),
          group: g,
          x: base.x + offset.x,
          y: base.y + offset.y,
          baseX: base.x,
          baseY: base.y,
          r: confidenceRadius(a.confidence),
          sourceKey: sourceKey(a),
          sourceLabel: sourceLabel(a),
          art: a,
        });
      });
    });

    const graphEdges: GraphEdge[] = graphNodes.map((n) => ({
      id: `seed:${n.id}`,
      from: "seed",
      to: n.id,
      group: n.group,
      relation: "seed",
      strength: Math.max(0.18, (n.art.confidence ?? 45) / 100),
    }));

    if (showSourceEdges) {
      const bySource = new Map<string, GraphNode[]>();
      for (const node of graphNodes) {
        if (node.sourceKey === "unknown") continue;
        (bySource.get(node.sourceKey) ?? bySource.set(node.sourceKey, []).get(node.sourceKey)!).push(node);
      }
      for (const list of bySource.values()) {
        if (list.length < 2) continue;
        const limited = list.slice(0, detail === "full" ? 8 : 4);
        for (let i = 1; i < limited.length; i++) {
          graphEdges.push({
            id: `source:${limited[i - 1].id}:${limited[i].id}`,
            from: limited[i - 1].id,
            to: limited[i].id,
            group: limited[i].group,
            relation: "source",
            strength: 0.34,
          });
        }
      }

      if (detail === "full") {
        const byKind = new Map<string, GraphNode[]>();
        for (const node of graphNodes) {
          (byKind.get(node.art.kind) ?? byKind.set(node.art.kind, []).get(node.art.kind)!).push(node);
        }
        for (const list of byKind.values()) {
          if (list.length < 3) continue;
          const limited = list.slice(0, 6);
          for (let i = 2; i < limited.length; i += 2) {
            graphEdges.push({
              id: `kind:${limited[0].id}:${limited[i].id}`,
              from: limited[0].id,
              to: limited[i].id,
              group: limited[i].group,
              relation: "kind",
              strength: 0.22,
            });
          }
        }
      }
    }

    return { nodes: graphNodes, edges: graphEdges, presentGroups: groups, groupCounts: counts };
  }, [density, detail, hidden, items, layout, offsets, showSourceEdges]);

  const selectedNode = nodes.find((n) => n.id === selected) ?? null;
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const activeNode = selected ?? hover;

  if (items.length === 0) {
    return (
      <EmptyState
        icon={Share2}
        title="No entities to graph yet"
        hint="As the investigation discovers emails, usernames, domains and other identifiers, they'll appear here linked back to the seed."
      />
    );
  }

  const toggleGroup = (g: Group) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g); else next.add(g);
      return next;
    });

  const svgDelta = (event: React.PointerEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { dx: 0, dy: 0 };
    return {
      dx: event.movementX * (W / rect.width) / zoom,
      dy: event.movementY * (H / rect.height) / zoom,
    };
  };

  const startNodeDrag = (id: string, event: React.PointerEvent<SVGGElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelected(id);
    setDrag({ kind: "node", id });
  };

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!drag) return;
    const { dx, dy } = svgDelta(event);
    if (drag.kind === "pan") {
      setPan((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
      return;
    }
    setOffsets((prev) => {
      const node = nodeById.get(drag.id);
      if (!node) return prev;
      const current = prev[drag.id] ?? { x: node.x - node.baseX, y: node.y - node.baseY };
      return { ...prev, [drag.id]: { x: current.x + dx, y: current.y + dy } };
    });
  };

  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setOffsets({});
    setSelected(null);
  };

  return (
    <div className="graph-workspace h-full flex flex-col min-h-0">
      <div className="graph-toolbar shrink-0 border-b border-white/[0.08] px-3 sm:px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.035] px-2 py-1">
            <ControlLabel icon={Layers3} label="Layout" />
            {(["radial", "cluster", "timeline"] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setLayout(mode)}
                className={cn("h-7 rounded-lg px-2.5 text-data font-medium capitalize transition-colors", layout === mode ? "bg-[hsl(var(--info))] text-black" : "text-muted-foreground hover:bg-white/[0.06] hover:text-foreground")}
              >
                {mode}
              </button>
            ))}
          </div>

          <div className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.035] px-2 py-1">
            <ControlLabel icon={SlidersHorizontal} label="Detail" />
            {(["compact", "standard", "full"] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setDetail(mode)}
                className={cn("h-7 rounded-lg px-2.5 text-data font-medium capitalize transition-colors", detail === mode ? "bg-white text-black" : "text-muted-foreground hover:bg-white/[0.06] hover:text-foreground")}
              >
                {mode}
              </button>
            ))}
          </div>

          <label className="inline-flex h-9 items-center gap-2 rounded-xl border border-white/10 bg-white/[0.035] px-3 text-data text-muted-foreground">
            Density
            <input
              type="range"
              min={25}
              max={100}
              step={5}
              value={density}
              onChange={(event) => setDensity(Number(event.target.value))}
              className="w-24 accent-[hsl(var(--info))]"
            />
            <span className="w-8 font-mono text-foreground/80">{density}%</span>
          </label>

          <button
            type="button"
            onClick={() => setShowSourceEdges((v) => !v)}
            className={cn("inline-flex h-9 items-center gap-2 rounded-xl border px-3 text-data font-medium transition-colors", showSourceEdges ? "border-[hsl(var(--info)/0.32)] bg-[hsl(var(--info)/0.1)] text-[hsl(var(--info))]" : "border-white/10 bg-white/[0.035] text-muted-foreground hover:text-foreground")}
          >
            <GitBranch className="h-3.5 w-3.5" />
            Source links
          </button>

          <div className="ml-auto flex items-center gap-1">
            <ZoomBtn icon={Move} label="Drag canvas or nodes" onClick={() => setDrag(null)} />
            <ZoomBtn icon={ZoomOut} label="Zoom out" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.2).toFixed(2)))} />
            <span className="font-mono text-data tabular-nums text-muted-foreground w-10 text-center">{Math.round(zoom * 100)}%</span>
            <ZoomBtn icon={ZoomIn} label="Zoom in" onClick={() => setZoom((z) => Math.min(2.6, +(z + 0.2).toFixed(2)))} />
            <ZoomBtn icon={Maximize2} label="Reset zoom" onClick={resetView} />
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {presentGroups.map((g) => {
            const off = hidden.has(g);
            return (
              <button
                key={g}
                onClick={() => toggleGroup(g)}
                aria-pressed={!off}
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-lg border px-2 text-data font-medium transition-colors",
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
      </div>

      <div className="flex-1 min-h-0 relative">
        <div className="absolute inset-0 overflow-hidden bg-[radial-gradient(circle_at_50%_45%,hsl(var(--surface-1)/0.6),transparent_70%)]">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            className="h-full w-full cursor-grab active:cursor-grabbing"
            role="img"
            aria-label="Interactive entity relationship graph"
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              setDrag({ kind: "pan" });
            }}
            onPointerMove={onPointerMove}
            onPointerUp={() => setDrag(null)}
            onPointerCancel={() => setDrag(null)}
          >
            <defs>
              <pattern id="graph-grid" width="44" height="44" patternUnits="userSpaceOnUse">
                <path d="M 44 0 L 0 0 0 44" fill="none" stroke="hsl(var(--foreground) / 0.045)" strokeWidth="1" />
              </pattern>
              <filter id="node-glow" x="-80%" y="-80%" width="260%" height="260%">
                <feGaussianBlur stdDeviation="5" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>
            <rect width={W} height={H} fill="url(#graph-grid)" opacity="0.9" />
            <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`} style={{ transformOrigin: `${CX}px ${CY}px` }}>
              <circle cx={CX} cy={CY} r={214} fill="none" stroke="hsl(var(--foreground) / 0.04)" />
              <circle cx={CX} cy={CY} r={314} fill="none" stroke="hsl(var(--foreground) / 0.035)" strokeDasharray="6 12" />

              {edges.map((edge) => {
                const from = edge.from === "seed" ? { x: CX, y: CY } : nodeById.get(edge.from);
                const to = nodeById.get(edge.to);
                if (!from || !to) return null;
                const active = activeNode === edge.from || activeNode === edge.to;
                const isSecondary = edge.relation !== "seed";
                return (
                  <line
                    key={edge.id}
                    x1={from.x}
                    y1={from.y}
                    x2={to.x}
                    y2={to.y}
                    stroke={isSecondary ? "hsl(var(--foreground))" : GROUP_COLOR[edge.group]}
                    strokeOpacity={active ? 0.62 : isSecondary ? 0.16 : 0.24}
                    strokeWidth={active ? 2 : isSecondary ? 1.1 : 1.3}
                    strokeDasharray={edge.relation === "source" ? "6 8" : edge.relation === "kind" ? "2 8" : undefined}
                  />
                );
              })}

              {nodes.map((n) => {
                const active = hover === n.id || selected === n.id;
                const showLabel = detail !== "compact" || active || n.r >= 13;
                return (
                  <g
                    key={n.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`${n.art.kind}: ${n.art.value}, ${GROUP_LABEL[n.group]}, confidence ${n.art.confidence ?? 0}`}
                    onPointerDown={(event) => startNodeDrag(n.id, event)}
                    onMouseEnter={() => setHover(n.id)}
                    onMouseLeave={() => setHover(null)}
                    onClick={() => setSelected(n.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelected(n.id);
                      }
                    }}
                    className="cursor-move focus:outline-none [&:focus-visible>*:first-child]:stroke-foreground"
                    filter={active ? "url(#node-glow)" : undefined}
                  >
                    <NodeGlyph
                      shape={GROUP_SHAPE[n.group]}
                      x={n.x}
                      y={n.y}
                      r={active ? n.r + 2 : n.r}
                      fill={GROUP_COLOR[n.group]}
                      stroke={selected === n.id ? "hsl(var(--foreground))" : "hsl(var(--background))"}
                      active={active}
                    />
                    {showLabel && (
                      <text
                        x={n.x}
                        y={n.y - (n.r + 8)}
                        textAnchor="middle"
                        className="pointer-events-none font-mono"
                        fontSize={active ? 12.5 : 11.5}
                        fontWeight={active ? 700 : 500}
                        fill={active ? "hsl(var(--foreground))" : "hsl(var(--foreground) / 0.72)"}
                      >
                        {n.label}
                      </text>
                    )}
                    {detail === "full" && (
                      <text
                        x={n.x}
                        y={n.y + n.r + 15}
                        textAnchor="middle"
                        className="pointer-events-none font-mono uppercase"
                        fontSize={8.5}
                        fill="hsl(var(--muted-foreground))"
                      >
                        {shorten(n.sourceLabel, 18)}
                      </text>
                    )}
                  </g>
                );
              })}

              <circle cx={CX} cy={CY} r={24} fill="hsl(var(--background))" stroke="hsl(var(--foreground))" strokeWidth={2} />
              <circle cx={CX} cy={CY} r={9} fill="hsl(var(--info))" />
              <text x={CX} y={CY + 44} textAnchor="middle" className="font-mono" fontSize={13} fill="hsl(var(--foreground))">
                {shorten(seed?.value ?? "seed", 34)}
              </text>
              <text x={CX} y={CY + 60} textAnchor="middle" className="font-mono uppercase" fontSize={9} fill="hsl(var(--muted-foreground))" letterSpacing="0.12em">
                {seed?.type ?? "seed"} hub
              </text>
            </g>
          </svg>
        </div>

        {selectedNode && (
          <div className="absolute top-3 right-3 w-[min(22rem,calc(100%-1.5rem))] rounded-2xl border border-white/10 bg-popover/95 p-3 shadow-[0_28px_90px_-42px_rgba(0,0,0,0.95)] backdrop-blur-xl">
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className="h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ backgroundColor: GROUP_COLOR[selectedNode.group] }} />
                <span className="truncate text-eyebrow uppercase tracking-[0.14em] text-muted-foreground">
                  {selectedNode.art.kind} · {GROUP_LABEL[selectedNode.group]}
                </span>
              </div>
              <button onClick={() => setSelected(null)} aria-label="Close detail" className="shrink-0 text-muted-foreground hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-2 flex items-start gap-2">
              <span className="flex-1 break-all font-mono text-meta text-foreground">{selectedNode.art.value}</span>
              <CopyButton value={selectedNode.art.value} label="Copy value" />
            </div>
            <dl className="mt-3 space-y-2 text-data">
              <DetailRow label="Confidence"><ConfidenceMeter value={selectedNode.art.confidence ?? 0} width={82} /></DetailRow>
              <DetailRow label="Source"><span className="truncate font-mono text-foreground/90" title={selectedNode.sourceLabel}>{selectedNode.sourceLabel}</span></DetailRow>
              <DetailRow label="Created"><span className="font-mono text-foreground/90">{new Date(selectedNode.art.created_at).toLocaleString()}</span></DetailRow>
              <DetailRow label="Linked to"><span className="truncate font-mono text-foreground/90">{shorten(seed?.value ?? "seed", 24)}</span></DetailRow>
            </dl>
            <div className="mt-3 rounded-xl border border-white/8 bg-white/[0.035] p-2 text-data leading-relaxed text-muted-foreground">
              Solid lines connect discoveries to the seed. Dashed lines show shared source or same-kind proximity and should be treated as graph context, not a verified relationship.
            </div>
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-white/[0.08] px-4 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {presentGroups.map((g) => (
          <span key={g} className={cn("inline-flex items-center gap-1.5 text-data", hidden.has(g) ? "text-muted-foreground/40" : "text-muted-foreground")}>
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden className="shrink-0">
              <NodeGlyph shape={GROUP_SHAPE[g]} x={7} y={7} r={4.5} fill={GROUP_COLOR[g]} stroke="transparent" active />
            </svg>
            {GROUP_LABEL[g]}
          </span>
        ))}
        <span className="ml-auto inline-flex items-center gap-2 text-data text-muted-foreground/70">
          <Activity className="h-3.5 w-3.5" />
          {nodes.length} of {items.length} entities · {edges.length} edges
        </span>
      </div>
    </div>
  );
}

function ControlLabel({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <span className="hidden items-center gap-1.5 text-eyebrow uppercase tracking-[0.14em] text-muted-foreground md:inline-flex">
      <Icon className="h-3.5 w-3.5" />
      {label}
    </span>
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

function ZoomBtn({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className="grid h-8 w-8 place-items-center rounded-lg border border-white/10 bg-white/[0.035] text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}
