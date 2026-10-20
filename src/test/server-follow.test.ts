import { describe, expect, it } from "vitest";
import { currentRunEvents, shouldFollowServer } from "@/lib/server-follow";
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
