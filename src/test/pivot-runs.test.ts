// pivot-runs.test.ts — a pivot the analyst started must read as started.
//
// Production, 2026-10-26: "Run now" on kcreech@drvhome.com posted the pivot and
// the case went to Analyzing, yet the Next card still said "No tool has run
// against it yet" and offered Run now again. A pivot only had two states,
// new | searched, and "searched" waited on a tool_usage_log row naming the exact
// target. These tests pin the third state the card was missing, and the honest
// outcome line it shows when the run ends.
import { describe, expect, it, beforeEach } from "vitest";
import {
  derivePivotRunViews,
  pivotRunKey,
  readPivotRuns,
  recordPivotRun,
  type PivotRun,
} from "@/lib/pivot-runs";
import type { Artifact } from "@/hooks/useThreadArtifacts";

const T = "thread-1";
const art = (id: string, created_at: string): Artifact =>
  ({ id, kind: "email", value: `${id}@x.test`, confidence: 50, source: null, created_at, metadata: null });
const run = (over: Partial<PivotRun> = {}): PivotRun => ({
  key: pivotRunKey("email", "kcreech@drvhome.com"),
  target: "kcreech@drvhome.com",
  targetType: "email",
  action: "Investigate email",
  sentAt: "2026-10-26T14:16:00.000Z",
  origin: "manual",
  ...over,
});

beforeEach(() => sessionStorage.clear());

describe("pivotRunKey", () => {
  it("keys by type AND normalized value, never value alone", () => {
    expect(pivotRunKey("email", " KCreech@DrvHome.com ")).toBe(pivotRunKey("email", "kcreech@drvhome.com"));
    // A name and a username that normalize to the same text must not collide.
    expect(pivotRunKey("username", "jordan.vale")).not.toBe(pivotRunKey("name", "Jordan Vale"));
  });
});

describe("the registry", () => {
  it("records per thread, newest last, and survives a re-read", () => {
    recordPivotRun(T, run());
    recordPivotRun(T, run({ target: "b@x.test", key: pivotRunKey("email", "b@x.test"), sentAt: "2026-10-26T14:20:00.000Z" }));
    recordPivotRun("other", run());
    expect(readPivotRuns(T).map((r) => r.target)).toEqual(["kcreech@drvhome.com", "b@x.test"]);
  });

  it("re-sending the same pivot moves it to the end instead of duplicating it", () => {
    recordPivotRun(T, run());
    recordPivotRun(T, run({ target: "b@x.test", key: pivotRunKey("email", "b@x.test") }));
    recordPivotRun(T, run({ sentAt: "2026-10-26T14:30:00.000Z" }));
    const runs = readPivotRuns(T);
    expect(runs.map((r) => r.target)).toEqual(["b@x.test", "kcreech@drvhome.com"]);
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
    const [v] = derivePivotRunViews([run()], { caseRunning: true, artifacts });
    expect(v.phase).toBe("running");
    expect(v.newRows.map((a) => a.id)).toEqual(["new2", "new1"]);
  });

  it("reads Completed once the case stops, and counts only rows created after it was sent", () => {
    const [v] = derivePivotRunViews([run()], { caseRunning: false, artifacts });
    expect(v.phase).toBe("done");
    expect(v.newRows).toHaveLength(2);
    expect(v.newRows.some((a) => a.id === "before")).toBe(false);
  });

  it("an older pivot is never Running, and its window ends where the next one began", () => {
    const older = run({ sentAt: "2026-10-26T14:16:00.000Z" });
    const newer = run({ key: pivotRunKey("email", "b@x.test"), target: "b@x.test", sentAt: "2026-10-26T14:17:00.000Z" });
    const views = derivePivotRunViews([older, newer], { caseRunning: true, artifacts });
    const byTarget = Object.fromEntries(views.map((v) => [v.run.target, v]));
    expect(byTarget["kcreech@drvhome.com"].phase).toBe("done");
    expect(byTarget["kcreech@drvhome.com"].newRows.map((a) => a.id)).toEqual(["new1"]);
    expect(byTarget["b@x.test"].phase).toBe("running");
    expect(byTarget["b@x.test"].newRows.map((a) => a.id)).toEqual(["new2"]);
  });

  it("lists the newest pivot first", () => {
    const views = derivePivotRunViews(
      [run(), run({ key: "email:b", target: "b@x.test", sentAt: "2026-10-26T14:17:00.000Z" })],
      { caseRunning: false, artifacts },
    );
    expect(views[0].run.target).toBe("b@x.test");
  });
});
