import { describe, expect, it } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import type { ToolEvent } from "@/hooks/useThreadToolActivity";
import {
  buildCaseSnapshot,
  describeCaseChanges,
  diffCaseSnapshots,
  shouldAnnounceChanges,
  type CaseSnapshotInput,
  type CaseThreadRow,
} from "@/lib/case-snapshot";

/**
 * The case snapshot is the ONE object the header, tab badges, Overview, Tools
 * and Report read. Production showed "Interrupted · 46 tools · $0.120" in the
 * header beside "48 calls" in the panels, then "Complete · 48 tools · $0.393"
 * with the Tools badge still at 46. These tests pin the pure half: what the
 * snapshot says, when it may say it, and what counts as an update.
 */

const NOW = Date.parse("2026-09-11T10:00:00Z");

const thread = (over: Partial<CaseThreadRow> = {}): CaseThreadRow => ({
  id: "t1",
  seed_value: "analyst@example.com",
  seed_type: "email",
  status: "finished",
  credits_used: 0,
  cost_micro_usd: 120_000,
  recovered_at: null,
  recovery_reason: "stream_error: upstream provider closed the connection",
  run_started_at: "2026-09-11T09:50:00Z",
  last_heartbeat_at: "2026-09-11T09:55:00Z",
  updated_at: "2026-09-11T09:55:00Z",
  ...over,
});

const event = (i: number, over: Partial<ToolEvent> = {}): ToolEvent => ({
  id: `e${i}`,
  toolName: "exa_search",
  displayName: "Exa search",
  actionLabel: "Search",
  tone: "ok",
  status: "succeeded",
  at: new Date(NOW - (100 - i) * 1000).toISOString(),
  durationMs: 500,
  cached: false,
  chargedMicroUsd: 1000,
  effectiveChargedMicroUsd: 1000,
  stage: i % 2 ? "VERIFY" : "TRIAGE",
  ...over,
});

const art = (i: number): Artifact => ({
  id: `a${i}`, kind: "email", value: `v${i}@example.com`, confidence: 60, source: "exa_search",
  created_at: "2026-09-11T09:51:00Z", metadata: {},
});

const tally = { verified: 2, infrastructure: 0, probable: 0, review: 5, weak: 0, quarantined: 1, conflict: 1, failed: 0 };

function input(over: Partial<CaseSnapshotInput> = {}): CaseSnapshotInput {
  const events = Array.from({ length: 46 }, (_, i) => event(i));
  return {
    threadId: "t1",
    accountReady: true,
    thread: thread(),
    threadLoaded: true,
    artifacts: { items: Array.from({ length: 10 }, (_, i) => art(i)), loading: false, error: false },
    tools: {
      events,
      persistedTotal: 46,
      failed: 1,
      degraded: 1,
      skipped: 0,
      gated: 0,
      ok: 44,
      loading: false,
      error: false,
      loadedAt: NOW,
    },
    authority: tally,
    integrity: { ok: true, total: 12, firstBreak: null },
    readiness: null,
    chatRunning: false,
    nowMs: NOW,
    ...over,
  };
}

describe("buildCaseSnapshot — one view of the case", () => {
  it("is not hydrated until auth, the thread row, artifacts AND tools have all answered", () => {
    expect(buildCaseSnapshot(input()).hydrated).toBe(true);
    expect(buildCaseSnapshot(input({ accountReady: false })).hydrated).toBe(false);
    expect(buildCaseSnapshot(input({ threadLoaded: false })).hydrated).toBe(false);
    expect(buildCaseSnapshot(input({ artifacts: { items: [], loading: true, error: false } })).hydrated).toBe(false);
    const t = input().tools;
    expect(buildCaseSnapshot(input({ tools: { ...t, loading: true } })).hydrated).toBe(false);
  });

  it("prints the persisted call total — the number every surface shares", () => {
    const s = buildCaseSnapshot(input());
    expect(s.tools.total).toBe(46);
    expect(s.tools.failed).toBe(1);
    expect(s.tools.degraded).toBe(1);
    // The rows travel WITH the count, so a list and its figure are one version.
    expect(s.tools.events).toHaveLength(46);
  });

  it("marks an unreadable ledger unavailable rather than a count of zero", () => {
    const t = input().tools;
    const s = buildCaseSnapshot(input({ tools: { ...t, events: [], persistedTotal: 0, error: true, loadedAt: null } }));
    expect(s.tools.available).toBe(false);
  });

  it("keeps a ledger that loaded once available through a later failed refresh", () => {
    const t = input().tools;
    expect(buildCaseSnapshot(input({ tools: { ...t, error: true } })).tools.available).toBe(true);
  });

  it("reads status, spend and the recovery reason from the same thread row", () => {
    const s = buildCaseSnapshot(input());
    expect(s.run.state).toBe("interrupted");
    expect(s.run.label).toBe("Interrupted");
    expect(s.run.terminal).toBe(true);
    expect(s.spend.text).toBe("$0.120");
    expect(s.run.recoveryReason).toMatch(/^stream_error:/);
  });

  it("carries the last stage that recorded tool activity", () => {
    const events = [event(1, { stage: "TRIAGE" }), event(2, { stage: "VERIFY" }), event(3, { stage: null })];
    const t = input().tools;
    expect(buildCaseSnapshot(input({ tools: { ...t, events } })).tools.lastStage).toBe("VERIFY");
  });

  it("uses the chain-verified evidence text, with the artifact count beside it", () => {
    const s = buildCaseSnapshot(input());
    expect(s.evidence.artifacts).toBe(10);
    expect(s.evidence.ledger).toBe(12);
    expect(s.evidence.text).toBe("12 evidence");
  });
});

describe("diffCaseSnapshots — what counts as a case update", () => {
  it("reports the exact production reconciliation: status, tools and spend moving together", () => {
    const before = buildCaseSnapshot(input());
    const events = Array.from({ length: 48 }, (_, i) => event(i));
    const after = buildCaseSnapshot(input({
      thread: thread({ recovery_reason: null, cost_micro_usd: 393_000 }),
      tools: { ...input().tools, events, persistedTotal: 48 },
    }));
    const changes = diffCaseSnapshots(before, after);
    expect(changes.map((c) => c.field)).toEqual(["status", "tools", "spend"]);
    expect(describeCaseChanges(changes)).toBe("Status Interrupted → Complete · Tools 46 → 48 · Spend $0.120 → $0.393");
  });

  it("never reports the first load as an update", () => {
    expect(diffCaseSnapshots(null, buildCaseSnapshot(input()))).toEqual([]);
    const unhydrated = buildCaseSnapshot(input({ threadLoaded: false }));
    expect(diffCaseSnapshots(unhydrated, buildCaseSnapshot(input()))).toEqual([]);
  });

  it("never compares across threads", () => {
    const a = buildCaseSnapshot(input());
    const b = buildCaseSnapshot(input({ threadId: "t2" }));
    expect(diffCaseSnapshots(a, b)).toEqual([]);
  });
});

describe("shouldAnnounceChanges — the live region's volume", () => {
  const runningInput = () => input({ thread: thread({ status: "active", recovery_reason: null, last_heartbeat_at: new Date(NOW - 5_000).toISOString() }) });

  it("always announces a status transition", () => {
    const next = buildCaseSnapshot(runningInput());
    expect(shouldAnnounceChanges([{ field: "status", from: "Interrupted", to: "Running" }], next)).toBe(true);
  });

  it("stays quiet about counts while a run is live — they move every few seconds", () => {
    const next = buildCaseSnapshot(runningInput());
    expect(next.run.state).toBe("running");
    expect(shouldAnnounceChanges([{ field: "tools", from: "46", to: "47" }], next)).toBe(false);
  });

  it("announces counts that move on a case that is NOT running — that is a reconciliation", () => {
    const next = buildCaseSnapshot(input({ thread: thread({ recovery_reason: null }) }));
    expect(shouldAnnounceChanges([{ field: "tools", from: "46", to: "48" }], next)).toBe(true);
  });
});
