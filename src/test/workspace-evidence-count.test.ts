import { describe, expect, it } from "vitest";
import { describeEvidence, deriveRunState, pickEvidenceCount } from "@/lib/case-snapshot";

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

  it("shows the ARTIFACT count in the legitimate direction — the Evidence tab's number", () => {
    // 29 evidence rows across 23 deduped artifacts — expected by design. The
    // header reads 23, like the tab; the 29 lives in the custody chip.
    const d = describeEvidence({ total: 29 }, 23);
    expect(d.text).toBe("23 evidence");
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
  // 2026-09-11: the same confusion a third time — header "146 evidence", Evidence
  // tab "131" — tooltip and all. The header now shows the tab's number and the
  // custody chip carries the ledger total.
  it("matches the tab badge and explains the ledger in the hint (88cf94fa, and 146 vs 131)", () => {
    const d = describeEvidence({ total: 11 }, 9);
    expect(d.text).toBe("9 evidence");
    expect(d.unledgered).toBe(0);
    expect(d.hint).toBe(
      "9 artifacts, recorded in 11 chain-of-custody entries — one artifact can carry more than one entry. The lock figure counts entries.",
    );
    expect(describeEvidence({ total: 146 }, 131).text).toBe("131 evidence");
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

  it("singularizes the legitimate-direction hint's artifact count correctly", () => {
    expect(describeEvidence({ total: 3 }, 1).hint).toBe(
      "1 artifact, recorded in 3 chain-of-custody entries — one artifact can carry more than one entry. The lock figure counts entries.",
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

// ── Run state ────────────────────────────────────────────────────────────────
//
// `deriveRunState` replaced the header's `deriveWorkspaceStatus`. The invariants
// that function's tests pinned are carried over one for one; what changed is the
// LIVENESS signal. The old function inferred "running" from a tool row landing in
// the last 90s — but `tool_usage_log` is not in the realtime publication, so on a
// long-lived header those rows were frozen at mount and a run opened mid-flight
// read "Interrupted". Liveness is now the backend heartbeat, judged by the same
// 75s bar the server recovers on.
const NOW = Date.parse("2026-09-11T10:00:00Z");
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();
const row = (over: Partial<Parameters<typeof deriveRunState>[0]["thread"] & object> = {}) => ({
  status: "finished",
  recovered_at: null,
  recovery_reason: null,
  run_started_at: ago(600),
  last_heartbeat_at: ago(300),
  ...over,
});

describe("deriveRunState", () => {
  it("lets a live browser stream override an early normal finished update", () => {
    expect(deriveRunState({ thread: row(), chatRunning: true, nowMs: NOW })).toBe("running");
  });

  it("does not paint a terminal run as RUNNING because of recent activity", () => {
    expect(deriveRunState({ thread: row({ last_heartbeat_at: ago(5) }), chatRunning: false, nowMs: NOW })).toBe("completed");
  });

  // `finished` is written on three paths that are NOT the same thing: a clean
  // finalize, the stream-error path (onError), and stale-run recovery.
  it("shows a recovered run as INTERRUPTED, never as a green COMPLETE", () => {
    expect(deriveRunState({
      thread: row({ recovered_at: "2026-07-26T00:20:43.070Z", recovery_reason: "stale heartbeat recovered by health sweep" }),
      chatRunning: false,
      nowMs: NOW,
    })).toBe("interrupted");
  });

  it("shows a stream-error run as INTERRUPTED (recovery_reason without recovered_at)", () => {
    expect(deriveRunState({ thread: row({ recovery_reason: "stream_error: provider disconnected" }), chatRunning: false, nowMs: NOW }))
      .toBe("interrupted");
  });

  it("shows a run that failed the completion contract as INTERRUPTED", () => {
    expect(deriveRunState({ thread: row({ recovery_reason: "incomplete: run ended without a durable report" }), chatRunning: false, nowMs: NOW }))
      .toBe("interrupted");
  });

  it("still shows a clean finalize as COMPLETE", () => {
    expect(deriveRunState({ thread: row(), chatRunning: false, nowMs: NOW })).toBe("completed");
  });

  // Production 2026-08-06, thread 6bdf7e55: status='active' in the database,
  // COMPLETE in the header. I-2 at the UI layer.
  it("does NOT paint a stalled active run as COMPLETE", () => {
    expect(deriveRunState({ thread: row({ status: "active", last_heartbeat_at: ago(400) }), chatRunning: false, nowMs: NOW }))
      .toBe("interrupted");
  });

  // I-1: a blank thread is born status='active' with no run marker.
  it("leaves a never-started active thread a DRAFT, never interrupted", () => {
    expect(deriveRunState({
      thread: row({ status: "active", run_started_at: null, last_heartbeat_at: null }),
      chatRunning: false,
      nowMs: NOW,
    })).toBe("draft");
  });

  it("shows an active thread with a fresh heartbeat as RUNNING even when this tab is not streaming", () => {
    // The page was opened mid-run: useChat has no stream to resume, but the
    // backend is plainly alive. The old 90s tool-row window called this Interrupted.
    expect(deriveRunState({ thread: row({ status: "active", last_heartbeat_at: ago(20) }), chatRunning: false, nowMs: NOW }))
      .toBe("running");
    expect(deriveRunState({ thread: row({ status: "active", run_started_at: null, last_heartbeat_at: null }), chatRunning: true, nowMs: NOW }))
      .toBe("running");
  });

  it("a live stream still overrides an interrupted row", () => {
    expect(deriveRunState({ thread: row({ recovery_reason: "stream_error: transient" }), chatRunning: true, nowMs: NOW }))
      .toBe("running");
  });

  // An analyst Stop writes status='stopped' and the server never stamps a reason
  // on it, so it used to render as a green Complete.
  it("shows an analyst stop as STOPPED — not complete, not interrupted", () => {
    expect(deriveRunState({ thread: row({ status: "stopped" }), chatRunning: false, nowMs: NOW })).toBe("stopped");
  });

  it("treats a thread row that has not loaded as a draft, not a run", () => {
    expect(deriveRunState({ thread: null, chatRunning: false, nowMs: NOW })).toBe("draft");
  });

  it("treats a legacy or failure-named terminal status honestly", () => {
    expect(deriveRunState({ thread: row({ status: "completed" }), chatRunning: false, nowMs: NOW })).toBe("completed");
    expect(deriveRunState({ thread: row({ status: "failed_context_limit" }), chatRunning: false, nowMs: NOW })).toBe("interrupted");
  });
});
