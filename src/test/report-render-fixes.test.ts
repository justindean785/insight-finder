import { describe, it, expect } from "vitest";
import { buildReportMarkdown } from "@/lib/intel";

// Fixture mirroring the artifact shape used across intel.ts consumers.
const artifact = (over: Partial<{ id: string; kind: string; value: string; source: string | null; confidence: number | null; created_at: string; metadata: Record<string, unknown> | null }> = {}) => ({
  id: over.id ?? "a1",
  thread_id: "t1",
  kind: over.kind ?? "email",
  value: over.value ?? "x@y.com",
  source: over.source ?? "breach_check",
  confidence: over.confidence ?? 60,
  created_at: over.created_at ?? "2026-06-01T10:00:00Z",
  updated_at: over.created_at ?? "2026-06-01T10:00:00Z",
  metadata: over.metadata ?? null,
  label: "VERIFY" as const,
  is_key: false,
  is_dismissed: false,
  notes: null,
  review_state: null,
  group: "contact" as const,
});

// #4 — Collision / Likely Unrelated must surface inline conflict metadata
// (conflict_note / geo_conflict), not just artifacts with an explicit
// collision flag. Previously these rows never appeared and the section read
// "No collisions flagged" even when an artifact pointed at "see Conflicts".
describe("report #4 — conflict metadata is surfaced in the Collision section", () => {
  it("renders a conflict_note row instead of 'No collisions flagged'", () => {
    const md = buildReportMarkdown({
      seedValue: "x@y.com",
      seedType: "email",
      artifacts: [
        artifact({ id: "p1", kind: "phone", value: "9258139324", metadata: {
          conflict_note: "Different name/address than other breaches",
          name_in_breach: "Exavier Hill-Larot",
        } }),
      ],
    });
    expect(md).toContain("## Collision / Likely Unrelated");
    expect(md).not.toContain("_No collisions flagged._");
    expect(md).toContain("Different name/address than other breaches");
  });

  it("surfaces a geo_conflict via its note", () => {
    const md = buildReportMarkdown({
      seedValue: "x@y.com",
      seedType: "email",
      artifacts: [
        artifact({ id: "ip1", kind: "ip", value: "66.87.118.76", metadata: {
          geo_conflict: true,
          geo_conflict_note: "ipgeolocation says Bellevue WA, ip_intel says San Jose CA",
        } }),
      ],
    });
    expect(md).toContain("ipgeolocation says Bellevue WA");
  });

  it("surfaces a metadata.conflict string (address state mismatch) instead of 'No collisions flagged'", () => {
    const md = buildReportMarkdown({
      seedValue: "x@y.com",
      seedType: "email",
      artifacts: [
        artifact({ id: "ad1", kind: "address", value: "302 S Mason Ct, Baltimore MD 21231", metadata: {
          conflict: "different state than LA and FL addresses",
        } }),
      ],
    });
    expect(md).toContain("## Collision / Likely Unrelated");
    expect(md).not.toContain("_No collisions flagged._");
    expect(md).toContain("different state than LA and FL addresses");
  });

  it("still reads 'No collisions flagged' when there is no conflict metadata", () => {
    const md = buildReportMarkdown({
      seedValue: "x@y.com",
      seedType: "email",
      artifacts: [artifact({ id: "c1", kind: "email", value: "x@y.com" })],
    });
    expect(md).toContain("_No collisions flagged._");
  });
});

// Namesake / same-name collision surfacing (Cameron Lawson run): the section must
// reflect the pipeline's OWN exclusion/collision signals — a profile marked
// metadata.status:"excluded", and a row whose reason/cluster names a collision —
// instead of reading "No collisions flagged" while such rows exist.
describe("report — status:excluded + free-text collisions are surfaced", () => {
  it("surfaces a metadata.status:'excluded' namesake in the collision section", () => {
    const md = buildReportMarkdown({
      seedValue: "cameron elijah lawson",
      seedType: "name",
      artifacts: [
        artifact({ id: "n1", kind: "name", value: "Cameron Elijah Lawson", confidence: 90, source: "court_record" }),
        artifact({ id: "x1", kind: "social_profile", value: "CameronLawson5 on Twitter/X", confidence: 30, metadata: {
          status: "excluded",
          reason_not_confirmed: "Display name is Cameron Jacobs, not Cameron Lawson; excluded",
        } }),
      ],
    });
    expect(md).toContain("## Collision / Likely Unrelated");
    expect(md).not.toContain("_No collisions flagged._");
    expect(md).toContain("CameronLawson5");
  });

  it("surfaces a free-text same-name collision noted via reason/cluster", () => {
    const md = buildReportMarkdown({
      seedValue: "cameron elijah lawson",
      seedType: "name",
      artifacts: [
        artifact({ id: "n1", kind: "name", value: "Cameron Elijah Lawson", confidence: 90, source: "court_record" }),
        artifact({ id: "t1", kind: "social_profile", value: "CameronLawson on Twitter/X", confidence: 30, metadata: {
          status: "needs_review",
          cluster: "B - Tennessee collision",
          reason_not_confirmed: "Tennessee location conflicts with CA subject; likely same-name collision",
        } }),
      ],
    });
    expect(md).not.toContain("_No collisions flagged._");
  });
});

// #5 — Timeline Summary must not collapse to a single timestamp. Tool-call
// events all inherit one message timestamp; the evidentiary chronology
// (artifacts/seed/query/report) carries real per-event times.
describe("report #5 — Timeline Summary uses real per-event timestamps", () => {
  it("renders distinct artifact timestamps, not the collapsed tool-call batch", () => {
    const messages = [
      {
        id: "m1",
        role: "assistant" as const,
        created_at: "2026-06-01T10:44:28Z",
        summary: "running tools",
        toolCalls: [
          { toolName: "breach_check", resultSummary: "completed" },
          { toolName: "leakcheck_lookup", resultSummary: "completed" },
          { toolName: "oathnet_lookup", resultSummary: "completed" },
        ],
      },
    ];
    const md = buildReportMarkdown({
      seedValue: "x@y.com",
      seedType: "email",
      artifacts: [
        artifact({ id: "a1", value: "first@y.com", created_at: "2026-06-01T10:11:00Z" }),
        artifact({ id: "a2", value: "second@y.com", created_at: "2026-06-01T10:38:00Z" }),
      ],
      messages,
    });
    const timeline = md.split("## Timeline Summary")[1] ?? "";
    // Real artifact timestamps appear…
    expect(timeline).toContain("2026-06-01T10:11:00");
    expect(timeline).toContain("2026-06-01T10:38:00");
    // …and the all-same-timestamp tool-call batch does not dominate it.
    expect(timeline).not.toContain("**tool_result**");
  });
});

// #6 — the warnings banner must render once (top of report), not be repeated
// inside the Candidate Identity Clusters section.
describe("report #6 — warnings banner is not duplicated", () => {
  it("prints a same-name collision warning exactly once", () => {
    // Two different people sharing a phone trips the cluster collision warning.
    const md = buildReportMarkdown({
      seedValue: "x@y.com",
      seedType: "email",
      artifacts: [
        artifact({ id: "n1", kind: "name", value: "Sheena Cero", metadata: { phone: "9258139324" } }),
        artifact({ id: "n2", kind: "name", value: "Exavier Hill-Larot", metadata: { phone: "9258139324" } }),
      ],
    });
    const collisionWarnings = md.split("same-name collision").length - 1;
    // 0 is acceptable (clustering may not trip on this tiny fixture); the
    // invariant is that it is NEVER printed twice.
    expect(collisionWarnings).toBeLessThanOrEqual(1);
  });
});
