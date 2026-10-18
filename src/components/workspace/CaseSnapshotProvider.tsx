import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useThreadArtifacts } from "@/hooks/useThreadArtifacts";
import { useThreadToolActivity } from "@/hooks/useThreadToolActivity";
import { CaseSnapshotContext, type CaseSnapshot, type CaseSnapshotApi } from "@/hooks/useCaseSnapshot";
import { reloadReviews, useReviewStates, type ReviewState } from "@/lib/review";
import { countVerifiedByAnalyst, tallyAuthority } from "@/lib/authority";
import { buildConfidenceProfile } from "@/lib/confidence-dimensions";
import { withReviewGate } from "@/lib/report-export-gate";
import {
  buildCaseSnapshot,
  CASE_THREAD_COLUMNS,
  diffCaseSnapshots,
  type CaseIntegrity,
  type CaseSnapshotCore,
  type CaseThreadRow,
} from "@/lib/case-snapshot";
import { hasRunMarker } from "@/lib/thread-status";

/**
 * Untrusted boundary: the thread row arrives from PostgREST or a realtime
 * payload. Parsed, never cast — `recovered_at` / `recovery_reason` are not in the
 * generated types, and a realtime payload can omit columns.
 */
const nullableString = z.string().nullable().optional().transform((v) => v ?? null);
const nullableNumber = z
  .union([z.number(), z.string()])
  .nullable()
  .optional()
  .transform((v) => (v === null || v === undefined || v === "" ? null : Number(v)));

const threadRowSchema = z.object({
  id: z.string(),
  seed_value: nullableString,
  seed_type: nullableString,
  status: nullableString,
  credits_used: nullableNumber,
  cost_micro_usd: nullableNumber,
  recovered_at: nullableString,
  recovery_reason: nullableString,
  run_started_at: nullableString,
  last_heartbeat_at: nullableString,
  updated_at: nullableString,
});

function parseThreadRow(raw: unknown): CaseThreadRow | null {
  const parsed = threadRowSchema.safeParse(raw);
  if (!parsed.success) return null;
  const d = parsed.data;
  // Rebuilt field by field: this repo compiles with `strict: false`, under which
  // zod infers every key optional, so the parsed object is not yet a row.
  if (typeof d.id !== "string") return null;
  return {
    id: d.id,
    seed_value: d.seed_value ?? null,
    seed_type: d.seed_type ?? null,
    status: d.status ?? null,
    credits_used: d.credits_used ?? null,
    cost_micro_usd: d.cost_micro_usd ?? null,
    recovered_at: d.recovered_at ?? null,
    recovery_reason: d.recovery_reason ?? null,
    run_started_at: d.run_started_at ?? null,
    last_heartbeat_at: d.last_heartbeat_at ?? null,
    updated_at: d.updated_at ?? null,
  };
}

const integritySchema = z.object({
  ok: z.boolean().nullable().optional(),
  total: z.union([z.number(), z.string()]).nullable().optional(),
  first_break: z.union([z.number(), z.string()]).nullable().optional(),
});

/** Fields whose change means the case moved — a status flip, a recovery stamp, a
 *  cost checkpoint, a new run. A heartbeat-only update is not one of them. */
const MATERIAL_FIELDS: (keyof CaseThreadRow)[] = [
  "status", "recovery_reason", "recovered_at", "cost_micro_usd", "run_started_at", "seed_value", "seed_type",
];

/** How long a reconcile may run before "Syncing case…" is shown — a fast one
 *  should not flicker the header. */
const SYNC_LABEL_DELAY_MS = 400;
/** Poll cadence while a run is live. The backend heartbeat is the primary
 *  signal; this is the fallback for a socket that has quietly died. */
const LIVE_POLL_MS = 30_000;
/** One automatic re-read this long after a failed one. A phone resuming a
 *  backgrounded tab re-reads before its network or auth token has woken up, and
 *  nothing else re-reads a case that is not live — so one failed read on a
 *  finished case used to stay "Sync failed" until the analyst tapped refresh. */
const SYNC_RETRY_MS = 2_000;

let channelSeq = 0;

function sameCore(a: CaseSnapshotCore, b: CaseSnapshotCore): boolean {
  return (
    a.threadId === b.threadId &&
    a.hydrated === b.hydrated &&
    a.run.state === b.run.state &&
    a.run.recoveryReason === b.run.recoveryReason &&
    a.run.recoveredAt === b.run.recoveredAt &&
    a.run.heartbeatAt === b.run.heartbeatAt &&
    a.run.startedAt === b.run.startedAt &&
    a.seed.value === b.seed.value &&
    a.seed.type === b.seed.type &&
    a.items === b.items &&
    a.tools.events === b.tools.events &&
    a.tools.total === b.tools.total &&
    a.tools.available === b.tools.available &&
    a.evidence.available === b.evidence.available &&
    a.evidence.ledger === b.evidence.ledger &&
    a.authority === b.authority &&
    a.verifiedByAnalyst === b.verifiedByAnalyst &&
    a.spend.microUsd === b.spend.microUsd &&
    a.readiness?.pct === b.readiness?.pct &&
    a.readiness?.reportReady === b.readiness?.reportReady &&
    a.readiness?.profile === b.readiness?.profile &&
    a.integrity?.ok === b.integrity?.ok &&
    a.integrity?.total === b.integrity?.total &&
    a.updatedAt === b.updatedAt
  );
}

/**
 * Owns the case snapshot for one thread. Mount it ONCE per workspace page, above
 * the header, the tab bar and every tab.
 */
export function CaseSnapshotProvider({ threadId, children }: { threadId: string; children: ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const accountId = user?.id ?? "";
  const artifacts = useThreadArtifacts(threadId);
  const tools = useThreadToolActivity(threadId, accountId);
  const review = useReviewStates(threadId);

  const [thread, setThread] = useState<CaseThreadRow | null>(null);
  const [threadLoaded, setThreadLoaded] = useState(false);
  const [integrity, setIntegrity] = useState<CaseIntegrity | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [showSyncing, setShowSyncing] = useState(false);
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const [syncError, setSyncError] = useState(false);
  /** Bumped by every failed reconcile, so the retry below re-evaluates after a
   *  failure even when `syncError` was already true (it does not change). */
  const [failedReads, setFailedReads] = useState(0);
  const [chatRunning, setChatRunning] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const threadRef = useRef<CaseThreadRow | null>(null);
  threadRef.current = thread;
  const reconcileSeq = useRef(0);
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);

  // The reloads each source exposes, held in a ref so `reconcile` keeps a stable
  // identity while those callbacks are re-created on every render.
  const sourcesRef = useRef({ reloadTools: tools.reload, reloadArtifacts: artifacts.reload });
  sourcesRef.current = { reloadTools: tools.reload, reloadArtifacts: artifacts.reload };

  const fetchThread = useCallback(async (): Promise<CaseThreadRow | null> => {
    const { data, error } = await supabase.from("threads").select(CASE_THREAD_COLUMNS).eq("id", threadId).maybeSingle();
    if (error) throw new Error(error.message);
    return data ? parseThreadRow(data) : null;
  }, [threadId]);

  /**
   * The custody chain's verdict, or `null` when the check did not run. A failed
   * RPC, a missing row or a row without an `ok` field is NOT evidence of
   * tampering — coercing it to `ok: false` put "chain broken at entry #null" in
   * the header on a transport error. Same rule as CustodyTab's Verify.
   */
  const fetchIntegrity = useCallback(async (): Promise<CaseIntegrity | null> => {
    const [{ count, error: countError }, { data: v, error: rpcError }] = await Promise.all([
      supabase.from("evidence_log").select("id", { count: "exact", head: true }).eq("thread_id", threadId),
      supabase.rpc("verify_evidence_chain", { _thread_id: threadId }),
    ]);
    if (rpcError) return null;
    const parsed = integritySchema.safeParse(Array.isArray(v) ? v[0] : v);
    const row = parsed.success ? parsed.data : null;
    if (!row || typeof row.ok !== "boolean") return null;
    const rawTotal = row.total ?? (countError ? null : count);
    const total = rawTotal === null || rawTotal === undefined ? NaN : Number(rawTotal);
    if (!Number.isFinite(total)) return null;
    const firstBreak = row.first_break === null || row.first_break === undefined ? null : Number(row.first_break);
    return { ok: row.ok, total, firstBreak };
  }, [threadId]);

  /**
   * Re-read EVERY source, then publish once. While this runs, publication is
   * frozen at the last version — so a thread row that already says "finished"
   * can never be shown beside a tool count from before the run ended.
   */
  const reconcile = useCallback(async (): Promise<void> => {
    const token = ++reconcileSeq.current;
    setReconciling(true);
    const labelTimer = setTimeout(() => {
      if (aliveRef.current && reconcileSeq.current === token) setShowSyncing(true);
    }, SYNC_LABEL_DELAY_MS);
    try {
      const [row, integ, toolsRead, artifactsRead] = await Promise.all([
        fetchThread(),
        fetchIntegrity(),
        sourcesRef.current.reloadTools(),
        sourcesRef.current.reloadArtifacts(),
        // Verdicts used to load once per page, so a second tab (or a verdict
        // written elsewhere) kept a stale "verified" figure forever. Re-read
        // them with every other source. Not part of the "synced" claim below:
        // a failed review read keeps the cached verdicts and says so itself.
        reloadReviews(threadId).catch(() => undefined),
      ]);
      if (!aliveRef.current || reconcileSeq.current !== token) return;
      // Batched with setReconciling(false) below: one render, one version.
      if (row) setThread(row);
      setThreadLoaded(true);
      // A custody check that did not run keeps the last verdict; it never
      // replaces a real one with an invented one.
      if (integ) setIntegrity(integ);
      // "Synced" is a claim that EVERY source was just read. The tool and
      // artifact stores keep their last rows on a failed read, so without this
      // check a refresh that only kept stale counts was stamped as a fresh sync.
      if (integ && toolsRead && artifactsRead) {
        setSyncedAt(Date.now());
        setSyncError(false);
      } else {
        setSyncError(true);
        setFailedReads((n) => n + 1);
      }
    } catch {
      if (aliveRef.current && reconcileSeq.current === token) {
        setSyncError(true);
        setFailedReads((n) => n + 1);
      }
    } finally {
      clearTimeout(labelTimer);
      if (aliveRef.current && reconcileSeq.current === token) {
        setReconciling(false);
        setShowSyncing(false);
      }
    }
  }, [fetchThread, fetchIntegrity, threadId]);

  // Hydration: the shared stores load themselves on first subscribe; this reads
  // the thread row and the custody chain alongside them.
  useEffect(() => {
    let alive = true;
    setThread(null);
    setThreadLoaded(false);
    setIntegrity(null);
    setSyncedAt(null);
    setSyncError(false);
    (async () => {
      try {
        const [row, integ] = await Promise.all([fetchThread(), fetchIntegrity()]);
        if (!alive) return;
        setThread(row);
        setIntegrity(integ);
        if (integ) setSyncedAt(Date.now());
        else setSyncError(true);
      } catch {
        if (alive) setSyncError(true);
      } finally {
        if (alive) setThreadLoaded(true);
      }
    })();
    return () => { alive = false; };
  }, [fetchThread, fetchIntegrity]);

  // Realtime on the thread row (published). A material change reconciles every
  // source; a heartbeat just refreshes liveness in place.
  useEffect(() => {
    const onChange = (payload: unknown) => {
      const next = parseThreadRow((payload as { new?: unknown } | null)?.new);
      const prev = threadRef.current;
      if (!next) { void reconcile(); return; }
      if (!prev || MATERIAL_FIELDS.some((f) => prev[f] !== next[f])) { void reconcile(); return; }
      setThread(next);
    };
    const ch = supabase
      .channel(`case-snapshot-${threadId}-${++channelSeq}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "threads", filter: `id=eq.${threadId}` }, onChange)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [threadId, reconcile]);

  // This tab's own stream: authoritative "running" while open, and a reconcile
  // when it closes (the run just ended; every figure is about to move).
  useEffect(() => {
    setChatRunning(false);
    let wasRunning = false;
    const onRun = (e: Event) => {
      const d = (e as CustomEvent<{ threadId?: string; running?: boolean }>).detail;
      if (!d || d.threadId !== threadId) return;
      const running = Boolean(d.running);
      setChatRunning(running);
      if (wasRunning && !running) void reconcile();
      wasRunning = running;
    };
    window.addEventListener("proximity:run-state", onRun);
    return () => window.removeEventListener("proximity:run-state", onRun);
  }, [threadId, reconcile]);

  // Returning to the tab is the one signal that survives a dead socket.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") void reconcile(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [reconcile]);

  // While a run may be live: tick the clock (so a heartbeat going stale is
  // noticed without an event) and poll as a fallback for a silent socket.
  const maybeLive = chatRunning || ((thread?.status ?? "active") === "active" && hasRunMarker(thread));
  useEffect(() => {
    if (!maybeLive) return;
    const tick = setInterval(() => setNowMs(Date.now()), 5_000);
    const poll = setInterval(() => { if (document.visibilityState === "visible") void reconcile(); }, LIVE_POLL_MS);
    return () => { clearInterval(tick); clearInterval(poll); };
  }, [maybeLive, reconcile]);

  // ── Derivations — each from the SAME source arrays the snapshot carries ──
  // `review.get` is re-created whenever a verdict changes, so it is the dependency
  // that keeps these in step with the ledger — the header once kept calling a
  // dismissed row Verified because its tally was memoised on the rows alone.
  const reviewGet = review.get;
  const authority = useMemo(() => tallyAuthority(artifacts.items, reviewGet), [artifacts.items, reviewGet]);
  const verifiedByAnalyst = useMemo(() => countVerifiedByAnalyst(artifacts.items, reviewGet), [artifacts.items, reviewGet]);
  const reviewMap = useMemo(() => {
    const m: Record<string, ReviewState> = {};
    for (const a of artifacts.items) {
      const r = reviewGet(a.id);
      if (r !== "new") m[a.id] = r;
    }
    return m;
  }, [artifacts.items, reviewGet]);
  // Report-ready fails closed until the verdicts are actually read: while they
  // load, or during an outage, `reviewMap` is empty, and a row the analyst
  // dismissed would otherwise count toward a report-safe export.
  const reviewAvailability = review.availability;
  const readiness = useMemo(
    () => (artifacts.loading
      ? null
      : withReviewGate(
        buildConfidenceProfile({ artifacts: artifacts.items, seedValue: thread?.seed_value ?? null, reviews: reviewMap }),
        reviewAvailability,
      )),
    [artifacts.loading, artifacts.items, thread?.seed_value, reviewMap, reviewAvailability],
  );

  const core = useMemo(
    () => buildCaseSnapshot({
      threadId,
      accountReady: !authLoading && Boolean(accountId),
      thread,
      threadLoaded,
      artifacts: { items: artifacts.items, loading: artifacts.loading, error: artifacts.error },
      tools: {
        events: tools.events,
        persistedTotal: tools.persistedTotal,
        failed: tools.failed,
        degraded: tools.degraded,
        skipped: tools.skipped,
        gated: tools.gated,
        ok: tools.ok,
        noRecord: tools.noRecord,
        loading: tools.loading,
        error: tools.error,
        loadedAt: tools.loadedAt,
      },
      authority,
      verifiedByAnalyst,
      integrity,
      readiness,
      chatRunning,
      nowMs,
    }),
    [
      threadId, authLoading, accountId, thread, threadLoaded,
      artifacts.items, artifacts.loading, artifacts.error,
      tools.events, tools.persistedTotal, tools.failed, tools.degraded, tools.skipped, tools.gated, tools.ok, tools.noRecord,
      tools.loading, tools.error, tools.loadedAt,
      authority, verifiedByAnalyst, integrity, readiness, chatRunning, nowMs,
    ],
  );

  // ── Publication — frozen while a reconcile is in flight ─────────────────
  // The shared stores also re-read on their own (heartbeat, refocus). A failure
  // there keeps the old rows too, so it is a sync failure as much as one here.
  const sourceError = syncError || tools.error || artifacts.error;
  // ONE automatic retry per failure. If the retry fails too the label stays
  // "Sync failed" — a second failure is a real fault, not a phone waking up —
  // and the next success re-arms it. A hidden tab does not spend the retry:
  // returning to it re-reads (the visibilitychange handler above), and if THAT
  // read fails, `failedReads` moves and the retry is still there to use.
  const retriedRef = useRef(false);
  useEffect(() => {
    if (!sourceError) {
      retriedRef.current = false;
      return;
    }
    if (retriedRef.current) return;
    const t = setTimeout(() => {
      if (!aliveRef.current || document.visibilityState !== "visible") return;
      retriedRef.current = true;
      void reconcile();
    }, SYNC_RETRY_MS);
    return () => clearTimeout(t);
  }, [sourceError, failedReads, reconcile]);

  const [published, setPublished] = useState<CaseSnapshot | null>(null);
  useEffect(() => {
    if (reconciling) return;
    setPublished((prev) => {
      if (prev && prev.threadId === core.threadId && sameCore(prev, core) && prev.syncedAt === syncedAt && prev.syncError === sourceError) {
        return prev;
      }
      const sameThread = prev?.threadId === core.threadId;
      const changes = sameThread ? diffCaseSnapshots(prev, core) : [];
      const at = Date.now();
      return {
        ...core,
        version: sameThread && prev ? prev.version + 1 : 1,
        capturedAt: at,
        syncing: false,
        syncedAt,
        syncError: sourceError,
        lastChange: changes.length > 0 ? { changes, at } : sameThread && prev ? prev.lastChange : null,
      };
    });
  }, [core, reconciling, syncedAt, sourceError]);

  const snapshot = useMemo<CaseSnapshot | null>(() => {
    if (!published || published.threadId !== threadId) return null;
    return showSyncing === published.syncing ? published : { ...published, syncing: showSyncing };
  }, [published, showSyncing, threadId]);

  const api = useMemo<CaseSnapshotApi>(() => ({ snapshot, refresh: reconcile }), [snapshot, reconcile]);

  return <CaseSnapshotContext.Provider value={api}>{children}</CaseSnapshotContext.Provider>;
}
