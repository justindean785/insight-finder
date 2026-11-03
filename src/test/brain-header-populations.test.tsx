import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Intelligence header, DRIVEN: the real page against a stubbed client.
 *
 * Live /brain on 2026-10-31 showed `MEMORIES 500` beside an Overview tile
 * `Memories 1,672`, and `AVG CONFIDENCE 66%` beside `Avg confidence 49%`. The
 * first pair were two populations (the 500-row recent sample vs. every stored
 * row); the second pair were two NOUNS (`agent_memory.confidence` over the
 * sample vs. `public.artifacts.confidence` over all artifacts). PR #927's first
 * cut also rendered "all memories fit in the slice" while the count was still
 * loading or had failed. This file is the state matrix from
 * docs/plans/2026-10-31-intelligence-memory-plan.md §5.1, row by row.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type Row = {
  id: string; kind: string; subject: string; subject_kind: string | null; content: string;
  related_values: string[] | null; confidence: number | null; hit_count: number;
  last_used_at: string | null; created_at: string; source_thread_id: string | null;
};

const m = vi.hoisted(() => ({
  rows: [] as unknown[],
  count: 0 as number | null,
  countError: null as { message: string } | null,
  pending: false,
  calls: [] as { table: string; op: string; args: unknown[]; head: boolean }[],
  bindings: [] as { table: string; event: string; cb: (p: unknown) => void }[],
  // Stable identity: the page's effect depends on `user`, so a fresh object per render would re-run it forever.
  auth: { user: { id: "u1" }, loading: false },
  summary: {
    kind_counts: [{ kind: "email", count: 40 }],
    source_counts: [{ source: "oathnet", count: 31 }, { source: "hunter_verify", count: 12 }],
    day_counts: [],
    top_cases: [],
    conf_buckets: { ge80: 4, b50: 10, b20: 20, lt20: 6, unscored: 0 },
    avg_confidence: 49,
    tool_counts: [{ tool_name: "hunter_verify", count: 12, ok_count: 11 }],
    tool_calls_total: 12,
  },
}));

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => m.auth }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/integrations/supabase/client", () => {
  const chain = (table: string) => {
    const node: Record<string, unknown> = {};
    let head = false;
    for (const op of ["select", "eq", "neq", "gte", "in", "not", "order", "limit", "is", "or", "filter", "range"]) {
      node[op] = (...args: unknown[]) => {
        if (op === "select" && (args[1] as { head?: boolean } | undefined)?.head) head = true;
        m.calls.push({ table, op, args, head });
        return node;
      };
    }
    // Thenable, so both `await` and `Promise.all` see it. `pending` never settles —
    // the loading row of the matrix.
    node.then = (resolve: (v: unknown) => void) => {
      if (m.pending) return;
      if (table === "agent_memory") {
        if (head) resolve({ data: null, error: m.countError, count: m.countError ? null : m.count });
        else resolve({ data: m.rows, error: null });
        return;
      }
      if (head) resolve({ data: null, error: null, count: 0 });
      else resolve({ data: [], error: null });
    };
    return node;
  };
  const channel = () => {
    const ch: Record<string, unknown> = {};
    ch.on = (_t: string, cfg: { table?: string; event?: string }, cb: (p: unknown) => void) => {
      m.bindings.push({ table: cfg.table ?? "", event: cfg.event ?? "*", cb });
      return ch;
    };
    ch.subscribe = () => ch;
    return ch;
  };
  return {
    supabase: {
      from: (t: string) => chain(t),
      rpc: () => Promise.resolve({ data: m.summary, error: null }),
      channel,
      removeChannel: () => Promise.resolve("ok"),
    },
  };
});

import BrainGlobalPage from "@/pages/BrainGlobalPage";
import { describeMemorySample } from "@/lib/memory-population";

const iso = (minsAgo: number) => new Date(Date.UTC(2026, 9, 31, 8, 0, 0) - minsAgo * 60_000).toISOString();
const mem = (i: number, over: Partial<Row> = {}): Row => ({
  id: `mem-${i}`, kind: "lesson", subject: `subject-${i}`, subject_kind: "email",
  content: `lesson ${i}`, related_values: null, confidence: 60, hit_count: 1,
  last_used_at: null, created_at: iso(i), source_thread_id: null, ...over,
});
const rows = (n: number, over: Partial<Row> = {}) => Array.from({ length: n }, (_, i) => mem(i, over));

// `?tab=patterns` keeps the Overview (its own RPC + three counts) and the 500-card
// Memories list out of the header tests. Stored lesson rows also exercise the
// Patterns population, which now includes both patterns and lessons.
function renderBrain(path = "/brain?tab=patterns") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <BrainGlobalPage />
    </MemoryRouter>,
  );
}

const caption = () => screen.getByTestId("memory-sample-caption").textContent ?? "";
const settled = () => waitFor(() => expect(caption()).not.toBe("… of —"));
const chip = (label: RegExp) => {
  const group = screen.getByTestId("memory-sample-group");
  const el = within(group).getByText(label).parentElement!;
  return el.querySelector(".tabular-nums")?.textContent ?? "";
};

beforeEach(() => {
  m.rows = []; m.count = 0; m.countError = null; m.pending = false; m.calls = []; m.bindings = [];
  window.localStorage.removeItem("brain_deleted_memories");
  window.localStorage.removeItem("brain_suppressed_memories");
  window.localStorage.removeItem("brain_last_visited");
});

describe("describeMemorySample — the state matrix", () => {
  const ok = (total: number) => ({ state: "ok", total }) as const;
  it("never claims completeness while loading or after a count failure", () => {
    expect(describeMemorySample({ loading: true, sample: 0, shown: 0, hidden: 0, total: { state: "loading" } })).toBe("… of —");
    expect(describeMemorySample({ loading: false, sample: 500, shown: 500, hidden: 0, total: { state: "loading" } })).toBe("… of —");
    const failed = describeMemorySample({ loading: false, sample: 500, shown: 497, hidden: 3, total: { state: "error" } });
    expect(failed).toBe("497 shown · total unavailable · 3 hidden locally");
    expect(failed).not.toMatch(/all stored|all memories|fit/i);
  });
  it("names the sample as a sample only when the stored total exceeds it", () => {
    expect(describeMemorySample({ loading: false, sample: 500, shown: 500, hidden: 0, total: ok(1672) })).toBe("500 most recent of 1,672");
    expect(describeMemorySample({ loading: false, sample: 12, shown: 12, hidden: 0, total: ok(12) })).toBe("12 memories (all stored)");
    expect(describeMemorySample({ loading: false, sample: 0, shown: 0, hidden: 0, total: ok(0) })).toBe("0 memories (all stored)");
    expect(describeMemorySample({ loading: false, sample: 1, shown: 1, hidden: 0, total: ok(1) })).toBe("1 memory (all stored)");
  });
  it("compares the total against the SAMPLE, not the shown count, so hiding rows cannot fake an over-cap state", () => {
    expect(describeMemorySample({ loading: false, sample: 500, shown: 497, hidden: 3, total: ok(500) })).toBe("500 memories (all stored) · 3 hidden locally");
  });
});

describe("Intelligence header — one honest population per number", () => {
  it("empty: 0 rows, count 0 → all stored, hits 0, confidence —", async () => {
    renderBrain();
    await settled();
    expect(caption()).toBe("0 memories (all stored)");
    expect(chip(/^Hits/)).toBe("0");
    expect(chip(/^Memory confidence/)).toBe("—");
    expect(document.querySelector("header")!.textContent).not.toMatch(/0%/);
  });

  it("Patterns includes stored lessons beside patterns and labels the lesson kind", async () => {
    m.rows = [
      mem(1, { kind: "lesson", content: "Retry this source later and corroborate independently." }),
      mem(2, { kind: "pattern", content: "Two cases reused the same selector pattern." }),
    ];
    m.count = 2;
    renderBrain();
    await settled();
    expect(await screen.findByText("Retry this source later and corroborate independently.")).toBeTruthy();
    expect(screen.getByText("Two cases reused the same selector pattern.")).toBeTruthy();
    expect(screen.getByText("LESSON")).toBeTruthy();
    expect(screen.getByText("STORED PATTERNS + LESSONS ·").parentElement?.textContent).toContain("2");
  });

  it("under-cap: 12 rows, count 12 → 12 memories (all stored)", async () => {
    m.rows = rows(12); m.count = 12;
    renderBrain();
    await settled();
    expect(caption()).toBe("12 memories (all stored)");
  });

  it("over-cap: 500 rows, count 1,672 → 500 most recent of 1,672", async () => {
    m.rows = rows(500, { confidence: 66, hit_count: 2 }); m.count = 1672;
    renderBrain();
    await settled();
    expect(caption()).toBe("500 most recent of 1,672");
    expect(chip(/^Hits/)).toBe("1000");
    expect(chip(/^Memory confidence/)).toBe("66%");
    // The stored total is stated exactly once in the header, as the denominator.
    const header = document.querySelector("header")!;
    expect(header.textContent!.match(/1,672/g)).toHaveLength(1);
  });

  it("locally hidden: 3 of 500 hidden → caption says so, stats cover 497, muting changes nothing", async () => {
    m.rows = rows(500); m.count = 1672;
    window.localStorage.setItem("brain_deleted_memories", JSON.stringify(["mem-1", "mem-2", "mem-3", "not-in-sample"]));
    window.localStorage.setItem("brain_suppressed_memories", JSON.stringify(["mem-4", "mem-5"]));
    renderBrain();
    await settled();
    expect(caption()).toBe("500 most recent of 1,672 · 3 hidden locally");
    expect(chip(/^Hits/)).toBe("497");
    const group = screen.getByTestId("memory-sample-group");
    expect(group.textContent).toMatch(/hidden in this browser are excluded from these numbers and still exist in the database/);
    expect(group.textContent).toMatch(/Muting changes no number/);
  });

  it("count failure: the sample renders, the total is unavailable, and nothing says every memory fit", async () => {
    m.rows = rows(500); m.countError = { message: "permission denied for table agent_memory" };
    renderBrain();
    await settled();
    expect(caption()).toBe("500 shown · total unavailable");
    expect(document.body.textContent).not.toMatch(/all stored|fit in|all of this user/i);
  });

  it("loading: the caption is a skeleton, not a count", async () => {
    m.pending = true; m.rows = rows(12); m.count = 12;
    renderBrain();
    await waitFor(() => expect(m.calls.some((c) => c.table === "agent_memory" && c.op === "limit")).toBe(true));
    expect(caption()).toBe("… of —");
    expect(document.body.textContent).not.toMatch(/all stored/);
  });

  it("refresh: the agent_memory realtime callback re-fetches the sample AND the total in one loader", async () => {
    m.rows = rows(12); m.count = 12;
    renderBrain();
    await settled();
    const binding = m.bindings.find((b) => b.table === "agent_memory");
    expect(binding, "the page subscribes to agent_memory changes").toBeTruthy();
    m.calls = [];
    m.rows = rows(13); m.count = 1700;
    binding!.cb({ eventType: "INSERT" });
    // A refresh never drops the caption back to the skeleton: the old count stays up until the new one lands.
    expect(caption()).toBe("12 memories (all stored)");
    await waitFor(() => expect(caption()).toBe("13 most recent of 1,700"));
    const mine = m.calls.filter((c) => c.table === "agent_memory" && c.op === "select");
    expect(mine.filter((c) => c.head)).toHaveLength(1);
    expect(mine.filter((c) => !c.head)).toHaveLength(1);
    expect(m.calls.find((c) => c.table === "agent_memory" && c.op === "limit")?.args).toEqual([500]);
  });

  it("scope is on-screen text: no element in the header relies on a title tooltip", async () => {
    m.rows = rows(12); m.count = 12;
    renderBrain();
    await settled();
    const header = document.querySelector("header")!;
    expect(header.querySelectorAll("[title]")).toHaveLength(0);
    expect(header.textContent).toMatch(/Recent memory sample/);
    expect(header.textContent).toMatch(/hit count rises when memory_recall surfaces it and when the same lesson is saved again, so hits are not recalls/);
    expect(header.textContent).toMatch(/Credits/);
    expect(header.textContent).toMatch(/SocialFetch/);
    // The retired labels: both were shared with an Overview tile over a different population or noun.
    expect(header.textContent).not.toMatch(/MEMORIES\s*·|RECALLS|AVG CONFIDENCE/);
  });

  it("the Memories tab caption names the shown population, never bare MEMORIES", async () => {
    m.rows = rows(12); m.count = 12;
    window.localStorage.setItem("brain_deleted_memories", JSON.stringify(["mem-0"]));
    renderBrain("/brain?tab=memories");
    await settled();
    expect(screen.getByTestId("memories-tab-caption").textContent).toBe("Showing 11 in sample");
    expect(caption()).toBe("12 memories (all stored) · 1 hidden locally");
  });
});

describe("Overview tiles — the stored population and the artifact noun", () => {
  it("count failure: Memories reads —, not 0; confidence is labelled as artifact confidence", async () => {
    m.rows = rows(12); m.countError = { message: "boom" };
    renderBrain("/brain?tab=overview");
    await settled();
    await screen.findByText("Stored count unavailable");
    expect(screen.getByLabelText("Memories unavailable").textContent).toBe("—");
    expect(screen.getByText("Artifact confidence")).toBeTruthy();
    expect(screen.getByText("49%")).toBeTruthy();
    expect(screen.getByText("Most-recorded sources")).toBeTruthy();
    expect(document.body.textContent).toMatch(/volume, not reliability/);
    expect(document.body.textContent).not.toMatch(/Avg confidence|Top sources/);
    // Header and Overview describe memory and artifact confidence with different labels.
    expect(document.body.textContent).toMatch(/Memory confidence \(sample\)/i);
  });

  it("success: the Memories tile says it is the stored, all-time count", async () => {
    m.rows = rows(12); m.count = 1672;
    renderBrain("/brain?tab=overview");
    await settled();
    await screen.findByText("Stored, all time");
    await waitFor(() => expect(screen.getByText("1,672")).toBeTruthy());
    expect(caption()).toBe("12 most recent of 1,672");
  });
});
