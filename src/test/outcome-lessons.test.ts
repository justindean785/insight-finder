import { describe, expect, it } from "vitest";
import { deriveOutcomeLessons } from "@/lib/outcome-lessons";
import { summarizeToolObservations, type ObservationRow } from "@/lib/tool-observation-classes";

const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);
const recent = (over: Partial<ObservationRow> = {}): ObservationRow => ({
  tool_name: "source_a",
  outcome: "failed",
  cached: false,
  status_code: 503,
  error_msg: "upstream returned HTTP 503",
  thread_id: "case-1",
  created_at: new Date(NOW - 86_400_000).toISOString(),
  ...over,
});

function failingRows(): ObservationRow[] {
  return [
    recent({ thread_id: "case-1" }),
    recent({ thread_id: "case-2" }),
    recent({ thread_id: "case-1" }),
    recent({ thread_id: "case-2" }),
    recent({ thread_id: "case-1" }),
    recent({ thread_id: "case-2", outcome: "ok", status_code: null, error_msg: null }),
  ];
}

describe("deriveOutcomeLessons", () => {
  it("turns repeated cross-case outcomes into an auditable next-run adaptation", () => {
    const summary = summarizeToolObservations(failingRows(), NOW);
    const lessons = deriveOutcomeLessons(summary);
    expect(lessons).toHaveLength(1);
    expect(lessons[0]).toMatchObject({
      tool: "source_a",
      failureClass: "transport",
      recentAttempts: 6,
      recentFailures: 5,
      sourceCases: 2,
    });
    expect(lessons[0].observation).toContain("5 of 6 real attempts failed");
    expect(lessons[0].adaptation).toContain("one later retry");
    expect(lessons[0].adaptation).toContain("independent source");
  });

  it("changes and retires lessons as the observed data changes", () => {
    const before = deriveOutcomeLessons(summarizeToolObservations(failingRows(), NOW));
    const recoveredRows = [
      ...failingRows(),
      ...Array.from({ length: 8 }, (_, i) => recent({
        thread_id: `recovery-${i % 2}`,
        outcome: "ok",
        status_code: null,
        error_msg: null,
      })),
    ];
    const after = deriveOutcomeLessons(summarizeToolObservations(recoveredRows, NOW));
    expect(before).toHaveLength(1);
    expect(after).toEqual([]);
  });

  it("does not generalize failures from one case or from cached calls", () => {
    const oneCase = Array.from({ length: 8 }, () => recent({ thread_id: "only-case" }));
    expect(deriveOutcomeLessons(summarizeToolObservations(oneCase, NOW))).toEqual([]);
    const cached = failingRows().map((row) => ({ ...row, cached: true }));
    expect(deriveOutcomeLessons(summarizeToolObservations(cached, NOW))).toEqual([]);
  });

  it("uses the failure-specific adaptation without declaring a credential dead", () => {
    const rows = failingRows().map((row, i) => i < 5
      ? { ...row, status_code: 403, error_msg: "forbidden" }
      : row);
    const [lesson] = deriveOutcomeLessons(summarizeToolObservations(rows, NOW));
    expect(lesson.failureClass).toBe("credential_plan");
    expect(lesson.adaptation).toContain("plan access, permissions, and provider policy");
    expect(lesson.adaptation).not.toMatch(/dead credential|key is dead/i);
  });
});
