import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useThreadArtifacts } from "@/hooks/useThreadArtifacts";
import { GROUP_LABEL, GROUP_ORDER, type Group } from "@/lib/intel";
import { buildEntityGraph, SEED_ID, type GraphNode, type GraphEdge } from "@/lib/entity-graph";
import { ConfidenceMeter } from "@/components/investigation/primitives";
import { CopyButton, TabHeader } from "@/components/ui/workspace-primitives";
import { EmptyState } from "@/components/panel/EmptyState";
import { ZoomIn, ZoomOut, Maximize2, Share2, X, Info, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { captureError } from "@/lib/telemetry";

/** A distinct shape per category so category never relies on color — color is
 * reserved for confidence/state. */
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

function shorten(s: string, n = 20): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** Node fill encodes confidence/state ONLY (shape carries category), so the
 * graph agrees with Evidence/Report: green = strong, amber = mid, muted = weak,
 * red = conflict/breach. */
function nodeFill(n: GraphNode): { fill: string; opacity: number } {
  if (n.conflict) return { fill: "hsl(var(--danger))", opacity: 0.95 };
  if (n.isSeed) return { fill: "hsl(var(--foreground))", opacity: 1 };
  if (n.confidence >= 70) return { fill: "hsl(var(--confidence-high))", opacity: 1 };
  if (n.confidence >= 40) return { fill: "hsl(var(--confidence-mid))", opacity: 0.92 };
  return { fill: "hsl(var(--muted-foreground))", opacity: 0.62 };
}

const EDGE_TYPE_LABEL: Record<GraphEdge["type"], string> = {
  identity: "identity link",
  "shared-infra": "shared infrastructure",
  "seed-discovery": "discovered under seed",
};

/** Edge styling communicates strength/source, never false certainty: identity
 * links are solid (brighter = stronger), shared-infra is dashed amber, the
 * seed-discovery fallback is a faint hairline, and a cross-identity BRIDGE gets
 * the one saturated accent so the highest-value finding pops. */
function edgeStyle(e: GraphEdge, lit: boolean): { stroke: string; width: number; dash?: string; opacity: number } {
  if (e.bridge) return { stroke: "hsl(var(--info))", width: lit ? 2.6 : 1.8, opacity: lit ? 0.95 : 0.7 };
  switch (e.type) {
    case "identity":
      return { stroke: "hsl(var(--foreground))", width: 0.6 + e.strength * 1.8, opacity: (lit ? 0.85 : 0.22) + e.strength * 0.18 };
    case "shared-infra":
      return { stroke: "hsl(var(--confidence-mid))", width: 1, dash: "4 3", opacity: lit ? 0.7 : 0.26 };
    default:
      return { stroke: "hsl(var(--muted-foreground))", width: 0.8, dash: "1 4", opacity: lit ? 0.5 : 0.12 };
  }
}

/** SVG node glyph — shape carries category; fill carries confidence/state. */
function NodeGlyph({ shape, x, y, r, fill, stroke, strokeWidth, fillOpacity }: {
  shape: Shape; x: number; y: number; r: number; fill: string; stroke: string; strokeWidth: number; fillOpacity: number;
}) {
  const common = { fill, fillOpacity, stroke, strokeWidth } as const;
  switch (shape) {
    case "square":
      return <rect x={x - r} y={y - r} width={r * 2} height={r * 2} rx={1.5} {...common} />;
    case "triangle":
      return <polygon points={`${x},${y - r * 1.2} ${x - r * 1.1},${y + r} ${x + r * 1.1},${y + r}`} {...common} />;
    case "diamond":
      return <polygon points={`${x},${y - r * 1.25} ${x + r * 1.25},${y} ${x},${y + r * 1.25} ${x - r * 1.25},${y}`} {...common} />;
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
 * Entity-connection graph — a deterministic constellation of the case. Nodes are
 * real entities (shape = category, fill = confidence, red = conflict); edges are
 * DERIVED from shared selectors / cluster membership only (never invented) and
 * styled by strength, with cross-identity bridges in the one accent. Layout and
 * edges come from the pure buildEntityGraph transform; this component is the
 * presentation + interaction layer.
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
      .then(({ data, error }) => {
        if (error) { captureError(error, "GraphTab.seedFetch", { threadId }); return; }
        if (alive) setSeed(data ? { value: data.seed_value, type: data.seed_type } : null);
      });
    return () => { alive = false; };
  }, [threadId]);

  // Reset transient view state when switching cases.
  useEffect(() => { setSelected(null); setHover(null); setHidden(new Set()); setZoom(1); }, [threadId]);

  const graph = useMemo(
    () => buildEntityGraph(items, seed?.value ?? null, seed?.type ?? null),
    [items, seed],
  );

  const presentGroups = useMemo(() => {
    const s = new Set<Group>();
    for (const n of graph.nodes) if (!n.isSeed) s.add(n.group);
    return GROUP_ORDER.filter((g) => s.has(g));
  }, [graph]);
  const groupCounts = useMemo(() => {
    const m = new Map<Group, number>();
    for (const n of graph.nodes) if (!n.isSeed) m.set(n.group, (m.get(n.group) ?? 0) + 1);
    return m;
  }, [graph]);

  const nodeById = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const visibleNodes = useMemo(() => graph.nodes.filter((n) => n.isSeed || !hidden.has(n.group)), [graph, hidden]);
  const visibleIds = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes]);
  const visibleEdges = useMemo(
    () => graph.edges.filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target)),
    [graph.edges, visibleIds],
  );

  const active = hover ?? selected;
  // 1-hop focus+context set for the active node.
  const lit = useMemo(() => {
    if (!active) return null;
    const nodes = new Set<string>([active]);
    const edges = new Set<string>();
    for (const e of visibleEdges) {
      if (e.source === active || e.target === active) {
        edges.add(e.id);
        nodes.add(e.source);
        nodes.add(e.target);
      }
    }
    return { nodes, edges };
  }, [active, visibleEdges]);

  const selectedNode = selected ? nodeById.get(selected) ?? null : null;
  const selectedLinks = useMemo(() => {
    if (!selected) return [];
    return visibleEdges
      .filter((e) => e.source === selected || e.target === selected)
      .map((e) => ({ edge: e, other: nodeById.get(e.source === selected ? e.target : e.source) }))
      .filter((l): l is { edge: GraphEdge; other: GraphNode } => !!l.other)
      .sort((a, b) => b.edge.strength - a.edge.strength);
  }, [selected, visibleEdges, nodeById]);

  // Auto-fit viewBox to the visible nodes (with padding), then apply zoom by
  // shrinking the box around its centre. Guarantees the whole graph fits — no
  // clipping on mobile — and stays deterministic.
  const view = useMemo(() => {
    if (visibleNodes.length === 0) return { x: 0, y: 0, w: 1000, h: 720 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of visibleNodes) {
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
    }
    const pad = 90;
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const w = Math.max(maxX - minX + pad * 2, 360) / zoom;
    const h = Math.max(maxY - minY + pad * 2, 280) / zoom;
    return { x: cx - w / 2, y: cy - h / 2, w, h };
  }, [visibleNodes, zoom]);

  const isEmpty = items.length === 0;
  const limited = !isEmpty && graph.stats.realEdgeCount === 0;
  const a11ySummary = `Entity graph: ${graph.stats.nodeCount} entities, ${graph.stats.realEdgeCount} corroborated connection${graph.stats.realEdgeCount === 1 ? "" : "s"}, ${graph.stats.clusterCount} cluster${graph.stats.clusterCount === 1 ? "" : "s"}${graph.stats.bridgeCount ? `, ${graph.stats.bridgeCount} cross-identity bridge${graph.stats.bridgeCount === 1 ? "" : "s"}` : ""}.`;

  const toggleGroup = (g: Group) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g); else next.add(g);
      return next;
    });

  const subtitle = isEmpty
    ? "Entity relationship map"
    : `${graph.stats.nodeCount} entities · ${graph.stats.realEdgeCount} connection${graph.stats.realEdgeCount === 1 ? "" : "s"}${graph.stats.clusterCount ? ` · ${graph.stats.clusterCount} cluster${graph.stats.clusterCount === 1 ? "" : "s"}` : ""}`;

  return (
    <div className="h-full flex flex-col min-h-0">
      <TabHeader icon={Share2} title="Graph" subtitle={subtitle}>
        {!isEmpty && (
          <div className="flex items-center gap-1">
            <ZoomBtn icon={ZoomOut} label="Zoom out" onClick={() => setZoom((z) => Math.max(0.6, +(z - 0.2).toFixed(2)))} />
            <span className="font-mono text-data tabular-nums text-muted-foreground w-10 text-center">{Math.round(zoom * 100)}%</span>
            <ZoomBtn icon={ZoomIn} label="Zoom in" onClick={() => setZoom((z) => Math.min(3, +(z + 0.2).toFixed(2)))} />
            <ZoomBtn icon={Maximize2} label="Fit" onClick={() => setZoom(1)} />
          </div>
        )}
      </TabHeader>

      {/* Safety / cluster warnings the pipeline already computed (e.g. possible
          minor, collision splits) — surfaced honestly above the canvas. */}
      {!isEmpty && graph.warnings.length > 0 && (
        <div className="shrink-0 mx-3 sm:mx-4 mt-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-data text-destructive flex items-start gap-2">
          <ShieldAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span className="leading-relaxed">{graph.warnings.join(" · ")}</span>
        </div>
      )}

      {/* Honest limited-state banner: nodes exist but nothing corroborates a
          link yet. Don't fake a web of connections. */}
      {limited && (
        <div className="shrink-0 mx-3 sm:mx-4 mt-2 rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-data text-muted-foreground flex items-start gap-2">
          <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span className="leading-relaxed">
            No corroborated connections yet. Each finding is shown on its own — edges appear when two entities share an
            email, phone, handle, address, or IP. Faint lines to the seed mark where a finding was discovered.
          </span>
        </div>
      )}

      {/* Category filter toggles (shape = category) */}
      {!isEmpty && (
        <div className="shrink-0 px-3 sm:px-4 py-2 flex items-center gap-2 flex-wrap">
          <span className="text-eyebrow uppercase tracking-[0.16em] text-muted-foreground/70 mr-1 hidden sm:inline">Categories</span>
          {presentGroups.map((g) => {
            const off = hidden.has(g);
            return (
              <button
                key={g}
                onClick={() => toggleGroup(g)}
                aria-pressed={!off}
                className={cn(
                  "inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-meta font-medium border transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  off
                    ? "border-transparent text-muted-foreground/50 line-through hover:text-muted-foreground"
                    : "border-white/10 bg-surface-1 text-foreground",
                )}
                title={off ? `Show ${GROUP_LABEL[g]}` : `Hide ${GROUP_LABEL[g]}`}
              >
                <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden className="shrink-0">
                  <NodeGlyph shape={GROUP_SHAPE[g]} x={6.5} y={6.5} r={4} fill="currentColor" stroke="transparent" strokeWidth={0} fillOpacity={off ? 0.4 : 0.85} />
                </svg>
                {GROUP_LABEL[g]}
                <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{groupCounts.get(g)}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="flex-1 min-h-0 relative">
        {isEmpty ? (
          <EmptyState
            icon={Share2}
            title="No entities to graph yet"
            hint="As the investigation discovers emails, usernames, domains and other identifiers, they'll appear here linked by shared evidence."
          />
        ) : (
          <>
            <svg
              viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
              className="absolute inset-0 w-full h-full bg-[radial-gradient(circle_at_50%_45%,hsl(var(--surface-1)/0.6),transparent_70%)]"
              role="img"
              aria-label={a11ySummary}
              preserveAspectRatio="xMidYMid meet"
            >
              {/* Edges first (under nodes). */}
              {visibleEdges.map((e) => {
                const a = nodeById.get(e.source)!;
                const b = nodeById.get(e.target)!;
                const isLit = !lit || lit.edges.has(e.id);
                const st = edgeStyle(e, !!lit && lit.edges.has(e.id));
                return (
                  <line
                    key={e.id}
                    x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                    stroke={st.stroke}
                    strokeWidth={st.width}
                    strokeOpacity={lit && !lit.edges.has(e.id) ? st.opacity * 0.25 : st.opacity}
                    strokeDasharray={st.dash}
                    strokeLinecap="round"
                  >
                    <title>{`${EDGE_TYPE_LABEL[e.type]}${e.bridge ? " (bridge)" : ""}: ${e.reason}`}</title>
                  </line>
                );
              })}

              {/* Nodes. */}
              {visibleNodes.map((n) => {
                if (n.isSeed) return null; // drawn last as a reticle
                const dim = !!lit && !lit.nodes.has(n.id);
                const isActive = active === n.id;
                const { fill, opacity } = nodeFill(n);
                const r = 6 + Math.min(6, n.degree);
                const showLabel = !dim && (isActive || (lit?.nodes.has(n.id) ?? false) || n.degree >= 3);
                return (
                  <g
                    key={n.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`${n.kind}: ${n.label}, confidence ${n.confidence}${n.conflict ? ", conflict" : ""}, ${n.degree} connection${n.degree === 1 ? "" : "s"}`}
                    onMouseEnter={() => setHover(n.id)}
                    onMouseLeave={() => setHover(null)}
                    onFocus={() => setHover(n.id)}
                    onBlur={() => setHover(null)}
                    onClick={() => setSelected(n.id)}
                    onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); setSelected(n.id); } }}
                    className="cursor-pointer focus:outline-none [&:focus-visible>*:first-child]:stroke-foreground"
                    style={{ opacity: dim ? 0.2 : 1, transition: "opacity 150ms" }}
                  >
                    <NodeGlyph
                      shape={GROUP_SHAPE[n.group]}
                      x={n.x} y={n.y}
                      r={isActive ? r + 2 : r}
                      fill={fill}
                      fillOpacity={opacity}
                      stroke={selected === n.id ? "hsl(var(--foreground))" : "hsl(var(--background))"}
                      strokeWidth={isActive ? 2.4 : 1.4}
                    />
                    {showLabel && (
                      <text
                        x={n.x} y={n.y - (r + 6)} textAnchor="middle"
                        className="font-mono pointer-events-none"
                        fontSize={isActive ? 12 : 10.5} fontWeight={isActive ? 600 : 400}
                        fill={isActive ? "hsl(var(--foreground))" : "hsl(var(--foreground)/0.7)"}
                      >
                        {shorten(n.label)}
                      </text>
                    )}
                  </g>
                );
              })}

              {/* Seed reticle on top. */}
              {visibleNodes.filter((n) => n.isSeed).map((n) => (
                <g key={n.id} style={{ opacity: lit && !lit.nodes.has(n.id) ? 0.3 : 1 }}>
                  <circle cx={n.x} cy={n.y} r={15} fill="hsl(var(--background))" stroke="hsl(var(--foreground))" strokeWidth={2} />
                  <circle cx={n.x} cy={n.y} r={6} fill="hsl(var(--foreground))" />
                  <text x={n.x} y={n.y + 30} textAnchor="middle" className="font-mono" fontSize={11.5} fill="hsl(var(--foreground))">
                    {shorten(n.label, 28)}
                  </text>
                  <text x={n.x} y={n.y + 44} textAnchor="middle" className="font-mono uppercase" fontSize={8.5} fill="hsl(var(--muted-foreground))" letterSpacing="0.12em">
                    {n.kind}
                  </text>
                </g>
              ))}
            </svg>

            {/* Node detail panel */}
            {selectedNode && (
              <div className="absolute top-3 right-3 w-[min(20rem,calc(100%-1.5rem))] max-h-[calc(100%-1.5rem)] overflow-y-auto rounded-xl border border-border bg-popover/95 backdrop-blur p-3 shadow-xl [scrollbar-width:thin]">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-eyebrow uppercase tracking-[0.14em] text-muted-foreground truncate">
                    {selectedNode.isSeed ? "Investigation seed" : `${selectedNode.kind} · ${GROUP_LABEL[selectedNode.group]}`}
                  </span>
                  <button onClick={() => setSelected(null)} aria-label="Close detail" className="shrink-0 text-muted-foreground hover:text-foreground">
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="mt-2 flex items-start gap-2">
                  <span className="font-mono text-meta text-foreground break-all flex-1">{selectedNode.label}</span>
                  <CopyButton value={selectedNode.label} label="Copy value" />
                </div>
                {!selectedNode.isSeed && (
                  <dl className="mt-3 space-y-2 text-data">
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-muted-foreground">Confidence</dt>
                      <dd><ConfidenceMeter value={selectedNode.confidence} width={72} /></dd>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-muted-foreground">Source</dt>
                      <dd className="font-mono text-foreground/90 truncate max-w-[60%]" title={selectedNode.art?.source ?? "—"}>
                        {selectedNode.art?.source ?? "—"}
                      </dd>
                    </div>
                    {selectedNode.conflict && (
                      <div className="flex items-center gap-1.5 text-destructive">
                        <ShieldAlert className="w-3.5 h-3.5" /> Conflict / collision — excluded from identity links
                      </div>
                    )}
                  </dl>
                )}

                <div className="mt-3 border-t border-border-subtle pt-2">
                  <div className="text-eyebrow uppercase tracking-[0.14em] text-muted-foreground mb-1.5">
                    Linked to ({selectedLinks.length})
                  </div>
                  {selectedLinks.length === 0 ? (
                    <p className="text-data text-muted-foreground/80 leading-relaxed">No connections — this entity stands alone in the current evidence.</p>
                  ) : (
                    <ul className="space-y-1">
                      {selectedLinks.map(({ edge, other }) => (
                        <li key={edge.id}>
                          <button
                            onClick={() => setSelected(other.id)}
                            className="w-full text-left rounded-md px-2 py-1.5 hover:bg-surface-2/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors"
                          >
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span className="font-mono text-data text-foreground truncate flex-1">{shorten(other.isSeed ? "seed" : other.label, 26)}</span>
                              {edge.bridge && <span className="text-[9px] font-mono uppercase tracking-wider text-[hsl(var(--info))] shrink-0">bridge</span>}
                            </div>
                            <div className="text-[10px] text-muted-foreground/80 leading-snug">{edge.reason}</div>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Legend */}
      {!isEmpty && (
        <div className="shrink-0 border-t border-border-subtle px-4 py-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-data text-muted-foreground">
          <span className="inline-flex items-center gap-1.5"><Dot fill="hsl(var(--confidence-high))" /> High</span>
          <span className="inline-flex items-center gap-1.5"><Dot fill="hsl(var(--confidence-mid))" /> Mid</span>
          <span className="inline-flex items-center gap-1.5"><Dot fill="hsl(var(--muted-foreground))" /> Low</span>
          <span className="inline-flex items-center gap-1.5"><Dot fill="hsl(var(--danger))" /> Conflict</span>
          <span className="text-muted-foreground/40">|</span>
          <span className="inline-flex items-center gap-1.5"><LineSwatch /> Identity link</span>
          <span className="inline-flex items-center gap-1.5"><LineSwatch dash color="hsl(var(--confidence-mid))" /> Shared infra</span>
          <span className="inline-flex items-center gap-1.5"><LineSwatch color="hsl(var(--info))" /> Bridge</span>
          <span className="ml-auto text-muted-foreground/60">shape = category · color = confidence · brightness = link strength, not proof</span>
        </div>
      )}
    </div>
  );
}

function Dot({ fill }: { fill: string }) {
  return <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: fill }} aria-hidden />;
}

function LineSwatch({ dash, color = "hsl(var(--foreground))" }: { dash?: boolean; color?: string }) {
  return (
    <svg width="18" height="6" viewBox="0 0 18 6" aria-hidden className="shrink-0">
      <line x1="0" y1="3" x2="18" y2="3" stroke={color} strokeWidth="2" strokeDasharray={dash ? "3 2" : undefined} strokeLinecap="round" />
    </svg>
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
