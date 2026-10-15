import { describe, expect, it } from "vitest";
import { resizeComposer } from "@/lib/composer-layout";

describe("composer sizing across responsive layouts", () => {
  it("shrinks empty input despite a stale or wrapped-placeholder scroll height", () => {
    const field = document.createElement("textarea");
    field.style.height = "208px";
    Object.defineProperty(field, "scrollHeight", { value: 400 });
    resizeComposer(field, "", true);
    expect(field.style.height).toBe("44px");
    resizeComposer(field, "", false);
    expect(field.style.height).toBe("44px");
  });
  it("expands real content within a bounded reading area", () => {
    const field = document.createElement("textarea");
    Object.defineProperty(field, "scrollHeight", { configurable: true, value: 120 });
    resizeComposer(field, "A question\nwith context", false);
    expect(field.style.height).toBe("120px");
    Object.defineProperty(field, "scrollHeight", { value: 600 });
    resizeComposer(field, "Long case notes", true);
    expect(field.style.height).toBe("208px");
  });
});
