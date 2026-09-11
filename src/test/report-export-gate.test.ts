import { describe, expect, it } from "vitest";
import type { ConfidenceProfile } from "@/lib/confidence-dimensions";
import {
  buildConfidenceProfile,
  REPORT_READY_MIN_CONFLICT_FREE,
  REPORT_READY_MIN_READINESS,
} from "@/lib/confidence-dimensions";
import {
  DRAFT_MARK,
  evaluateExportGate,
  exportFilename,
  markMarkdown,
  withReviewGate,
  wrapJsonExport,
} from "@/lib/report-export-gate";

/**
 * Export gating reads the EXISTING `reportReady` decision — it adds no
 * threshold. A report at 2% readiness must not be exportable as report-safe,
 * and every draft export must be marked UNVERIFIED DRAFT in the file name AND
 * inside the payload.
 */

function profile(readiness: number, conflictFree: number, identitySufficient: boolean, reportReady: boolean): ConfidenceProfile {
  const dim = (key: string, value: number, sufficient = true) => ({ key, label: key, value, sufficient, reason: "" });
  return {
    dimensions: [
      dim("identity", 60, identitySufficient),
      dim("corroboration", 0),
      dim("conflictFree", conflictFree),
      dim("readiness", readiness),
    ],
    overall: 30,
    artifactCount: 44,
    conflictCount: 11,
    reportReady,
    limited: false,
  };
}

describe("the thresholds are the scoring's own, unchanged", () => {
  it("names the two 60% bars the reportReady expression uses", () => {
    expect(REPORT_READY_MIN_READINESS).toBe(60);
    expect(REPORT_READY_MIN_CONFLICT_FREE).toBe(60);
  });

  it("an empty case is not report-ready", () => {
    expect(buildConfidenceProfile({ artifacts: [], seedValue: null }).reportReady).toBe(false);
  });
});

describe("evaluateExportGate", () => {
  it("a 2%-ready report is a draft, with the reason in plain words", () => {
    const g = evaluateExportGate(profile(2, 75, true, false), "ok");
    expect(g.mode).toBe("draft");
    expect(g.mark).toBe(DRAFT_MARK);
    expect(g.readinessPct).toBe(2);
    expect(g.reasons.join(" ")).toMatch(/Report readiness is 2% — report-safe needs 60%/);
  });

  it("names every unmet check, not just the first", () => {
    const g = evaluateExportGate(profile(2, 40, false, false), "ok");
    expect(g.reasons).toHaveLength(3);
  });

  it("follows reportReady exactly — it never overrules the scoring", () => {
    expect(evaluateExportGate(profile(80, 80, true, true), "ok").mode).toBe("report-safe");
    // Numbers above the bar but reportReady false → still a draft.
    expect(evaluateExportGate(profile(80, 80, true, false), "ok").mode).toBe("draft");
  });

  it("an unknown profile (still loading) is a draft", () => {
    expect(evaluateExportGate(null, "ok").mode).toBe("draft");
  });
});

describe("report-safe fails closed until analyst verdicts are read", () => {
  // Without verdicts an empty review map is indistinguishable from "nothing was
  // rejected", so a row the analyst dismissed would count toward report-safe.
  const strong = profile(80, 80, true, true);

  it("a report-ready profile is still a draft while verdicts load, and says why", () => {
    const g = evaluateExportGate(strong, "unknown");
    expect(g.mode).toBe("draft");
    expect(g.mark).toBe(DRAFT_MARK);
    expect(g.reasons).toEqual([expect.stringMatching(/verdicts are still loading/)]);
  });

  it("…and during an outage, when they could not be read at all", () => {
    const g = evaluateExportGate(strong, "unavailable");
    expect(g.mode).toBe("draft");
    expect(g.reasons[0]).toMatch(/verdicts could not be read/);
  });

  it("the verdict reason sits beside, not instead of, the scoring's own reasons", () => {
    const g = evaluateExportGate(profile(2, 40, false, false), "unavailable");
    expect(g.reasons).toHaveLength(4);
  });

  it("withReviewGate withholds reportReady only — every score is left as computed", () => {
    const gated = withReviewGate(strong, "unavailable");
    expect(gated.reportReady).toBe(false);
    expect(gated.dimensions).toBe(strong.dimensions);
    expect(gated.overall).toBe(strong.overall);
    expect(withReviewGate(strong, "unknown").reportReady).toBe(false);
  });

  it("withReviewGate hands back the SAME object when it withholds nothing", () => {
    expect(withReviewGate(strong, "ok")).toBe(strong);
    const weak = profile(2, 75, true, false);
    expect(withReviewGate(weak, "unavailable")).toBe(weak);
  });
});

describe("draft marking in every payload", () => {
  const draft = evaluateExportGate(profile(2, 75, true, false), "ok");
  const safe = evaluateExportGate(profile(80, 80, true, true), "ok");
  const at = "2026-09-11T10:00:00.000Z";

  it("puts UNVERIFIED-DRAFT in a draft's file name, and nothing in a safe one's", () => {
    expect(exportFilename("osint-report", "analyst_example.com", "md", draft)).toBe("osint-report-UNVERIFIED-DRAFT-analyst_example.com.md");
    expect(exportFilename("osint-report", "analyst_example.com", "md", safe)).toBe("osint-report-analyst_example.com.md");
  });

  it("marks draft Markdown at the top AND the bottom", () => {
    const md = markMarkdown("# Report\n\nBody", draft, at);
    const lines = md.trim().split("\n");
    expect(lines[0]).toContain(`**${DRAFT_MARK}**`);
    expect(lines[lines.length - 1]).toContain(`**${DRAFT_MARK}**`);
    expect(md).toContain("Report readiness is 2%");
  });

  it("marks a report-safe export as such", () => {
    expect(markMarkdown("# Report", safe, at).split("\n")[0]).toContain("REPORT-SAFE");
  });

  it("carries the status INSIDE the JSON payload, where a file name cannot follow", () => {
    const parsed = JSON.parse(wrapJsonExport([{ id: "a1" }], draft, at)) as Record<string, unknown>;
    expect(parsed.export_status).toBe(DRAFT_MARK);
    expect(parsed.report_ready).toBe(false);
    expect(parsed.report_readiness_pct).toBe(2);
    expect(parsed.artifacts).toEqual([{ id: "a1" }]);
  });
});
