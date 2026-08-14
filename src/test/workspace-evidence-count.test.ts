import { describe, expect, it } from "vitest";
import { describeEvidence, deriveWorkspaceStatus, pickEvidenceCount } from "@/components/workspace/WorkspaceHeader";

// ── The header must not report a number the analyst cannot interpret ─────────
//
// Production 2026-08-06: the header read "2 evidence · 25 tools" while the
// Evidence tab badge on the SAME page read 50. Both were true — the header reads
// the chain-verified `evidence_log` total, the badge counts `artifacts` — and the
// analyst has no way to know that. The documented invariant (see pickEvidenceCount)
// is that the chain total is the LARGER number, because one artifact can carry
// several evidence rows and the artifact list is deduped. When the chain total is
// SMALLER, that invariant is violated: artifacts exist with no chain-of-custody
// entry, and reporting the small number alone reads as "we found almost nothing."
describe("describeEvidence — header evidence summary", () => {
  it("names both numbers when artifacts exceed the chain (missing custody)", () => {
    // The real prod shape: 50 artifacts, 2 chain entries.
    const d = describeEvidence({ total: 2 }, 50);
    expect(d.text).toBe("50 recorded · 2 chain-verified");
    expect(d.unledgered).toBe(48);
    expect(d.hint).toBe("48 recorded artifacts have no chain-of-custody entry");
  });

  it("leaves the documented, legitimate direction's TEXT unchanged", () => {
    // 29 evidence rows across 23 deduped artifacts — expected by design.
    const d = describeEvidence({ total: 29 }, 23);
    expect(d.text).toBe("29 evidence");
    expect(d.unledgered).toBe(0);
  });

  // 2026-08-10, thread 88cf94fa: header read "11 evidence · 38 tools" while the
  // Evidence tab on the SAME page read "Evidence 9". This is the exact scenario
  // the test above already calls "legitimate" (11 evidence-log rows across 9
  // deduped artifacts) — it was never a counting bug. But `describeEvidence`
  // rendered a bare "11 evidence" with no tooltip in this branch, so it read as
  // an unexplained mismatch against the tab badge, reproducing the 2026-08-06
  // incident in miniature. `hint` must never be silent when the two genuinely
  // differ.
  it("explains itself on the legitimate-but-different-numbers case (2026-08-10, thread 88cf94fa)", () => {
    const d = describeEvidence({ total: 11 }, 9);
    expect(d.text).toBe("11 evidence");
    expect(d.unledgered).toBe(0);
    expect(d.hint).toBe(
      "11 chain-verified evidence rows across 9 deduped artifacts — one artifact can carry more than one evidence-log entry.",
    );
  });

  it("says nothing extra when the two agree — no discrepancy exists to explain", () => {
    const d = describeEvidence({ total: 12 }, 12);
    expect(d.text).toBe("12 evidence");
    expect(d.hint).toBeUndefined();
  });

  it("falls back to the artifact count while integrity is still loading, with no tooltip", () => {
    const d = describeEvidence(null, 23);
    expect(d.text).toBe("23 evidence");
    expect(d.unledgered).toBe(0);
    expect(d.hint).toBeUndefined();
  });

  it("singularizes the missing-custody hint for exactly one artifact", () => {
    expect(describeEvidence({ total: 4 }, 5).hint).toBe(
      "1 recorded artifact has no chain-of-custody entry",
    );
  });

  it("pluralizes the legitimate-direction hint's artifact count correctly", () => {
    expect(describeEvidence({ total: 3 }, 1).hint).toBe(
      "3 chain-verified evidence rows across 1 deduped artifact — one artifact can carry more than one evidence-log entry.",
    );
  });
});

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

  // ── An `active` row is NOT a completed run ────────────────────────────────
  //
  // Production 2026-08-06, thread 6bdf7e55: the database row was status='active'
  // while the UI badge read COMPLETE. `active` was never handled here — after
  // chatRunning and recentlyActive both failed, it fell through to
  // `hasEvidence ? "completed" : "idle"`, so a run that started and died without
  // ever finalizing was painted green. That is invariant I-2 (a run may only
  // present as complete if it actually completed) failing at the UI layer, on the
  // one surface the analyst actually looks at.
  it("does NOT paint a stalled active run as COMPLETE", () => {
    expect(deriveWorkspaceStatus({
      threadStatus: "active",
      chatRunning: false,
      recentlyActive: false,
      hasEvidence: true,
    })).toBe("interrupted");
  });

  // I-1: a thread with no run marker is not an interrupted investigation. A blank
  // thread is born status='active' with no evidence — it must stay IDLE, or every
  // untouched new case renders as a failed run.
  it("leaves a blank active thread IDLE, never interrupted", () => {
    expect(deriveWorkspaceStatus({
      threadStatus: "active",
      chatRunning: false,
      recentlyActive: false,
      hasEvidence: false,
    })).toBe("idle");
  });

  it("still shows a genuinely running active thread as ACTIVE", () => {
    expect(deriveWorkspaceStatus({
      threadStatus: "active",
      chatRunning: false,
      recentlyActive: true,
      hasEvidence: true,
    })).toBe("active");
    expect(deriveWorkspaceStatus({
      threadStatus: "active",
      chatRunning: true,
      recentlyActive: false,
      hasEvidence: false,
    })).toBe("active");
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
