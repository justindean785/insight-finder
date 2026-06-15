import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useThreadArtifacts, type Artifact } from "@/hooks/useThreadArtifacts";
import { groupForKind, GROUP_LABEL, GROUP_ORDER, type Group } from "@/lib/intel";
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

interface Node { id: string; label: string; sub: string; group: Group; x: number; y: number; r: number; }
interface Edge { x1: number; y1: number; x2: number; y2: number; group: Group; }

const W = 1000, H = 720, CX = W / 2, CY = H / 2;

function shorten(s: string, n = 22): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/**
 * Entity relationship graph — a radial map of how the seed connects to every
 * discovered entity (emails, usernames, names, phones, IPs, domains, social
 * profiles, breach sources). Deterministic hub-and-spoke layout: the seed sits
 * at the centre, each evidence category fans into its own sector. A first-pass
 * visualization; it reserves the full workspace for relationship analysis.
 */
export function GraphTab({ threadId }: { threadId: string }) {
  const { items } = useThreadArtifacts(threadId);
  const [seed, setSeed] = useState<{ value: string | null; type: string | null } | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    supabase.from("threads").select("seed_value,seed_type").eq("id", threadId).maybeSingle()
      .then(({ data }) => { if (alive) setSeed(data ? { value: data.seed_value, type: data.seed_type } : null); });
    return () => { alive = false; };
  }, [threadId]);

  const { nodes, edges, presentGroups } = useMemo(() => {
    const byGroup = new Map<Group, Artifact[]>();
    for (const a of items) {
      const g = groupForKind(a.kind);
      (byGroup.get(g) ?? byGroup.set(g, []).get(g)!).push(a);
    }
    const groups = GROUP_ORDER.filter((g) => (byGroup.get(g)?.length ?? 0) > 0);
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const sectorCount = Math.max(groups.length, 1);
    groups.forEach((g, gi) => {
      const list = byGroup.get(g)!;
      // Sector centre angle for this group, then spread members across the sector.
      const base = (gi / sectorCount) * Math.PI * 2 - Math.PI / 2;
      const spread = (Math.PI * 2) / sectorCount;
      list.forEach((a, i) => {
        const ring = 200 + (i % 3) * 78;                 // 3 concentric rings per sector
        const frac = list.length > 1 ? (i / (list.length - 1) - 0.5) : 0;
        const angle = base + frac * spread * 0.72;
        const x = CX + Math.cos(angle) * ring;
        const y = CY + Math.sin(angle) * ring;
        nodes.push({
          id: a.id,
          label: shorten(a.value),
          sub: a.kind,
          group: g,
          x, y,
          r: 5 + Math.min(4, Math.round((a.confidence ?? 0) / 25)),
        });
        edges.push({ x1: CX, y1: CY, x2: x, y2: y, group: g });
      });
    });
    return { nodes, edges, presentGroups: groups };
  }, [items]);

  if (items.length === 0) {
    return (
      <div className="p-6 text-data text-muted-foreground max-w-md">
        No entities to graph yet. As the investigation discovers emails, usernames, domains and other
        identifiers, they'll appear here linked back to the seed.
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex-1 min-h-0 overflow-auto grid place-items-center bg-[radial-gradient(circle_at_50%_45%,hsl(var(--surface-1)/0.6),transparent_70%)]">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-full max-w-[1100px]" role="img" aria-label="Entity relationship graph">
          {edges.map((e, i) => (
            <line key={i} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2}
              stroke={GROUP_COLOR[e.group]} strokeOpacity={0.18} strokeWidth={1} />
          ))}
          {nodes.map((n) => {
            const active = hover === n.id;
            return (
              <g key={n.id} onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)} className="cursor-default">
                <circle cx={n.x} cy={n.y} r={active ? n.r + 2 : n.r}
                  fill={GROUP_COLOR[n.group]} fillOpacity={active ? 1 : 0.85}
                  stroke="hsl(var(--background))" strokeWidth={1.5} />
                <text x={n.x} y={n.y - (n.r + 6)} textAnchor="middle"
                  className="font-mono pointer-events-none"
                  fontSize={11} fill={active ? "hsl(var(--foreground))" : "hsl(var(--muted-foreground))"}>
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
        </svg>
      </div>
      <div className="shrink-0 border-t border-border-subtle px-4 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {presentGroups.map((g) => (
          <span key={g} className="inline-flex items-center gap-1.5 text-data text-muted-foreground">
            <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: GROUP_COLOR[g] }} />
            {GROUP_LABEL[g]}
          </span>
        ))}
        <span className={cn("ml-auto text-data text-muted-foreground/70")}>
          {nodes.length} entities linked to seed
        </span>
      </div>
    </div>
  );
}
