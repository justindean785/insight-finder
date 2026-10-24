import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Share2 } from "lucide-react";
import { useCaseSnapshot } from "@/hooks/useCaseSnapshot";
import { useReviewStates } from "@/lib/review";
import { buildEntityGraph, SEED_ID, type EdgeType } from "@/lib/entity-graph";
import type { ReviewAdjustment } from "@/lib/intel";
import { authorityFor } from "@/lib/authority";
import { AuthorityChip } from "@/components/ui/authority";
import { ArtifactPivotAction } from "@/components/pivots/ArtifactPivotAction";
import { connectionsView, linksOf } from "@/lib/workbench-connections";
import { readSelectedEntity, SELECT_ENTITY_EVENT } from "@/lib/workbench-selection";
import { cn } from "@/lib/utils";

const ISOLATED_LIMIT = 12;

const EDGE_WORDS: Record<EdgeType, string> = {
  identity: "Shared selector",
  "co-record": "Named in the same record",
  "shared-infra": "Shared infrastructure",
  "seed-discovery": "Found in this run",
};

/**
 * The Workbench's Connections tab: the entity you picked (here, or in the Graph), every real relationship it has, and
 * a Preview-gated pivot on each neighbour. It reads the SAME graph the Graph tab draws (`buildEntityGraph`), so the
 * counts and the links cannot disagree with it, and it pivots through `ArtifactPivotAction`, so a neighbour the engine
 * will not pivot on says why instead of getting a looser path to a run. Read-only otherwise: it records nothing and
 * changes no authority.
 */
export function WorkbenchConnections({ threadId }: { threadId: string }) {
  const { snapshot } = useCaseSnapshot();
  const review = useReviewStates(threadId);
  const items = snapshot?.items ?? [];
  const seed = snapshot?.seed ?? { value: null, type: null };
  const [selected, setSelected] = useState<string | null>(() => readSelectedEntity(threadId));

  useEffect(() => {
    setSelected(readSelectedEntity(threadId));
    const onSelect = (e: Event) => {
      const d = (e as CustomEvent<{ threadId: string; id: string | null }>).detail;
      if (d?.threadId === threadId && d.id) setSelected(d.id);
    };
    window.addEventListener(SELECT_ENTITY_EVENT, onSelect);
    return () => window.removeEventListener(SELECT_ENTITY_EVENT, onSelect);
  }, [threadId]);

  const reviews = useMemo(() => {
    const m: Record<string, ReviewAdjustment> = {};
    for (const a of items) {
      const r = review.get(a.id);
      if (r !== "new") m[a.id] = r;
    }
    return m;
  }, [items, review]);
  const graph = useMemo(() => buildEntityGraph(items, seed.value, seed.type, reviews), [items, seed.value, seed.type, reviews]);
  const view = useMemo(() => connectionsView(graph), [graph]);
  const node = selected ? graph.nodes.find((n) => n.id === selected) ?? null : null;
  const links = useMemo(() => (node ? linksOf(graph, node.id) : []), [graph, node]);

  if (!snapshot?.hydrated) {
    return <div className="space-y-3 p-5" aria-busy="true"><div className="h-12 animate-pulse rounded-md bg-surface-2 motion-reduce:animate-none" aria-hidden /></div>;
  }
  if (items.length === 0) {
    return <p className="px-5 py-4 text-[13px] text-muted-foreground">No entities yet. Connections appear as the investigation records selectors.</p>;
  }

  return (
    <div className="flex min-h-0 flex-col" data-workbench-connections>
      <section aria-label="Connection summary" className="border-b border-border-subtle px-5 py-3">
        <p className="text-[13px] text-foreground">
          <span className="font-mono tabular-nums">{view.realLinks}</span> real link{view.realLinks === 1 ? "" : "s"}
          <span className="text-muted-foreground"> · {view.clusters} cluster{view.clusters === 1 ? "" : "s"} · {view.isolatedLeads} isolated lead{view.isolatedLeads === 1 ? "" : "s"}</span>
        </p>
        {view.seedRecords > 0 && (
          <p className="mt-0.5 text-[12px] text-subtle-foreground">{view.seedRecords} record{view.seedRecords === 1 ? "" : "s"} only repeat the seed; not counted as links.</p>
        )}
      </section>

      {node ? (
        <section aria-label="Selected entity" className="flex flex-col gap-3 border-b border-border-subtle px-5 py-4">
          <div className="flex min-w-0 items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate font-mono text-[14px] text-foreground" title={node.art?.value ?? node.label}>{node.art?.value ?? node.label}</p>
              <p className="text-[12px] text-subtle-foreground">{node.id === SEED_ID ? "Case seed" : node.seedRecord ? `${node.kind} · the seed's own record` : node.kind}</p>
            </div>
            {node.art && <AuthorityChip view={authorityFor(node.art, review.map[node.art.id] ?? "new")} />}
          </div>
          {node.art && !node.seedRecord && (
            <ArtifactPivotAction threadId={threadId} artifact={node.art} artifacts={items} />
          )}
          {links.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">
              {node.seedRecord ? "This record only repeats the seed, so it has no relationship of its own." : "No relationship to another entity has been established."}
            </p>
          ) : (
            <ul className="flex flex-col gap-3" aria-label={`${links.length} connection${links.length === 1 ? "" : "s"}`}>
              {links.map(({ edge, other }) => (
                <li key={edge.id} className="rounded-lg border border-border-subtle bg-surface-1/60 p-3">
                  <p className="text-[12px] text-subtle-foreground">{EDGE_WORDS[edge.type]}{edge.bridge ? " · bridges two clusters" : ""}</p>
                  <button
                    type="button"
                    onClick={() => setSelected(other.id)}
                    className="mt-0.5 block max-w-full truncate text-left font-mono text-[13px] text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    title={`Select ${other.label}`}
                  >
                    {other.art?.value ?? other.label}
                  </button>
                  <p className="mt-0.5 text-[12px] leading-snug text-muted-foreground">{edge.reason}</p>
                  {other.art && (
                    <div className="mt-2">
                      <ArtifactPivotAction threadId={threadId} artifact={other.art} artifacts={items} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          {node.art && (
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent("swarmbot:navigate", { detail: { tab: "artifacts", artifactId: node.art!.id } }))}
              className="inline-flex w-fit items-center gap-1 text-[12.5px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Open in Evidence <ArrowRight className="h-3 w-3" aria-hidden />
            </button>
          )}
        </section>
      ) : (
        <p className="border-b border-border-subtle px-5 py-3 text-[13px] text-muted-foreground">Pick an entity below, or select a node in the Graph.</p>
      )}

      <section aria-label="Connected entities" className="px-3.5 py-3">
        <h3 className="px-1.5 pb-1 text-[13px] font-semibold text-foreground">Connected entities <span className="font-mono text-[12px] font-normal tabular-nums text-muted-foreground">{view.linked.length}</span></h3>
        {view.linked.length === 0 ? (
          <p className="flex items-start gap-2 px-1.5 py-2 text-[13px] text-muted-foreground">
            <Share2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            No relationships between distinct entities established. Corroborating pivots form links.
          </p>
        ) : (
          <ul className="flex flex-col">
            {view.linked.map(({ node: n, links: count }) => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => setSelected(n.id)}
                  aria-pressed={n.id === selected}
                  className={cn(
                    "flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    n.id === selected && "bg-white/[0.06]",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-foreground">{n.art?.value ?? n.label}</span>
                  <span className="shrink-0 text-[12px] text-subtle-foreground">{n.kind}</span>
                  <span className="shrink-0 font-mono text-[12px] tabular-nums text-muted-foreground" title={`${count} real link${count === 1 ? "" : "s"}`}>{count}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {view.isolated.length > 0 && (
        <section aria-label="Isolated leads" className="border-t border-border-subtle px-3.5 py-3">
          <h3 className="px-1.5 pb-1 text-[13px] font-semibold text-foreground">
            Isolated leads <span className="font-mono text-[12px] font-normal tabular-nums text-muted-foreground">{view.isolated.length}</span>
            <span className="ml-2 text-[12px] font-normal text-subtle-foreground">found together, not related</span>
          </h3>
          <ul className="flex flex-col">
            {view.isolated.slice(0, ISOLATED_LIMIT).map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => setSelected(n.id)}
                  aria-pressed={n.id === selected}
                  className={cn(
                    "flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    n.id === selected && "bg-white/[0.06]",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-foreground">{n.art?.value ?? n.label}</span>
                  <span className="shrink-0 text-[12px] text-subtle-foreground">{n.kind}</span>
                </button>
              </li>
            ))}
          </ul>
          {view.isolated.length > ISOLATED_LIMIT && (
            <p className="px-1.5 pt-1 text-[12px] text-subtle-foreground">+{view.isolated.length - ISOLATED_LIMIT} more in the Graph list.</p>
          )}
        </section>
      )}
    </div>
  );
}
