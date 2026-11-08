import { describe, it, expect } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { authorityFor, underlyingRepeatsBasis } from "@/lib/authority";

/**
 * The ledger's status column prints, for a quarantined row, the underlying
 * strength label and then the evidence-basis string. When the basis already
 * opens with that label the analyst reads it twice
 * ("Shared infrastructure · Shared infrastructure · not ownership proof").
 * The label must be suppressed there and ONLY there: for every other quarantined
 * row it is the second axis (strength) that quarantine would otherwise hide.
 */

const NOW = new Date("2026-11-07T00:00:00Z").toISOString();
const QUARANTINE = { subject_unlinked: true, subject_unlinked_reason: "name-only query; linkage unproven" };

function art(meta: Record<string, unknown>, over: Partial<Artifact> = {}): Artifact {
  return {
    id: "dedupe-1",
    kind: "email",
    value: "row@example.com",
    confidence: 92,
    source: "hunter_verify",
    created_at: NOW,
    metadata: { sources: ["hunter_verify", "exa_search"], corroborations: 2, ...meta },
    ...over,
  } as Artifact;
}

describe("underlyingRepeatsBasis", () => {
  it("is true when a quarantined shared-infrastructure basis restates the label", () => {
    const v = authorityFor(art({ ...QUARANTINE, shared_infra: true }, { kind: "ip", value: "203.0.113.7" }));
    expect(v.state).toBe("quarantined");
    expect(v.underlyingLabel).toBe("Shared infrastructure");
    expect(v.basis.startsWith("Shared infrastructure")).toBe(true);
    expect(underlyingRepeatsBasis(v)).toBe(true);
  });

  it("is false for a quarantined row whose basis says something different", () => {
    const v = authorityFor(art(QUARANTINE));
    expect(v.state).toBe("quarantined");
    expect(underlyingRepeatsBasis(v)).toBe(false);
  });

  it("is false for breach-related quarantine (label 'Manual review' is not in the basis)", () => {
    const v = authorityFor(art(QUARANTINE));
    const b = authorityFor(art(QUARANTINE, { kind: "breach", source: "hibp" }));
    expect(b.state).toBe("quarantined");
    expect(underlyingRepeatsBasis(b)).toBe(false);
    expect(underlyingRepeatsBasis(v)).toBe(false);
  });

  it("is false for non-quarantined rows (the label is never shown there)", () => {
    expect(underlyingRepeatsBasis(authorityFor(art({})))).toBe(false);
  });
});
