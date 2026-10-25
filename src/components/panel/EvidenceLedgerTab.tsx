import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, Search, X } from "lucide-react";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { useReviewStates } from "@/lib/review";
import { authorityFor, LEDGER_SORT_RANK, type AuthorityState } from "@/lib/authority";
import {
  STATUS_FILTER_GROUPS,
  type EvidenceStatusFilter,
  type EvidenceSortMode,
  ArtifactDrawer,
} from "@/components/ResourcesPanel";
import { partitionBulkCorpusRows, type BulkCorpusDisplayRow } from "@/lib/bulk-corpus-display";
import { extractSourceInfo } from "@/lib/intel";
import { isProseValue } from "@/lib/evidence-bands";
import { effectiveConfidenceOrZero } from "@/lib/display-confidence";
import { AuthorityChip } from "@/components/ui/authority";
import { MenuSelect, CompactFilter, type CompactOption } from "@/components/ui/compact-controls";
import { useToolbarSlot } from "@/hooks/useToolbarSlot";
import { useOptionalWorkspaceUIState } from "@/hooks/useWorkspaceUIState";
import { cn } from "@/lib/utils";

/**
 * The compact Evidence ledger — the primary Evidence view.
 *
 * One scrollable list, aligned columns, hairline rules. Reuses the filter,
 * sort, authority and grouping machinery the Board already relies on so
 * every count, every chip and every quarantined row stays consistent across
 * lenses. Does NOT introduce new scoring.
 *
 * Selection publishes to the shared `useOptionalWorkspaceUIState` so the
 * Workbench Sheet tab surfaces the inspector at xl+ (one detail surface at
 * every width — the invariant WRT the Workbench). Below xl, where the
 * Workbench is hidden, the ledger opens the existing ArtifactDrawer as its
 * own detail surface.
 */

/** 1280px matched to the Workbench `xl:block` gate in ChatPage. Local copy of
 *  the hook ResourcesPanel defines non-exported — keeping it here keeps the
 *  Ledger standalone-testable without touching the Board's export surface. */
function useIsWorkbenchViewport(): boolean {
  const [match, setMatch] = useState<boolean>(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(min-width: 1280px)").matches
      : false,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia("(min-width: 1280px)");
    const onChange = () => setMatch(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return match;
}

const SORT_LABEL: Record<EvidenceSortMode, string> = {
  strength: "Strength",
  confidence: "Confidence",
  newest: "Newest",
};

function sortRows(rows: Artifact[], mode: EvidenceSortMode, review: ReturnType<typeof useReviewStates>): Artifact[] {
  const copy = rows.slice();
  if (mode === "newest") {
    copy.sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at));
    return copy;
  }
  if (mode === "confidence") {
    copy.sort((a, b) => effectiveConfidenceOrZero(b) - effectiveConfidenceOrZero(a));
    return copy;
  }
  // strength: by authority rank, break ties by effective confidence desc.
  copy.sort((a, b) => {
    const sa = authorityFor(a, review.get(a.id)).state as AuthorityState;
    const sb = authorityFor(b, review.get(b.id)).state as AuthorityState;
    const ra = LEDGER_SORT_RANK[sa] ?? 999;
    const rb = LEDGER_SORT_RANK[sb] ?? 999;
    if (ra !== rb) return ra - rb;
    return effectiveConfidenceOrZero(b) - effectiveConfidenceOrZero(a);
  });
  return copy;
}

interface LedgerProps {
  threadId: string;
  artifacts: Artifact[];
  onLocalUpdate: (a: Artifact) => void;
  focusRequest?: { id: string; n: number } | null;
}

export function EvidenceLedgerTab({ threadId, artifacts, onLocalUpdate, focusRequest }: LedgerProps) {
  const review = useReviewStates(threadId);
  const [statusFilter, setStatusFilter] = useState<EvidenceStatusFilter>("analyst");
  const [sortMode, setSortMode] = useState<EvidenceSortMode>("strength");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Artifact | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const ui = useOptionalWorkspaceUIState();
  const isWorkbench = useIsWorkbenchViewport();
  const workbenchHandlesDetail = isWorkbench && !!ui;

  const slot = useToolbarSlot();

  // Counts per quick-filter — same shape as Board so chips agree.
  const counts = useMemo(() => {
    const c: Record<string, number> = { analyst: 0, all: artifacts.length, strong: 0, review: 0, quarantined: 0, weak: 0, excluded: 0 };
    for (const a of artifacts) {
      const s = authorityFor(a, review.get(a.id)).state;
      if (STATUS_FILTER_GROUPS.analyst!.has(s)) c.analyst++;
      if (STATUS_FILTER_GROUPS.strong!.has(s)) c.strong++;
      else if (STATUS_FILTER_GROUPS.review!.has(s)) c.review++;
      else if (STATUS_FILTER_GROUPS.quarantined!.has(s)) c.quarantined++;
      else if (STATUS_FILTER_GROUPS.weak!.has(s)) c.weak++;
      else if (STATUS_FILTER_GROUPS.excluded!.has(s)) c.excluded++;
    }
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifacts, review.revision]);

  const rows: BulkCorpusDisplayRow[] = useMemo(() => {
    const allow = STATUS_FILTER_GROUPS[statusFilter];
    const q = search.trim().toLowerCase();
    const filtered = artifacts.filter((a) => {
      const state = authorityFor(a, review.get(a.id)).state;
      if (allow && !allow.has(state)) return false;
      if (q) {
        const metaSource = (() => {
          const m = (a.metadata ?? {}) as Record<string, unknown>;
          return typeof m.source === "string" ? m.source : "";
        })();
        const hay = `${a.value} ${a.source ?? ""} ${a.kind} ${metaSource}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const sorted = sortRows(filtered, sortMode, review);
    return partitionBulkCorpusRows(sorted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifacts, statusFilter, sortMode, search, review.revision]);

  const handleSelect = useCallback(
    (a: Artifact | null) => {
      setSelected(a);
      if (!ui) return;
      if (a) {
        ui.rememberOpener(`ledger-row-${a.id}`);
        ui.select(a.id);
      }
    },
    [ui],
  );

  // Honor a focus request (deep link from command palette etc.) — widen filter
  // to "all" so the row is visible, then select it.
  const [focusedNonce, setFocusedNonce] = useState<number | null>(null);
  useEffect(() => {
    if (!focusRequest || focusRequest.n === focusedNonce) return;
    const target = artifacts.find((a) => a.id === focusRequest.id);
    if (!target) return;
    setStatusFilter("all");
    handleSelect(target);
    setFocusedNonce(focusRequest.n);
  }, [focusRequest, focusedNonce, artifacts, handleSelect]);

  const toggleGroup = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const filterOptions: CompactOption<EvidenceStatusFilter>[] = [
    { key: "analyst", label: "Analyst view", count: counts.analyst, hint: "Everything that needs a decision — leads and exclusions hidden" },
    { key: "all", label: "All", count: counts.all },
    { key: "strong", label: "Findings", count: counts.strong, tone: "ok" },
    { key: "review", label: "Needs review", count: counts.review, tone: "warn" },
    ...(counts.quarantined > 0
      ? [{ key: "quarantined" as const, label: "Quarantined", count: counts.quarantined }]
      : []),
    { key: "weak", label: "Leads", count: counts.weak },
    { key: "excluded", label: "Excluded", count: counts.excluded, tone: "danger" as const },
  ];

  const toolbar = (
    <>
      <CompactFilter<EvidenceStatusFilter>
        label="Filter"
        active={statusFilter}
        onChange={setStatusFilter}
        options={filterOptions}
        primary={["analyst", "strong", "review", "quarantined"]}
      />
      <MenuSelect<EvidenceSortMode>
        label="Sort"
        align="end"
        active={sortMode}
        onChange={setSortMode}
        options={[
          { key: "strength", label: SORT_LABEL.strength },
          { key: "confidence", label: SORT_LABEL.confidence },
          { key: "newest", label: SORT_LABEL.newest },
        ]}
      />
      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search selectors, sources…"
          aria-label="Search evidence"
          className="h-7 w-48 rounded-md border border-white/[0.08] bg-surface-2 pl-7 pr-7 text-[12px] text-foreground outline-none placeholder:text-muted-foreground focus:border-ring"
        />
        {search && (
          <button
            type="button"
            onClick={() => setSearch("")}
            aria-label="Clear search"
            className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
    </>
  );

  return (
    <>
      {slot && createPortal(toolbar, slot)}

      <section aria-label="Evidence ledger" className="mx-auto max-w-5xl px-3 py-3 sm:px-4">
        {/* column headings — monospace, uppercase, understated */}
        <div
          role="row"
          aria-hidden
          className="hidden gap-3 border-b border-white/[0.08] px-2 pb-2 font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground sm:grid"
          style={{ gridTemplateColumns: "32px minmax(0, 1.3fr) minmax(0, 1.4fr) 128px 20px" }}
        >
          <span>N°</span>
          <span>Selector</span>
          <span>Basis</span>
          <span>Authority</span>
          <span className="sr-only">Open</span>
        </div>

        {rows.length === 0 ? (
          <div className="px-2 py-10 text-center text-[13px] text-muted-foreground">
            {search || statusFilter !== "all" ? (
              <>
                No evidence matches these filters.{" "}
                <button
                  type="button"
                  onClick={() => { setSearch(""); setStatusFilter("all"); }}
                  className="underline text-foreground"
                >
                  Clear filters
                </button>
              </>
            ) : (
              <>No evidence yet.</>
            )}
          </div>
        ) : (
          <ol className="divide-y divide-white/[0.06]">
            {rows.map((row, i) =>
              row.type === "single" ? (
                <LedgerRow
                  key={row.artifact.id}
                  n={i + 1}
                  artifact={row.artifact}
                  selected={selected?.id === row.artifact.id}
                  onSelect={handleSelect}
                  review={review}
                />
              ) : (
                <LedgerGroup
                  key={row.key}
                  row={row}
                  openIndex={i + 1}
                  expanded={expanded.has(row.key)}
                  onToggle={() => toggleGroup(row.key)}
                  onSelect={handleSelect}
                  review={review}
                  selectedId={selected?.id ?? null}
                />
              ),
            )}
          </ol>
        )}

        {rows.length > 0 && (
          <p className="mt-6 text-center text-[11px] text-muted-foreground">
            Every source record retained. Repeated observations grouped visually; grouping does not raise independence.
          </p>
        )}
      </section>

      {/* Below xl the Workbench is hidden, so the ledger opens its own detail
         surface via the existing drawer — one detail surface at every width. */}
      {!workbenchHandlesDetail && (
        <ArtifactDrawer
          artifact={selected}
          onClose={() => {
            setSelected(null);
            ui?.clear?.();
          }}
          onChanged={(next) => {
            onLocalUpdate(next);
            setSelected(next);
          }}
          reviewGet={review.get}
          reviewSet={async (id, s, ctx) => {
            // Delegate to supabase through the review state's own writer: the
            // review map is the source of truth for note/verdict persistence.
            return review.set(id, s, ctx);
          }}
          threadId={threadId}
          allArtifacts={artifacts}
        />
      )}
    </>
  );
}

/** Dense single row — one evidence entry. */
function LedgerRow({
  n,
  artifact,
  selected,
  onSelect,
  review,
}: {
  n: number;
  artifact: Artifact;
  selected: boolean;
  onSelect: (a: Artifact) => void;
  review: ReturnType<typeof useReviewStates>;
}) {
  const auth = authorityFor(artifact, review.get(artifact.id));
  const src = extractSourceInfo(artifact);
  const prose = isProseValue(artifact.value);
  return (
    <li>
      <button
        id={`ledger-row-${artifact.id}`}
        type="button"
        role="row"
        aria-selected={selected}
        onClick={() => onSelect(artifact)}
        data-ledger-row
        data-artifact-id={artifact.id}
        className={cn(
          "grid w-full items-center gap-3 px-2 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:gap-3",
          selected ? "bg-primary/10" : "hover:bg-white/[0.03]",
        )}
        style={{ gridTemplateColumns: "32px minmax(0, 1.3fr) minmax(0, 1.4fr) 128px 20px" }}
      >
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {String(n).padStart(2, "0")}
        </span>
        <span className="min-w-0">
          <span
            className={cn(
              "block min-w-0 text-[13px] leading-tight text-foreground",
              prose ? "" : "truncate font-mono",
            )}
            title={artifact.value}
          >
            {artifact.value}
          </span>
          <span className="mt-1 flex items-baseline gap-2 text-[11px] text-muted-foreground">
            <span className="truncate">{artifact.kind}</span>
          </span>
        </span>
        <span className="min-w-0 text-[12.5px] leading-snug text-muted-foreground">
          <span className="line-clamp-2">{auth.basis || src.primary || "—"}</span>
        </span>
        <span className="justify-self-start">
          <AuthorityChip view={auth} />
        </span>
        <ChevronRight aria-hidden className="h-3.5 w-3.5 text-muted-foreground/60" />
      </button>
    </li>
  );
}

/** Grouped repeated observations — same-reason bulk-corpus rows. */
function LedgerGroup({
  row,
  openIndex,
  expanded,
  onToggle,
  onSelect,
  review,
  selectedId,
}: {
  row: Extract<BulkCorpusDisplayRow, { type: "bulk_group" }>;
  openIndex: number;
  expanded: boolean;
  onToggle: () => void;
  onSelect: (a: Artifact) => void;
  review: ReturnType<typeof useReviewStates>;
  selectedId: string | null;
}) {
  // Represent the group's authority by the first row's; expanded rows carry
  // their own chip. Never merge authority across rows.
  const headAuth = authorityFor(row.artifacts[0], review.get(row.artifacts[0].id));
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="grid w-full items-center gap-3 px-2 py-3 text-left transition-colors hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{ gridTemplateColumns: "32px minmax(0, 1.3fr) minmax(0, 1.4fr) 128px 20px" }}
      >
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {String(openIndex).padStart(2, "0")}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[13px] leading-tight text-foreground">
            {row.label} · {row.artifacts.length} observations
          </span>
          <span className="mt-1 block text-[11px] text-muted-foreground">
            Grouped; each row retained
          </span>
        </span>
        <span className="min-w-0 text-[12.5px] leading-snug text-muted-foreground">
          <span className="line-clamp-2">{row.reason}</span>
        </span>
        <span className="justify-self-start">
          <AuthorityChip view={headAuth} />
        </span>
        <ChevronRight
          aria-hidden
          className={cn("h-3.5 w-3.5 text-muted-foreground/60 transition-transform", expanded && "rotate-90")}
        />
      </button>
      {expanded && (
        <ol className="divide-y divide-white/[0.04] bg-white/[0.015] pb-1">
          {row.artifacts.map((a, idx) => (
            <LedgerRow
              key={a.id}
              n={idx + 1}
              artifact={a}
              selected={selectedId === a.id}
              onSelect={onSelect}
              review={review}
            />
          ))}
        </ol>
      )}
    </li>
  );
}
