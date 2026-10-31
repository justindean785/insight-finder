import { describe, expect, it } from "vitest";
import { currentRunEvents, isCurrentRunMessage, shouldFollowServer, shouldForceStreamEnd, shouldEndStreamAfterGrace } from "@/lib/server-follow";
import type { ToolEvent } from "@/hooks/useThreadToolActivity";

const ev = (id: string, at: string): ToolEvent => ({ id, at } as unknown as ToolEvent);

describe("shouldFollowServer — the live view dropped but the run is alive", () => {
  it("follows when this browser is not streaming and the server run is alive", () => {
    expect(shouldFollowServer({ clientStreaming: false, serverRunActive: true })).toBe(true);
  });
  it("does not follow while this browser is receiving the stream itself", () => {
    expect(shouldFollowServer({ clientStreaming: true, serverRunActive: true })).toBe(false);
  });
  it("does not follow when no run is alive", () => {
    expect(shouldFollowServer({ clientStreaming: false, serverRunActive: false })).toBe(false);
  });
});

describe("currentRunEvents — only this run's calls, oldest first", () => {
  const start = "2026-10-19T18:24:06.000Z";
  it("drops calls from earlier runs on the same case and sorts by time", () => {
    const out = currentRunEvents(
      [ev("late", "2026-10-19T18:25:11.000Z"), ev("old", "2026-10-19T17:00:00.000Z"), ev("early", "2026-10-19T18:24:10.000Z")],
      start,
    );
    expect(out.map((e) => e.id)).toEqual(["early", "late"]);
  });
  it("tolerates small clock skew between the browser-observed start and the ledger", () => {
    expect(currentRunEvents([ev("skew", "2026-10-19T18:24:03.000Z")], start).map((e) => e.id)).toEqual(["skew"]);
  });
  it("without a recorded start it shows nothing rather than mixing in earlier runs", () => {
    expect(currentRunEvents([ev("x", "2026-10-19T18:25:00.000Z")], null)).toEqual([]);
  });
});

describe("isCurrentRunMessage — only this run's reply may read as live while following", () => {
  const start = "2026-10-19T18:24:06.000Z";
  it("a saved reply created after the run started is this run's", () => {
    expect(isCurrentRunMessage("2026-10-19T18:24:30.000Z", start)).toBe(true);
  });
  it("tolerates small clock skew just before the recorded start", () => {
    expect(isCurrentRunMessage("2026-10-19T18:24:03.000Z", start)).toBe(true);
  });
  it("a reply saved before the run started belongs to an earlier run (a second tab opened on the case)", () => {
    expect(isCurrentRunMessage("2026-10-19T17:00:00.000Z", start)).toBe(false);
  });
  it("a reply with no saved time is this tab's own local copy", () => {
    expect(isCurrentRunMessage(undefined, start)).toBe(true);
  });
  it("with no recorded start there is no honest cut, so the previous behaviour stands", () => {
    expect(isCurrentRunMessage("2026-10-19T17:00:00.000Z", null)).toBe(true);
  });
});

describe("shouldForceStreamEnd — a stream that outlived the run it was streaming", () => {
  const streamStart = Date.parse("2026-10-19T18:24:05.000Z");
  it("ends when the row is terminal for the run this tab is streaming", () => {
    expect(shouldForceStreamEnd({ clientStreaming: true, rowState: "completed", rowStartedAt: "2026-10-19T18:24:06.000Z", streamStartedAtMs: streamStart })).toBe(true);
  });
  it("also ends on an interrupted or stopped row for that run", () => {
    expect(shouldForceStreamEnd({ clientStreaming: true, rowState: "interrupted", rowStartedAt: "2026-10-19T18:24:06.000Z", streamStartedAtMs: streamStart })).toBe(true);
    expect(shouldForceStreamEnd({ clientStreaming: true, rowState: "stopped", rowStartedAt: "2026-10-19T18:24:06.000Z", streamStartedAtMs: streamStart })).toBe(true);
  });
  it("never ends a healthy new stream because the row still shows the PREVIOUS run's finish", () => {
    expect(shouldForceStreamEnd({ clientStreaming: true, rowState: "completed", rowStartedAt: "2026-10-19T17:00:00.000Z", streamStartedAtMs: streamStart })).toBe(false);
  });
  it("does nothing while the row still reads running", () => {
    expect(shouldForceStreamEnd({ clientStreaming: true, rowState: "running", rowStartedAt: "2026-10-19T18:24:06.000Z", streamStartedAtMs: streamStart })).toBe(false);
  });
  it("does nothing when this tab is not streaming", () => {
    expect(shouldForceStreamEnd({ clientStreaming: false, rowState: "completed", rowStartedAt: "2026-10-19T18:24:06.000Z", streamStartedAtMs: streamStart })).toBe(false);
  });
  it("does nothing without a recorded run start or a stream start", () => {
    expect(shouldForceStreamEnd({ clientStreaming: true, rowState: "completed", rowStartedAt: null, streamStartedAtMs: streamStart })).toBe(false);
    expect(shouldForceStreamEnd({ clientStreaming: true, rowState: "completed", rowStartedAt: "2026-10-19T18:24:06.000Z", streamStartedAtMs: null })).toBe(false);
  });
});

describe("shouldEndStreamAfterGrace — the watchdog's 8s fallback ends only the stream it was armed for", () => {
  const armedAtMs = 1_000_000;
  it("ends a stream that was already open when the terminal update arrived and is still loading", () => {
    expect(shouldEndStreamAfterGrace({ clientStreaming: true, streamStartedAtMs: armedAtMs - 30_000, armedAtMs })).toBe(true);
    expect(shouldEndStreamAfterGrace({ clientStreaming: true, streamStartedAtMs: armedAtMs, armedAtMs })).toBe(true);
  });
  it("NEVER ends a stream that opened after the update (a new run started inside the grace window)", () => {
    // production 2026-10-31: run A finished, run B started 8.2s later, B's stream was cut at ~1s
    expect(shouldEndStreamAfterGrace({ clientStreaming: true, streamStartedAtMs: armedAtMs + 8_200, armedAtMs })).toBe(false);
    expect(shouldEndStreamAfterGrace({ clientStreaming: true, streamStartedAtMs: armedAtMs + 1, armedAtMs })).toBe(false);
  });
  it("does nothing when the tab is not streaming", () => {
    expect(shouldEndStreamAfterGrace({ clientStreaming: false, streamStartedAtMs: armedAtMs - 1, armedAtMs })).toBe(false);
    expect(shouldEndStreamAfterGrace({ clientStreaming: true, streamStartedAtMs: null, armedAtMs })).toBe(false);
  });
});
