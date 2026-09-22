import { describe, expect, it } from "vitest";
import {
  AUTO_RUN_MAX_CYCLES,
  CONTINUE_PROMPT,
  REPORT_PROMPT,
  autoRunStopMessage,
  canShowRunControls,
  decideAutoContinue,
} from "@/lib/run-controls";

const base = {
  enabled: true,
  cyclesRun: 1,
  artifactsBefore: 10,
  artifactsNow: 12,
  runFailed: false,
  threadFinished: true,
};

describe("decideAutoContinue", () => {
  it("continues while enabled, under the ceiling and the last cycle recorded new evidence", () => {
    expect(decideAutoContinue(base)).toEqual({ action: "continue", cyclesRun: 2 });
  });

  it("stops on saturation: no new artifacts since the cycle was sent", () => {
    expect(decideAutoContinue({ ...base, artifactsNow: 10 })).toEqual({ action: "stop", reason: "no_new_evidence" });
    expect(decideAutoContinue({ ...base, artifactsNow: 9 })).toEqual({ action: "stop", reason: "no_new_evidence" });
  });

  it("does not judge saturation before any armed cycle has run", () => {
    expect(decideAutoContinue({ ...base, cyclesRun: 0, artifactsBefore: null, artifactsNow: 0 }))
      .toEqual({ action: "continue", cyclesRun: 1 });
  });

  it("stops at the cycle ceiling — the cost guard", () => {
    expect(decideAutoContinue({ ...base, cyclesRun: AUTO_RUN_MAX_CYCLES }))
      .toEqual({ action: "stop", reason: "max_cycles" });
    expect(decideAutoContinue({ ...base, cyclesRun: 1, maxCycles: 1 }))
      .toEqual({ action: "stop", reason: "max_cycles" });
  });

  it("a failed or unfinished run wins over everything else", () => {
    expect(decideAutoContinue({ ...base, runFailed: true, artifactsNow: 99 }))
      .toEqual({ action: "stop", reason: "run_failed" });
    expect(decideAutoContinue({ ...base, threadFinished: false, artifactsNow: 99 }))
      .toEqual({ action: "stop", reason: "run_not_finished" });
  });

  it("is a no-op when the switch is off", () => {
    expect(decideAutoContinue({ ...base, enabled: false })).toEqual({ action: "stop", reason: "disabled" });
  });

  it("every stop reason has analyst-facing copy", () => {
    for (const reason of ["disabled", "max_cycles", "no_new_evidence", "run_failed", "run_not_finished"] as const) {
      expect(autoRunStopMessage(reason).length).toBeGreaterThan(10);
    }
    expect(autoRunStopMessage("max_cycles", 5)).toContain("5 cycles");
  });
});

describe("canShowRunControls", () => {
  const ok = { isLoading: false, hasAssistantTurn: true, seedLoaded: true, hasLiveError: false };
  it("shows only under a finished turn with no live failure card", () => {
    expect(canShowRunControls(ok)).toBe(true);
    expect(canShowRunControls({ ...ok, isLoading: true })).toBe(false);
    expect(canShowRunControls({ ...ok, hasAssistantTurn: false })).toBe(false);
    expect(canShowRunControls({ ...ok, seedLoaded: false })).toBe(false);
    expect(canShowRunControls({ ...ok, hasLiveError: true })).toBe(false);
  });
  it("hides when the server reports a live run this tab is not streaming (overlap guard)", () => {
    expect(canShowRunControls({ ...ok, serverRunActive: true })).toBe(false);
  });
  it("stays visible during a run that Auto-run itself started", () => {
    expect(canShowRunControls({ ...ok, isLoading: true, autoRunEnabled: true })).toBe(true);
    expect(canShowRunControls({ ...ok, isLoading: true, autoRunEnabled: false })).toBe(false);
  });
});

describe("prompts", () => {
  it("the continue prompt asks for a delta, not a dossier, and records as it goes", () => {
    expect(CONTINUE_PROMPT).toMatch(/only what is new/i);
    expect(CONTINUE_PROMPT).toMatch(/record_artifacts/);
    expect(CONTINUE_PROMPT).toMatch(/do not rewrite the full report/i);
  });
  it("the report prompt asks for the closing structure the edge contract requires, with no new lookups", () => {
    expect(REPORT_PROMPT).toMatch(/Findings table/);
    expect(REPORT_PROMPT).toMatch(/Network section/);
    expect(REPORT_PROMPT).toMatch(/Summary/);
    expect(REPORT_PROMPT).toMatch(/do not run new lookups/i);
  });
});
