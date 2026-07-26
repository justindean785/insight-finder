import { describe, expect, it } from "vitest";
import { deriveWorkspaceStatus, pickEvidenceCount } from "@/components/workspace/WorkspaceHeader";

describe("pickEvidenceCount — header 'N evidence'", () => {
  it("shows the chain-verified evidence_log total, not the artifact count", () => {
    // Real prod case (thread d9ade739): 29 evidence rows across 23 deduped
    // artifacts. The header must read 29 (evidence_log), never 23 (artifacts).
    expect(pickEvidenceCount({ total: 29 }, 23)).toBe(29);
  });

  it("trusts a chain-verified zero even when artifacts are present", () => {
    expect(pickEvidenceCount({ total: 0 }, 5)).toBe(0);
  });

  it("falls back to the artifact count only while integrity is still loading", () => {
    expect(pickEvidenceCount(null, 23)).toBe(23);
  });
});

describe("deriveWorkspaceStatus", () => {
  it("lets a live browser stream override an early normal finished update", () => {
    expect(deriveWorkspaceStatus({
      threadStatus: "finished",
      chatRunning: true,
      recentlyActive: true,
      hasEvidence: true,
    })).toBe("active");
  });

  it("does not paint a terminal run as RUNNING because of old tool activity", () => {
    expect(deriveWorkspaceStatus({
      threadStatus: "finished",
      chatRunning: false,
      recentlyActive: true,
      hasEvidence: true,
    })).toBe("completed");
  });

  // `finished` is written on three paths that are NOT the same thing: a clean
  // finalize, the stream-error path (onError), and stale-run recovery. Painting all
  // three green is how a fabricated "recovered run" stub and a genuine report became
  // visually identical in production.
  it("shows a recovered run as INTERRUPTED, never as a green COMPLETE", () => {
    expect(deriveWorkspaceStatus({
      threadStatus: "finished",
      chatRunning: false,
      recentlyActive: false,
      hasEvidence: false,
      recoveredAt: "2026-07-26T00:20:43.070Z",
      recoveryReason: "stale heartbeat recovered by health sweep",
    })).toBe("interrupted");
  });

  it("shows a stream-error run as INTERRUPTED (recovery_reason without recovered_at)", () => {
    expect(deriveWorkspaceStatus({
      threadStatus: "finished",
      chatRunning: false,
      recentlyActive: false,
      hasEvidence: true,
      recoveryReason: "stream_error: provider disconnected",
    })).toBe("interrupted");
  });

  it("shows a run that failed the completion contract as INTERRUPTED", () => {
    expect(deriveWorkspaceStatus({
      threadStatus: "finished",
      chatRunning: false,
      recentlyActive: false,
      hasEvidence: true,
      recoveryReason: "incomplete: run ended without a durable report",
    })).toBe("interrupted");
  });

  it("still shows a clean finalize as COMPLETE", () => {
    expect(deriveWorkspaceStatus({
      threadStatus: "finished",
      chatRunning: false,
      recentlyActive: false,
      hasEvidence: true,
      recoveredAt: null,
      recoveryReason: null,
    })).toBe("completed");
  });

  it("a live stream still overrides an interrupted row", () => {
    expect(deriveWorkspaceStatus({
      threadStatus: "finished",
      chatRunning: true,
      recentlyActive: true,
      hasEvidence: true,
      recoveryReason: "stream_error: transient",
    })).toBe("active");
  });
});
