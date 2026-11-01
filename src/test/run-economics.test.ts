import { describe, it, expect } from "vitest";
import {
  endingLabel,
  splitRunTime,
  sumTokens,
  summarizeRuns,
  dailySpendUsd,
  formatDuration,
  formatTokens,
  formatUsd,
  latestRun,
  type InvocationRow,
} from "@/lib/run-economics";

// A fixed "now" so every window assertion is deterministic.
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const DAY = 86_400_000;
const daysAgo = (d: number) => new Date(NOW - d * DAY).toISOString();

let seq = 0;
function inv(over: Partial<InvocationRow> = {}): InvocationRow {
  seq += 1;
  return {
    id: `inv-${seq}`,
    thread_id: "thread-1",
    started_at: daysAgo(1),
    duration_ms: 100_000,
    step_count: 8,
    tool_call_count: 12,
    stop_reason: "natural_stop",
    credits_micro_usd: 150_000,
    model_id: "glm-5.2",
    persist_ms: 2_000,
    salvage_ms: null,
    salvage_outcome: "none",
    unfinished_steps: 0,
    ...over,
  };
}

describe("endingLabel", () => {
  it("names a forced finalization as a time limit, not as a failure", () => {
    const e = endingLabel("finalize_forced");
    expect(e.label).toMatch(/time limit/i);
    expect(e.label).not.toMatch(/fail|error/i);
    expect(e.tone).toBe("warn");
  });

  it("marks a stream error as bad and a natural stop as ok", () => {
    expect(endingLabel("stream_error").tone).toBe("bad");
    expect(endingLabel("natural_stop").tone).toBe("ok");
  });

  it("says 'Not recorded' for null and for a value it does not know, and never throws", () => {
    expect(endingLabel(null).label).toBe("Not recorded");
    expect(endingLabel("something_new").label).toBe("Not recorded");
    expect(endingLabel(null).tone).toBe("info");
  });
});

describe("splitRunTime", () => {
  it("splits a timed run into loop, salvage and the rest of persistence", () => {
    const s = splitRunTime(inv({ duration_ms: 150_000, persist_ms: 55_000, salvage_ms: 53_000, unfinished_steps: 0 }));
    expect(s).toEqual({ totalMs: 150_000, loopMs: 95_000, salvageMs: 53_000, persistOtherMs: 2_000 });
  });

  it("treats a missing salvage as zero inside a timed run", () => {
    const s = splitRunTime(inv({ duration_ms: 90_000, persist_ms: 2_000, salvage_ms: null, unfinished_steps: 0 }));
    expect(s).toEqual({ totalMs: 90_000, loopMs: 88_000, salvageMs: 0, persistOtherMs: 2_000 });
  });

  it("returns null for a run that was never timed (unfinished_steps is not a number)", () => {
    expect(splitRunTime(inv({ unfinished_steps: null, persist_ms: null }))).toBeNull();
  });

  it("returns null when the duration is missing", () => {
    expect(splitRunTime(inv({ duration_ms: null }))).toBeNull();
  });

  it("never lets salvage exceed persistence, and never goes negative", () => {
    const s = splitRunTime(inv({ duration_ms: 50_000, persist_ms: 10_000, salvage_ms: 99_000, unfinished_steps: 0 }));
    expect(s).not.toBeNull();
    expect(s!.salvageMs).toBe(10_000);
    expect(s!.persistOtherMs).toBe(0);
    expect(s!.loopMs).toBe(40_000);
  });
});

describe("sumTokens", () => {
  it("adds step tokens per invocation", () => {
    const m = sumTokens([
      { invocation_id: "a", input_tokens: 100, output_tokens: 10 },
      { invocation_id: "a", input_tokens: 200, output_tokens: 20 },
      { invocation_id: "b", input_tokens: 5, output_tokens: 1 },
    ]);
    expect(m.get("a")).toEqual({ input: 300, output: 30, partial: false });
    expect(m.get("b")).toEqual({ input: 5, output: 1, partial: false });
  });

  it("flags a run as partial when any step carries no usage, instead of counting it as zero", () => {
    const m = sumTokens([
      { invocation_id: "a", input_tokens: 100, output_tokens: 10 },
      { invocation_id: "a", input_tokens: null, output_tokens: null },
    ]);
    expect(m.get("a")).toEqual({ input: 100, output: 10, partial: true });
  });
});

describe("summarizeRuns", () => {
  it("separates 14-day and 30-day spend and ignores runs older than 30 days", () => {
    const s = summarizeRuns(
      [
        inv({ started_at: daysAgo(2), credits_micro_usd: 100_000 }),
        inv({ started_at: daysAgo(20), credits_micro_usd: 300_000 }),
        inv({ started_at: daysAgo(45), credits_micro_usd: 900_000 }),
      ],
      NOW,
    );
    expect(s.runs).toBe(2);
    expect(s.spend14Usd).toBeCloseTo(0.1, 6);
    expect(s.spend30Usd).toBeCloseTo(0.4, 6);
  });

  it("counts a null cost as unknown, not as zero, and leaves it out of the average", () => {
    const s = summarizeRuns(
      [
        inv({ credits_micro_usd: 200_000 }),
        inv({ credits_micro_usd: null }),
        inv({ credits_micro_usd: 400_000 }),
      ],
      NOW,
    );
    expect(s.costUnknownRuns).toBe(1);
    expect(s.avgRunUsd).toBeCloseTo(0.3, 6);
    expect(s.spend30Usd).toBeCloseTo(0.6, 6);
  });

  it("reports the forced share over runs whose ending is recorded", () => {
    const s = summarizeRuns(
      [
        inv({ stop_reason: "finalize_forced" }),
        inv({ stop_reason: "natural_stop" }),
        inv({ stop_reason: "natural_stop" }),
        inv({ stop_reason: null }),
      ],
      NOW,
    );
    expect(s.forcedShare).toBeCloseTo(1 / 3, 6);
  });

  it("reports the salvage share of run time over timed runs only", () => {
    const s = summarizeRuns(
      [
        inv({ duration_ms: 100_000, persist_ms: 40_000, salvage_ms: 38_000, unfinished_steps: 0 }),
        inv({ duration_ms: 100_000, persist_ms: 2_000, salvage_ms: null, unfinished_steps: 0 }),
        inv({ duration_ms: 500_000, persist_ms: null, salvage_ms: null, unfinished_steps: null }), // never timed: excluded
      ],
      NOW,
    );
    expect(s.timedRuns).toBe(2);
    expect(s.salvageShareOfTime).toBeCloseTo(38_000 / 200_000, 6);
  });

  it("returns null shares and a zero count for an empty window, without dividing by zero", () => {
    const s = summarizeRuns([], NOW);
    expect(s.runs).toBe(0);
    expect(s.forcedShare).toBeNull();
    expect(s.salvageShareOfTime).toBeNull();
    expect(s.avgRunUsd).toBeNull();
    expect(s.spend30Usd).toBe(0);
  });
});

describe("dailySpendUsd", () => {
  it("buckets recorded cost into 14 whole days, oldest first, skipping null costs", () => {
    const d = dailySpendUsd(
      [
        inv({ started_at: daysAgo(0.2), credits_micro_usd: 100_000 }),
        inv({ started_at: daysAgo(0.4), credits_micro_usd: 50_000 }),
        inv({ started_at: daysAgo(3.1), credits_micro_usd: 200_000 }),
        inv({ started_at: daysAgo(3.2), credits_micro_usd: null }),
        inv({ started_at: daysAgo(20), credits_micro_usd: 999_000 }), // outside the 14 days
      ],
      14,
      NOW,
    );
    expect(d).toHaveLength(14);
    expect(d[13]).toBeCloseTo(0.15, 6); // today
    expect(d[10]).toBeCloseTo(0.2, 6); // three days ago
    expect(d.reduce((a, b) => a + b, 0)).toBeCloseTo(0.35, 6);
  });
});

describe("formatDuration", () => {
  it("writes minutes and seconds, seconds alone under a minute, and <1s for a blink", () => {
    expect(formatDuration(154_200)).toBe("2m 34s");
    expect(formatDuration(84_700)).toBe("1m 25s");
    expect(formatDuration(9_000)).toBe("9s");
    expect(formatDuration(57)).toBe("<1s");
    expect(formatDuration(120_000)).toBe("2m 0s");
  });

  it("shows an em dash for a missing duration, never 0s", () => {
    expect(formatDuration(null)).toBe("—");
  });
});

describe("formatTokens", () => {
  it("keeps small counts exact and abbreviates thousands and millions", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(2_950)).toBe("3.0k");
    expect(formatTokens(141_500)).toBe("141.5k");
    expect(formatTokens(1_250_000)).toBe("1.25M");
  });
});

describe("formatUsd", () => {
  it("uses three decimals under a dollar and two from a dollar up", () => {
    expect(formatUsd(0.1423)).toBe("$0.142");
    expect(formatUsd(0)).toBe("$0.000");
    expect(formatUsd(1.7721)).toBe("$1.77");
  });

  it("shows an em dash for a cost that was never recorded, not $0", () => {
    expect(formatUsd(null)).toBe("—");
  });
});

describe("latestRun", () => {
  it("returns the newest run even when its cost was not recorded, instead of borrowing an older run's cost", () => {
    const newest = inv({ started_at: daysAgo(0.1), credits_micro_usd: null });
    const older = inv({ started_at: daysAgo(2), credits_micro_usd: 400_000 });
    const r = latestRun([older, newest]);
    expect(r?.id).toBe(newest.id);
    expect(r?.credits_micro_usd).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(latestRun([])).toBeNull();
  });
});
