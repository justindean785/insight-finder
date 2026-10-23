import { describe, expect, it } from "vitest";
import {
  describeSourceReliability,
  summarizeSourceReliability,
  type SourceLogRow,
} from "@/lib/source-reliability";

const NOW = Date.parse("2026-10-23T12:00:00Z");
const day = (n: number) => new Date(NOW - n * 24 * 3600 * 1000).toISOString();
const row = (tool: string, outcome: string | null, ageDays = 1, cached: boolean | null = false): SourceLogRow => ({
  tool_name: tool, outcome, cached, created_at: day(ageDays),
});
const many = (n: number, f: () => SourceLogRow) => Array.from({ length: n }, f);
const get = (rows: SourceLogRow[], tool: string) =>
  summarizeSourceReliability(rows, [tool], NOW).find((r) => r.tool === tool);

describe("Sources reliability is measured on real attempts, like tool_health", () => {
  it("a tool with only skips and empties does NOT read 100%: it has no attempts", () => {
    const rows = [...many(30, () => row("t", "skipped")), ...many(10, () => row("t", "empty"))];
    const r = get(rows, "t")!;
    expect(r.reliability).toBeNull();
    expect(r.attempts).toBe(0);
    expect(r.skipped).toBe(30);
    expect(r.empty).toBe(10);
  });

  it("skips and empties are excluded from numerator AND denominator", () => {
    const rows = [
      ...many(9, () => row("t", "ok")), row("t", "failed"),
      ...many(50, () => row("t", "skipped")), ...many(50, () => row("t", "empty")),
    ];
    const r = get(rows, "t")!;
    expect(r.reliability).toBe(90); // 9 / (9 + 1), not 109 / 110
    expect(r.attempts).toBe(10);
  });

  it("the reproduced production shape: the old ok-flag read 100%, the outcome reading shows the failures", () => {
    // deepfind_disposable_email: failures only in the last two weeks. ok-flag rows were true for skip/empty.
    const rows = [...many(3, () => row("t", "failed", 3)), ...many(7, () => row("t", "ok", 20)), row("t", "skipped", 2)];
    const r = get(rows, "t")!;
    expect(r.reliability).toBe(70);
    expect(r.delta).toBeLessThan(0);
  });

  it("cache replays are not live attempts", () => {
    const rows = [row("t", "ok", 1, true), row("t", "ok", 1, true), row("t", "failed")];
    const r = get(rows, "t")!;
    expect(r.attempts).toBe(1);
    expect(r.reliability).toBe(0);
  });

  it("a NULL outcome is dropped, never guessed", () => {
    const rows = [row("t", null), row("t", null), row("t", "ok")];
    expect(get(rows, "t")!.attempts).toBe(1);
  });

  it("rows older than the 30-day window are ignored", () => {
    const rows = [row("t", "failed", 45), row("t", "ok", 1)];
    const r = get(rows, "t")!;
    expect(r.attempts).toBe(1);
    expect(r.reliability).toBe(100);
  });

  it("delta compares the last 14 days with the earlier part of the window, on attempts only", () => {
    const rows = [
      ...many(4, () => row("t", "ok", 3)),                         // recent 100%
      ...many(2, () => row("t", "ok", 20)), ...many(2, () => row("t", "failed", 20)), // earlier 50%
      ...many(40, () => row("t", "skipped", 3)),                   // must not move it
    ];
    expect(get(rows, "t")!.delta).toBe(50);
  });

  it("delta is 0 when either side has no attempts", () => {
    expect(get([row("t", "ok", 3)], "t")!.delta).toBe(0);
  });

  it("only tools the user actually ran appear, ordered by attempts, ties by skips then name", () => {
    const rows = [
      ...many(5, () => row("b", "ok")), ...many(5, () => row("a", "ok")),
      ...many(9, () => row("c", "skipped")),
    ];
    const out = summarizeSourceReliability(rows, ["a", "b", "c", "never_run"], NOW).map((r) => r.tool);
    expect(out).toEqual(["a", "b", "c"]);
  });

  it("states the exclusion in words", () => {
    const text = describeSourceReliability({ tool: "t", reliability: 90, delta: 0, attempts: 10, ok: 9, failed: 1, skipped: 3, empty: 2 });
    expect(text).toBe("9 succeeded · 1 failed · 3 skipped (not counted) · 2 no-record (not counted)");
  });
});
