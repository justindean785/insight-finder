import { describe, it, expect } from "vitest";
import { partitionDismissed } from "@/lib/artifactVisibility";

const items = [{ id: "a" }, { id: "b" }, { id: "c" }];

describe("partitionDismissed", () => {
  it("splits dismissed ids out of the visible list", () => {
    const { visible, hidden } = partitionDismissed(items, (id) => id === "b");
    expect(visible.map((x) => x.id)).toEqual(["a", "c"]);
    expect(hidden.map((x) => x.id)).toEqual(["b"]);
  });

  it("keeps everything visible when nothing is dismissed", () => {
    const { visible, hidden } = partitionDismissed(items, () => false);
    expect(visible).toHaveLength(3);
    expect(hidden).toHaveLength(0);
  });

  it("hides everything when all are dismissed", () => {
    const { visible, hidden } = partitionDismissed(items, () => true);
    expect(visible).toHaveLength(0);
    expect(hidden).toHaveLength(3);
  });

  it("preserves order within each partition", () => {
    const { visible, hidden } = partitionDismissed(items, (id) => id !== "b");
    expect(visible.map((x) => x.id)).toEqual(["b"]);
    expect(hidden.map((x) => x.id)).toEqual(["a", "c"]);
  });
});
