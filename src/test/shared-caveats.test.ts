import { describe, expect, it } from "vitest";
import { groupSharedCaveats } from "@/lib/shared-caveats";

const LINK = "Linkage to the subject is unproven: this selector was found by a name-only query.";

describe("groupSharedCaveats", () => {
  it("a caveat on several rows is shared once, with a count", () => {
    const g = groupSharedCaveats([
      { id: "a", caveat: LINK, caveatKind: "linkage" },
      { id: "b", caveat: LINK, caveatKind: "linkage" },
      { id: "c", caveat: LINK, caveatKind: "linkage" },
    ]);
    expect(g.shared).toEqual([{ caveat: LINK, caveatKind: "linkage", count: 3 }]);
    expect([...g.byRow.keys()]).toEqual(["a", "b", "c"]);
  });

  it("a single row keeps its own caveat", () => {
    const g = groupSharedCaveats([{ id: "a", caveat: LINK, caveatKind: "linkage" }]);
    expect(g.shared).toEqual([]);
    expect(g.byRow.size).toBe(0);
  });

  it("mixed reasons: only the repeated one is shared", () => {
    const g = groupSharedCaveats([
      { id: "a", caveat: LINK, caveatKind: "linkage" },
      { id: "b", caveat: "Two sources disagree on the registrant.", caveatKind: "contradiction" },
      { id: "c", caveat: LINK, caveatKind: "linkage" },
    ]);
    expect(g.shared.map((s) => s.count)).toEqual([2]);
    expect(g.byRow.has("b")).toBe(false);
  });

  it("same words with a different kind are different reasons", () => {
    const g = groupSharedCaveats([
      { id: "a", caveat: LINK, caveatKind: "linkage" },
      { id: "b", caveat: LINK, caveatKind: "contradiction" },
    ]);
    expect(g.shared).toEqual([]);
  });

  it("whitespace differences do not split a group; empty caveats are ignored", () => {
    const g = groupSharedCaveats([
      { id: "a", caveat: `  ${LINK}` },
      { id: "b", caveat: LINK.replace(" ", "   ") },
      { id: "c", caveat: "" },
      { id: "d", caveat: null },
    ]);
    expect(g.shared).toHaveLength(1);
    expect(g.byRow.has("c")).toBe(false);
  });
});
