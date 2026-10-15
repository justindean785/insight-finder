import { describe, it, expect } from "vitest";
import { classifyActivityRow, tallyToolEvents } from "@/hooks/useThreadToolActivity";
import { aggregateToolHealth } from "@/hooks/useThreadToolHealth";
import { groupOutcomeCounts, OUTCOME_GROUP_MEMBERS, type CanonicalOutcome } from "@/lib/tool-outcome";

/**
 * F1 (2026-10): the Tools tab's Activity and Health panels classified the SAME
 * tool_usage_log rows differently. On one 125-call production case Activity read
 * "Succeeded 100 / Failed 6 / Degraded 8 / Skipped 11" while Health beside it
 * read "84 Succeeded / 16 No record / 15 Skipped / 3 Degraded / 7 Faulted".
 *
 * Both panels now run `classifyDetailedOutcome` and group with `outcomeGroup`.
 * This test feeds ONE fixture to the Activity tally and the Health aggregation
 * and requires the same five numbers. The error strings are verbatim from
 * production.
 */

type Row = { outcome: string | null; ok: boolean | null; error_msg: string | null; status_code: number | null };

const row = (outcome: string | null, error_msg: string | null = null, status_code: number | null = null, ok: boolean | null = null): Row => ({
  outcome,
  ok: ok ?? (outcome === "ok" || outcome === "empty"),
  error_msg,
  status_code,
});

const FIXTURE: Row[] = [
  // governance skips
  row("skipped", "internal paid-call cap reached (12 this run) — internal throttle, not a provider limit"),
  row("skipped", "provider 'minimax' already has a call in-flight — waiting for its result"),
  row("skipped", "finalize window open; live lookup skipped"),
  row("skipped", "duplicate call: prior other"),
  row("skipped", "indicia address quota/credit exhausted (HTTP 402) — provider suppressed for investigation"),
  // a gated skip (tool unavailable) — counted INSIDE skipped
  row("skipped", "unavailable: missing_key (HIBP_API_KEY not set)"),
  // genuine faults
  row("failed", "input rejected by schema: kind (invalid_enum_value)"),
  row("failed", "input was not valid JSON for record_artifacts: the tool-call text did not parse"),
  // upstream refusals: the 403 in a status code, or only in the text
  row("failed", "jina target error 403", 403),
  row("failed", "nominatim 403"),
  row("failed", "reddit request failed (403)"),
  // the refusal exists ONLY in status_code
  row("failed", "request refused", 403),
  row("failed", "too many requests", 429),
  row("failed", null, 429),
  // cancelled by the run's own time budget
  row("failed", "AbortError: signal has been aborted"),
  row("failed", "The operation was aborted"),
  // clean negatives
  row("empty", "tool returned no usable result"),
  row("empty", ""),
  row("empty", null),
  // successes
  row("ok"),
  row("ok"),
  row("ok", null, 200),
  // legacy row: no outcome column, ok boolean only
  row(null, null, null, true),
];

function activityGroups(rows: Row[]) {
  const events = rows.map((r) => classifyActivityRow(r.outcome, r.ok, r.error_msg, r.status_code));
  return tallyToolEvents(events);
}

function healthGroups(rows: Row[]) {
  const agg = aggregateToolHealth(
    rows.map((r, i) => ({ tool_name: `tool_${i % 4}`, created_at: new Date(1_700_000_000_000 + i * 1000).toISOString(), ...r })),
  );
  return groupOutcomeCounts(agg.totals);
}

describe("Activity and Health report the same outcome groups for the same rows", () => {
  it("produces identical group counts from one fixture", () => {
    const { groups: activity } = activityGroups(FIXTURE);
    const health = healthGroups(FIXTURE);
    expect(activity).toEqual(health);
  });

  it("puts each production string in the group the Health panel shows", () => {
    const { groups, gated } = activityGroups(FIXTURE);
    expect(groups).toEqual({
      succeeded: 4, // 3 ok + the legacy ok row
      no_record: 3, // every `empty`, including "tool returned no usable result" and a blank message
      skipped: 8, // 6 governance/gated skips + 2 cancellations
      degraded: 6, // 4 × 403 (status or text) + 2 × 429 (status only)
      faulted: 2, // the schema rejection and the unparseable JSON
    });
    // Gated is a sub-count INSIDE skipped, never beside it.
    expect(gated).toBe(1);
    const sum = Object.values(groups).reduce((a, b) => a + b, 0);
    expect(sum).toBe(FIXTURE.length);
  });

  it("reads a 403/429 that exists only in status_code as Degraded, not Faulted", () => {
    expect(classifyActivityRow("failed", false, "request refused", 403).group).toBe("degraded");
    expect(classifyActivityRow("failed", false, null, 429).group).toBe("degraded");
    // Without the status code the same text is a genuine fault — Activity must fetch status_code.
    expect(classifyActivityRow("failed", false, "request refused", null).group).toBe("faulted");
  });

  it("reads a cancelled / AbortError row as Skipped, matching Health's Skipped tile", () => {
    const r = classifyActivityRow("failed", false, "AbortError: signal has been aborted", null);
    expect(r.category).toBe("cancelled");
    expect(r.group).toBe("skipped");
    expect(r.status).toBe("skipped");
  });

  it("the five groups partition every canonical outcome exactly once", () => {
    const all: CanonicalOutcome[] = [
      "success", "empty", "skipped", "cancelled", "timeout", "rate_limited",
      "http_denied", "blocked", "config_error", "failed", "unknown",
    ];
    const members = Object.values(OUTCOME_GROUP_MEMBERS).flat();
    expect([...members].sort()).toEqual([...all].sort());
  });
});
