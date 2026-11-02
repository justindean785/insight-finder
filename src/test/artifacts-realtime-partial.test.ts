import { describe, expect, it } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { __applyDeltaForTest as apply } from "@/hooks/useThreadArtifacts";

const row = (over: Partial<Artifact> = {}): Artifact => ({
  id: "a1", kind: "email", value: "x@example.test", confidence: 60, source: "fixture",
  created_at: "2026-01-01T00:00:00Z", metadata: {}, ...over,
});

describe("realtime artifact delta: a partial row never becomes a broken artifact", () => {
  it("an UPDATE carrying only some columns merges into the row already held", () => {
    const out = apply([row()], "UPDATE", { id: "a1", metadata: { cluster: "c1" } });
    expect(out.merged).toBe(true);
    expect(out.items[0].value).toBe("x@example.test");
    expect(out.items[0].kind).toBe("email");
    expect(out.items[0].metadata).toMatchObject({ cluster: "c1" });
  });

  it("an UPDATE with no value for a row we do not hold asks for a reload instead", () => {
    const out = apply([row()], "UPDATE", { id: "zz", metadata: {} });
    expect(out.merged).toBe(false);
    expect(out.items).toHaveLength(1);
  });

  it("an INSERT missing its value asks for a reload instead of storing a broken row", () => {
    const out = apply([row()], "INSERT", { id: "a2", kind: "email" });
    expect(out.merged).toBe(false);
    expect(out.items.every((a) => typeof a.value === "string")).toBe(true);
  });

  it("a complete INSERT is added", () => {
    const out = apply([row()], "INSERT", row({ id: "a2", value: "y@example.test" }));
    expect(out.merged).toBe(true);
    expect(out.items.map((a) => a.id).sort()).toEqual(["a1", "a2"]);
  });
});
