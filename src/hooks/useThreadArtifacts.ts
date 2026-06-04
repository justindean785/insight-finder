import { useEffect, useState } from "react";
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
    const prevReviewed = (prevMd as any)?.reviewed === true;
    const nextReviewed = (a.metadata as any)?.reviewed === true;
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
  subscribers: Set<(items: Artifact[]) => void>;
  channel: ReturnType<typeof supabase.channel> | null;
  loading: Promise<void> | null;
  refCount: number;
};
const stores = new Map<string, Store>();

async function loadStore(threadId: string, store: Store) {
  const { data } = await supabase
    .from("artifacts")
    .select("id,kind,value,confidence,source,created_at,metadata")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: true });
  store.items = dedupeArtifacts((data ?? []) as Artifact[]);
  for (const fn of store.subscribers) fn(store.items);
}

function acquireStore(threadId: string, listener: (items: Artifact[]) => void): Store {
  let store = stores.get(threadId);
  if (!store) {
    store = { items: [], subscribers: new Set(), channel: null, loading: null, refCount: 0 };
    stores.set(threadId, store);
    store.loading = loadStore(threadId, store);
    store.channel = supabase
      .channel(`artifacts-${threadId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "artifacts", filter: `thread_id=eq.${threadId}` },
        () => { void loadStore(threadId, store!); },
      )
      .subscribe();
  }
  store.subscribers.add(listener);
  store.refCount += 1;
  return store;
}

function releaseStore(threadId: string, listener: (items: Artifact[]) => void) {
  const store = stores.get(threadId);
  if (!store) return;
  store.subscribers.delete(listener);
  store.refCount -= 1;
  if (store.refCount <= 0) {
    if (store.channel) supabase.removeChannel(store.channel);
    stores.delete(threadId);
  }
}

export function useThreadArtifacts(threadId: string) {
  const [items, setItems] = useState<Artifact[]>(() => stores.get(threadId)?.items ?? []);

  useEffect(() => {
    if (!threadId) return;
    const listener = (next: Artifact[]) => setItems(next);
    const store = acquireStore(threadId, listener);
    // Seed with whatever's already cached so the first paint isn't empty.
    setItems(store.items);
    return () => releaseStore(threadId, listener);
  }, [threadId]);

  const updateLocal = (a: Artifact) => {
    const store = stores.get(threadId);
    if (!store) return;
    store.items = store.items.map((x) => (x.id === a.id ? a : x));
    for (const fn of store.subscribers) fn(store.items);
  };

  const userItems = items.filter((a) => !isMeta(a));
  const metaItems = items.filter(isMeta);
  return { items: userItems, metaItems, allItems: items, updateLocal };
}