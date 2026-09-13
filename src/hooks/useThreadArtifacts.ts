import { useEffect, useState, useMemo } from "react";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { toSourceStrings } from "@/lib/source-strings";

export type Artifact = {
  id: string;
  kind: string;
  value: string;
  confidence: number | null;
  source: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
};

const realtimeArtifactSchema = z.object({
  id: z.string(),
  kind: z.string(),
  value: z.string(),
  confidence: z.number().nullable(),
  source: z.string().nullable(),
  created_at: z.string(),
  metadata: z.record(z.unknown()).nullable(),
}).partial();

// Canonicalize a value per kind so duplicates across tools collapse cleanly.
function normalizeValue(kind: string, raw: string): string {
  const v = (raw ?? "").trim();
  const k = kind.toLowerCase();
  if (!v) return v;
  if (k === "email" || k === "domain") return v.toLowerCase();
  if (k === "username" || k === "social") return v.replace(/^@+/, "").toLowerCase();
  if (k === "ip") {
    // Lightweight IPv4 canonicalization (strip leading zeros per octet).
    const m = v.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) return m.slice(1).map((n) => String(parseInt(n, 10))).join(".");
    return v.toLowerCase();
  }
  if (k === "name") {
    // Strip trailing parentheticals like "Prince (Twitter display name)" → "prince"
    // so the bare name and its platform-tagged variant collapse to one row.
    return v.replace(/\s*\(.*\)\s*$/, "").trim().toLowerCase();
  }
  return v.toLowerCase();
}

/** Artifact kinds that represent meta/status rows — surfaced in audit/timeline,
 * not in the user-facing artifact list. */
/**
 * SINGLE SOURCE OF TRUTH for the meta kinds.
 *
 * Exported because filtering them out of the artifact LIST was never enough. Every
 * artifact COUNT is a bare `count(*)`: `useInsightsData` (Brain totals), `HomeHub`
 * (workspace totals) and the `get_case_metrics` RPC (per-case totals). All three
 * bypassed this filter, so a `cluster_decision` row was hidden from the list while
 * still inflating every number an analyst actually reads. Any surface that counts
 * artifacts must exclude these kinds.
 */
export const META_ARTIFACT_KINDS = ["triage_decision", "cluster_decision"] as const;
const META_KINDS = new Set<string>(META_ARTIFACT_KINDS);
export function isMetaArtifact(a: Artifact): boolean {
  if (META_KINDS.has(a.kind.toLowerCase())) return true;
  const meta = (a.metadata ?? {}) as Record<string, unknown>;
  return META_KINDS.has(String(meta.label ?? "").toLowerCase());
}

function sourceSet(a: Artifact): string[] {
  const md = (a.metadata ?? {}) as Record<string, unknown>;
  return Array.from(new Set<string>([...toSourceStrings(md.sources), ...(a.source ? [a.source] : [])]));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Everything a consumer can read authority from. That is the top-level source
 * and confidence plus the WHOLE metadata blob, not a list of "authority keys":
 * cluster membership alone reads metadata.email / phone / address /
 * parent_seed, so no key is safely descriptive. `sources` is folded to the set
 * dedupe maintains, so a stored item and its raw twin compare equal when a
 * realtime delta re-dedupes the store.
 */
function authorityFingerprint(a: Artifact): string {
  const { sources: _sources, ...rest } = (a.metadata ?? {}) as Record<string, unknown>;
  return stableStringify({ source: a.source, confidence: a.confidence, metadata: rest, sources: sourceSet(a).sort() });
}

function isEarlier(a: Artifact, b: Artifact): boolean {
  const ta = Date.parse(a.created_at);
  const tb = Date.parse(b.created_at);
  if (ta !== tb && !Number.isNaN(ta) && !Number.isNaN(tb)) return ta < tb;
  return a.id < b.id;
}

/**
 * Collapse rows that are the same evidence twice — same kind, same normalized
 * value AND identical authority — onto the earliest row.
 *
 * Rows that share a value but differ in authority stay separate items. The old
 * merge spread a later row's metadata over the first, so one database row
 * donated source class, cap, cluster, quarantine release (`linkage_confirmed`)
 * and analyst confirmation (`reviewed`) to another, and the result depended on
 * row order. One item cannot carry two rows' authority without inventing a
 * merged authority object, so it doesn't try: each raw row stays the authority
 * input, and every surface and export built on these items inherits that.
 */
function dedupeArtifacts(rows: Artifact[]): Artifact[] {
  const seen = new Map<string, Artifact>();
  for (const a of rows) {
    const key = `${a.kind.toLowerCase()}|${normalizeValue(a.kind, a.value)}|${authorityFingerprint(a)}`;
    const prev = seen.get(key);
    if (prev && !isEarlier(a, prev)) continue;
    seen.set(key, { ...a, metadata: { ...(a.metadata ?? {}), sources: sourceSet(a) } });
  }
  return Array.from(seen.values());
}

// ---------------------------------------------------------------------------
// Shared per-thread store: every component that calls useThreadArtifacts(tid)
// subscribes to the SAME fetch + realtime channel. Previously each call site
// (ChatWindow, ThreadHeader, ResourcesPanel) opened its own channel and ran
// its own SELECT on every event, multiplying load by N panels.
// ---------------------------------------------------------------------------
type Store = {
  items: Artifact[];
  // loadedCount is the raw row count returned by the most recent load,
  // before dedupe — used to detect cap saturation honestly.
  loadedCount: number;
  hasMore: boolean;
  // Whether at least one load has completed, and whether the most recent load
  // errored. Together these let the UI tell "still loading" and "load failed,
  // retry" apart from a genuinely-empty case.
  loaded: boolean;
  error: boolean;
  /** Epoch ms of the last SUCCESSFUL load — the case header's "Last synced". */
  loadedAt: number | null;
  subscribers: Set<(snapshot: StoreSnapshot) => void>;
  channel: ReturnType<typeof supabase.channel> | null;
  loading: Promise<boolean> | null;
  refCount: number;
  // Whether the realtime channel has completed its first SUBSCRIBED. A second
  // SUBSCRIBED means the socket recovered after a disconnect, so we reconcile
  // from persistence in case artifact events were missed while it was down.
  subscribed: boolean;
  // Throttle: coalesce bursts of realtime events into at most one full
  // reload per THROTTLE_MS. Protects against event storms (e.g. a single
  // scan inserting 50+ rows in <100ms) hammering the DB.
  pendingReload: ReturnType<typeof setTimeout> | null;
  // Reconcile-on-refocus handler, kept so release can detach it. See
  // acquireStore for why this exists.
  onVisible: (() => void) | null;
};

type StoreSnapshot = {
  items: Artifact[];
  loadedCount: number;
  hasMore: boolean;
  loaded: boolean;
  error: boolean;
  loadedAt: number | null;
};

/** Hard cap on initial artifact load per thread. Large investigations
 *  surface a UI warning when this is hit so the analyst knows the view
 *  is windowed, not complete. Realtime INSERTs continue to apply on top. */
export const ARTIFACTS_INITIAL_LIMIT = 1000;

const stores = new Map<string, Store>();
const THROTTLE_MS = 500;

function snapshot(store: Store): StoreSnapshot {
  return {
    items: store.items,
    loadedCount: store.loadedCount,
    hasMore: store.hasMore,
    loaded: store.loaded,
    error: store.error,
    loadedAt: store.loadedAt,
  };
}

/** Resolves `true` when the read succeeded, `false` when it failed. */
async function loadStore(threadId: string, store: Store): Promise<boolean> {
  const { data, error } = await supabase
    .from("artifacts")
    .select("id,kind,value,confidence,source,created_at,metadata")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: true })
    .limit(ARTIFACTS_INITIAL_LIMIT);
  // A transient DB/network failure must not masquerade as an empty case. Flag
  // the error and keep whatever we already had so the UI can offer a retry
  // instead of silently rendering "nothing found".
  if (error) {
    store.loaded = true;
    store.error = true;
    const snap = snapshot(store);
    for (const fn of store.subscribers) fn(snap);
    return false;
  }
  const rows = (data ?? []) as Artifact[];
  store.loadedCount = rows.length;
  store.hasMore = rows.length >= ARTIFACTS_INITIAL_LIMIT;
  store.items = dedupeArtifacts(rows);
  store.loaded = true;
  store.error = false;
  store.loadedAt = Date.now();
  const snap = snapshot(store);
  for (const fn of store.subscribers) fn(snap);
  return true;
}

/**
 * Apply a single realtime event to the in-memory store. Supabase's
 * postgres_changes payload includes `eventType`, `new` (for INSERT/UPDATE),
 * and `old` (for UPDATE/DELETE) so we can mutate `store.items` in-place
 * without re-fetching. Falls through to loadStore() if the payload is
 * missing fields we need (defensive — Supabase can drop columns in
 * row-level filters).
 */
function applyDelta(
  store: Store,
  eventType: "INSERT" | "UPDATE" | "DELETE",
  newRow: Partial<Artifact> | null,
  oldRow: Partial<Artifact> | null,
): boolean {
  if (eventType === "INSERT" && newRow && newRow.id) {
    const exists = store.items.some((a) => a.id === newRow.id);
    if (!exists) {
      store.items = dedupeArtifacts([...store.items, newRow as Artifact]);
    }
    return true;
  }
  if (eventType === "UPDATE" && newRow && newRow.id) {
    const next = store.items.map((a) => (a.id === newRow.id ? (newRow as Artifact) : a));
    store.items = dedupeArtifacts(next);
    return true;
  }
  if (eventType === "DELETE" && oldRow && oldRow.id) {
    const next = store.items.filter((a) => a.id !== oldRow.id);
    if (next.length !== store.items.length) {
      store.items = next;
      return true;
    }
  }
  return false;
}

function scheduleReload(threadId: string, store: Store) {
  // Coalesce: if a reload is already pending, do nothing.
  if (store.pendingReload !== null) return;
  store.pendingReload = setTimeout(() => {
    store.pendingReload = null;
    void loadStore(threadId, store);
  }, THROTTLE_MS);
}

function acquireStore(threadId: string, listener: (snapshot: StoreSnapshot) => void): Store {
  let store = stores.get(threadId);
  if (!store) {
    store = {
      items: [],
      loadedCount: 0,
      hasMore: false,
      loaded: false,
      error: false,
      loadedAt: null,
      subscribers: new Set(),
      channel: null,
      loading: null,
      refCount: 0,
      pendingReload: null,
      subscribed: false,
      onVisible: null,
    };
    stores.set(threadId, store);
    store.loading = loadStore(threadId, store);
    store.channel = supabase
      .channel(`artifacts-${threadId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "artifacts", filter: `thread_id=eq.${threadId}` },
        (payload) => {
          const ev = payload.eventType;
          if (ev !== "INSERT" && ev !== "UPDATE" && ev !== "DELETE") return;
          const parsedNew = realtimeArtifactSchema.safeParse(payload.new);
          const parsedOld = realtimeArtifactSchema.safeParse(payload.old);
          const newRow = parsedNew.success ? parsedNew.data : null;
          const oldRow = parsedOld.success ? parsedOld.data : null;
          const merged = applyDelta(store!, ev, newRow, oldRow);
          if (merged) {
            // Local merge succeeded — notify subscribers without a DB round-trip.
            const snap = snapshot(store!);
            for (const fn of store!.subscribers) fn(snap);
          } else {
            // Payload was missing fields; fall back to a (throttled) full reload.
            scheduleReload(threadId, store!);
          }
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "threads", filter: `id=eq.${threadId}` },
        (payload) => {
          // When the run reaches a terminal status, artifact INSERTs made during
          // a realtime gap (e.g. a CPU-killed isolate whose socket dropped before
          // the recovery INSERTs landed) may have been missed, freezing the count
          // (the "0 evidence on a finished run" bug). Reconcile from persistence —
          // the same self-heal useThreadToolActivity already performs.
          const next = (payload.new as { status?: string } | null)?.status;
          if (next === "finished" || next === "stopped") {
            void loadStore(threadId, store!);
          }
        },
      )
      .subscribe((status) => {
        if (status !== "SUBSCRIBED") return;
        // A second SUBSCRIBED means the channel recovered after disconnecting;
        // reload in case artifact events were missed while it was down.
        if (store!.subscribed) void loadStore(threadId, store!);
        store!.subscribed = true;
      });

    // Every self-heal above is realtime-dependent: the INSERT event, the
    // terminal-status flip, and the re-SUBSCRIBED reconcile all need a live
    // socket. A backgrounded tab whose socket dies gets none of them, and a
    // CPU-killed run never flips status cleanly either (it is recovered later
    // by the health sweep), so the count can stay stale indefinitely — the
    // "second run wrote five artifacts, badge still reads three" case.
    //
    // Returning to the tab is the one signal that does not depend on the
    // socket, so reconcile from persistence there. Not throttled: visibility
    // changes are user-driven and inherently low-frequency.
    if (typeof document !== "undefined") {
      store.onVisible = () => {
        if (document.visibilityState !== "visible") return;
        void loadStore(threadId, stores.get(threadId) ?? store!);
      };
      document.addEventListener("visibilitychange", store.onVisible);
    }
  }
  store.subscribers.add(listener);
  store.refCount += 1;
  return store;
}

function releaseStore(threadId: string, listener: (snapshot: StoreSnapshot) => void) {
  const store = stores.get(threadId);
  if (!store) return;
  store.subscribers.delete(listener);
  store.refCount -= 1;
  if (store.refCount <= 0) {
    if (store.channel) supabase.removeChannel(store.channel);
    if (store.pendingReload !== null) clearTimeout(store.pendingReload);
    if (store.onVisible && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", store.onVisible);
    }
    stores.delete(threadId);
  }
}

export function useThreadArtifacts(threadId: string) {
  const seed = stores.get(threadId);
  const [snap, setSnap] = useState<StoreSnapshot>(() => ({
    items: seed?.items ?? [],
    loadedCount: seed?.loadedCount ?? 0,
    hasMore: seed?.hasMore ?? false,
    loaded: seed?.loaded ?? false,
    error: seed?.error ?? false,
    loadedAt: seed?.loadedAt ?? null,
  }));

  useEffect(() => {
    if (!threadId) return;
    const listener = (next: StoreSnapshot) => setSnap(next);
    const store = acquireStore(threadId, listener);
    // Seed with whatever's already cached so the first paint isn't empty.
    setSnap(snapshot(store));
    return () => releaseStore(threadId, listener);
  }, [threadId]);

  const updateLocal = (a: Artifact) => {
    const store = stores.get(threadId);
    if (!store) return;
    store.items = store.items.map((x) => (x.id === a.id ? a : x));
    const next = snapshot(store);
    for (const fn of store.subscribers) fn(next);
  };

  // Force a fresh SELECT — used by the evidence surfaces' error-retry affordance
  // and by the case header's Refresh. Resolves once that read has settled —
  // `true` if it succeeded, `false` if it failed and the old rows were kept — so
  // a caller reconciling several sources can publish them together, and never
  // call a refresh that kept stale rows a successful one.
  const reload = (): Promise<boolean> => {
    const store = stores.get(threadId);
    return store ? loadStore(threadId, store) : Promise.resolve(true);
  };
  const retry = () => { void reload(); };

  // Memoised on the store's array: a fresh `filter()` on every render handed
  // consumers a new `items` identity each time, so anything memoised on it —
  // the case snapshot most of all — recomputed and republished forever.
  const userItems = useMemo(() => snap.items.filter((a) => !isMetaArtifact(a)), [snap.items]);
  const metaItems = useMemo(() => snap.items.filter(isMetaArtifact), [snap.items]);
  return {
    items: userItems,
    metaItems,
    allItems: snap.items,
    updateLocal,
    loadedCount: snap.loadedCount,
    hasMore: snap.hasMore,
    cap: ARTIFACTS_INITIAL_LIMIT,
    // Distinct load states so a transient failure isn't shown as "empty".
    loading: !snap.loaded,
    error: snap.error,
    loadedAt: snap.loadedAt,
    retry,
    reload,
  };
}
