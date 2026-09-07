import { describe, it, expect } from "vitest";
import {
  isRunHeartbeatAlive,
  isStaleActiveThread,
  selectStaleActiveIds,
  RUN_HEARTBEAT_ALIVE_MS,
  STALE_ACTIVE_MS,
} from "@/lib/stale-thread";

const NOW = 1_700_000_000_000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

/** A row that has actually run — the sweep is only ever meant to see these. */
const started = (msAgo: number) => ({
  run_started_at: iso(msAgo),
  last_heartbeat_at: iso(msAgo),
});

describe("isStaleActiveThread", () => {
  it("flags an active thread with no writes past the staleness window", () => {
    expect(isStaleActiveThread("active", iso(STALE_ACTIVE_MS + 1_000), NOW)).toBe(true);
  });

  it("does NOT flag an active thread that wrote recently (still running)", () => {
    expect(isStaleActiveThread("active", iso(30_000), NOW)).toBe(false);
    expect(isStaleActiveThread("active", iso(STALE_ACTIVE_MS - 1_000), NOW)).toBe(false);
  });

  it("never flags a thread that already reached a terminal status", () => {
    expect(isStaleActiveThread("finished", iso(STALE_ACTIVE_MS * 10), NOW)).toBe(false);
    expect(isStaleActiveThread("stopped", iso(STALE_ACTIVE_MS * 10), NOW)).toBe(false);
  });

  it("treats a null status as active (matches isActiveThreadStatus) and can flag it", () => {
    expect(isStaleActiveThread(null, iso(STALE_ACTIVE_MS + 1_000), NOW)).toBe(true);
    expect(isStaleActiveThread(null, iso(10_000), NOW)).toBe(false);
  });

  it("is resilient to a missing or unparseable timestamp", () => {
    expect(isStaleActiveThread("active", null, NOW)).toBe(false);
    expect(isStaleActiveThread("active", "not-a-date", NOW)).toBe(false);
  });
});

describe("isRunHeartbeatAlive", () => {
  it("is true only while the backend is still pulsing (~15s cadence)", () => {
    expect(isRunHeartbeatAlive(iso(0), NOW)).toBe(true);
    expect(isRunHeartbeatAlive(iso(15_000), NOW)).toBe(true);
    expect(isRunHeartbeatAlive(iso(RUN_HEARTBEAT_ALIVE_MS - 1), NOW)).toBe(true);
  });

  it("goes false at the server's own recovery bar, so the two never disagree", () => {
    expect(isRunHeartbeatAlive(iso(RUN_HEARTBEAT_ALIVE_MS + 1), NOW)).toBe(false);
    expect(isRunHeartbeatAlive(iso(10 * 60_000), NOW)).toBe(false);
  });

  it("FAILS CLOSED — no heartbeat, or an unparseable one, is never 'alive'", () => {
    // This is the whole guard. A blank thread and a CPU-killed isolate both sit
    // at status='active' with no fresh heartbeat; answering "alive" for either
    // is how a dead run gets reported as still running.
    expect(isRunHeartbeatAlive(null, NOW)).toBe(false);
    expect(isRunHeartbeatAlive(undefined, NOW)).toBe(false);
    expect(isRunHeartbeatAlive("", NOW)).toBe(false);
    expect(isRunHeartbeatAlive("not-a-date", NOW)).toBe(false);
  });

  it("does not consider a future-dated heartbeat stale (clock skew is not death)", () => {
    expect(isRunHeartbeatAlive(iso(-30_000), NOW)).toBe(true);
  });
});

describe("selectStaleActiveIds", () => {
  it("returns only the ids of stale-active rows that actually ran", () => {
    const rows = [
      { id: "dead", status: "active", updated_at: iso(STALE_ACTIVE_MS + 60_000), ...started(STALE_ACTIVE_MS + 60_000) },
      { id: "running", status: "active", updated_at: iso(15_000), ...started(15_000) },
      { id: "done", status: "finished", updated_at: iso(STALE_ACTIVE_MS * 5), ...started(STALE_ACTIVE_MS * 5) },
    ];
    expect(selectStaleActiveIds(rows, NOW)).toEqual(["dead"]);
  });

  it("NEVER sweeps a never-started thread, however old it looks", () => {
    // The production shape: "New investigation" inserts {user_id}, status
    // defaults to 'active', updated_at freezes at creation — so a blank thread
    // is instantly "stale" by the updated_at test alone and was being written to
    // 'finished'. That reports a completed investigation that never happened.
    // Mirrors the backend's own hasRunMarker refusal (CLAUDE.md I-1).
    const rows = [
      { id: "blank-old", status: "active", updated_at: iso(30 * 24 * 60 * 60_000), run_started_at: null, last_heartbeat_at: null },
      { id: "blank-new", status: "active", updated_at: iso(1_000), run_started_at: null, last_heartbeat_at: null },
    ];
    expect(selectStaleActiveIds(rows, NOW)).toEqual([]);
  });

  it("sweeps a dead run that has only ONE of the two markers", () => {
    const rows = [
      { id: "hb-only", status: "active", updated_at: iso(STALE_ACTIVE_MS + 1_000), run_started_at: null, last_heartbeat_at: iso(STALE_ACTIVE_MS + 1_000) },
      { id: "start-only", status: "active", updated_at: iso(STALE_ACTIVE_MS + 1_000), run_started_at: iso(STALE_ACTIVE_MS + 1_000), last_heartbeat_at: null },
    ];
    expect(selectStaleActiveIds(rows, NOW).sort()).toEqual(["hb-only", "start-only"]);
  });

  it("returns an empty array when nothing is stale", () => {
    const rows = [{ id: "a", status: "active", updated_at: iso(1_000), ...started(1_000) }];
    expect(selectStaleActiveIds(rows, NOW)).toEqual([]);
  });
});
