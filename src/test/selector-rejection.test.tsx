import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useThreadArtifacts } from "@/hooks/useThreadArtifacts";
import { useReviewStates } from "@/lib/review";
import { labelForArtifact } from "@/lib/intel";
import { buildConfidenceProfile } from "@/lib/confidence-dimensions";
import { tallyAuthority } from "@/lib/authority";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/**
 * An analyst's REJECTION of a value reaches every record of that value (#593 review, N3).
 *
 * Rows are kept separate by useThreadArtifacts, so a value dismissed on one row used to come back through its sibling —
 * and every dismissal recorded before this change was recorded against the old MERGED item's id, so its sibling row is
 * not dismissed. useReviewStates therefore reads a rejection recorded on any row of a selector as a rejection of the
 * siblings that have no verdict of their own. Positive decisions never propagate; nothing is written for the sibling; the
 * controls act on the row's OWN recorded state.
 */

type Row = {
  id: string; kind: string; value: string; confidence: number | null; source: string | null; created_at: string;
  metadata: Record<string, unknown> | null;
};

const db = vi.hoisted(() => ({
  rows: new Map<string, Row[]>(),
  reviews: [] as Array<{ artifact_id: string; state: string; note?: string }>,
  upserts: [] as unknown[],
  deletes: [] as unknown[],
  channels: [] as Array<{ active: boolean; bindings: Array<{ table: string; cb: (p: unknown) => void }> }>,
}));
const mounted: Root[] = [];

vi.mock("@/lib/analyst-feedback", () => ({
  recordAnalystFeedback: vi.fn(() => Promise.resolve()),
  actionForReviewState: () => null,
}));

vi.mock("@/integrations/supabase/client", () => {
  const from = (table: string) => {
    let thread = "";
    const q: Record<string, unknown> = {};
    const chain = () => q;
    q.select = chain;
    q.order = chain;
    q.eq = (col: string, v: string) => { if (col === "thread_id") thread = v; return q; };
    q.limit = () => Promise.resolve({ data: db.rows.get(thread) ?? [], error: null });
    q.maybeSingle = () => Promise.resolve({ data: null, error: null });
    q.upsert = (row: unknown) => { db.upserts.push({ table, row }); return Promise.resolve({ error: null }); };
    q.delete = () => {
      const d: Record<string, unknown> = {};
      d.eq = (col: string, v: unknown) => { db.deletes.push({ table, col, v }); return d; };
      d.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve);
      return d;
    };
    // `select().eq().eq()` on artifact_reviews resolves like a promise
    if (table === "artifact_reviews") {
      q.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: db.reviews, error: null }).then(resolve);
    }
    return q;
  };
  return {
    supabase: {
      from,
      rpc: () => Promise.resolve({ error: null }),
      auth: { getUser: () => Promise.resolve({ data: { user: { id: "u1" } } }) },
      channel() {
        const ch = {
          active: true,
          bindings: [] as Array<{ table: string; cb: (p: unknown) => void }>,
          on(_e: string, cfg: { table: string }, cb: (p: unknown) => void) { ch.bindings.push({ table: cfg.table, cb }); return ch; },
          subscribe(cb?: (s: string) => void) { cb?.("SUBSCRIBED"); return ch; },
        };
        db.channels.push(ch);
        return ch;
      },
      removeChannel(ch: { active: boolean }) { ch.active = false; },
    },
  };
});

const mkRow = (id: string, value: string, over: Partial<Row> = {}): Row => ({
  id, kind: "email", value, confidence: 60, source: "oathnet_lookup",
  created_at: `2026-10-01T00:00:0${id.length}.000Z`, metadata: { status: "observed", source_category: ["breach"] }, ...over,
});

// Twins that DIFFER in authority, so the hook keeps them as two items.
const A = mkRow("a", "jordan.vale@example.com", { created_at: "2026-10-01T00:00:00.000Z" });
const B = mkRow("b", "Jordan.Vale@example.com", { created_at: "2026-10-01T00:00:05.000Z", source: "socialfetch_lookup", confidence: 45, metadata: { status: "needs_review", source_category: ["social_profile_passive"] } });
const OTHER = mkRow("o", "someone.else@example.com", { created_at: "2026-10-01T00:00:07.000Z" });

function mount(thread: string) {
  const container = document.createElement("div");
  const root = createRoot(container);
  mounted.push(root);
  const snap: { art: ReturnType<typeof useThreadArtifacts> | null; rev: ReturnType<typeof useReviewStates> | null } = { art: null, rev: null };
  function Harness() {
    snap.art = useThreadArtifacts(thread);
    snap.rev = useReviewStates(thread);
    return null;
  }
  act(() => root.render(<Harness />));
  return {
    get art() { return snap.art!; },
    get rev() { return snap.rev!; },
  };
}

async function settle(assertion: () => void) {
  let last: unknown;
  for (let i = 0; i < 60; i++) {
    try { assertion(); return; } catch (e) { last = e; await act(async () => { await new Promise((r) => setTimeout(r, 10)); }); }
  }
  throw last;
}

async function emitRows(payload: unknown) {
  await act(async () => {
    for (const ch of db.channels) if (ch.active) for (const b of ch.bindings) if (b.table === "artifacts") b.cb(payload);
  });
}

beforeEach(() => {
  db.rows.clear(); db.reviews.length = 0; db.upserts.length = 0; db.deletes.length = 0; db.channels.length = 0;
});
afterEach(() => { for (const r of mounted.splice(0)) act(() => r.unmount()); });

describe("a rejection recorded on one record of a value applies to the other records of that value", () => {
  it("a dismissal recorded on the EARLIER row (e.g. every pre-existing one) dismisses the later twin", async () => {
    db.rows.set("t1", [A, B, OTHER]);
    db.reviews.push({ artifact_id: "a", state: "dismissed" });
    const h = mount("t1");
    await settle(() => {
      expect(h.art.items).toHaveLength(3);
      expect(h.rev.get("a")).toBe("dismissed");
    });
    expect(h.rev.get("b")).toBe("dismissed");
    expect(h.rev.getOwn("b")).toBe("new");
    expect(h.rev.isInherited("b")).toBe(true);
    expect(h.rev.isInherited("a")).toBe(false);
    expect(h.rev.get("o")).toBe("new"); // a different value is untouched
    expect(h.rev.map.b).toBe("dismissed");
  });

  it("…and the other way round (recorded on the LATER row)", async () => {
    db.rows.set("t2", [A, B]);
    db.reviews.push({ artifact_id: "b", state: "wrong" });
    const h = mount("t2");
    await settle(() => expect(h.rev.get("a")).toBe("wrong"));
    expect(h.rev.getOwn("a")).toBe("new");
  });

  it("the consumers read the inherited rejection: FAILED label, struck from the authority tally", async () => {
    db.rows.set("t3", [A, B]);
    db.reviews.push({ artifact_id: "a", state: "dismissed" });
    const h = mount("t3");
    await settle(() => expect(h.rev.get("b")).toBe("dismissed"));
    const b = h.art.items.find((x) => x.id === "b")!;
    expect(labelForArtifact(b, h.rev.get(b.id))).toBe("FAILED");
    const tally = tallyAuthority(h.art.items, h.rev.get);
    expect(tally.failed).toBe(2);
    // …and it does not count toward corroboration or readiness
    const profile = buildConfidenceProfile({ artifacts: h.art.items, seedValue: null, reviews: h.rev.map, nowMs: Date.parse("2026-10-02T00:00:00Z") });
    // both records are rejected, so neither is a reportable finding (the axis has nothing to score)
    expect(profile.dimensions.find((d) => d.key === "readiness")!.reason).toBe("No reportable findings yet");
  });

  it("POSITIVE decisions never propagate: a confirmed row leaves its twin 'new'", async () => {
    db.rows.set("t4", [A, B]);
    db.reviews.push({ artifact_id: "a", state: "confirmed" });
    const h = mount("t4");
    await settle(() => expect(h.rev.get("a")).toBe("confirmed"));
    expect(h.rev.get("b")).toBe("new");
    expect(h.rev.isInherited("b")).toBe(false);
  });

  it("a sibling's OWN verdict wins: confirmed on one record, dismissed on the other — each keeps its own", async () => {
    db.rows.set("t5", [A, B]);
    db.reviews.push({ artifact_id: "a", state: "confirmed" }, { artifact_id: "b", state: "dismissed" });
    const h = mount("t5");
    await settle(() => expect(h.rev.get("b")).toBe("dismissed"));
    expect(h.rev.get("a")).toBe("confirmed");
  });

  it("a twin that arrives LATER over realtime inherits the rejection on arrival", async () => {
    db.rows.set("t6", [A]);
    db.reviews.push({ artifact_id: "a", state: "dismissed" });
    const h = mount("t6");
    await settle(() => expect(h.rev.get("a")).toBe("dismissed"));
    await emitRows({ eventType: "INSERT", new: B, old: null });
    await settle(() => expect(h.art.items.map((x) => x.id).sort()).toEqual(["a", "b"]));
    expect(h.rev.get("b")).toBe("dismissed");
  });

  it("recording a dismissal writes ONE review row (the clicked record) — the sibling is derived, never stored", async () => {
    db.rows.set("t7", [A, B]);
    const h = mount("t7");
    await settle(() => expect(h.art.items).toHaveLength(2));
    await act(async () => { await h.rev.set("a", "dismissed", { value: A.value, kind: "email" }); });
    expect(h.rev.get("b")).toBe("dismissed");
    const reviewWrites = db.upserts.filter((u) => (u as { table: string }).table === "artifact_reviews") as Array<{ row: { artifact_id: string } }>;
    expect(reviewWrites.map((w) => w.row.artifact_id)).toEqual(["a"]);
  });

  it("resetting the verdict on the row it was recorded on lifts the rejection from the sibling too", async () => {
    db.rows.set("t8", [A, B]);
    const h = mount("t8");
    await settle(() => expect(h.art.items).toHaveLength(2));
    await act(async () => { await h.rev.set("a", "dismissed", { value: A.value, kind: "email" }); });
    expect(h.rev.get("b")).toBe("dismissed");
    await act(async () => { await h.rev.set("a", null, { value: A.value, kind: "email" }); });
    expect(h.rev.get("b")).toBe("new");
    expect(h.rev.get("a")).toBe("new");
  });

  it("with no rejection anywhere, `map` is the recorded map itself (no copy on the common path)", async () => {
    db.rows.set("t9", [A, B]);
    db.reviews.push({ artifact_id: "a", state: "key" });
    const h = mount("t9");
    await settle(() => expect(h.rev.get("a")).toBe("key"));
    expect(Object.keys(h.rev.map)).toEqual(["a"]);
  });
});
