import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The Cases list and the read-only case page must say what the workspace header
 * says about a run: they share `deriveRunState` (case-snapshot.ts).
 *
 * Before this, both pages used `isRunningThread`, which reads `status='active'` +
 * a run marker as Running. That is exactly the row a CPU-killed run leaves
 * behind, and since #795 the sidebar no longer writes `finished` over it, so the
 * row stays `active` until server recovery runs (at the next run start or a
 * `/health` probe). The pages called that dead run "Running".
 *
 * The other half is invariant I-2: once the server recovers the run it writes
 * `finished` + `recovery_reason`, which the Cases list rendered as "Finished",
 * i.e. complete. A dead run is "Interrupted" before AND after recovery.
 *
 * The Supabase stub returns only the columns a query asks for, so a page that
 * does not SELECT `recovery_reason` / `recovered_at` cannot see them here either.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const m = vi.hoisted(() => ({
  threadRows: [] as Array<Record<string, unknown>>,
  metricsFail: false,
  metricsDelayMs: 0,
  threadsFail: false,
  realtime: [] as Array<() => void>,
  auth: { user: { id: "user-1", email: "analyst@test.local" }, session: { access_token: "t" }, loading: false, error: null },
}));

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => m.auth }));

vi.mock("@/integrations/supabase/client", () => {
  const pick = (row: Record<string, unknown>, cols: string | null) => {
    if (!cols || cols.trim() === "*") return row;
    const out: Record<string, unknown> = {};
    for (const c of cols.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (c in row) out[c] = row[c];
    }
    return out;
  };
  const makeChain = (table: string) => {
    let cols: string | null = null;
    const rows = () => (table === "threads" ? m.threadRows.map((r) => pick(r, cols)) : []);
    const chain: Record<string | symbol, unknown> = {};
    const proxy: Record<string | symbol, unknown> = new Proxy(chain, {
      get(target, key) {
        if (key === "select") {
          return (c?: string) => {
            cols = c ?? null;
            return proxy;
          };
        }
        if (key === "maybeSingle" || key === "single") {
          return () => Promise.resolve({ data: rows()[0] ?? null, error: null });
        }
        if (key === "then") {
          const result = table === "threads" && m.threadsFail
            ? { data: null, error: { message: "threads read failed" }, count: null }
            : { data: rows(), error: null, count: rows().length };
          return (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
            Promise.resolve(result).then(resolve, reject);
        }
        if (key in target) return target[key];
        return () => proxy;
      },
    });
    return proxy;
  };
  // Keep the realtime callbacks so a test can fire a change event.
  const ch: { on: (...a: unknown[]) => unknown; subscribe: () => unknown } = {
    on: (...a: unknown[]) => {
      const cb = a[2];
      if (typeof cb === "function") m.realtime.push(cb as () => void);
      return ch;
    },
    subscribe: () => ch,
  };
  return {
    supabase: {
      from: (table: string) => makeChain(table),
      rpc: () => {
        const result = m.metricsFail ? { data: null, error: { message: "get_case_metrics unavailable" } } : { data: [], error: null };
        return m.metricsDelayMs > 0
          ? new Promise((r) => setTimeout(() => r(result), m.metricsDelayMs))
          : Promise.resolve(result);
      },
      auth: {
        getUser: () => Promise.resolve({ data: { user: { id: "user-1" } }, error: null }),
        getSession: () => Promise.resolve({ data: { session: null }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      },
      channel: () => ch,
      removeChannel: () => Promise.resolve(),
    },
  };
});

import CasesPage from "@/pages/CasesPage";
import CaseViewPage from "@/pages/CaseViewPage";

const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function row(id: string, title: string, over: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    title,
    created_at: ago(60 * 60_000),
    updated_at: ago(20 * 60_000),
    status: "active",
    seed_type: "email",
    seed_value: `${id}@example.test`,
    run_started_at: null,
    last_heartbeat_at: null,
    recovered_at: null,
    recovery_reason: null,
    ...over,
  };
}

const DEAD_ACTIVE = row("dead", "Dead run case", { run_started_at: ago(25 * 60_000), last_heartbeat_at: ago(20 * 60_000) });
const LIVE = row("live", "Live run case", { updated_at: ago(5_000), run_started_at: ago(60_000), last_heartbeat_at: ago(5_000) });
const RECOVERED = row("recovered", "Recovered run case", {
  status: "finished",
  run_started_at: ago(30 * 60_000),
  last_heartbeat_at: ago(28 * 60_000),
  recovered_at: ago(10 * 60_000),
  recovery_reason: "stale_active",
});
const DRAFT = row("draft", "Draft case", {});
const DONE = row("done", "Done case", { status: "finished", run_started_at: ago(40 * 60_000), last_heartbeat_at: ago(35 * 60_000) });
const STOPPED = row("stopped", "Stopped case", { status: "stopped", run_started_at: ago(40 * 60_000), last_heartbeat_at: ago(35 * 60_000) });

afterEach(() => {
  cleanup();
  m.threadRows = [];
  m.metricsFail = false;
  m.threadsFail = false;
  m.metricsDelayMs = 0;
  m.realtime = [];
});

async function chipFor(title: string): Promise<string> {
  const name = await screen.findByText(title);
  const li = name.closest("li");
  expect(li).not.toBeNull();
  const chip = within(li as HTMLElement).getAllByText(/^(Running|Interrupted|Draft|Stopped|Finished)$/);
  expect(chip).toHaveLength(1);
  return chip[0].textContent ?? "";
}

function renderCases() {
  return render(
    <MemoryRouter initialEntries={["/cases"]}>
      <Routes>
        <Route path="/cases" element={<CasesPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Cases list labels a run the way the workspace header does", () => {
  it("a run whose heartbeat died is Interrupted, not Running (row still active, recovery not run yet)", async () => {
    m.threadRows = [DEAD_ACTIVE];
    renderCases();
    expect(await chipFor("Dead run case")).toBe("Interrupted");
  });

  it("a run the server already recovered is Interrupted, not Finished (I-2)", async () => {
    m.threadRows = [RECOVERED];
    renderCases();
    expect(await chipFor("Recovered run case")).toBe("Interrupted");
  });

  it("controls: a live heartbeat is Running; a never-started thread is Draft; a clean finish is Finished; a stop is Stopped", async () => {
    m.threadRows = [LIVE, DRAFT, DONE, STOPPED];
    renderCases();
    expect(await chipFor("Live run case")).toBe("Running");
    expect(await chipFor("Draft case")).toBe("Draft");
    expect(await chipFor("Done case")).toBe("Finished");
    expect(await chipFor("Stopped case")).toBe("Stopped");
  });

  it("a live run stays Running when the list re-renders long after it was fetched (typing in search)", async () => {
    m.threadRows = [LIVE];
    renderCases();
    expect(await chipFor("Live run case")).toBe("Running");
    // Five minutes on, nothing re-fetched: the rows still describe the moment they were read.
    const spy = vi.spyOn(Date, "now").mockReturnValue(NOW + 5 * 60_000);
    try {
      fireEvent.change(screen.getByPlaceholderText("Search by title or seed…"), { target: { value: "Live" } });
      expect(await chipFor("Live run case")).toBe("Running");
    } finally {
      spy.mockRestore();
    }
  });

  it("a run that dies while the list is open turns Interrupted on the next re-read, with no other write", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      m.threadRows = [LIVE];
      renderCases();
      expect(await chipFor("Live run case")).toBe("Running");
      // The run dies: its heartbeat stops, so no row changes and no realtime event fires.
      vi.setSystemTime(NOW + 5 * 60_000);
      await vi.advanceTimersByTimeAsync(31_000);
      await waitFor(async () => expect(await chipFor("Live run case")).toBe("Interrupted"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("the re-read still applies fresh thread rows when the unrelated counts RPC fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      m.threadRows = [LIVE];
      renderCases();
      expect(await chipFor("Live run case")).toBe("Running");
      m.metricsFail = true;
      vi.setSystemTime(NOW + 5 * 60_000);
      await vi.advanceTimersByTimeAsync(31_000);
      await waitFor(async () => expect(await chipFor("Live run case")).toBe("Interrupted"));
      expect(screen.queryByText(/get_case_metrics unavailable/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a counts failure during a re-read updates rows on screen but adds no row the cached counts never covered", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      m.threadRows = [LIVE];
      renderCases();
      expect(await chipFor("Live run case")).toBe("Running");
      // The counts RPC goes down, and a case is created elsewhere meanwhile.
      m.metricsFail = true;
      m.threadRows = [row("fresh", "Case created elsewhere", { updated_at: ago(1_000) }), LIVE];
      vi.setSystemTime(NOW + 5 * 60_000);
      await vi.advanceTimersByTimeAsync(31_000);
      await waitFor(async () => expect(await chipFor("Live run case")).toBe("Interrupted"));
      expect(screen.queryByText("Case created elsewhere")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a case held back during a counts outage appears once counts recover, even with nothing running", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      m.threadRows = [DONE];
      renderCases();
      expect(await chipFor("Done case")).toBe("Finished");
      // Counts go down; a case is created elsewhere and its realtime event fires.
      m.metricsFail = true;
      m.threadRows = [row("fresh", "Case created elsewhere", { updated_at: ago(1_000) }), DONE];
      for (const cb of m.realtime) cb();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(screen.queryByText("Case created elsewhere")).toBeNull();
      // Counts recover. No further write happens; the list must still pick the case up.
      m.metricsFail = false;
      await vi.advanceTimersByTimeAsync(31_000);
      expect(await screen.findByText("Case created elsewhere")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the stale-counts retry survives a read where counts recover but the threads query fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      m.threadRows = [DONE];
      renderCases();
      expect(await chipFor("Done case")).toBe("Finished");
      m.metricsFail = true;
      m.threadRows = [row("fresh", "Case created elsewhere", { updated_at: ago(1_000) }), DONE];
      for (const cb of m.realtime) cb();
      await vi.advanceTimersByTimeAsync(1_000);
      // Next retry: counts are back, but the threads read fails.
      m.metricsFail = false;
      m.threadsFail = true;
      await vi.advanceTimersByTimeAsync(31_000);
      expect(screen.queryByText("Case created elsewhere")).toBeNull();
      // The retry must still be scheduled; the next one succeeds.
      m.threadsFail = false;
      await vi.advanceTimersByTimeAsync(31_000);
      expect(await screen.findByText("Case created elsewhere")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rows are judged as of when the threads read returned, not after a slow counts call", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      m.metricsDelayMs = 90_000;
      m.threadRows = [LIVE];
      renderCases();
      await vi.advanceTimersByTimeAsync(91_000);
      expect(await chipFor("Live run case")).toBe("Running");
    } finally {
      vi.useRealTimers();
    }
  });

  it("an older read that finishes after a newer one does not overwrite it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      m.threadRows = [DONE];
      renderCases();
      expect(await chipFor("Done case")).toBe("Finished");
      // Read A starts: its counts call is slow (it will succeed, with A's older rows).
      m.metricsDelayMs = 5_000;
      for (const cb of m.realtime) cb();
      await vi.advanceTimersByTimeAsync(700);
      // Read B starts later: a new case, and its counts call fails at once.
      m.threadRows = [row("fresh", "Case created elsewhere", { updated_at: ago(1_000) }), DONE];
      m.metricsDelayMs = 0;
      m.metricsFail = true;
      for (const cb of m.realtime) cb();
      await vi.advanceTimersByTimeAsync(700);
      // A finishes after B. It must not publish over B (nor clear B's stale flag).
      await vi.advanceTimersByTimeAsync(5_000);
      m.metricsFail = false;
      await vi.advanceTimersByTimeAsync(31_000);
      expect(await screen.findByText("Case created elsewhere")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("when counts have never loaded, a background refresh keeps the error instead of showing zero counts", async () => {
    m.metricsFail = true;
    m.threadRows = [LIVE];
    renderCases();
    expect(await screen.findByText(/get_case_metrics unavailable/)).toBeTruthy();
    // A realtime change schedules a silent refresh; the counts RPC is still down.
    for (const cb of m.realtime) cb();
    await new Promise((r) => setTimeout(r, 800));
    expect(screen.getByText(/get_case_metrics unavailable/)).toBeTruthy();
    expect(screen.queryByText(/0 artifacts/)).toBeNull();
  });
});

function renderCaseView(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/cases/${id}`]}>
      <Routes>
        <Route path="/cases/:threadId" element={<CaseViewPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Read-only case page does not call a dead run live", () => {
  it("no Running badge and no 'Open live chat' when the heartbeat has died", async () => {
    m.threadRows = [DEAD_ACTIVE];
    renderCaseView("dead");
    expect(await screen.findByRole("link", { name: /Continue in chat/ })).toBeTruthy();
    // Let the case snapshot hydrate before judging the badge.
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryByText("Running")).toBeNull();
    expect(screen.queryByRole("link", { name: /Open live chat/ })).toBeNull();
  });

  it("control: a live heartbeat still shows Running and 'Open live chat'", async () => {
    m.threadRows = [LIVE];
    renderCaseView("live");
    expect(await screen.findByRole("link", { name: /Open live chat/ })).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
  });

  it("a live run keeps Running when the page re-renders long after its metadata was fetched", async () => {
    m.threadRows = [LIVE];
    const view = renderCaseView("live");
    expect(await screen.findByRole("link", { name: /Open live chat/ })).toBeTruthy();
    // Five minutes on, the page re-renders (a tab change, an artifact arriving). The live run
    // keeps pulsing its heartbeat server-side; only a stale one-time read would call it dead.
    const spy = vi.spyOn(Date, "now").mockReturnValue(NOW + 5 * 60_000);
    try {
      view.rerender(
        <MemoryRouter initialEntries={["/cases/live"]}>
          <Routes>
            <Route path="/cases/:threadId" element={<CaseViewPage />} />
          </Routes>
        </MemoryRouter>,
      );
      expect(screen.getByRole("link", { name: /Open live chat/ })).toBeTruthy();
      expect(screen.getByText("Running")).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });
});
