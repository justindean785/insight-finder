import { describe, expect, it } from "vitest";
import { buildRunCockpit, type RunCockpitInput } from "@/lib/run-cockpit";
import type { ToolEvent } from "@/hooks/useThreadToolActivity";

const NOW = Date.parse("2026-10-20T10:00:00Z");

const ev = (toolName: string, at: string, status = "succeeded"): ToolEvent =>
  ({ id: `${toolName}-${at}`, toolName, at, status } as unknown as ToolEvent);

function input(over: Partial<RunCockpitInput> = {}, run: Partial<RunCockpitInput["run"]> = {}): RunCockpitInput {
  return {
    run: {
      state: "running", label: "Running", terminal: false,
      recoveryReason: null, recoveredAt: null,
      startedAt: "2026-10-20T09:58:30Z", heartbeatAt: "2026-10-20T09:59:50Z",
      ...run,
    },
    tools: {
      total: 3, failed: 1, lastStage: "TARGETED_PIVOT", lastAt: "2026-10-20T09:59:40Z", available: true,
      events: [ev("whois_lookup", "2026-10-20T09:59:00Z"), ev("breach_check", "2026-10-20T09:59:40Z"), ev("exa_search", "2026-10-20T09:59:20Z", "failed")],
    },
    spendText: "$0.031",
    pendingDecisions: 2,
    nowMs: NOW,
    ...over,
  };
}

describe("buildRunCockpit", () => {
  it("a running case counts elapsed to now and is live", () => {
    const c = buildRunCockpit(input());
    expect(c.live).toBe(true);
    expect(c.elapsed).toBe("1m 30s");
    expect(c.elapsedBasis).toBe("to now");
    expect(c.stop).toBeNull();
  });

  it("the last action is the newest event by time, not by array position", () => {
    const c = buildRunCockpit(input());
    expect(c.lastAction?.at).toBe("2026-10-20T09:59:40Z");
    expect(c.lastAction?.roleInferred).toBe(true);
  });

  it("humanizes the recorded stage and never leaks the raw token", () => {
    expect(buildRunCockpit(input()).stage).toBe("Targeted pivot");
  });

  it("a finished run counts to its last heartbeat and says the reason is not shown here", () => {
    const c = buildRunCockpit(input({}, { state: "completed", label: "Complete", terminal: true }));
    expect(c.elapsed).toBe("1m 20s");
    expect(c.elapsedBasis).toBe("to last heartbeat");
    expect(c.stop?.tone).toBe("done");
    expect(c.stop?.message).toMatch(/not shown in this view/);
  });

  it("an interrupted run explains itself through classifyRecovery", () => {
    const c = buildRunCockpit(input({}, { state: "interrupted", label: "Interrupted", terminal: true, recoveryReason: "stream_error: upstream 529" }));
    expect(c.stop?.title).toBe("Model connection failed");
    expect(c.stop?.detail).toBe("upstream 529");
  });

  it("an analyst stop reads as a stop, neutral", () => {
    const c = buildRunCockpit(input({}, { state: "stopped", label: "Stopped", terminal: true }));
    expect(c.stop?.title).toBe("Run stopped");
    expect(c.stop?.tone).toBe("neutral");
  });

  it("no recorded start means no elapsed figure, not 0s", () => {
    const c = buildRunCockpit(input({}, { startedAt: null }));
    expect(c.elapsed).toBeNull();
    expect(c.elapsedBasis).toBeNull();
  });

  it("an unreadable call ledger yields nulls, never confident zeros", () => {
    const c = buildRunCockpit(input({ tools: { total: 0, failed: 0, lastStage: null, lastAt: null, events: [], available: false } }));
    expect(c.calls).toBeNull();
    expect(c.failed).toBeNull();
    expect(c.lastAction).toBeNull();
    expect(c.stage).toBeNull();
  });

  it("a draft has no elapsed time and no stop explanation", () => {
    const c = buildRunCockpit(input({ tools: { total: 0, failed: 0, lastStage: null, lastAt: null, events: [], available: true } }, { state: "draft", label: "Draft", startedAt: null }));
    expect(c.live).toBe(false);
    expect(c.elapsed).toBeNull();
    expect(c.stop).toBeNull();
    expect(c.calls).toBe(0);
  });

  it("never exposes a progress percentage or a plan", () => {
    const c = buildRunCockpit(input()) as unknown as Record<string, unknown>;
    expect(Object.keys(c)).not.toContain("progress");
    expect(Object.keys(c)).not.toContain("plan");
  });
});
