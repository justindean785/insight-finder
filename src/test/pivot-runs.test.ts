// pivot-runs.test.ts — a pivot the analyst started must read as started.
//
// Production, 2026-10-26: "Run now" on person@example.test posted the pivot and
// the case went to Analyzing, yet the Next card still said "No tool has run
// against it yet" and offered Run now again. A pivot only had two states,
// new | searched, and "searched" waited on a tool_usage_log row naming the exact
// target. These tests pin the third state the card was missing, and the honest
// outcome line it shows when the run ends.
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  closeLatestPivotRun,
  derivePivotRunViews,
  newestCreatedAt,
  pivotRunKey,
  pivotSendHooks,
  readPivotRuns,
  recordPivotRun,
  type PivotRun,
} from "@/lib/pivot-runs";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { normalizeTarget } from "@/lib/next-step-cards";

const T = "thread-1";
const art = (id: string, created_at: string): Artifact =>
  ({ id, kind: "email", value: `${id}@x.test`, confidence: 50, source: null, created_at, metadata: null });
const run = (over: Partial<PivotRun> = {}): PivotRun => ({
  key: pivotRunKey("email", "person@example.test"),
  target: "person@example.test",
  targetType: "email",
  action: "Investigate email",
  sentAt: "2026-10-26T14:16:00.000Z",
  // The newest server row when it was sent ("before", below).
  anchorCreatedAt: "2026-10-26T14:10:00.000Z",
  origin: "manual",
  ...over,
});
const NONE = new Set<string>();
// Normalized the way useThreadQueriedTargets stores tool_usage_log targets.
const QUERIED = new Set([normalizeTarget("person@example.test")]);

beforeEach(() => sessionStorage.clear());

describe("pivotRunKey", () => {
  it("keys by type AND normalized value, never value alone", () => {
    expect(pivotRunKey("email", " Person@Example.TEST ")).toBe(pivotRunKey("email", "person@example.test"));
    // A name and a username that normalize to the same text must not collide.
    expect(pivotRunKey("username", "jordan.vale")).not.toBe(pivotRunKey("name", "Jordan Vale"));
  });
});

describe("the registry", () => {
  it("records per thread, newest last, and survives a re-read", () => {
    recordPivotRun(T, run());
    recordPivotRun(T, run({ target: "b@x.test", key: pivotRunKey("email", "b@x.test"), sentAt: "2026-10-26T14:20:00.000Z" }));
    recordPivotRun("other", run());
    expect(readPivotRuns(T).map((r) => r.target)).toEqual(["person@example.test", "b@x.test"]);
  });

  it("re-sending the same pivot moves it to the end instead of duplicating it", () => {
    recordPivotRun(T, run());
    recordPivotRun(T, run({ target: "b@x.test", key: pivotRunKey("email", "b@x.test") }));
    recordPivotRun(T, run({ sentAt: "2026-10-26T14:30:00.000Z" }));
    const runs = readPivotRuns(T);
    expect(runs.map((r) => r.target)).toEqual(["b@x.test", "person@example.test"]);
    expect(runs[1].sentAt).toBe("2026-10-26T14:30:00.000Z");
  });

  it("reads an empty list from corrupt storage instead of throwing", () => {
    sessionStorage.setItem(`swarmbot:pivot-runs:${T}`, "{not json");
    expect(readPivotRuns(T)).toEqual([]);
  });
});

describe("derivePivotRunViews", () => {
  const artifacts = [
    art("before", "2026-10-26T14:10:00.000Z"),
    art("new1", "2026-10-26T14:16:30.000Z"),
    art("new2", "2026-10-26T14:18:00.000Z"),
  ];

  it("the latest pivot reads Running while the case runs, with rows so far", () => {
    const [v] = derivePivotRunViews([run()], { caseRunning: true, artifacts, queriedTargets: NONE });
    expect(v.phase).toBe("running");
    expect(v.newRows.map((a) => a.id)).toEqual(["new2", "new1"]);
  });

  it("reads Completed once the case stops ONLY when a tool call was recorded against the target", () => {
    const [v] = derivePivotRunViews([run()], { caseRunning: false, artifacts, queriedTargets: QUERIED });
    expect(v.phase).toBe("done");
    expect(v.newRows).toHaveLength(2);
    expect(v.newRows.some((a) => a.id === "before")).toBe(false);
  });

  it("an ended run with no recorded tool call reads ended (unknown), never done", () => {
    // Stop, an errored run, or a run the agent spent on other leads all end the
    // case the same way; none of them is evidence the pivot ran.
    const [v] = derivePivotRunViews([run()], { caseRunning: false, artifacts, queriedTargets: new Set([normalizeTarget("someone.else@example.test")]) });
    expect(v.phase).toBe("ended");
    expect(v.newRows).toHaveLength(2); // the window count is still reported, as a window
  });

  it("an older pivot is never Running, and its window ends at the next one's anchor", () => {
    const older = run();
    const newer = run({ key: pivotRunKey("email", "b@x.test"), target: "b@x.test", sentAt: "2026-10-26T14:17:00.000Z", anchorCreatedAt: "2026-10-26T14:16:30.000Z" });
    const views = derivePivotRunViews([older, newer], { caseRunning: true, artifacts, queriedTargets: QUERIED });
    const byTarget = Object.fromEntries(views.map((v) => [v.run.target, v]));
    expect(byTarget["person@example.test"].phase).toBe("done");
    expect(byTarget["person@example.test"].newRows.map((a) => a.id)).toEqual(["new1"]);
    expect(byTarget["b@x.test"].phase).toBe("running");
    expect(byTarget["b@x.test"].newRows.map((a) => a.id)).toEqual(["new2"]);
  });

  it("lists the newest pivot first", () => {
    const views = derivePivotRunViews(
      [run(), run({ key: "email:b", target: "b@x.test", sentAt: "2026-10-26T14:17:00.000Z" })],
      { caseRunning: false, artifacts, queriedTargets: NONE },
    );
    expect(views[0].run.target).toBe("b@x.test");
  });

  it("a row created in the same instant as the anchor row is not counted as new (strictly newer)", () => {
    const [v] = derivePivotRunViews([run()], { caseRunning: false, artifacts: [art("tie", "2026-10-26T14:10:00.000Z")], queriedTargets: NONE });
    expect(v.newRows).toEqual([]);
  });
});

describe("browser clock skew cannot move the window", () => {
  afterEach(() => vi.useRealTimers());
  const existing = [art("old1", "2026-10-26T14:00:00.000Z"), art("old2", "2026-10-26T14:10:00.000Z")];
  const later = [art("fresh1", "2026-10-26T14:10:05.000Z"), art("fresh2", "2026-10-26T14:10:20.000Z")];

  // Server time at the send is 14:10:10; the two fresh rows arrive 5s before
  // and 10s after that by the browser's clock. Skew the browser by ±30s.
  for (const skew of [-30_000, 0, 30_000]) {
    it(`counts the same rows with the browser clock ${skew / 1000}s off`, () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(Date.parse("2026-10-26T14:10:10.000Z") + skew));
      const hooks = pivotSendHooks(T, { target: "person@example.test", targetType: "email", action: "Investigate email", origin: "manual" }, () => existing);
      hooks.onAccepted();
      const [v] = derivePivotRunViews(readPivotRuns(T), { caseRunning: true, artifacts: [...existing, ...later], queriedTargets: NONE });
      expect(v.newRows.map((a) => a.id)).toEqual(["fresh2", "fresh1"]);
    });
  }
});

describe("a pivot is recorded only once its send is accepted", () => {
  const pivot = { target: "person@example.test", targetType: "email", action: "Investigate email", origin: "manual" as const };

  it("accepted: recorded, anchored to the newest row present at that moment", () => {
    pivotSendHooks(T, pivot, () => [art("a", "2026-10-26T14:01:00.000Z"), art("b", "2026-10-26T14:05:00.000Z")]).onAccepted();
    const [r] = readPivotRuns(T);
    expect(r.key).toBe(pivotRunKey("email", "person@example.test"));
    expect(r.anchorCreatedAt).toBe("2026-10-26T14:05:00.000Z");
  });

  it("a send that is accepted and then rejects leaves no Running card, so the pivot stays in the queue", () => {
    const hooks = pivotSendHooks(T, pivot, () => []);
    hooks.onAccepted();
    hooks.onFailed();
    expect(readPivotRuns(T)).toEqual([]);
    const views = derivePivotRunViews(readPivotRuns(T), { caseRunning: true, artifacts: [], queriedTargets: NONE });
    expect(views).toEqual([]);
  });

  it("a refused send (neither hook called) records nothing", () => {
    pivotSendHooks(T, pivot, () => []);
    expect(readPivotRuns(T)).toEqual([]);
  });

  it("withdrawing a failed resend does not erase a different, earlier run", () => {
    recordPivotRun(T, run({ key: pivotRunKey("email", "b@x.test"), target: "b@x.test" }));
    const hooks = pivotSendHooks(T, pivot, () => []);
    hooks.onAccepted();
    hooks.onFailed();
    expect(readPivotRuns(T).map((r) => r.target)).toEqual(["b@x.test"]);
  });

  it("newestCreatedAt ignores unparseable timestamps and is null on an empty case", () => {
    expect(newestCreatedAt([])).toBeNull();
    expect(newestCreatedAt([art("x", "not a date"), art("y", "2026-10-26T14:00:00.000Z")])).toBe("2026-10-26T14:00:00.000Z");
  });

  it("a run stored before the anchor existed reads back with a null anchor", () => {
    sessionStorage.setItem(`swarmbot:pivot-runs:${T}`, JSON.stringify([{ ...run(), anchorCreatedAt: undefined }]));
    expect(readPivotRuns(T)[0].anchorCreatedAt).toBeNull();
  });
});

describe("a later non-pivot send ends the pivot's claim to the run", () => {
  const rows = [
    art("before", "2026-10-26T14:10:00.000Z"),
    art("during", "2026-10-26T14:12:00.000Z"),
    art("after", "2026-10-26T14:20:00.000Z"),
  ];

  it("after Continue (or any chat send) the case runs again, but the finished pivot never reads Running", () => {
    recordPivotRun(T, run());
    closeLatestPivotRun(T, rows.slice(0, 2)); // Continue sent once "during" existed
    const [v] = derivePivotRunViews(readPivotRuns(T), { caseRunning: true, artifacts: rows, queriedTargets: NONE });
    expect(v.phase).toBe("ended");
  });

  it("its window stops at the rows present when the other send started", () => {
    recordPivotRun(T, run());
    closeLatestPivotRun(T, rows.slice(0, 2));
    const [v] = derivePivotRunViews(readPivotRuns(T), { caseRunning: false, artifacts: rows, queriedTargets: QUERIED });
    expect(v.phase).toBe("done");
    expect(v.newRows.map((a) => a.id)).toEqual(["during"]);
  });

  it("closing is idempotent and touches only the latest run", () => {
    recordPivotRun(T, run({ key: pivotRunKey("email", "b@x.test"), target: "b@x.test", sentAt: "2026-10-26T14:00:00.000Z" }));
    recordPivotRun(T, run());
    closeLatestPivotRun(T, rows.slice(0, 2));
    closeLatestPivotRun(T, rows); // a second send must not move the first close's anchor
    const byTarget = Object.fromEntries(readPivotRuns(T).map((r) => [r.target, r]));
    expect(byTarget["b@x.test"].closed).toBe(false);
    expect(byTarget["person@example.test"].closedAnchorCreatedAt).toBe("2026-10-26T14:12:00.000Z");
  });

  it("a new pivot sent after a close reads Running on its own run", () => {
    recordPivotRun(T, run());
    closeLatestPivotRun(T, rows.slice(0, 2));
    pivotSendHooks(T, { target: "b@x.test", targetType: "email", action: "Investigate email", origin: "manual" }, () => rows).onAccepted();
    const views = derivePivotRunViews(readPivotRuns(T), { caseRunning: true, artifacts: rows, queriedTargets: NONE });
    expect(views[0].run.target).toBe("b@x.test");
    expect(views[0].phase).toBe("running");
  });
});
