import { describe, expect, it } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { computePivots, canonicalKey } from "@/lib/pivot-engine";
import { extractRecommendedPivots, type RecommendedPivot } from "@/lib/recommended-pivots";

let seq = 0;
function art(partial: Partial<Artifact> & { kind: string; value: string }): Artifact {
  seq += 1;
  return {
    id: partial.id ?? `a${seq}`,
    kind: partial.kind,
    value: partial.value,
    confidence: partial.confidence ?? 80,
    source: partial.source ?? "tool",
    created_at: partial.created_at ?? `2026-01-01T00:00:${String(seq).padStart(2, "0")}Z`,
    metadata: partial.metadata ?? {},
  };
}

function reportPivot(over: Partial<RecommendedPivot> & { value: string; type: RecommendedPivot["type"] }): RecommendedPivot {
  return {
    label: over.label ?? `Investigate ${over.value}`,
    actionLabel: over.actionLabel ?? "Review lead",
    detail: over.detail ?? over.value,
    reason: over.reason ?? "analyst recommendation",
    priority: over.priority ?? "medium",
    prompt: over.prompt ?? `Run pivot on ${over.value}`,
    value: over.value,
    type: over.type,
  };
}

const NONE = new Set<string>();

describe("computePivots — already-run filter", () => {
  it("hides a candidate whose normalized target is in the skip set", () => {
    const artifacts = [art({ kind: "email", value: "Target@Example.com" })];
    const skip = new Set(["target example com"]);
    const out = computePivots({ artifacts, seedValue: null, reportPivots: [], skipSet: skip });
    expect(out.find((p) => p.value === "Target@Example.com")).toBeUndefined();
  });

  it("hides the seed value itself", () => {
    const artifacts = [art({ kind: "name", value: "Jane Seed" })];
    const out = computePivots({ artifacts, seedValue: "Jane Seed", reportPivots: [], skipSet: NONE });
    expect(out.find((p) => p.value === "Jane Seed")).toBeUndefined();
  });

  it("demotes to 'searched' when another artifact links it as a parent", () => {
    const artifacts = [
      art({ kind: "email", value: "lead@example.com" }),
      art({ kind: "username", value: "child_handle", metadata: { parent: "lead@example.com" } }),
    ];
    const out = computePivots({ artifacts, seedValue: null, reportPivots: [], skipSet: NONE });
    const lead = out.find((p) => p.value === "lead@example.com");
    expect(lead?.status).toBe("searched");
  });

  it("demotes a report pivot whose target already exists as a pivotable artifact (existingValueSet)", () => {
    // A false-positive artifact is NOT surfaced by buildPivots, so it only
    // reaches the engine via a report recommendation; existingValueSet demotes
    // it because we already hold it as evidence.
    const artifacts = [art({ kind: "email", value: "fp@example.com", metadata: { false_positive: true } })];
    const reportPivots = [reportPivot({ value: "fp@example.com", type: "email", actionLabel: "Verify email ownership" })];
    const out = computePivots({ artifacts, seedValue: null, reportPivots, skipSet: NONE });
    const p = out.find((x) => x.value === "fp@example.com");
    expect(p?.status).toBe("searched");
  });
});

describe("computePivots — canonical-key dedupe + merge", () => {
  it("collapses a report 'Damien O'Brien' and artifact 'Damien O Brien' into one, keeping the recommendation copy", () => {
    const artifacts = [art({ kind: "name", value: "Damien O Brien", confidence: 90 })];
    const reportPivots = [
      reportPivot({
        value: "Damien O'Brien",
        type: "name",
        actionLabel: "Review lead",
        reason: "independent identity check",
        priority: "medium",
      }),
    ];
    const out = computePivots({ artifacts, seedValue: null, reportPivots, skipSet: NONE });
    const names = out.filter((p) => p.type === "name");
    expect(names).toHaveLength(1);
    // Both variants share one canonical key.
    expect(canonicalKey({ type: "name", value: "Damien O'Brien" }))
      .toBe(canonicalKey({ type: "name", value: "Damien O Brien" }));
    // The recommendation's richer copy + priority win over the finding's.
    expect(names[0].reason).toBe("independent identity check");
    expect(names[0].priority).toBe("medium"); // not the conf-90 'high' the finding would derive
    expect(names[0].status).toBe("new");
  });
});

describe("computePivots — ranking", () => {
  it("ranks a high-priority report email above a low-priority name finding", () => {
    const artifacts = [art({ kind: "name", value: "Weak Lead", confidence: 20 })];
    const reportPivots = [reportPivot({ value: "hit@example.com", type: "email", priority: "high" })];
    const out = computePivots({ artifacts, seedValue: null, reportPivots, skipSet: NONE });
    expect(out[0].value).toBe("hit@example.com");
    expect(out.map((p) => p.value)).toContain("Weak Lead");
    expect(out.indexOf(out.find((p) => p.value === "hit@example.com")!))
      .toBeLessThan(out.indexOf(out.find((p) => p.value === "Weak Lead")!));
  });

  it("always ranks a 'new' pivot above any 'searched' pivot", () => {
    const artifacts = [
      // High-value email, but searched (a child links it) → must sink.
      art({ kind: "email", value: "old@example.com", confidence: 99 }),
      // A low-value but still-new lead must outrank it purely on status.
      art({ kind: "username", value: "fresh_handle", confidence: 30, metadata: {} }),
      art({ kind: "username", value: "kid", metadata: { parent: "old@example.com" } }),
    ];
    const out = computePivots({ artifacts, seedValue: null, reportPivots: [], skipSet: NONE });
    const emailIdx = out.findIndex((p) => p.value === "old@example.com");
    const freshIdx = out.findIndex((p) => p.value === "fresh_handle");
    expect(out[emailIdx].status).toBe("searched");
    expect(out[freshIdx].status).toBe("new");
    expect(freshIdx).toBeLessThan(emailIdx);
  });

  it("breaks ties between equal-priority new pivots by recency (newer artifact wins)", () => {
    const artifacts = [
      art({ kind: "email", value: "older@example.com", confidence: 80, created_at: "2026-01-01T00:00:00Z" }),
      art({ kind: "email", value: "newer@example.com", confidence: 80, created_at: "2026-06-01T00:00:00Z" }),
    ];
    const out = computePivots({ artifacts, seedValue: null, reportPivots: [], skipSet: NONE });
    const newerIdx = out.findIndex((p) => p.value === "newer@example.com");
    const olderIdx = out.findIndex((p) => p.value === "older@example.com");
    expect(newerIdx).toBeLessThan(olderIdx);
  });
});

describe("computePivots — #185 infra-domain filtering (end-to-end)", () => {
  it("drops infra domains from BOTH the report and the artifact path, but keeps a real subject domain", () => {
    const reportText = `
**Recommended next pivots:**
- Review linkedin.com footprint for the subject
- Investigate ceroconstruction.com — subject's company site
`;
    const reportPivots = extractRecommendedPivots(reportText);
    const artifacts = [
      art({ kind: "domain", value: "bizfile.com", confidence: 90 }),
      art({ kind: "domain", value: "ceroconstruction.com", confidence: 85 }),
    ];
    const out = computePivots({ artifacts, seedValue: null, reportPivots, skipSet: NONE });
    const values = out.map((p) => p.value);
    expect(values).toContain("ceroconstruction.com");
    expect(values).not.toContain("bizfile.com");
    expect(values).not.toContain("linkedin.com");
  });
});

describe("computePivots — weak/path-bearing domain-url noise guard (#185 fallback parity)", () => {
  it("drops a sub-40-confidence domain but keeps a confident subject domain", () => {
    const artifacts = [
      art({ kind: "domain", value: "weaklead.com", confidence: 30 }),
      art({ kind: "domain", value: "strongsubject.com", confidence: 70 }),
    ];
    const out = computePivots({ artifacts, seedValue: null, reportPivots: [], skipSet: NONE });
    const values = out.map((p) => p.value);
    expect(values).toContain("strongsubject.com");
    expect(values).not.toContain("weaklead.com");
  });

  it("drops a path-bearing domain/url even at high confidence", () => {
    const artifacts = [
      art({ kind: "domain", value: "subject.com/some/path", confidence: 95 }),
      art({ kind: "domain", value: "subject.com", confidence: 95 }),
    ];
    const out = computePivots({ artifacts, seedValue: null, reportPivots: [], skipSet: NONE });
    const values = out.map((p) => p.value);
    expect(values).toContain("subject.com");
    expect(values).not.toContain("subject.com/some/path");
  });
});

describe("computePivots — report pivots re-evaluated live", () => {
  it("returns a report pivot as 'searched' (not the hardcoded 'new') when its target is now parent-linked", () => {
    const artifacts = [
      art({ kind: "username", value: "spawned", metadata: { parent: "sam.cole@example.com" } }),
    ];
    const reportPivots = [reportPivot({ value: "sam.cole@example.com", type: "email", actionLabel: "Verify email ownership" })];
    const out = computePivots({ artifacts, seedValue: null, reportPivots, skipSet: NONE });
    const p = out.find((x) => x.value === "sam.cole@example.com");
    expect(p).toBeDefined();
    expect(p?.status).toBe("searched");
  });
});
