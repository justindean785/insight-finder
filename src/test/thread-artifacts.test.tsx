import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useThreadArtifacts } from "@/hooks/useThreadArtifacts";
import { isClusterIneligible } from "@/lib/report-hygiene";
import { wrapJsonExport, type ExportGate } from "@/lib/report-export-gate";
import { computePivots } from "@/lib/pivot-engine";
import { artifactsToSources } from "@/lib/audit/from-artifacts";
import { adjustedConfidence, labelForArtifact } from "@/lib/intel";
import { displayConfidence } from "@/lib/display-confidence";
import { stripDerivedItemMetadata, MINOR_DERIVED_MARKER } from "@/lib/selector-group";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type TestRow = {
  id: string;
  kind: string;
  value: string;
  confidence: number | null;
  source: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
};

type Binding = {
  table: string;
  callback: (payload: unknown) => void;
};

type TestChannel = {
  active: boolean;
  bindings: Binding[];
  statusCallback?: (status: string) => void;
  on: (event: string, config: { table: string }, callback: (payload: unknown) => void) => TestChannel;
  subscribe: (callback?: (status: string) => void) => TestChannel;
};

const mock = vi.hoisted(() => ({
  rowsByThread: new Map<string, TestRow[]>(),
  channels: [] as TestChannel[],
  queriedTables: [] as string[],
}));

const mountedRoots: Root[] = [];

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from(table: string) {
      mock.queriedTables.push(table);
      let threadId = "";
      const query = {
        select: () => query,
        eq: (_column: string, value: string) => {
          threadId = value;
          return query;
        },
        order: () => query,
        // Artifacts load ends in `.limit()`, which resolves the query.
        limit: () => Promise.resolve({ data: mock.rowsByThread.get(threadId) ?? [], error: null }),
      };
      return query;
    },
    channel() {
      const channel: TestChannel = {
        active: true,
        bindings: [],
        on: (_event, config, callback) => {
          channel.bindings.push({ table: config.table, callback });
          return channel;
        },
        subscribe: (callback) => {
          channel.statusCallback = callback;
          callback?.("SUBSCRIBED");
          return channel;
        },
      };
      mock.channels.push(channel);
      return channel;
    },
    removeChannel(channel: TestChannel) {
      channel.active = false;
    },
  },
}));

// Distinct artifacts (unique kind|value) so none collapse under dedupe and
// items.length equals the raw row count — the number the header renders.
function artifacts(count: number): TestRow[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `art-${index}`,
    kind: "email",
    value: `user${index}@example.com`,
    confidence: 50,
    source: `tool_${index}`,
    created_at: new Date(1_700_000_000_000 + index).toISOString(),
    metadata: null,
  }));
}

async function emit(table: string, payload: unknown) {
  await act(async () => {
    for (const channel of mock.channels) {
      if (!channel.active) continue;
      for (const binding of channel.bindings) {
        if (binding.table === table) binding.callback(payload);
      }
    }
  });
}

function renderArtifactsHook(threadId: string) {
  const container = document.createElement("div");
  const root = createRoot(container);
  const snapshot: { current: ReturnType<typeof useThreadArtifacts> | null } = { current: null };

  function HookHarness(props: { threadId: string }) {
    snapshot.current = useThreadArtifacts(props.threadId);
    return null;
  }

  const render = (props: { threadId: string }) => {
    act(() => root.render(<HookHarness {...props} />));
  };
  render({ threadId });
  mountedRoots.push(root);

  return {
    result: {
      get current() {
        if (!snapshot.current) throw new Error("Hook did not render");
        return snapshot.current;
      },
    },
  };
}

async function waitFor(assertion: () => void) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
  }
  throw lastError;
}

describe("useThreadArtifacts terminal-status reconciliation", () => {
  beforeEach(() => {
    mock.rowsByThread.clear();
    mock.channels.length = 0;
    mock.queriedTables.length = 0;
  });

  afterEach(() => {
    for (const root of mountedRoots.splice(0)) {
      act(() => root.unmount());
    }
  });

  it("loads persisted artifacts on mount", async () => {
    mock.rowsByThread.set("thread-a", artifacts(3));
    const { result } = renderArtifactsHook("thread-a");
    await waitFor(() => expect(result.current.items).toHaveLength(3));
  });

  // The bug this fixes: when the realtime socket drops during a CPU-kill, the
  // artifact INSERTs from server-side recovery are missed and the count freezes
  // (e.g. "0 evidence"). The terminal-status flip must trigger a full refetch —
  // the same self-heal the sibling tools count already has.
  it("refetches when the run reaches a terminal status (finished)", async () => {
    mock.rowsByThread.set("thread-b", artifacts(1));
    const { result } = renderArtifactsHook("thread-b");
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    // Realtime missed these INSERTs; DB now holds the true count.
    mock.rowsByThread.set("thread-b", artifacts(23));
    await emit("threads", { new: { id: "thread-b", status: "finished" } });

    await waitFor(() => expect(result.current.items).toHaveLength(23));
  });

  it("refetches when the run is stopped", async () => {
    mock.rowsByThread.set("thread-c", artifacts(2));
    const { result } = renderArtifactsHook("thread-c");
    await waitFor(() => expect(result.current.items).toHaveLength(2));

    mock.rowsByThread.set("thread-c", artifacts(9));
    await emit("threads", { new: { id: "thread-c", status: "stopped" } });

    await waitFor(() => expect(result.current.items).toHaveLength(9));
  });

  it("does NOT refetch on a non-terminal threads update (still active)", async () => {
    mock.rowsByThread.set("thread-d", artifacts(4));
    const { result } = renderArtifactsHook("thread-d");
    await waitFor(() => expect(result.current.items).toHaveLength(4));
    const queryCount = mock.queriedTables.length;

    mock.rowsByThread.set("thread-d", artifacts(99));
    await emit("threads", { new: { id: "thread-d", status: "active" } });

    // No extra query fired; count unchanged.
    expect(mock.queriedTables).toHaveLength(queryCount);
    expect(result.current.items).toHaveLength(4);
  });

  it("refetches after a realtime reconnect (second SUBSCRIBED)", async () => {
    mock.rowsByThread.set("thread-e", artifacts(1));
    const { result } = renderArtifactsHook("thread-e");
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    mock.rowsByThread.set("thread-e", artifacts(7));
    // The artifacts store owns exactly one channel; re-fire SUBSCRIBED to
    // simulate the socket recovering after a disconnect.
    await act(async () => { mock.channels[0].statusCallback?.("SUBSCRIBED"); });

    await waitFor(() => expect(result.current.items).toHaveLength(7));
  });

  // The gap the tests above do NOT cover, observed on thread dd2514e3 (2026-08-06):
  // a second run in an already-terminal thread wrote five artifacts at 10:14, and
  // the Evidence badge stayed on the three rows from 09:02.
  //
  // Every existing self-heal is realtime-dependent: the INSERT event, the
  // terminal-status flip, and the re-SUBSCRIBED reconcile all require a live
  // socket. When the socket is dead none of them fire — and that run was
  // CPU-killed (recovery_reason "stale heartbeat recovered by health sweep"),
  // so it never flipped status cleanly either. The count then stays stale
  // indefinitely, because nothing re-reads persistence until the store is torn
  // down and rebuilt (a reload or a re-navigation).
  //
  // Returning to the tab is the one signal that does not depend on the socket.
  it("reconciles from persistence when the tab becomes visible again", async () => {
    mock.rowsByThread.set("thread-f", artifacts(3));
    const { result } = renderArtifactsHook("thread-f");
    await waitFor(() => expect(result.current.items).toHaveLength(3));

    // Rows landed while the socket was down: no INSERT event, no terminal flip.
    mock.rowsByThread.set("thread-f", artifacts(9));
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await waitFor(() => expect(result.current.items).toHaveLength(9));
  });

  it("does NOT reconcile while the tab is still hidden", async () => {
    mock.rowsByThread.set("thread-g", artifacts(4));
    const { result } = renderArtifactsHook("thread-g");
    await waitFor(() => expect(result.current.items).toHaveLength(4));
    const queryCount = mock.queriedTables.length;

    const original = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    try {
      mock.rowsByThread.set("thread-g", artifacts(99));
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(mock.queriedTables).toHaveLength(queryCount);
      expect(result.current.items).toHaveLength(4);
    } finally {
      delete (document as unknown as Record<string, unknown>).visibilityState;
      if (original) Object.defineProperty(Document.prototype, "visibilityState", original);
    }
  });

  it("stops reconciling once the last subscriber has unmounted", async () => {
    mock.rowsByThread.set("thread-h", artifacts(2));
    renderArtifactsHook("thread-h");
    await waitFor(() => expect(mock.queriedTables.length).toBeGreaterThan(0));

    for (const root of mountedRoots.splice(0)) act(() => root.unmount());
    const queryCount = mock.queriedTables.length;

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    // A leaked listener would keep querying for a thread nobody is watching.
    expect(mock.queriedTables).toHaveLength(queryCount);
  });
});

// ---------------------------------------------------------------------------
// Dedupe must never let one database row donate authority to another.
//
// Measured on a live case (thread 16065613, 2026-09-13): 118 artifact rows were
// displayed — and exported — as 113. All five collapsed pairs carried DIFFERENT
// authority, and the old merge spread the LATER row's metadata over the first:
// an analyst-confirmed socialfetch name row rendered as `ai_summary`, cap 55,
// in the model's cluster; a breach email picked up a model-written `parent_seed`
// (a cluster merge key); confidence became the max of both rows. A later row
// with `linkage_confirmed: true` released a quarantined row, and a later
// `reviewed: true` would mark an earlier row analyst-confirmed.
//
// Fixtures mirror those production shapes with synthetic values.
// ---------------------------------------------------------------------------

const SEED_NAME: TestRow = {
  id: "row-seed-name",
  kind: "name",
  value: "Jordan Vale",
  confidence: 40,
  source: "socialfetch_lookup",
  created_at: "2026-09-13T11:37:10.883Z",
  metadata: {
    status: "observed",
    source_category: ["social_profile_passive"],
    confidence_cap_applied: 40,
    cluster_id: "clus_seed",
    sources: ["socialfetch_lookup"],
  },
};

const LATER_AI_NAME: TestRow = {
  id: "row-ai-name",
  kind: "name",
  value: "Jordan Vale",
  confidence: 45,
  source: "minimax_correlate",
  created_at: "2026-09-13T11:46:58.116Z",
  metadata: {
    status: "needs_review",
    source_category: ["ai_summary"],
    confidence_cap_applied: 55,
    cluster_id: "clus_ai",
    reason: "age conflict; may be a relative with the same name",
    sources: ["minimax_correlate"],
  },
};

const QUARANTINED_EMAIL: TestRow = {
  id: "row-quarantined-email",
  kind: "email",
  value: "jordan.vale@example.com",
  confidence: 40,
  source: "oathnet_lookup",
  created_at: "2026-09-13T11:37:24.988Z",
  metadata: {
    status: "observed",
    source_category: ["breach"],
    confidence_cap_applied: 60,
    subject_unlinked: true,
    subject_unlinked_reason: "harvested from a name-only query — linkage to the subject is unproven",
    sources: ["oathnet_lookup"],
  },
};

const LATER_RELEASE_CLAIM: TestRow = {
  id: "row-release-claim",
  kind: "email",
  value: "Jordan.Vale@example.com",
  confidence: 65,
  source: "oathnet_lookup + serus_darkweb_scan",
  created_at: "2026-09-13T12:57:29.325Z",
  metadata: {
    status: "observed",
    source_category: ["breach"],
    confidence_cap_applied: 65,
    linkage_confirmed: true,
    sources: ["oathnet_lookup + serus_darkweb_scan"],
  },
};

const TOOL_USERNAME: TestRow = {
  id: "row-tool-username",
  kind: "username",
  value: "jvale80",
  confidence: 45,
  source: "oathnet_lookup",
  created_at: "2026-09-13T12:37:31.037Z",
  metadata: {
    status: "observed",
    source_category: ["breach"],
    confidence_cap_applied: 60,
    cluster_id: "clus_tool",
    sources: ["oathnet_lookup"],
  },
};

const LATER_MODEL_USERNAME: TestRow = {
  id: "row-model-username",
  kind: "username",
  value: "@JVale80",
  confidence: 65,
  source: "oathnet_lookup + serus_darkweb_scan",
  created_at: "2026-09-13T12:57:29.325Z",
  metadata: {
    status: "needs_review",
    source_category: ["breach"],
    confidence_cap_applied: 65,
    cluster_id: "clus_model",
    parent_seed: "jordan.vale.seed",
    reviewed: true,
    sources: ["oathnet_lookup + serus_darkweb_scan"],
  },
};

const DIVERGENT_ROWS: TestRow[] = [
  SEED_NAME,
  QUARANTINED_EMAIL,
  LATER_AI_NAME,
  TOOL_USERNAME,
  LATER_RELEASE_CLAIM,
  LATER_MODEL_USERNAME,
];

type Shown = { source: string | null; confidence: number | null; metadata: Record<string, unknown> | null };

function byId(items: ReadonlyArray<{ id: string } & Shown>): Record<string, Shown> {
  return Object.fromEntries(
    items.map((a) => [a.id, { source: a.source, confidence: a.confidence, metadata: a.metadata }]),
  );
}

describe("useThreadArtifacts dedupe never transfers authority between rows", () => {
  beforeEach(() => {
    mock.rowsByThread.clear();
    mock.channels.length = 0;
    mock.queriedTables.length = 0;
  });

  afterEach(() => {
    for (const root of mountedRoots.splice(0)) {
      act(() => root.unmount());
    }
  });

  it("a later AI-summary row cannot replace the seed row's provenance, confidence or cluster", async () => {
    mock.rowsByThread.set("dedupe-provenance", [SEED_NAME, LATER_AI_NAME]);
    const { result } = renderArtifactsHook("dedupe-provenance");
    await waitFor(() => expect(result.current.loading).toBe(false));

    const shown = byId(result.current.items);
    expect(shown["row-seed-name"]).toEqual({
      source: "socialfetch_lookup",
      confidence: 40,
      metadata: {
        status: "observed",
        source_category: ["social_profile_passive"],
        confidence_cap_applied: 40,
        cluster_id: "clus_seed",
        sources: ["socialfetch_lookup"],
      },
    });
    // The divergent row is disclosed under its own authority, not folded away.
    expect(shown["row-ai-name"]?.metadata?.source_category).toEqual(["ai_summary"]);
  });

  it("a later linkage_confirmed:true cannot release an earlier quarantined row", async () => {
    mock.rowsByThread.set("dedupe-quarantine", [QUARANTINED_EMAIL, LATER_RELEASE_CLAIM]);
    const { result } = renderArtifactsHook("dedupe-quarantine");
    await waitFor(() => expect(result.current.loading).toBe(false));

    const quarantined = result.current.items.find((a) => a.id === "row-quarantined-email");
    expect(quarantined).toBeDefined();
    expect(quarantined!.metadata?.linkage_confirmed).toBeUndefined();
    expect(quarantined!.confidence).toBe(40);
    expect(isClusterIneligible(quarantined!)).toBe(true);
  });

  it("a later row's cluster, status, parent_seed and reviewed flag do not migrate onto an earlier row", async () => {
    mock.rowsByThread.set("dedupe-cluster", [TOOL_USERNAME, LATER_MODEL_USERNAME]);
    const { result } = renderArtifactsHook("dedupe-cluster");
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(byId(result.current.items)["row-tool-username"]).toEqual({
      source: "oathnet_lookup",
      confidence: 45,
      metadata: {
        status: "observed",
        source_category: ["breach"],
        confidence_cap_applied: 60,
        cluster_id: "clus_tool",
        sources: ["oathnet_lookup"],
      },
    });
  });

  it("the same guarantee holds for a row that arrives over realtime", async () => {
    mock.rowsByThread.set("dedupe-realtime", [TOOL_USERNAME]);
    const { result } = renderArtifactsHook("dedupe-realtime");
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    await emit("artifacts", { eventType: "INSERT", new: LATER_MODEL_USERNAME, old: {} });

    const shown = byId(result.current.items);
    expect(shown["row-tool-username"]?.metadata?.cluster_id).toBe("clus_tool");
    expect(shown["row-tool-username"]?.metadata?.reviewed).toBeUndefined();
    expect(shown["row-tool-username"]?.confidence).toBe(45);
    expect(shown["row-model-username"]?.metadata?.cluster_id).toBe("clus_model");
  });

  it("reversing the database row order does not change any row's displayed authority", async () => {
    mock.rowsByThread.set("dedupe-forward", DIVERGENT_ROWS);
    mock.rowsByThread.set("dedupe-reversed", [...DIVERGENT_ROWS].reverse());
    const forward = renderArtifactsHook("dedupe-forward");
    const reversed = renderArtifactsHook("dedupe-reversed");
    await waitFor(() => {
      expect(forward.result.current.loading).toBe(false);
      expect(reversed.result.current.loading).toBe(false);
    });

    expect(byId(reversed.result.current.items)).toEqual(byId(forward.result.current.items));
  });

  it("rows identical in value and authority still collapse, to the earliest row in either order", async () => {
    const early: TestRow = {
      id: "row-dup-early",
      kind: "phone",
      value: "+12025550143",
      confidence: 60,
      source: "oathnet_lookup",
      created_at: "2026-09-13T12:00:00.000Z",
      metadata: { status: "observed", source_category: ["breach"], confidence_cap_applied: 60, sources: ["oathnet_lookup"] },
    };
    const late: TestRow = { ...early, id: "row-dup-late", created_at: "2026-09-13T12:05:00.000Z" };
    mock.rowsByThread.set("dedupe-identical", [early, late]);
    mock.rowsByThread.set("dedupe-identical-reversed", [late, early]);
    const forward = renderArtifactsHook("dedupe-identical");
    const reversed = renderArtifactsHook("dedupe-identical-reversed");
    await waitFor(() => {
      expect(forward.result.current.loading).toBe(false);
      expect(reversed.result.current.loading).toBe(false);
    });

    expect(forward.result.current.items.map((a) => a.id)).toEqual(["row-dup-early"]);
    expect(reversed.result.current.items.map((a) => a.id)).toEqual(["row-dup-early"]);
  });

  it("rows from the same tool at the same confidence still split when only the quarantine flag differs", async () => {
    // One tool, two queries: a name-only harvest (quarantined) and a direct
    // lookup (linked) both return the same email at confidence 40.
    const harvested: TestRow = { ...QUARANTINED_EMAIL, id: "row-harvested" };
    const linked: TestRow = {
      ...QUARANTINED_EMAIL,
      id: "row-linked",
      created_at: "2026-09-13T12:00:00.000Z",
      metadata: { status: "observed", source_category: ["breach"], confidence_cap_applied: 60, sources: ["oathnet_lookup"] },
    };
    for (const [thread, rows] of [
      ["dedupe-flag-only", [harvested, linked]],
      ["dedupe-flag-only-reversed", [linked, harvested]],
    ] as const) {
      mock.rowsByThread.set(thread, [...rows]);
      const { result } = renderArtifactsHook(thread);
      await waitFor(() => expect(result.current.loading).toBe(false));
      const quarantined = result.current.items.find((a) => a.id === "row-harvested");
      expect(quarantined && isClusterIneligible(quarantined)).toBe(true);
      expect(result.current.items.map((a) => a.id).sort()).toEqual(["row-harvested", "row-linked"]);
    }
  });

  it("a higher confidence on a later, otherwise-identical row is not donated to the earlier one", async () => {
    const low: TestRow = { ...TOOL_USERNAME, id: "row-low" };
    const high: TestRow = { ...TOOL_USERNAME, id: "row-high", confidence: 60, created_at: "2026-09-13T12:40:00.000Z" };
    mock.rowsByThread.set("dedupe-confidence-only", [low, high]);
    const { result } = renderArtifactsHook("dedupe-confidence-only");
    await waitFor(() => expect(result.current.loading).toBe(false));

    const shown = byId(result.current.items);
    expect(shown["row-low"]?.confidence).toBe(45);
    expect(shown["row-high"]?.confidence).toBe(60);
  });

  it("a realtime twin of a row with no metadata.sources collapses onto the stored row", async () => {
    const stored: TestRow = {
      id: "row-bare",
      kind: "domain",
      value: "example.com",
      confidence: 50,
      source: "crtsh_lookup",
      created_at: "2026-09-13T12:00:00.000Z",
      metadata: { status: "observed" },
    };
    mock.rowsByThread.set("dedupe-realtime-twin", [stored]);
    const { result } = renderArtifactsHook("dedupe-realtime-twin");
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    await emit("artifacts", {
      eventType: "INSERT",
      new: { ...stored, id: "row-bare-twin", created_at: "2026-09-13T12:01:00.000Z" },
      old: {},
    });

    expect(result.current.items.map((a) => a.id)).toEqual(["row-bare"]);
  });

  it("the JSON export carries each row's own authority", async () => {
    mock.rowsByThread.set("dedupe-export", DIVERGENT_ROWS);
    const { result } = renderArtifactsHook("dedupe-export");
    await waitFor(() => expect(result.current.loading).toBe(false));

    const gate: ExportGate = { mode: "draft", readinessPct: 3, reasons: ["Report readiness is 3%."], mark: "UNVERIFIED DRAFT" };
    const exported = JSON.parse(wrapJsonExport(result.current.items, gate, "2026-09-13T14:17:34.980Z")) as {
      artifacts: Array<{ id: string } & Shown>;
    };
    const rows = byId(exported.artifacts);
    expect(rows["row-seed-name"]?.metadata?.source_category).toEqual(["social_profile_passive"]);
    expect(rows["row-seed-name"]?.metadata?.cluster_id).toBe("clus_seed");
    expect(rows["row-quarantined-email"]?.metadata?.linkage_confirmed).toBeUndefined();
    expect(rows["row-tool-username"]?.metadata?.parent_seed).toBeUndefined();
    expect(Object.keys(rows).sort()).toEqual(DIVERGENT_ROWS.map((r) => r.id).sort());
  });
});

// ---------------------------------------------------------------------------
// Realtime cost + hidden-twin reconciliation (owner-requested follow-up on #593).
//
// Cost. The fingerprint that keeps rows of different authority apart is the WHOLE
// metadata blob, and the first version of the hook re-fingerprinted EVERY row on
// EVERY realtime delta: 50 inserts into a 1,000-row store measured 75 ms on main
// and 663 ms / 4,577 ms for 0.6 KB / 4.9 KB of metadata per row (jsdom). The
// fingerprint of a row that has not changed must not be computed again.
//
// Hidden twins. When two rows collapsed (identical authority), the store kept only
// the survivor, so a later realtime UPDATE of the survivor — or its DELETE — could
// not bring the other row back until a full reload.
// ---------------------------------------------------------------------------

function bigRow(i: number, kb: number): TestRow {
  return {
    id: `perf-${i}`,
    kind: "email",
    value: `perf${i}@example.com`,
    confidence: 50,
    source: `tool_${i % 7}`,
    created_at: new Date(1_700_000_000_000 + i).toISOString(),
    metadata: { status: "observed", source_category: ["breach"], blob: "x".repeat(kb * 1024), n: i },
  };
}

describe("useThreadArtifacts realtime cost and hidden-twin reconciliation", () => {
  beforeEach(() => {
    mock.rowsByThread.clear();
    mock.channels.length = 0;
    mock.queriedTables.length = 0;
  });
  afterEach(() => {
    for (const root of mountedRoots.splice(0)) act(() => root.unmount());
  });

  it("50 realtime inserts into a 1,000-row store of ~5 KB metadata cost a small fraction of the first version's ~4.5 s", async () => {
    mock.rowsByThread.set("perf-a", Array.from({ length: 1000 }, (_, i) => bigRow(i, 5)));
    const { result } = renderArtifactsHook("perf-a");
    await waitFor(() => expect(result.current.items).toHaveLength(1000));

    const t0 = performance.now();
    for (let i = 1000; i < 1050; i++) {
      await emit("artifacts", { eventType: "INSERT", new: bigRow(i, 5), old: null });
    }
    const ms = performance.now() - t0;
    expect(result.current.items).toHaveLength(1050);
    console.info(`[perf] 50 inserts into 1000 rows x 5 KB: ${ms.toFixed(0)} ms`);
    // Measured here (jsdom): first version ~2,000 ms (4,500 ms on a slower machine), this version ~100 ms, main ~70 ms.
    // 600 ms is 3x under the regression and ~6x over the fixed cost, so a slower runner does not flake it.
    expect(ms).toBeLessThan(600);
  });

  it("an UPDATE of a survivor brings its collapsed twin back instead of losing it until reload", async () => {
    const twin = (id: string, created: string): TestRow => ({
      id, kind: "email", value: "twin@example.com", confidence: 60, source: "oathnet_lookup",
      created_at: created, metadata: { status: "observed" },
    });
    mock.rowsByThread.set("twin-a", [twin("t1", "2026-10-01T00:00:00.000Z"), twin("t2", "2026-10-01T00:00:01.000Z")]);
    const { result } = renderArtifactsHook("twin-a");
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(result.current.items[0].id).toBe("t1");

    // The survivor is updated so that it now differs in authority from its twin: both must be visible again.
    await emit("artifacts", {
      eventType: "UPDATE",
      new: { ...twin("t1", "2026-10-01T00:00:00.000Z"), confidence: 30, metadata: { status: "needs_review" } },
      old: { id: "t1" },
    });
    await waitFor(() => expect(result.current.items.map((a) => a.id).sort()).toEqual(["t1", "t2"]));
  });

  it("deleting the survivor of a collapsed pair reveals the other row (no reload needed)", async () => {
    const twin = (id: string, created: string): TestRow => ({
      id, kind: "email", value: "twin2@example.com", confidence: 60, source: "oathnet_lookup",
      created_at: created, metadata: { status: "observed" },
    });
    mock.rowsByThread.set("twin-b", [twin("t1", "2026-10-01T00:00:00.000Z"), twin("t2", "2026-10-01T00:00:01.000Z")]);
    const { result } = renderArtifactsHook("twin-b");
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    await emit("artifacts", { eventType: "DELETE", new: null, old: { id: "t1" } });
    await waitFor(() => expect(result.current.items.map((a) => a.id)).toEqual(["t2"]));
  });
});

// ---------------------------------------------------------------------------
// The minor-safety ceiling is a property of the SELECTOR, not of the row a surface happens to read.
//
// #593 review, finding B1: pivot-engine's minor guard reads ONE row (the candidate's source row), and its own comment says
// the ceiling "must never be restorable by another row". On main the merge spread the flag onto the single merged
// item by accident; with separate rows an unflagged twin was pivotable (`[email:<same address>]` offered) and its value
// was shown unredacted. The flags are copied across the group — and ONLY the flags: never a review, a confidence, a
// source class, a cluster or a quarantine release.
// ---------------------------------------------------------------------------

describe("useThreadArtifacts: a minor-safety flag protects every row of the selector", () => {
  beforeEach(() => {
    mock.rowsByThread.clear();
    mock.channels.length = 0;
    mock.queriedTables.length = 0;
  });
  afterEach(() => {
    for (const root of mountedRoots.splice(0)) act(() => root.unmount());
  });

  const plain = (id: string, created: string, extra: Partial<TestRow> = {}): TestRow => ({
    id, kind: "email", value: "jordan.vale@example.com", confidence: 70, source: "oathnet_lookup",
    created_at: created, metadata: { status: "observed", source_category: ["breach"] }, ...extra,
  });
  const flagged = (id: string, created: string, flag: Record<string, unknown> = { possible_minor: true }): TestRow => ({
    id, kind: "email", value: "Jordan.Vale@Example.com", confidence: 55, source: "socialfetch_lookup",
    created_at: created, metadata: { status: "observed", source_category: ["social_profile_passive"], ...flag },
  });
  const byId = (items: Array<{ id: string }>, id: string) => items.find((a) => a.id === id) as unknown as TestRow;
  const meta = (a: TestRow) => (a.metadata ?? {}) as Record<string, unknown>;

  async function load(thread: string, rows: TestRow[]) {
    mock.rowsByThread.set(thread, rows);
    const { result } = renderArtifactsHook(thread);
    await waitFor(() => expect(result.current.items.length).toBe(rows.length));
    return result;
  }

  it.each([
    ["earlier unflagged row, later flagged row", false],
    ["the same rows in the opposite database order", true],
  ])("%s: BOTH rows carry the ceiling", async (_name, reversed) => {
    const rows = [plain("a", "2026-10-01T00:00:00.000Z"), flagged("b", "2026-10-01T00:00:05.000Z")];
    const result = await load(reversed ? "mino-r" : "mino-f", reversed ? [...rows].reverse() : rows);
    for (const id of ["a", "b"]) {
      const m = meta(byId(result.current.items, id));
      expect(m.possible_minor, id).toBe(true);
      expect(m.minor_warning, id).toBe(true);
      expect(m.auto_pivot_blocked, id).toBe(true);
    }
    // the flagged row's own flags are its own: nothing is marked as derived on it beyond what it lacked
    expect(meta(byId(result.current.items, "b")).possible_minor).toBe(true);
    expect(meta(byId(result.current.items, "a"))[MINOR_DERIVED_MARKER]).toEqual(["possible_minor", "minor_warning", "auto_pivot_blocked"]);
  });

  it.each([
    [{ minor_warning: true }],
    [{ auto_pivot_blocked: true }],
    [{ flag: "MINOR_SAFETY_FLAG" }],
  ])("any of the recognised flags %j protects the twin", async (flag) => {
    const result = await load(`mino-${Object.keys(flag)[0]}`, [plain("a", "2026-10-01T00:00:00.000Z"), flagged("b", "2026-10-01T00:00:05.000Z", flag)]);
    const m = meta(byId(result.current.items, "a"));
    expect(m.possible_minor).toBe(true);
    expect(m.minor_warning).toBe(true);
  });

  it("copies ONLY the protective flags: no review, confidence, source class, cluster or quarantine release crosses rows", async () => {
    const analystRow = flagged("b", "2026-10-01T00:00:05.000Z", {
      possible_minor: true, reviewed: true, linkage_confirmed: true, cluster_id: "clus_b", status: "confirmed",
      confidence_cap_applied: 99, parent_seed: "seed@example.com",
    });
    analystRow.confidence = 95;
    const result = await load("mino-nt", [plain("a", "2026-10-01T00:00:00.000Z"), analystRow]);
    const a = byId(result.current.items, "a");
    const m = meta(a);
    expect(a.confidence).toBe(70);
    expect(a.source).toBe("oathnet_lookup");
    expect(m.source_category).toEqual(["breach"]);
    for (const k of ["reviewed", "linkage_confirmed", "cluster_id", "confidence_cap_applied", "parent_seed"]) {
      expect(k in m, `${k} must not cross rows`).toBe(false);
    }
    expect(m.status).toBe("observed");
  });

  it("a selector with NO flagged row is untouched", async () => {
    const result = await load("mino-none", [plain("a", "2026-10-01T00:00:00.000Z"), plain("c", "2026-10-01T00:00:03.000Z", { confidence: 60 })]);
    for (const a of result.current.items) {
      expect("possible_minor" in meta(a as unknown as TestRow)).toBe(false);
      expect(MINOR_DERIVED_MARKER in meta(a as unknown as TestRow)).toBe(false);
    }
  });

  it("a different selector is untouched, even with a flagged neighbour", async () => {
    const other: TestRow = { ...plain("o", "2026-10-01T00:00:01.000Z"), value: "someone.else@example.com" };
    const result = await load("mino-other", [plain("a", "2026-10-01T00:00:00.000Z"), other, flagged("b", "2026-10-01T00:00:05.000Z")]);
    expect("possible_minor" in meta(byId(result.current.items, "o"))).toBe(false);
  });

  it("realtime: a flagged row arriving LATER protects the rows already on screen, and a twin arriving later is protected on arrival", async () => {
    const result = await load("mino-rt", [plain("a", "2026-10-01T00:00:00.000Z")]);
    expect(meta(byId(result.current.items, "a")).possible_minor).toBeUndefined();
    await emit("artifacts", { eventType: "INSERT", new: flagged("b", "2026-10-01T00:00:05.000Z"), old: null });
    await waitFor(() => expect(meta(byId(result.current.items, "a")).possible_minor).toBe(true));
    await emit("artifacts", { eventType: "INSERT", new: plain("c", "2026-10-01T00:00:09.000Z", { confidence: 61 }), old: null });
    await waitFor(() => expect(meta(byId(result.current.items, "c")).possible_minor).toBe(true));
  });

  it("when the flagged row is deleted the protection it lent goes with it (derived at read time, never stored)", async () => {
    const result = await load("mino-del", [plain("a", "2026-10-01T00:00:00.000Z"), flagged("b", "2026-10-01T00:00:05.000Z")]);
    expect(meta(byId(result.current.items, "a")).possible_minor).toBe(true);
    await emit("artifacts", { eventType: "DELETE", new: null, old: { id: "b" } });
    await waitFor(() => expect(meta(byId(result.current.items, "a")).possible_minor).toBeUndefined());
  });

  it("the consumers that read ONE row now agree for every row: no pivot, redacted label, capped number, never ATTESTED", async () => {
    const attestedTwin = plain("a", "2026-10-01T00:00:00.000Z");
    attestedTwin.metadata = { ...attestedTwin.metadata, reviewed: true };
    const result = await load("mino-consumers", [attestedTwin, flagged("b", "2026-10-01T00:00:05.000Z")]);
    const items = result.current.items;

    // pivot-engine: the candidate's source row may be either; neither offers the address.
    const pivots = computePivots({ artifacts: items, seedValue: null, reportPivots: [], skipSet: new Set(), reviews: {} });
    expect(pivots.filter((p) => p.value.toLowerCase() === "jordan.vale@example.com")).toEqual([]);

    // audit redaction: neither row lends its value to a guardrail line
    const labels = artifactsToSources(items).map((s) => s.label);
    expect(labels).toEqual(["(minor-safety redacted)", "(minor-safety redacted)"]);

    // the analyst's OWN attestation on the twin is capped by the ceiling, exactly as on the flagged row
    expect(labelForArtifact(byId(items, "a") as never)).not.toBe("ATTESTED");
    expect(labelForArtifact(byId(items, "a") as never)).not.toBe("CONFIRMED");
    expect(adjustedConfidence(byId(items, "a") as never)).toBeLessThanOrEqual(55);
    expect(displayConfidence(byId(items, "a") as never).ceilings.map((c) => c.kind)).toContain("possible_minor");
    // …while the attestation itself is still recorded on that row and was not moved
    expect(meta(byId(items, "a")).reviewed).toBe(true);
    expect(meta(byId(items, "b")).reviewed).toBeUndefined();
  });

  it("stripDerivedItemMetadata removes exactly what the hook derived, and nothing the row carried itself", async () => {
    const result = await load("mino-strip", [plain("a", "2026-10-01T00:00:00.000Z"), flagged("b", "2026-10-01T00:00:05.000Z", { possible_minor: true, minor_warning: true })]);
    const a = meta(byId(result.current.items, "a"));
    const stripped = stripDerivedItemMetadata(a);
    expect("possible_minor" in stripped).toBe(false);
    expect("minor_warning" in stripped).toBe(false);
    expect("auto_pivot_blocked" in stripped).toBe(false);
    expect(MINOR_DERIVED_MARKER in stripped).toBe(false);
    expect(stripped.status).toBe("observed");
    // the flagged row carried possible_minor / minor_warning ITSELF, so only the key it lacked is derived on it
    const b = meta(byId(result.current.items, "b"));
    expect(b[MINOR_DERIVED_MARKER]).toEqual(["auto_pivot_blocked"]);
    const bStripped = stripDerivedItemMetadata(b);
    expect(bStripped.possible_minor).toBe(true);
    expect(bStripped.minor_warning).toBe(true);
    expect("auto_pivot_blocked" in bStripped).toBe(false);
    // a row without a marker is returned as-is
    const clean = { status: "observed" };
    expect(stripDerivedItemMetadata(clean)).toBe(clean);
  });
});
