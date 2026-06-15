import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useThreadArtifacts, type Artifact } from "@/hooks/useThreadArtifacts";
import { groupForKind, GROUP_LABEL, GROUP_ORDER, type Group } from "@/lib/intel";
import { ConfidenceMeter } from "@/components/investigation/primitives";
import { CopyButton } from "@/components/ui/workspace-primitives";
import { EmptyState } from "@/components/panel/EmptyState";
import { ZoomIn, ZoomOut, Maximize2, Share2, X } from "lucide-react";
import { cn } from "@/lib/utils";

/** One meaning per hue — keeps the graph legible at a glance. */
const GROUP_COLOR: Record<Group, string> = {
  identity: "hsl(var(--primary))",
  contact: "hsl(var(--brain-cyan))",
  social: "hsl(var(--accent))",
  infrastructure: "hsl(var(--confidence-mid))",
  breach: "hsl(var(--danger))",
  web: "hsl(var(--confidence-high))",
  crypto: "hsl(var(--warning))",
  other: "hsl(var(--muted-foreground))",
};

/** A distinct shape per group so the graph never relies on color alone. */
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

interface Node { id: string; label: string; group: Group; x: number; y: number; r: number; art: Artifact; }
interface Edge { x1: number; y1: number; x2: number; y2: number; group: Group; }

const W = 1000, H = 720, CX = W / 2, CY = H / 2;

function shorten(s: string, n = 22): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** SVG node glyph — color + shape together carry the category. */
function NodeGlyph({ shape, x, y, r, fill, stroke, active }: {
  shape: Shape; x: number; y: number; r: number; fill: string; stroke: string; active: boolean;
}) {
  const common = { fill, fillOpacity: active ? 1 : 0.85, stroke, strokeWidth: active ? 2.5 : 1.5 } as const;
  switch (shape) {
    case "square":
      return <rect x={x - r} y={y - r} width={r * 2} height={r * 2} rx={1.5} {...common} />;
    case "triangle": {
      const p = `${x},${y - r * 1.2} ${x - r * 1.1},${y + r} ${x + r * 1.1},${y + r}`;
      return <polygon points={p} {...common} />;
    }
    case "diamond": {
      const p = `${x},${y - r * 1.25} ${x + r * 1.25},${y} ${x},${y + r * 1.25} ${x - r * 1.25},${y}`;
      return <polygon points={p} {...common} />;
    }
    case "hexagon": {
      const pts = Array.from({ length: 6 }, (_, i) => {
        const a = (Math.PI / 3) * i - Math.PI / 6;
        return `${x + Math.cos(a) * r * 1.15},${y + Math.sin(a) * r * 1.15}`;
      }).join(" ");
      return <polygon points={pts} {...common} />;
    }
    default:
      return <circle cx={x} cy={y} r={r} {...common} />;
  }
}

/**
 * Entity relationship graph — a radial map of how the seed connects to every
 * discovered entity. Color + shape encode the category (never color alone);
 * category filters isolate a cluster, a node click opens a detail panel, and
 * zoom controls let an analyst inspect dense sectors.
 */
export function GraphTab({ threadId }: { threadId: string }) {
  const { items } = useThreadArtifacts(threadId);
  const [seed, setSeed] = useState<{ value: string | null; type: string | null } | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<Group>>(new Set());
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    let alive = true;
    supabase.from("threads").select("seed_value,seed_type").eq("id", threadId).maybeSingle()
      .then(({ data }) => { if (alive) setSeed(data ? { value: data.seed_value, type: data.seed_type } : null); });
    return () => { alive = false; };
  }, [threadId]);

  // Reset transient view state when switching cases.
  useEffect(() => { setSelected(null); setHidden(new Set()); setZoom(1); }, [threadId]);

  const { nodes, edges, presentGroups, groupCounts } = useMemo(() => {
    const byGroup = new Map<Group, Artifact[]>();
    for (const a of items) {
      const g = groupForKind(a.kind);
      (byGroup.get(g) ?? byGroup.set(g, []).get(g)!).push(a);
    }
    const groups = GROUP_ORDER.filter((g) => (byGroup.get(g)?.length ?? 0) > 0);
    const counts = new Map<Group, number>(groups.map((g) => [g, byGroup.get(g)!.length]));
    const visibleGroups = groups.filter((g) => !hidden.has(g));
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const sectorCount = Math.max(visibleGroups.length, 1);
    visibleGroups.forEach((g, gi) => {
      const list = byGroup.get(g)!;
      const base = (gi / sectorCount) * Math.PI * 2 - Math.PI / 2;
      const spread = (Math.PI * 2) / sectorCount;
      list.forEach((a, i) => {
        const ring = 200 + (i % 3) * 78;
        const frac = list.length > 1 ? (i / (list.length - 1) - 0.5) : 0;
        const angle = base + frac * spread * 0.72;
        const x = CX + Math.cos(angle) * ring;
        const y = CY + Math.sin(angle) * ring;
        nodes.push({
          id: a.id,
          label: shorten(a.value),
          group: g,
          x, y,
          r: 6 + Math.min(5, Math.round((a.confidence ?? 0) / 22)),
          art: a,
        });
        edges.push({ x1: CX, y1: CY, x2: x, y2: y, group: g });
      });
    });
    return { nodes, edges, presentGroups: groups, groupCounts: counts };
  }, [items, hidden]);

  const selectedNode = nodes.find((n) => n.id === selected) ?? null;

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

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Category filter toggles + zoom controls */}
      <div className="shrink-0 px-3 sm:px-4 py-2 border-b border-border-subtle flex items-center gap-2 flex-wrap">
        <span className="text-eyebrow uppercase tracking-[0.16em] text-muted-foreground/70 mr-1 hidden sm:inline">Categories</span>
        {presentGroups.map((g) => {
          const off = hidden.has(g);
          return (
            <button
              key={g}
              onClick={() => toggleGroup(g)}
              aria-pressed={!off}
              className={cn(
                "inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-data font-medium border transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                off
                  ? "border-transparent text-muted-foreground/50 line-through hover:text-muted-foreground"
                  : "border-white/10 bg-surface-1 text-foreground",
              )}
              title={off ? `Show ${GROUP_LABEL[g]}` : `Hide ${GROUP_LABEL[g]}`}
            >
              <span className="w-2.5 h-2.5 rounded-[2px]" style={{ backgroundColor: GROUP_COLOR[g], opacity: off ? 0.4 : 1 }} />
              {GROUP_LABEL[g]}
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{groupCounts.get(g)}</span>
            </button>
          );
        })}
        <div className="ml-auto flex items-center gap-1">
          <ZoomBtn icon={ZoomOut} label="Zoom out" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.2).toFixed(2)))} />
          <span className="font-mono text-data tabular-nums text-muted-foreground w-10 text-center">{Math.round(zoom * 100)}%</span>
          <ZoomBtn icon={ZoomIn} label="Zoom in" onClick={() => setZoom((z) => Math.min(2.5, +(z + 0.2).toFixed(2)))} />
          <ZoomBtn icon={Maximize2} label="Reset zoom" onClick={() => setZoom(1)} />
        </div>
      </div>

      <div className="flex-1 min-h-0 relative">
        <div className="absolute inset-0 overflow-auto grid place-items-center bg-[radial-gradient(circle_at_50%_45%,hsl(var(--surface-1)/0.6),transparent_70%)]">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="w-full h-full max-w-[1100px]"
            role="img"
            aria-label="Entity relationship graph"
            style={{ minWidth: zoom > 1 ? `${zoom * 100}%` : undefined }}
          >
            <g transform={`scale(${zoom})`} style={{ transformOrigin: `${CX}px ${CY}px` }}>
              {edges.map((e, i) => {
                const lit = hover != null && nodes.find((n) => n.id === hover)?.x === e.x2;
                return (
                  <line key={i} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2}
                    stroke={GROUP_COLOR[e.group]} strokeOpacity={lit ? 0.5 : 0.2} strokeWidth={lit ? 1.6 : 1} />
                );
              })}
              {nodes.map((n) => {
                const active = hover === n.id || selected === n.id;
                return (
                  <g
                    key={n.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`${n.art.kind}: ${n.art.value}, ${GROUP_LABEL[n.group]}, confidence ${n.art.confidence ?? 0}`}
                    onMouseEnter={() => setHover(n.id)}
                    onMouseLeave={() => setHover(null)}
                    onClick={() => setSelected(n.id)}
                    onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); setSelected(n.id); } }}
                    className="cursor-pointer focus:outline-none [&:focus-visible>*:first-child]:stroke-foreground"
                  >
                    <NodeGlyph
                      shape={GROUP_SHAPE[n.group]}
                      x={n.x} y={n.y} r={active ? n.r + 2 : n.r}
                      fill={GROUP_COLOR[n.group]}
                      stroke={selected === n.id ? "hsl(var(--foreground))" : "hsl(var(--background))"}
                      active={active}
                    />
                    <text x={n.x} y={n.y - (n.r + 7)} textAnchor="middle"
                      className="font-mono pointer-events-none"
                      fontSize={active ? 13 : 12} fontWeight={active ? 600 : 400}
                      fill={active ? "hsl(var(--foreground))" : "hsl(var(--foreground)/0.72)"}>
                      {n.label}
                    </text>
                  </g>
                );
              })}
              {/* Seed hub on top */}
              <circle cx={CX} cy={CY} r={16} fill="hsl(var(--background))" stroke="hsl(var(--foreground))" strokeWidth={2} />
              <circle cx={CX} cy={CY} r={6} fill="hsl(var(--foreground))" />
              <text x={CX} y={CY + 34} textAnchor="middle" className="font-mono" fontSize={13} fill="hsl(var(--foreground))">
                {shorten(seed?.value ?? "seed", 30)}
              </text>
              <text x={CX} y={CY + 50} textAnchor="middle" className="font-mono uppercase" fontSize={9} fill="hsl(var(--muted-foreground))" letterSpacing="0.12em">
                {seed?.type ?? "seed"}
              </text>
            </g>
          </svg>
        </div>

        {/* Node detail panel */}
        {selectedNode && (
          <div className="absolute top-3 right-3 w-[min(20rem,calc(100%-1.5rem))] rounded-xl border border-border bg-popover/95 backdrop-blur p-3 shadow-xl">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-2.5 h-2.5 rounded-[2px] shrink-0" style={{ backgroundColor: GROUP_COLOR[selectedNode.group] }} />
                <span className="text-eyebrow uppercase tracking-[0.14em] text-muted-foreground truncate">
                  {selectedNode.art.kind} · {GROUP_LABEL[selectedNode.group]}
                </span>
              </div>
              <button onClick={() => setSelected(null)} aria-label="Close detail" className="shrink-0 text-muted-foreground hover:text-foreground">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="mt-2 flex items-start gap-2">
              <span className="font-mono text-meta text-foreground break-all flex-1">{selectedNode.art.value}</span>
              <CopyButton value={selectedNode.art.value} label="Copy value" />
            </div>
            <dl className="mt-3 space-y-2 text-data">
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted-foreground">Confidence</dt>
                <dd><ConfidenceMeter value={selectedNode.art.confidence ?? 0} width={72} /></dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted-foreground">Source</dt>
                <dd className="font-mono text-foreground/90 truncate max-w-[60%]" title={selectedNode.art.source ?? "—"}>
                  {selectedNode.art.source ?? "—"}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted-foreground">Linked to</dt>
                <dd className="font-mono text-foreground/90 truncate max-w-[60%]">{shorten(seed?.value ?? "seed", 22)}</dd>
              </div>
            </dl>
            <p className="mt-3 text-data text-muted-foreground/80 leading-relaxed border-t border-border-subtle pt-2">
              Edge means this entity was discovered while investigating the seed. It is an observation from a named source, not a confirmed link.
            </p>
          </div>
        )}
      </div>

      {/* Legend: color + shape + label + count */}
      <div className="shrink-0 border-t border-border-subtle px-4 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {presentGroups.map((g) => (
          <span key={g} className={cn("inline-flex items-center gap-1.5 text-data", hidden.has(g) ? "text-muted-foreground/40" : "text-muted-foreground")}>
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden className="shrink-0">
              <NodeGlyph shape={GROUP_SHAPE[g]} x={7} y={7} r={4.5} fill={GROUP_COLOR[g]} stroke="transparent" active />
            </svg>
            {GROUP_LABEL[g]}
          </span>
        ))}
        <span className="ml-auto text-data text-muted-foreground/70">
          {nodes.length} of {items.length} {items.length === 1 ? "entity" : "entities"} shown
        </span>
      </div>
    </div>
  );
}

function ZoomBtn({ icon: Icon, label, onClick }: { icon: typeof ZoomIn; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className="w-7 h-7 grid place-items-center rounded-md border border-border-subtle text-muted-foreground hover:text-foreground hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon className="w-3.5 h-3.5" />
    </button>
  );
}
