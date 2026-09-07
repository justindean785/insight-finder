import { describe, it, expect } from "vitest";
import {
  hasRunMarker,
  isActiveThreadStatus,
  isNeverStartedThread,
  isRunningThread,
} from "@/lib/thread-status";

describe("isActiveThreadStatus", () => {
  it("treats only null/undefined/'active' as active", () => {
    expect(isActiveThreadStatus("active")).toBe(true);
    expect(isActiveThreadStatus(null)).toBe(true);
    expect(isActiveThreadStatus(undefined)).toBe(true);
  });

  it("treats every terminal/unknown status as NOT active (so it lands in Finished)", () => {
    // Regression: the sidebar previously matched only finished|stopped, so any
    // other status vanished from both groups. The finished bucket must be the
    // exact complement of active — these must all be NOT active.
    for (const s of ["finished", "stopped", "failed_context_limit", "completed", "weird_future_status"]) {
      expect(isActiveThreadStatus(s)).toBe(false);
    }
  });
});

describe("hasRunMarker", () => {
  it("is true when either marker is present", () => {
    expect(hasRunMarker({ run_started_at: "2026-09-07T03:18:54.688Z", last_heartbeat_at: null })).toBe(true);
    expect(hasRunMarker({ run_started_at: null, last_heartbeat_at: "2026-09-07T03:19:44.364Z" })).toBe(true);
    expect(hasRunMarker({ run_started_at: "2026-09-07T03:18:54.688Z", last_heartbeat_at: "2026-09-07T03:19:44.364Z" })).toBe(true);
  });

  it("FAILS CLOSED on a row with no markers, missing fields, or no row at all", () => {
    expect(hasRunMarker({ run_started_at: null, last_heartbeat_at: null })).toBe(false);
    expect(hasRunMarker({})).toBe(false);
    expect(hasRunMarker(null)).toBe(false);
    expect(hasRunMarker(undefined)).toBe(false);
  });
});

describe("isRunningThread / isNeverStartedThread", () => {
  // The exact production shape this exists for: two rows measured 2026-09-07,
  // created by pressing "New investigation" and never typed into. Both sat
  // status='active' with every marker null, and /cases rendered them "Running".
  const blankThread = { status: "active", run_started_at: null, last_heartbeat_at: null };

  it("does NOT call a never-started thread running, however active its status", () => {
    expect(isRunningThread(blankThread)).toBe(false);
    expect(isNeverStartedThread(blankThread)).toBe(true);
  });

  it("treats a defaulted (null) status the same way — that IS how the column arrives", () => {
    const defaulted = { status: null, run_started_at: null, last_heartbeat_at: null };
    expect(isRunningThread(defaulted)).toBe(false);
    expect(isNeverStartedThread(defaulted)).toBe(true);
  });

  it("still calls a genuinely live run running", () => {
    const live = { status: "active", run_started_at: "2026-09-07T03:18:54.688Z", last_heartbeat_at: "2026-09-07T03:19:44.364Z" };
    expect(isRunningThread(live)).toBe(true);
    expect(isNeverStartedThread(live)).toBe(false);
  });

  it("a CPU-killed run — active, markers present, heartbeat long dead — is still 'running' to this predicate", () => {
    // Deliberate: this predicate answers "did a run start and has nothing ended
    // it", which is what a label should say. Liveness in the *now* sense is
    // isRunHeartbeatAlive, and reaping a dead run is the stale sweep's job.
    // Conflating the two is what let a dead run be reported as alive.
    const killed = { status: "active", run_started_at: "2026-08-01T00:00:00.000Z", last_heartbeat_at: "2026-08-01T00:01:00.000Z" };
    expect(isRunningThread(killed)).toBe(true);
    expect(isNeverStartedThread(killed)).toBe(false);
  });

  it("never claims a terminal thread is running or a draft", () => {
    for (const status of ["finished", "stopped", "failed_context_limit"]) {
      const done = { status, run_started_at: "2026-09-07T03:18:54.688Z", last_heartbeat_at: "2026-09-07T03:19:44.364Z" };
      expect(isRunningThread(done)).toBe(false);
      expect(isNeverStartedThread(done)).toBe(false);
      // A finished thread that somehow lost its markers is still not a draft.
      expect(isNeverStartedThread({ status, run_started_at: null, last_heartbeat_at: null })).toBe(false);
    }
  });

  it("handles a null row (meta not loaded yet) without claiming a run", () => {
    expect(isRunningThread(null)).toBe(false);
    expect(isRunningThread(undefined)).toBe(false);
    expect(isNeverStartedThread(null)).toBe(false);
  });
});
