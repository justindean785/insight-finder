import { describe, expect, it } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { buildIdentityRows, pickSubjectName } from "@/lib/report-hygiene";

// Synthetic fixtures only — no case identifiers.
let n = 0;
function art(kind: string, value: string, metadata: Record<string, unknown> = {}, confidence = 40): Artifact {
  n += 1;
  return { id: `s${n}`, kind, value, confidence, source: "fixture", created_at: `2026-01-01T00:00:${String(n).padStart(2, "0")}Z`, metadata };
}

const SEED = "Alex Example, 12 Sample Street, Unit 5, Testville, CA 90000: 43 YOA";
const QUARANTINED = { subject_unlinked: true, subject_unlinked_reason: "echo of a name-only query" };

describe("subject name — a seed that names a person", () => {
  it("never names a different person when the seed's own name is quarantined", () => {
    const seedName = art("name", "ALEX EXAMPLE", QUARANTINED, 50);
    const stranger = art("name", "Robin Stranger", { source_category: ["breach"] }, 40);
    expect(pickSubjectName([seedName, stranger], undefined, SEED)).toBeNull();
    expect(buildIdentityRows([seedName, stranger], undefined, SEED).find((r) => r.field === "Real name")).toBeUndefined();
  });

  it("still names the seed's person when that row is eligible", () => {
    const seedName = art("name", "Alex Example", {}, 50);
    const stranger = art("name", "Robin Stranger", {}, 90);
    expect(pickSubjectName([seedName, stranger], undefined, SEED)?.value).toBe("Alex Example");
  });

  it("does not let a single shared token count as the seed's name", () => {
    const seedName = art("name", "Alex Example", QUARANTINED);
    const relative = art("name", "Jamie Example", {}, 80);
    expect(pickSubjectName([seedName, relative], undefined, SEED)).toBeNull();
  });
});

describe("subject name — a seed that names no one", () => {
  it("is unchanged for a selector seed: a discovered name is still the subject", () => {
    const found = art("name", "Alex Example", {}, 70);
    expect(pickSubjectName([found], undefined, "alex@example.test")?.value).toBe("Alex Example");
  });

  it("is unchanged when no seed is passed", () => {
    const a = art("name", "Robin Stranger", {}, 70);
    expect(pickSubjectName([a])?.value).toBe("Robin Stranger");
    expect(pickSubjectName([a], undefined, null)?.value).toBe("Robin Stranger");
  });
});
