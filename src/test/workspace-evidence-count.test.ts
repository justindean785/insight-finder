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
});
