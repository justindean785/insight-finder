import { describe, expect, it } from "vitest";
import { unlinkedReasons } from "@/lib/workbench-connections";
import type { Artifact } from "@/hooks/useThreadArtifacts";

const A = (id: string, kind: string, metadata: Record<string, unknown> | null = null): Artifact => ({
  id, kind, value: `${id}@example.com`, confidence: 50, source: "web_search", created_at: "2026-11-08T00:00:00Z", metadata,
});

describe("unlinkedReasons — why a case reads 0 evidence links", () => {
  it("counts breach rows and quarantined rows separately, each against the whole", () => {
    const r = unlinkedReasons(
      [
        A("1", "email"),
        A("2", "breach_exposure"),
        A("3", "breach_exposure", { subject_unlinked: true, subject_unlinked_reason: "name-only harvest" }),
        A("4", "username", { subject_unlinked: true, subject_unlinked_reason: "name-only harvest" }),
      ],
      "seed@example.com",
    );
    // A quarantined breach row is counted once, as quarantined.
    expect(r).toEqual({ total: 4, breachOnly: 1, quarantined: 2, noSubject: false });
  });

  it("an upload-only seed is a case with no subject", () => {
    expect(unlinkedReasons([A("1", "email")], "Attached files:\n- [scan.pdf](https://storage.example.com/x").noSubject).toBe(true);
    expect(unlinkedReasons([A("1", "email")], null).noSubject).toBe(true);
  });

  it("a released quarantine is not counted as quarantined", () => {
    const r = unlinkedReasons([A("1", "email", { subject_unlinked: true, linkage_confirmed: true })], "seed@example.com");
    expect(r.quarantined).toBe(0);
  });
});
