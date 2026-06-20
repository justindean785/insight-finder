import { useEffect, useState } from "react";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";

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
const META_KINDS = new Set(["triage_decision"]);
function isMeta(a: Artifact): boolean {
  if (META_KINDS.has(a.kind.toLowerCase())) return true;
  const meta = (a.metadata ?? {}) as Record<string, unknown>;
  return meta.label === "triage_decision";
}

function dedupeArtifacts(rows: Artifact[]): Artifact[] {
  const seen = new Map<string, Artifact>();
  for (const a of rows) {
    const norm = normalizeValue(a.kind, a.value);
    const key = `${a.kind.toLowerCase()}|${norm}`;
    const prev = seen.get(key);
    if (!prev) {
      const md = { ...(a.metadata ?? {}) } as Record<string, unknown>;
      const sources = new Set<string>([
        ...((md.sources as string[] | undefined) ?? []),
        ...(a.source ? [a.source] : []),
      ]);
      md.sources = Array.from(sources);
      seen.set(key, { ...a, metadata: md });
      continue;
    }
    const prevMd = (prev.metadata ?? {}) as Record<string, unknown>;
    const sources = new Set<string>([
      ...((prevMd.sources as string[] | undefined) ?? []),
      ...(prev.source ? [prev.source] : []),
      ...(a.source ? [a.source] : []),
    ]);
    const prevReviewed = prevMd.reviewed === true;
    const nextReviewed = a.metadata?.reviewed === true;
    seen.set(key, {
      ...prev,
      confidence: Math.max(prev.confidence ?? 0, a.confidence ?? 0) || prev.confidence,
      metadata: {
        ...prevMd,
        ...(a.metadata ?? {}),
        sources: Array.from(sources),
        reviewed: prevReviewed || nextReviewed,
      },
    });
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
  subscribers: Set<(snapshot: StoreSnapshot) => void>;
  channel: ReturnType<typeof supabase.channel> | null;
  loading: Promise<void> | null;
  refCount: number;
  // Throttle: coalesce bursts of realtime events into at most one full
  // reload per THROTTLE_MS. Protects against event storms (e.g. a single
  // scan inserting 50+ rows in <100ms) hammering the DB.
  pendingReload: ReturnType<typeof setTimeout> | null;
};

type StoreSnapshot = {
  items: Artifact[];
  loadedCount: number;
  hasMore: boolean;
};

/** Hard cap on initial artifact load per thread. Large investigations
 *  surface a UI warning when this is hit so the analyst knows the view
 *  is windowed, not complete. Realtime INSERTs continue to apply on top. */
export const ARTIFACTS_INITIAL_LIMIT = 1000;

const stores = new Map<string, Store>();
const THROTTLE_MS = 500;

function snapshot(store: Store): StoreSnapshot {
  return { items: store.items, loadedCount: store.loadedCount, hasMore: store.hasMore };
}

async function loadStore(threadId: string, store: Store) {
  const { data } = await supabase
    .from("artifacts")
    .select("id,kind,value,confidence,source,created_at,metadata")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: true })
    .limit(ARTIFACTS_INITIAL_LIMIT);
  const rows = (data ?? []) as Artifact[];
  store.loadedCount = rows.length;
  store.hasMore = rows.length >= ARTIFACTS_INITIAL_LIMIT;
  store.items = dedupeArtifacts(rows);
  const snap = snapshot(store);
  for (const fn of store.subscribers) fn(snap);
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
      subscribers: new Set(),
      channel: null,
      loading: null,
      refCount: 0,
      pendingReload: null,
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
      .subscribe();
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
    stores.delete(threadId);
  }
}

export function useThreadArtifacts(threadId: string) {
  const seed = stores.get(threadId);
  const [snap, setSnap] = useState<StoreSnapshot>(() => ({
    items: seed?.items ?? [],
    loadedCount: seed?.loadedCount ?? 0,
    hasMore: seed?.hasMore ?? false,
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

  const userItems = snap.items.filter((a) => !isMeta(a));
  const metaItems = snap.items.filter(isMeta);
  return {
    items: userItems,
    metaItems,
    allItems: snap.items,
    updateLocal,
    loadedCount: snap.loadedCount,
    hasMore: snap.hasMore,
    cap: ARTIFACTS_INITIAL_LIMIT,
  };
}
