import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowRight, Link2, Mail, Phone, Globe, User, Hash, MapPin, FileSearch, Share2 } from "lucide-react";
import { useCaseSnapshot } from "@/hooks/useCaseSnapshot";
import { useReviewStates } from "@/lib/review";
import { buildEntityGraph, SEED_ID, type EdgeType } from "@/lib/entity-graph";
import type { ReviewAdjustment } from "@/lib/intel";
import { authorityFor } from "@/lib/authority";
import { AuthorityChip } from "@/components/ui/authority";
import { ArtifactPivotActionWith } from "@/components/pivots/ArtifactPivotAction";
import { useThreadQueriedTargets } from "@/hooks/useThreadQueriedTargets";
import { connectionsView, linksOf, unlinkedReasons } from "@/lib/workbench-connections";
import { isProseValue } from "@/lib/evidence-bands";
import { readSelectedEntity, SELECT_ENTITY_EVENT } from "@/lib/workbench-selection";
import { pickSubjectName } from "@/lib/report-hygiene";
import { cn } from "@/lib/utils";
import { ASSOCIATION_LIKELIHOOD_ENABLED, AssociationLikelihood } from "@/components/workspace/AssociationLikelihood";

const ISOLATED_LIMIT = 12;

const REVIEWS_UNAVAILABLE =
  "Your review decisions couldn't be loaded, so connections are withheld — they could otherwise show a link through a row you already rejected.";

const EDGE_WORDS: Record<EdgeType, string> = {
  identity: "Shared selector",
  "co-record": "Named in the same record",
  "shared-infra": "Shared infrastructure",
  "seed-discovery": "Found in this run",
};

const KIND_ICON: Record<string, typeof Mail> = {
  email: Mail, phone: Phone, domain: Globe, url: Link2, social_profile: Link2, username: User, handle: User,
  name: User, person: User, crypto: Hash, crypto_wallet: Hash, wallet: Hash, address: MapPin, location: MapPin, ip: Globe, ip_address: Globe,
};

/**
 * The Workbench's Connections tab, laid out to JD's prototype (R3): the counts
 * as two figures, the selected entity as the node, and each relationship as a
 * connector line (what joins them) leading to a leaf (the other entity, which
 * selects on click). A co-record link reads amber, because "found together"
 * is not "owned by the same person".
 *
 * It reads the SAME graph the Graph tab draws (`buildEntityGraph`), so the
 * counts and the links cannot disagree with it, and it pivots through
 * `ArtifactPivotAction`, so a neighbour the engine will not pivot on says why
 * instead of getting a looser path to a run. Read-only otherwise: it records
 * nothing and changes no authority. "Open graph" reaches the Graph tab (the
 * 4th workspace tab, kept — JD, 2026-11-02).
 */
export function WorkbenchConnections({ threadId }: { threadId: string }) {
  const { snapshot } = useCaseSnapshot();
  const review = useReviewStates(threadId);
  // Read ONCE and shared by every pivot action below (each used to open its own full-log read and subscription).
  const queriedTargets = useThreadQueriedTargets(threadId);
  const items = useMemo(() => snapshot?.items ?? [], [snapshot?.items]);
  const seed = snapshot?.seed ?? { value: null, type: null };
  const [selected, setSelected] = useState<string | null>(() => readSelectedEntity(threadId));
  const [isolatedFilter, setIsolatedFilter] = useState<string>("");

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
  const subject = useMemo(() => pickSubjectName(items, reviews), [items, reviews]);
  const why = useMemo(() => (view.realLinks === 0 ? unlinkedReasons(items, seed.value) : null), [view.realLinks, items, seed.value]);
  // Automatic subject-first navigation: an analyst can still select any node,
  // but nobody has to hunt through an "unlinked" list to find the person map.
  const node = (selected ? graph.nodes.find((n) => n.id === selected) : null)
    ?? graph.nodes.find((n) => n.id === subject?.id)
    ?? null;
  const links = useMemo(() => (node ? linksOf(graph, node.id) : []), [graph, node]);
  const filteredIsolated = useMemo(() => {
    const q = isolatedFilter.trim().toLowerCase();
    if (!q) return view.isolated;
    return view.isolated.filter((n) => {
      const label = (n.art?.value ?? n.label ?? "").toLowerCase();
      const kind = (n.kind ?? "").toLowerCase();
      return label.includes(q) || kind.includes(q);
    });
  }, [view.isolated, isolatedFilter]);

  const openGraph = () => window.dispatchEvent(new CustomEvent("swarmbot:navigate", { detail: { tab: "graph" } }));

  // Relationships and pivots are decided BY the analyst's verdicts (a dismissed row must not read as a link or a lead),
  // so both fail closed like the case sheet: wait for the read, and say so when it failed instead of treating an unread
  // verdict as "new".
  if (!snapshot?.hydrated || review.availability === "unknown") {
    return <div className="space-y-3 p-5" aria-busy="true"><div className="h-12 animate-pulse rounded-md bg-surface-2 motion-reduce:animate-none" aria-hidden /></div>;
  }
  if (review.availability === "unavailable") {
    return <p role="status" className="px-5 py-4 text-[13px] leading-snug text-muted-foreground">{REVIEWS_UNAVAILABLE}</p>;
  }
  if (items.length === 0) {
    return <p className="px-5 py-4 text-[13px] text-muted-foreground">No entities yet. Connections appear as the investigation records selectors.</p>;
  }

  const NodeIcon = KIND_ICON[(node?.kind ?? "").toLowerCase()] ?? (node?.id === SEED_ID ? Mail : FileSearch);

  return (
    <div className="flex min-h-0 flex-col" data-workbench-connections>
      <section aria-label="Connection summary" className="px-5 pt-5">
        <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.09em] text-subtle-foreground">
          <span>Evidence relationships</span>
          <button
            type="button"
            onClick={openGraph}
            className="inline-flex items-center gap-1 normal-case tracking-normal text-[hsl(var(--brand))] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Open graph <ArrowRight className="h-3 w-3" aria-hidden />
          </button>
        </div>
        <div className="my-5 flex gap-5">
          <div>
            <b className="block text-[23px] font-normal tabular-nums leading-none">{view.realLinks}</b>
            <small className="mt-1 block text-[11px] text-subtle-foreground"> evidence link{view.realLinks === 1 ? "" : "s"}</small>
          </div>
          <div>
            <b className="block text-[23px] font-normal tabular-nums leading-none">{view.isolatedLeads}</b>
            <small className="mt-1 block text-[11px] text-subtle-foreground"> unlinked candidate{view.isolatedLeads === 1 ? "" : "s"}</small>
          </div>
          <div>
            <b className="block text-[23px] font-normal tabular-nums leading-none">{view.clusters}</b>
            <small className="mt-1 block text-[11px] text-subtle-foreground"> cluster{view.clusters === 1 ? "" : "s"}</small>
          </div>
        </div>
        {/* The graph distinguishes shared selectors, same-record associations
            and shared infrastructure. All three explain how evidence relates;
            only the first can support identity, and even then it is not an
            analyst confirmation. Say that next to the counts, not in a tooltip. */}
        <p className="text-[11px] leading-relaxed text-faint-foreground">
          Evidence links include shared selectors and same-record associations. They explain how records relate, not that they belong to one person.
        </p>
        {why && why.total > 0 && (
          <div data-why-unlinked className="mt-3 rounded-md border border-border-subtle bg-surface-2 px-3 py-2.5 text-[12.5px] leading-relaxed text-muted-foreground">
            <p className="font-medium text-foreground">Why nothing reads as linked yet</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {why.noSubject && (
                <li>This case started from an upload, so it has no subject selector for anything to link to.</li>
              )}
              {why.breachOnly > 0 && (
                <li>{why.breachOnly} of {why.total} rows are breach records. Breach records can show selectors appearing together, but never prove identity on their own.</li>
              )}
              {why.quarantined > 0 && (
                <li>{why.quarantined} of {why.total} rows are quarantined: their link to the subject is unproven, so they lend no linkage.</li>
              )}
              {!why.noSubject && why.breachOnly === 0 && why.quarantined === 0 && (
                <li>No two rows share a selector yet. A corroborating pivot forms the first link.</li>
              )}
            </ul>
          </div>
        )}
        {view.seedRecords > 0 && (
          <p className="mt-1 text-[11px] text-subtle-foreground">{view.seedRecords} record{view.seedRecords === 1 ? "" : "s"} only repeat the seed; not counted as links.</p>
        )}
        {view.cleanChecks > 0 && (
          <p className="mt-1 text-[11px] text-subtle-foreground" data-clean-checks>{view.cleanChecks} clean check{view.cleanChecks === 1 ? "" : "s"} (coverage, not candidates): lookups that found nothing. Still listed in Evidence.</p>
        )}
      </section>

      {node ? (
        <section aria-label="Selected entity" className="px-5 pt-5">
          {/* The node */}
          <div className="flex items-start gap-2.5 rounded-md border border-[hsl(var(--brand)/0.35)] bg-[hsl(var(--brand)/0.1)] p-3 text-[12px] text-foreground">
            <NodeIcon className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--brand))]" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="break-words font-mono [overflow-wrap:anywhere]" title={node.art?.value ?? node.label}>{node.art?.value ?? node.label}</p>
              <p className="mt-0.5 text-[11px] text-subtle-foreground">{node.id === subject?.id ? "Subject name · automatic evidence map" : node.id === SEED_ID ? "Case seed" : node.seedRecord ? `${node.kind} · the seed's own record` : node.kind}</p>
            </div>
            {node.art && <AuthorityChip view={authorityFor(node.art, review.map[node.art.id] ?? "new")} />}
          </div>
          {node.art && !node.seedRecord && (
            <div className="mt-3">
              <ArtifactPivotActionWith queriedSet={queriedTargets} threadId={threadId} artifact={node.art} artifacts={items} />
            </div>
          )}
          {/* The tree: connector → leaf */}
          {links.length === 0 ? (
            <p className="mt-4 text-[12px] leading-relaxed text-muted-foreground">
              {node.seedRecord
                ? "This record only repeats the seed, so it has no relationship of its own."
                : ["name", "person"].includes(node.kind.toLowerCase())
                  ? "No selector-level relationship. A name alone does not establish identity; inspect its source record or corroborate it with another selector."
                  : "No relationship derived yet. Inspect the source record or run a corroborating pivot."}
            </p>
          ) : (
            <ul className="mt-1" aria-label={`${links.length} connection${links.length === 1 ? "" : "s"}`}>
              {links.map(({ edge, other }) => {
                const soft = edge.type === "co-record" || edge.type === "shared-infra";
                return (
                  <li key={edge.id} className="ml-4 border-l border-border pl-[19px] pt-4">
                    <p className={cn("mb-1.5 flex items-center gap-1.5 text-[11px]", soft ? "text-[hsl(var(--warning))]" : "text-subtle-foreground")}>
                      {soft ? <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden /> : <Link2 className="h-3 w-3 shrink-0" aria-hidden />}
                      <span>{EDGE_WORDS[edge.type]}{edge.bridge ? " · bridges two clusters" : ""}{soft ? " · not an identity edge" : ""}</span>
                    </p>
                    <button
                      type="button"
                      onClick={() => setSelected(other.id)}
                      className="block w-full rounded-[5px] border border-border bg-surface-1/60 p-2.5 text-left text-[12px] text-foreground hover:border-[hsl(var(--brand)/0.5)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      title={`Select ${other.label}`}
                    >
                      <span className="block break-words font-mono [overflow-wrap:anywhere]">{other.art?.value ?? other.label}</span>
                      <small className="mt-1 block text-[11px] text-subtle-foreground">{edge.reason}</small>
                    </button>
                    {other.art && (
                      <div className="mt-2">
                        <ArtifactPivotActionWith queriedSet={queriedTargets} threadId={threadId} artifact={other.art} artifacts={items} />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {node.art && (
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent("swarmbot:navigate", { detail: { tab: "artifacts", artifactId: node.art!.id } }))}
              className="mt-4 inline-flex w-fit items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Open in Evidence <ArrowRight className="h-3 w-3" aria-hidden />
            </button>
          )}
        </section>
      ) : (
        <p className="px-5 pt-5 text-[12px] text-muted-foreground">Pick an entity below, or select a node in the Graph.</p>
      )}

      <div className="mx-5 my-5 h-px bg-border" aria-hidden />

      <section aria-label="Related evidence" className="px-3.5 pb-3">
        <h3 className="px-1.5 pb-1 text-[12px] font-medium text-foreground">Related evidence <span className="font-mono text-[11px] font-normal tabular-nums text-muted-foreground">{view.linked.length}</span></h3>
        {view.linked.length === 0 ? (
          <p className="flex items-start gap-2 px-1.5 py-2 text-[12px] text-muted-foreground">
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
                    "flex w-full min-w-0 items-start gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    n.id === selected && "bg-white/[0.06]",
                  )}
                >
                  <RowValue value={n.art?.value ?? n.label} />
                  <span className="shrink-0 text-[11px] text-subtle-foreground">{n.kind}</span>
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground" title={`${count} real link${count === 1 ? "" : "s"}`}>{count}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {view.isolated.length > 0 && (
        <section aria-label="Unlinked candidates" className="border-t border-border-subtle px-3.5 py-3">
          <h3 className="px-1.5 pb-1 text-[12px] font-medium text-foreground">
            Unlinked candidates <span className="font-mono text-[11px] font-normal tabular-nums text-muted-foreground">{view.isolated.length}</span>
            <span className="block text-[11.5px] font-normal text-subtle-foreground">No shared selector or source-record association yet</span>
          </h3>
          {view.isolated.length > 6 && (
            <div className="mb-1.5 px-1.5">
              <input
                type="search"
                value={isolatedFilter}
                onChange={(e) => setIsolatedFilter(e.target.value)}
                placeholder={`Search ${view.isolated.length} candidates…`}
                className="h-7 w-full rounded-md border border-border-subtle bg-surface-1 px-2 font-mono text-[12px] text-foreground placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                aria-label="Filter unlinked candidates"
              />
            </div>
          )}
          <ul className="flex flex-col">
            {filteredIsolated.slice(0, ISOLATED_LIMIT).map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => setSelected(n.id)}
                  aria-pressed={n.id === selected}
                  className={cn(
                    "flex w-full min-w-0 items-start gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    n.id === selected && "bg-white/[0.06]",
                  )}
                >
                  <RowValue value={n.art?.value ?? n.label} />
                  <span className="shrink-0 text-[11px] text-subtle-foreground">{n.kind}</span>
                </button>
              </li>
            ))}
          </ul>
          {view.isolated.length > ISOLATED_LIMIT && (
            <p className="px-1.5 pt-1 text-[11px] text-subtle-foreground">+{view.isolated.length - ISOLATED_LIMIT} more in the Graph list.</p>
          )}
        </section>
      )}
      {ASSOCIATION_LIKELIHOOD_ENABLED && <AssociationLikelihood items={items} seedValue={seed.value} reviews={reviews} />}
      <p className="px-5 pb-5 text-[11px] leading-relaxed text-faint-foreground">
        Found together does not mean owned by the same person. Name-only candidates and quarantined observations stay separate.
      </p>
    </div>
  );
}

/**
 * One row value. A selector is compared character by character, so it keeps the
 * data face and wraps anywhere instead of ending in an ellipsis; a finding
 * written into the value column is prose and reads in the sans face over at
 * most two lines (DESIGN.md: "Don't truncate a sentence like a selector").
 */
function RowValue({ value }: { value: string }) {
  return isProseValue(value) ? (
    <span title={value} className="min-w-0 flex-1 overflow-hidden text-[12.5px] leading-snug text-foreground [-webkit-box-orient:vertical] [-webkit-line-clamp:2] [display:-webkit-box]">{value}</span>
  ) : (
    <span className="min-w-0 flex-1 font-mono text-[12px] leading-snug text-foreground [overflow-wrap:anywhere]">{value}</span>
  );
}
