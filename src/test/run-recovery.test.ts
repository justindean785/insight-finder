import { describe, expect, it } from "vitest";
import {
  buildRecoveryDiagnostic,
  classifyRecovery,
  recoveryPrimaryAction,
  RESUME_UNAVAILABLE_REASON,
} from "@/lib/run-recovery";

/**
 * The interrupted-run state machine. Two things are pinned: every value the
 * backend writes to `recovery_reason` maps to a stable code and a plain
 * explanation, and the ONLY primary action without a server-issued resume
 * contract is "Recovery unavailable" — never a blind retry.
 */

const cls = (reason: string | null, recoveredAt: string | null = null) =>
  classifyRecovery({ runState: "interrupted", recoveryReason: reason, recoveredAt });

describe("classifyRecovery — stable codes for a free-text column", () => {
  it.each([
    ["stale heartbeat recovered by health sweep", "STALE_HEARTBEAT", /health sweep/],
    ["stale heartbeat recovered at run startup", "STALE_HEARTBEAT", /next run started/],
    ["stale heartbeat recovered before new request", "STALE_HEARTBEAT", /new request/],
    ["stale heartbeat recovered by sweeper", "STALE_HEARTBEAT", /sweep/],
  ])("%s → %s", (reason, code, detail) => {
    const c = cls(reason, "2026-09-11T10:00:00Z");
    expect(c?.code).toBe(code);
    expect(c?.detail).toMatch(detail);
  });

  it("maps the completion-contract failures", () => {
    expect(cls("incomplete: run ended without a durable report")?.code).toBe("RUN_INCOMPLETE");
    expect(cls("incomplete: final report could not be saved")?.code).toBe("REPORT_NOT_SAVED");
    expect(cls("incomplete: something new the backend grew")?.code).toBe("RUN_INCOMPLETE");
  });

  it("keeps the provider's own words for a stream error, clipped", () => {
    const c = cls(`stream_error: ${"x".repeat(400)}`);
    expect(c?.code).toBe("STREAM_ERROR");
    expect(c!.detail!.length).toBeLessThanOrEqual(180);
  });

  it("distinguishes recovered-with-no-reason from not-yet-recovered", () => {
    expect(cls(null, "2026-09-11T10:00:00Z")?.code).toBe("RECOVERED");
    expect(cls(null, null)?.code).toBe("RUN_STALLED");
  });

  it("falls back to UNSPECIFIED with the raw reason rather than inventing one", () => {
    const c = cls("something the classifier has never seen");
    expect(c?.code).toBe("UNSPECIFIED");
    expect(c?.detail).toBe("something the classifier has never seen");
  });

  it("gives an analyst Stop its own neutral code — not a failure", () => {
    const c = classifyRecovery({ runState: "stopped", recoveryReason: null, recoveredAt: null });
    expect(c?.code).toBe("STOPPED_BY_ANALYST");
    expect(c?.tone).toBe("neutral");
  });

  it("has nothing to say about a run that completed or is still running", () => {
    expect(classifyRecovery({ runState: "completed", recoveryReason: null, recoveredAt: null })).toBeNull();
    expect(classifyRecovery({ runState: "running", recoveryReason: "stream_error: x", recoveredAt: null })).toBeNull();
    expect(classifyRecovery({ runState: "draft", recoveryReason: null, recoveredAt: null })).toBeNull();
  });
});

describe("recoveryPrimaryAction — never a blind retry", () => {
  it("is 'Recovery unavailable', with the reason, when the server issued no contract", () => {
    const a = recoveryPrimaryAction(null);
    expect(a.kind).toBe("unavailable");
    expect(a.label).toBe("Recovery unavailable");
    if (a.kind === "unavailable") expect(a.reason).toBe(RESUME_UNAVAILABLE_REASON);
  });

  it("refuses a half-formed contract — both a run ID and an idempotency key are required", () => {
    expect(recoveryPrimaryAction({ runId: "r1", idempotencyKey: "" }).kind).toBe("unavailable");
    expect(recoveryPrimaryAction({ runId: "  ", idempotencyKey: "k1" }).kind).toBe("unavailable");
  });

  it("offers 'Resume investigation' only for a well-formed server contract", () => {
    const a = recoveryPrimaryAction({ runId: "run_123", idempotencyKey: "idem_456" });
    expect(a.kind).toBe("resume");
    expect(a.label).toBe("Resume investigation");
  });

  it("has no retry variant at all", () => {
    for (const c of [null, { runId: "r", idempotencyKey: "k" }]) {
      expect(recoveryPrimaryAction(c).label).not.toMatch(/retry/i);
    }
  });
});

describe("buildRecoveryDiagnostic", () => {
  const classification = cls("stream_error: upstream closed")!;
  const text = buildRecoveryDiagnostic({
    threadId: "11111111-2222-4333-8444-555555555555",
    classification,
    runStateLabel: "Interrupted",
    recoveryReason: "stream_error: upstream closed",
    startedAt: "2026-09-11T09:50:00Z",
    heartbeatAt: "2026-09-11T09:55:00Z",
    recoveredAt: null,
    artifacts: 55,
    toolTotal: 48,
    toolFailed: 1,
    toolDegraded: 1,
    spendText: "$0.393",
    lastStage: "Verify",
    failedTools: [{ name: "Firecrawl", reason: "timeout after 15000ms" }],
    capturedAt: "2026-09-11T10:00:00Z",
  });

  it("carries identifiers, the code, counts and timestamps", () => {
    expect(text).toContain("Case: 11111111-2222-4333-8444-555555555555");
    expect(text).toContain("Status: Interrupted (STREAM_ERROR)");
    expect(text).toContain("Preserved: 55 artifacts · 48 tool calls (1 failed, 1 degraded)");
    expect(text).toContain("Last stage with tool activity: Verify");
    expect(text).toContain("Firecrawl — timeout after 15000ms");
  });

  it("never carries the investigation target — a diagnostic is pasted into tickets", () => {
    expect(text).not.toMatch(/@example\.com|seed/i);
  });
});
