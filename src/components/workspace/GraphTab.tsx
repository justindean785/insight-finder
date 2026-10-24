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
import { GROUP_LABEL, type Group, type ReviewAdjustment } from "@/lib/intel";
import { useReviewStates, type ReviewState } from "@/lib/review";
import {
  buildEntityGraph,
  type EdgeType,
  type EntityGraph,
  type GraphNode as EntityNodeModel,
  isIsolatedLead,
  linkedNodeIds,
} from "@/lib/entity-graph";
import { ConfidenceMeter } from "@/components/investigation/primitives";
import { CopyButton } from "@/components/ui/workspace-primitives";
import { AuthorityLegend, AuthorityChip } from "@/components/ui/authority";
import { authorityFor } from "@/lib/authority";
import { SubTabs } from "@/components/ui/compact-controls";
import { timeAgo } from "@/lib/time";
import { EmptyState } from "@/components/panel/EmptyState";
import { Activity, AlertTriangle, List, Share2, Sparkles, Waypoints, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { captureError } from "@/lib/telemetry";

// The graph's OWN taxonomy palette — the one documented exception to "hue
// belongs to authority" (see the --kind-* block in index.css).
//
// These used to borrow confidence tokens: infrastructure was --confidence-mid
// and web was --confidence-high. That coupling was invisible until confidence
// was neutralised, at which point two entire node groups and the shared-infra
// edge class would have collapsed into the grey `other` bucket — on the one
// tab where hue IS the only thing separating a breach row from a DNS record.
// Kind and confidence are different questions; they now use different tokens.
const GROUP_COLOR: Record<Group, string> = {
  identity: "hsl(var(--kind-identity))",
  contact: "hsl(var(--kind-contact))",
  social: "hsl(var(--kind-social))",
  infrastructure: "hsl(var(--kind-infrastructure))",
  breach: "hsl(var(--kind-breach))",
  web: "hsl(var(--kind-web))",
  crypto: "hsl(var(--kind-crypto))",
  affiliation: "hsl(var(--kind-identity))",
  records: "hsl(var(--kind-web))",
  other: "hsl(var(--kind-other))",
};

// How each edge class is drawn. The WHY ("reason") rides in edge.data and is
// surfaced in the detail panel + as a native title tooltip — never invented:
// every edge comes from buildEntityGraph's shared-selector analysis.
const EDGE_STYLE: Record<EdgeType, { stroke: string; dashed: boolean; baseOpacity: number }> = {
  identity: { stroke: "hsl(var(--kind-identity))", dashed: false, baseOpacity: 0.55 },
  "co-record": { stroke: "hsl(var(--kind-identity))", dashed: true, baseOpacity: 0.45 },
  "shared-infra": { stroke: "hsl(var(--kind-infrastructure))", dashed: true, baseOpacity: 0.4 },
  "seed-discovery": { stroke: "hsl(var(--foreground))", dashed: false, baseOpacity: 0.14 },
};
const EDGE_LABEL: Record<EdgeType, string> = {
  identity: "Identity link",
  "co-record": "Named in the same record",
  "shared-infra": "Shared infrastructure",
  "seed-discovery": "Discovered in run (provenance only)",
};
/** What each line CLAIMS — the distinction between a finding and a coincidence. */
const EDGE_HINT: Record<EdgeType, string> = {
  identity: "These entities share a selector that ties them to the same identity.",
  "co-record": "One record names both of these selectors (e.g. a breach row's associated email). That groups them; it is NOT independent confirmation that either belongs to the subject.",
  "shared-infra": "These entities sit on shared infrastructure. That is co-location, NOT common ownership or identity.",
  "seed-discovery": "This entity was surfaced during the run from the seed. Provenance, not a relationship claim.",
};

function shorten(s: string, n = 22): string {
  return s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s;
}

/**
 * Split labels on the suffix they SHARE with their neighbours.
 *
 * A case rooted on one company produces a wall of hostnames — docs·, git·,
 * cdn·, api·, mail·, ns1·, smtp·, vpn·, staging· — that are identical for
 * everything after the first dot. Rendered whole in a fixed-width chip they all
 * truncate to "…northgate-logist…", so the ONLY distinguishing characters are
 * the ones the ellipsis eats, and 16 nodes become visually indistinguishable.
 *
 * So: any suffix shared by 3+ labels is demoted to a dimmed tail. Nothing is
 * hidden — the head carries the distinction, the tail stays legible, and the
 * full value is still on the node's title and in the detail panel.
 */
function splitSharedSuffixes(labels: string[]): Map<string, { head: string; tail: string }> {
  const counts = new Map<string, number>();
  for (const l of labels) {
    const dot = l.indexOf(".");
    // Only host-like labels; an email's "@" tail is already its own signal.
    if (dot <= 0 || l.includes("@")) continue;
    const suffix = l.slice(dot);
    counts.set(suffix, (counts.get(suffix) ?? 0) + 1);
  }
  const out = new Map<string, { head: string; tail: string }>();
  for (const l of labels) {
    const dot = l.indexOf(".");
    if (dot <= 0 || l.includes("@")) { out.set(l, { head: l, tail: "" }); continue; }
    const suffix = l.slice(dot);
    out.set(l, (counts.get(suffix) ?? 0) >= 3
      ? { head: l.slice(0, dot), tail: suffix }
      : { head: l, tail: "" });
  }
  return out;
}

type EntityNodeData = {
  label: string;
  head: string;
  tail: string;
  group: Group;
  kind: string;
  value: string;
  confidence: number;
  isSeed: boolean;
  conflict: boolean;
  degree: number;
};

/** A single graph node — group-colored chip; seed is the hub, marked by a
 *  raised neutral plate with an indigo edge (indigo is a mark, never a fill);
 *  a breach/conflict node carries the restrained destructive accent. */
const EntityNode = memo(function EntityNode({ data, selected }: NodeProps<EntityNodeData>) {
  const color = data.conflict ? "hsl(var(--danger))" : GROUP_COLOR[data.group];
  if (data.isSeed) {
    return (
      <div
        className={cn(
          // Capped width: a seed can be a whole pasted instruction plus a URL,
          // which at fit-view zoom became a band across the entire canvas. It
          // wraps (never truncates — it is the selector) inside 20rem.
          "flex max-w-[20rem] flex-col items-center gap-0.5 rounded-xl border-2 px-3.5 py-2 text-center shadow-[0_12px_28px_-16px_hsl(0_0%_0%/1)]",
          "border-[hsl(var(--info))] bg-surface-3 text-foreground",
          selected && "ring-2 ring-foreground ring-offset-2 ring-offset-background",
        )}
      >
        <Handle type="target" position={Position.Top} className="!h-1 !w-1 !border-0 !bg-transparent !opacity-0" isConnectable={false} />
        <span className="font-mono text-micro font-bold leading-snug [overflow-wrap:anywhere]">{data.label}</span>
        <span className="font-mono text-micro uppercase tracking-[0.16em] opacity-70">{data.kind} · seed</span>
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
      {/* Hard width cap. Without it a single archive URL renders a ~700px chip,
          which no layout spacing can plan around — one long node shoved four
          neighbours underneath itself.
          The head NEVER truncates when a tail exists: the head is the whole
          reason this split happens (docs· vs git· vs cdn·), so letting flexbox
          shrink both proportionally just reproduces the original bug pointed the
          other way — "do…northgate-logistics.com". The shared tail absorbs all
          of it; the full value stays on the title and in the detail panel. */}
      <span className="flex min-w-0 max-w-[230px] items-baseline font-mono text-data">
        {data.tail ? (
          <>
            <span className="shrink-0 font-medium text-foreground">{data.head}</span>
            <span className="min-w-0 truncate text-muted-foreground/55">{data.tail}</span>
          </>
        ) : (
          <span className="max-w-[190px] truncate font-medium text-foreground">{data.head}</span>
        )}
      </span>
      {data.confidence > 0 && (
        <span className="font-mono text-micro tabular-nums text-muted-foreground/90">{data.confidence}</span>
      )}
      <Handle type="source" position={Position.Bottom} className="!h-1 !w-1 !border-0 !bg-transparent !opacity-0" isConnectable={false} />
    </div>
  );
});

const nodeTypes = { entity: EntityNode };

function toRfNodes(graph: EntityGraph, hidden: Set<Group>, showIsolated = true): Node<EntityNodeData>[] {
  const linked = linkedNodeIds(graph);
  const visible = graph.nodes.filter((n) => (n.isSeed || !hidden.has(n.group)) && (showIsolated || n.isSeed || n.seedRecord || linked.has(n.id)));
  const parts = splitSharedSuffixes(visible.map((n) => n.label));
  return visible
    .map((n) => ({
      id: n.id,
      type: "entity",
      position: { x: n.x, y: n.y },
      data: {
        label: n.label,
        head: parts.get(n.label)?.head ?? n.label,
        tail: parts.get(n.label)?.tail ?? "",
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
      // Nodes are focusable buttons; without a name a screen reader says only "button".
      ariaLabel: `${n.label}, ${n.kind}${n.isSeed ? ", seed" : ""}`,
    }));
}

function toRfEdges(graph: EntityGraph, hidden: Set<Group>, selected: string | null, showDiscovery: boolean, showIsolated = true): Edge[] {
  const linked = linkedNodeIds(graph);
  const visible = new Set(
    graph.nodes
      .filter((n) => (n.isSeed || !hidden.has(n.group)) && (showIsolated || n.isSeed || n.seedRecord || linked.has(n.id)))
      .map((n) => n.id),
  );
  return graph.edges
    .filter((e) => visible.has(e.source) && visible.has(e.target))
    // "seed-discovery" is PROVENANCE, not a relationship claim (see EDGE_HINT):
    // every node was discovered in the run, so drawing all of them says nothing
    // and costs everything — 28 straight spokes converging on the seed rendered
    // this graph as a starburst in which the ONE real identity link was
    // invisible. Off by default; the toggle restores them, and selecting a node
    // still reveals its own discovery edge below.
    .filter((e) => showDiscovery || e.type !== "seed-discovery" || e.source === selected || e.target === selected)
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
  const [showDiscovery, setShowDiscovery] = useState(false);
  // Proven links first. Entities tied to nothing but "found in this run" are an
  // optional layer, not the default picture: 44 entities with ONE real link
  // drew as a field of equal-weight chips that implied relationships nobody
  // had shown.
  const [showIsolated, setShowIsolated] = useState(false);
  // A readable list is the default on a phone; the canvas scaled to 390px was
  // not inspectable. Desktop defaults to the canvas.
  const [mode, setMode] = useState<"graph" | "list">(() =>
    typeof window !== "undefined" && window.innerWidth < 768 ? "list" : "graph",
  );

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
  // Analyst verdicts, loaded the same way ClustersTab does. Without them the
  // graph re-clustered and re-linked rows the analyst had dismissed, so the
  // link picture still asserted connections they had explicitly struck out.
  const review = useReviewStates(threadId);
  const reviews = useMemo(() => {
    const m: Record<string, ReviewAdjustment> = {};
    for (const a of items) {
      const r = review.get(a.id);
      if (r !== "new") m[a.id] = r;
    }
    return m;
  }, [items, review]);

  const graph = useMemo<EntityGraph>(
    () => buildEntityGraph(items, seed?.value ?? null, seed?.type ?? null, reviews),
    [items, seed, reviews],
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
  // A browser side panel (~758px) is a PRIMARY viewport for this product, not a
  // shrunken desktop: it is where an analyst keeps the case while reading a
  // source in the other pane. Track it so fit/zoom can be tuned for it rather
  // than inheriting desktop padding that leaves the graph a speck in the middle.
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.innerWidth < 900);
  const narrowRef = useRef(narrow);
  useEffect(() => { narrowRef.current = narrow; }, [narrow]);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 900);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const fittedThread = useRef<string | null>(null);
  const onRfInit = useCallback(
    (inst: ReactFlowInstance) => {
      rfRef.current = inst;
      requestAnimationFrame(() => {
        if (rfNodes.length > 0) {
          fittedThread.current = threadId;
          inst.fitView({ padding: narrowRef.current ? 0.05 : 0.1, maxZoom: 1.45 });
        }
      });
    },
    [rfNodes.length, threadId],
  );

  // Node positions resync on graph/hidden only — so selecting a node (which only
  // restyles edges) never resets a manual drag arrangement.
  //
  // Carry React Flow's measured width/height across every rebuild. A node is only
  // painted once `initialized = !!node.width && !!node.height` (the ResizeObserver
  // writes those). Handing setNodes a freshly-built, dimensionless array on a
  // later update (the async seed fetch lands a second rebuild right after the
  // first measurement, and artifact streams land more) wipes those dimensions;
  // because the DOM element's size is unchanged the observer never re-fires, so
  // every node gets stranded at `visibility:hidden` and the canvas goes blank.
  useEffect(() => {
    setRfNodes((prev) => {
      const measured = new Map(prev.map((p) => [p.id, { width: p.width, height: p.height }]));
      return toRfNodes(graph, hidden, showIsolated).map((n) => {
        const m = measured.get(n.id);
        return m?.width != null && m?.height != null ? { ...n, width: m.width, height: m.height } : n;
      });
    });
  }, [graph, hidden, showIsolated, setRfNodes]);
  useEffect(() => { setRfEdges(toRfEdges(graph, hidden, selected, showDiscovery, showIsolated)); }, [graph, hidden, selected, showDiscovery, showIsolated, setRfEdges]);
  // Selection is this component's own state (onNodeClick), so mirror it onto
  // the nodes: EntityNode draws its selected ring from React Flow's `selected`
  // flag, which nothing else sets. Re-applied after every node rebuild above.
  useEffect(() => {
    setRfNodes((prev) => prev.map((n) => (Boolean(n.selected) === (n.id === selected) ? n : { ...n, selected: n.id === selected })));
  }, [selected, graph, hidden, showIsolated, setRfNodes]);

  // Fit once the (async) nodes for a case are present; re-fits when the case
  // changes. Group-filter toggles keep the same threadId so they don't re-fit.
  useEffect(() => {
    if (!rfRef.current || rfNodes.length === 0) return;
    if (fittedThread.current === threadId) return;
    fittedThread.current = threadId;
    const raf = requestAnimationFrame(() => rfRef.current?.fitView({ padding: narrowRef.current ? 0.05 : 0.1, maxZoom: 1.45, duration: 250 }));
    return () => cancelAnimationFrame(raf);
  }, [rfNodes, threadId]);

  const toggleGroup = (g: Group) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g); else next.add(g);
      return next;
    });

  const selectedNode = selected ? nodeById.get(selected) ?? null : null;
  const selectedAuthority = selectedNode?.art ? authorityFor(selectedNode.art, review.get(selectedNode.art.id)) : null;
  const linkedIds = useMemo(() => linkedNodeIds(graph), [graph]);
  const isolatedCount = useMemo(
    () => graph.nodes.filter((n) => isIsolatedLead(n, linkedIds)).length,
    [graph, linkedIds],
  );
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
    <div className="h-full flex flex-col min-h-0 bg-surface-0">
      {/* One toolbar: view mode, layers, category filters — then the run's
          warnings, in full. */}
      <div className="shrink-0 border-b border-white/[0.08] px-2.5 py-2 sm:px-4">
        <div className="flex flex-wrap items-center gap-2">
          <SubTabs<"graph" | "list">
            label="Graph view"
            options={[{ key: "graph", label: "Graph", icon: Waypoints }, { key: "list", label: "List", icon: List }]}
            active={mode}
            onChange={setMode}
          />
          <span aria-hidden className="hidden h-5 w-px bg-white/[0.08] sm:block" />
          {isolatedCount > 0 && (
            <button
              type="button"
              onClick={() => setShowIsolated((v) => !v)}
              aria-pressed={showIsolated}
              title="Entities found in this run that share no selector with anything else. Found together is not related."
              className={cn(
                "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-data font-medium transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:h-11",
                showIsolated ? "bg-surface-3 text-foreground shadow-e1" : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
              )}
            >
              Isolated leads <span className="font-mono tabular-nums text-muted-foreground">{isolatedCount}</span>
            </button>
          )}
          {graph.stats.nodeCount > 1 && mode === "graph" && (
            <button
              type="button"
              onClick={() => setShowDiscovery((v) => !v)}
              aria-pressed={showDiscovery}
              title="Draw every 'discovered in run' line. Provenance only — not a relationship."
              className={cn(
                "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-data font-medium transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:h-11",
                showDiscovery ? "bg-surface-3 text-foreground shadow-e1" : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
              )}
            >
              Discovery lines
            </button>
          )}
          <div className="ml-auto flex items-center gap-1">
            <AuthorityLegend />
          </div>
        </div>
        {/* One scrollable row on a phone (the right edge fades to say "more"),
            wrapping rows from `sm` up. Five wrapped rows of chips at 390px
            pushed the relationship list off the screen. */}
        <div
          className="mt-2 flex items-center gap-1.5 overflow-x-auto pb-0.5 [mask-image:linear-gradient(90deg,#000_calc(100%-24px),transparent)] [scrollbar-width:none] sm:flex-wrap sm:overflow-visible sm:[mask-image:none] [&::-webkit-scrollbar]:hidden"
          role="group"
          aria-label="Entity categories"
        >
          {presentGroups.map((g) => {
            const off = hidden.has(g);
            return (
              <button
                key={g}
                type="button"
                onClick={() => toggleGroup(g)}
                aria-pressed={!off}
                className={cn(
                  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-data font-medium transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:h-10",
                  off
                    ? "border-transparent text-muted-foreground/55 line-through hover:text-muted-foreground"
                    : "border-white/10 bg-surface-1/80 text-foreground",
                )}
                title={off ? `Show ${GROUP_LABEL[g]}` : `Hide ${GROUP_LABEL[g]}`}
              >
                <span className="h-2 w-2 rounded-[2px]" style={{ backgroundColor: GROUP_COLOR[g], opacity: off ? 0.4 : 1 }} />
                {GROUP_LABEL[g]}
                <span className="font-mono tabular-nums text-muted-foreground">{groupCounts.get(g)}</span>
              </button>
            );
          })}
        </div>
        {graph.warnings.length > 0 && (
          <ul className="mt-2 space-y-1">
            {graph.warnings.map((w) => (
              <li key={w} className="flex items-start gap-1.5 text-[13px] leading-snug text-[hsl(var(--warning))]">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="min-w-0">{w}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {mode === "list" && (
        <GraphList
          graph={graph}
          hidden={hidden}
          showIsolated={showIsolated}
          linkedIds={linkedIds}
          review={review.get}
        />
      )}

      <div
        className={cn("relative flex-1 min-h-0", mode === "list" && "hidden")}
        // Keyboard parity with a click: Enter/Space on a focused node opens its
        // detail, Escape closes it. React Flow focuses nodes but does not route
        // the key to onNodeClick, so selection never happened from the keyboard.
        onKeyDown={(e) => {
          const node = (e.target as HTMLElement).closest<HTMLElement>(".react-flow__node");
          if (!node) return;
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(node.dataset.id ?? null); }
          else if (e.key === "Escape") setSelected(null);
        }}
      >
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          onInit={onRfInit}
          onNodesChange={onNodesChange}
          nodeTypes={nodeTypes}
          onNodeClick={(_, n) => setSelected(n.id)}
          onPaneClick={() => setSelected(null)}
          fitView
          fitViewOptions={{ padding: narrow ? 0.05 : 0.1, maxZoom: 1.45 }}
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
            // Hidden under 900px: in a browser side panel (~758px) it covered
            // real nodes and bought nothing a pan gesture does not.
            pannable
            zoomable
            className="!hidden min-[900px]:!block !rounded-lg !border !border-white/10 !bg-surface-0/90"
            maskColor="hsl(var(--background) / 0.6)"
            nodeColor={(n) => {
              const d = n.data as EntityNodeData;
              return d?.isSeed ? "hsl(var(--info))" : d?.conflict ? "hsl(var(--danger))" : GROUP_COLOR[d?.group ?? "other"];
            }}
          />
        </ReactFlow>

        {graph.stats.realEdgeCount === 0 && (
          <div className="pointer-events-none absolute inset-0 z-[5] grid place-items-center p-4">
            <div className="max-w-md rounded-xl border border-white/10 bg-[linear-gradient(160deg,hsl(var(--film)/0.1),hsl(var(--film)/0.025)_55%)] px-4 py-3 text-center shadow-[0_20px_60px_-36px_rgba(0,0,0,0.95)] backdrop-blur-xl">
              <div className="inline-flex items-center gap-1.5 text-micro font-semibold tracking-normal text-[hsl(var(--warning))]">
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
          <div className="absolute top-3 right-3 z-10 w-[min(22rem,calc(100%-1.5rem))] rounded-2xl border border-white/12 bg-[linear-gradient(160deg,hsl(var(--film)/0.09),hsl(var(--film)/0.03)_48%,hsl(var(--film)/0.015))] p-3 shadow-[0_30px_100px_-42px_rgba(0,0,0,0.96)] backdrop-blur-xl">
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
                {selectedAuthority && (
                  <DetailRow label="Authority"><AuthorityChip view={selectedAuthority} /></DetailRow>
                )}
                <DetailRow label="Confidence"><ConfidenceMeter value={selectedNode.confidence} width={82} /></DetailRow>
                {selectedNode.art?.source && <DetailRow label="Source"><span className="font-mono text-foreground/90">{selectedNode.art.source}</span></DetailRow>}
                {selectedNode.art?.created_at && <DetailRow label="Captured"><span className="text-foreground/90">{timeAgo(selectedNode.art.created_at)}</span></DetailRow>}
                {selectedAuthority && (
                  <DetailRow label="May link identity">
                    <span className={selectedAuthority.inert ? "text-[hsl(var(--warning))]" : "text-foreground/90"}>
                      {selectedAuthority.inert ? "No — withheld" : "Yes"}
                    </span>
                  </DetailRow>
                )}
              </dl>
            )}
            {/* Typed relationships — the auditable WHY behind every line, and an
                explicit statement when a line is provenance, not a relationship. */}
            <div className="mt-3">
              <div className="text-micro font-semibold tracking-normal text-muted-foreground/80">Relationships</div>
              {connections.filter((c) => c.type !== "seed-discovery").length === 0 ? (
                <p className="mt-1 text-data text-muted-foreground">
                  None proven. {connections.some((c) => c.type === "seed-discovery") ? "It was found during this run, which is provenance, not a relationship." : ""}
                </p>
              ) : (
                <ul className="mt-1.5 space-y-1.5">
                  {connections.filter((c) => c.type !== "seed-discovery").slice(0, 8).map((c) => (
                    <li key={c.id} className="rounded-lg border border-white/8 bg-white/[0.03] p-2">
                      <div className="flex items-center gap-1.5">
                        {c.bridge && <Sparkles className="h-3 w-3 shrink-0 text-[hsl(var(--warning))]" aria-hidden />}
                        <span className="truncate font-mono text-data text-foreground/90">{shorten(c.otherLabel, 28)}</span>
                      </div>
                      <div className="mt-0.5 text-micro leading-snug text-muted-foreground">
                        <span className="text-foreground/75">{EDGE_LABEL[c.type]}{c.bridge ? " · bridge" : ""}</span> — {c.reason}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>

      {/* EDGE legend + honest stats.
          The node-colour swatches that used to sit here were a READ-ONLY copy of
          the filter chips at the top of this same panel — same eight labels,
          same eight colours, two rows apart, one of them clickable and one not.
          Deleted: the chips already say it, and they do something.
          The edge legend stays, because nothing else explains what the LINES
          claim — a solid line asserting shared identity and a dashed one meaning
          "these merely sit on the same host" is the difference between a finding
          and a coincidence. */}
      <div className="shrink-0 border-t border-white/[0.08] px-4 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {mode === "graph" && (Object.keys(EDGE_STYLE) as EdgeType[]).map((t) => (
          <span key={t} className="inline-flex items-center gap-1.5 text-data text-muted-foreground" title={EDGE_HINT[t]}>
            <svg width="18" height="6" viewBox="0 0 18 6" aria-hidden className="shrink-0">
              <line
                x1="0" y1="3" x2="18" y2="3"
                stroke={EDGE_STYLE[t].stroke}
                strokeWidth="1.75"
                strokeDasharray={EDGE_STYLE[t].dashed ? "3 2.5" : undefined}
                opacity={Math.max(EDGE_STYLE[t].baseOpacity, 0.55)}
              />
            </svg>
            {EDGE_LABEL[t]}
          </span>
        ))}
        <div className="ml-auto flex items-center gap-3">
          <span className="inline-flex items-center gap-2 text-data text-muted-foreground/70">
            <Activity className="h-3.5 w-3.5" />
            {graph.stats.nodeCount - graph.stats.seedRecordCount} entit{graph.stats.nodeCount - graph.stats.seedRecordCount === 1 ? "y" : "ies"}{graph.stats.seedRecordCount > 0 && <> + {graph.stats.seedRecordCount} seed record{graph.stats.seedRecordCount > 1 ? "s" : ""}</>} · {graph.stats.realEdgeCount} real link{graph.stats.realEdgeCount === 1 ? "" : "s"} · {graph.stats.clusterCount} cluster{graph.stats.clusterCount === 1 ? "" : "s"}
            {graph.stats.bridgeCount > 0 && <> · {graph.stats.bridgeCount} bridge{graph.stats.bridgeCount > 1 ? "s" : ""}</>}
          </span>
        </div>
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

/**
 * The relationship LIST — the default on a phone, and a readable alternative
 * to the canvas anywhere. Linked entities come first with every typed
 * relationship spelled out; entities tied to nothing but the run sit in their
 * own section, labelled as what they are: found together, not related.
 */
function GraphList({
  graph,
  hidden,
  showIsolated,
  linkedIds,
  review,
}: {
  graph: EntityGraph;
  hidden: Set<Group>;
  showIsolated: boolean;
  linkedIds: Set<string>;
  review: (id: string) => ReviewState;
}) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const visible = graph.nodes.filter((n) => !n.isSeed && !hidden.has(n.group));
  const linked = visible.filter((n) => linkedIds.has(n.id));
  const isolated = visible.filter((n) => isIsolatedLead(n, linkedIds));
  const seedRecords = visible.filter((n) => n.seedRecord);

  const row = (n: EntityNodeModel) => {
    const view = n.art ? authorityFor(n.art, review(n.art.id)) : null;
    const rels = graph.edges.filter((e) => e.type !== "seed-discovery" && (e.source === n.id || e.target === n.id));
    return (
      <li key={n.id} className="px-4 py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ backgroundColor: n.conflict ? "hsl(var(--danger))" : GROUP_COLOR[n.group] }} aria-hidden />
          <span className="min-w-0 break-all font-mono text-[13px] text-foreground">{n.art?.value ?? n.label}</span>
          <span className="text-micro text-muted-foreground">{n.kind}</span>
          {view && <AuthorityChip view={view} className="ml-auto" />}
        </div>
        {rels.length > 0 ? (
          <ul className="mt-1.5 space-y-1 pl-4">
            {rels.map((e) => {
              const other = byId.get(e.source === n.id ? e.target : e.source);
              return (
                <li key={e.id} className="text-[13px] leading-snug text-muted-foreground">
                  <span className="text-foreground/80">{EDGE_LABEL[e.type]}</span>
                  {" "}with <span className="font-mono text-foreground/85">{other?.art?.value ?? other?.label ?? "the seed"}</span> — {e.reason}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-1 pl-4 text-[13px] text-muted-foreground">Found in this run. No relationship shown.</p>
        )}
      </li>
    );
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <section aria-labelledby="graph-list-linked">
        <h3 id="graph-list-linked" className="sticky top-0 z-[1] border-b border-white/[0.06] bg-surface-0 px-4 py-2 text-data font-medium text-muted-foreground">
          Linked entities <span className="font-mono tabular-nums">{linked.length}</span>
        </h3>
        {linked.length === 0 ? (
          <p className="px-4 py-3 text-[13px] text-muted-foreground">No relationships between distinct entities established. A record that only repeats the seed is the seed itself, not a link; corroborating pivots form links.</p>
        ) : (
          <ul className="divide-y divide-white/[0.06]">{linked.map(row)}</ul>
        )}
      </section>
      {seedRecords.length > 0 && (
        <section aria-labelledby="graph-list-seed-record" className="border-t border-white/[0.06]">
          <h3 id="graph-list-seed-record" className="px-4 py-2 text-data font-medium text-muted-foreground">
            Seed record <span className="font-mono tabular-nums">{seedRecords.length}</span>
            <span className="ml-2 font-normal">— repeats the seed itself; not a relationship</span>
          </h3>
          <ul className="divide-y divide-white/[0.06]">{seedRecords.map(row)}</ul>
        </section>
      )}
      {isolated.length > 0 && (
        <section aria-labelledby="graph-list-isolated" className="border-t border-white/[0.06]">
          <h3 id="graph-list-isolated" className="px-4 py-2 text-data font-medium text-muted-foreground">
            Isolated leads <span className="font-mono tabular-nums">{isolated.length}</span>
            <span className="ml-2 font-normal">— found together in this run, not related</span>
          </h3>
          {showIsolated ? (
            <ul className="divide-y divide-white/[0.06]">{isolated.map(row)}</ul>
          ) : (
            <p className="px-4 pb-3 text-[13px] text-muted-foreground">Hidden. Turn on “Isolated leads” above to list them.</p>
          )}
        </section>
      )}
    </div>
  );
}
