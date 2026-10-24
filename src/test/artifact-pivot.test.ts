import { describe, expect, it } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { pivotForArtifact } from "@/lib/artifact-pivot";

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

function ctx(artifacts: Artifact[], over: Partial<Parameters<typeof pivotForArtifact>[1]> = {}) {
  return {
    artifacts,
    seedValue: null as string | null,
    queriedSet: new Set<string>(),
    reviews: {} as Record<string, string | null | undefined>,
    reviewOf: (id: string) => ((over.reviews ?? {})[id] ?? "new") as never,
    ...over,
  };
}

describe("pivotForArtifact", () => {
  it("offers a runnable pivot for a recorded email, tied to that row", () => {
    const row = art({ kind: "email", value: "synthetic.one@example.com" });
    const out = pivotForArtifact(row, ctx([row]));
    expect(out.available).toBe(true);
    if (out.available === false) return;
    expect(out.pivot.target).toBe("synthetic.one@example.com");
    expect(out.pivot.targetType).toBe("email");
    expect(out.pivot.sourceArtifactIds).toEqual([row.id]);
    expect(out.eligibility.runnable).toBe(true);
    expect(out.eligibility.rerun).toBe(false);
  });

  it("marks a target tools already ran against as a rerun the analyst must confirm", () => {
    const row = art({ kind: "email", value: "synthetic.two@example.com" });
    const out = pivotForArtifact(row, ctx([row], { queriedSet: new Set(["synthetic two example com"]) }));
    expect(out.available).toBe(true);
    if (out.available === false) return;
    expect(out.eligibility.rerun).toBe(true);
  });

  it("does not offer the case seed itself", () => {
    const row = art({ kind: "name", value: "Jane Seed" });
    const out = pivotForArtifact(row, ctx([row], { seedValue: "Jane Seed" }));
    expect(out.available).toBe(false);
  });

  it("does not offer a row the analyst dismissed", () => {
    const row = art({ kind: "email", value: "synthetic.three@example.com" });
    const out = pivotForArtifact(row, ctx([row], { reviews: { [row.id]: "dismissed" } }));
    expect(out.available).toBe(false);
  });

  it("does not offer a kind that has no pivot", () => {
    const row = art({ kind: "note", value: "free text observation" });
    const out = pivotForArtifact(row, ctx([row]));
    expect(out.available).toBe(false);
    if (out.available === true) return;
    expect(out.why).toMatch(/No pivot is offered/);
  });

  it("does not offer a credential-shaped value", () => {
    const row = art({ kind: "email", value: "password hash for synthetic.four@example.com" });
    const out = pivotForArtifact(row, ctx([row]));
    expect(out.available).toBe(false);
  });
});
