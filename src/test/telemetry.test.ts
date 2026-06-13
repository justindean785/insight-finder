import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  addBreadcrumb,
  getBreadcrumbs,
  captureError,
  getLastError,
  setErrorSink,
  type CapturedError,
} from "@/lib/telemetry";

// jsdom provides window/localStorage; silence the structured console.error noise.
beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("telemetry breadcrumbs", () => {
  it("records breadcrumbs in order", () => {
    const before = getBreadcrumbs().length;
    addBreadcrumb("test", "one");
    addBreadcrumb("test", "two", { k: 1 });
    const after = getBreadcrumbs();
    expect(after.length).toBe(before + 2);
    expect(after.at(-1)).toMatchObject({ category: "test", message: "two", data: { k: 1 } });
  });

  it("caps the ring buffer at 50", () => {
    for (let i = 0; i < 80; i++) addBreadcrumb("flood", `b${i}`);
    expect(getBreadcrumbs().length).toBeLessThanOrEqual(50);
    // oldest entries are dropped — the most recent survives
    expect(getBreadcrumbs().at(-1)?.message).toBe("b79");
  });
});

describe("captureError", () => {
  it("normalizes non-Error values and attaches breadcrumbs", () => {
    addBreadcrumb("ctx", "marker");
    const rec = captureError("plain string failure", "unit.test");
    expect(rec.source).toBe("unit.test");
    expect(rec.message).toBe("plain string failure");
    expect(rec.breadcrumbs.some((b) => b.message === "marker")).toBe(true);
  });

  it("persists the last error to localStorage and reloads it", () => {
    captureError(new Error("boom"), "unit.test");
    const last = getLastError();
    expect(last?.message).toBe("boom");
  });

  it("delivers to a registered sink without letting sink failures cascade", () => {
    const seen: CapturedError[] = [];
    setErrorSink((r) => {
      seen.push(r);
      throw new Error("sink is broken"); // must be swallowed
    });
    expect(() => captureError(new Error("x"), "unit.test")).not.toThrow();
    expect(seen).toHaveLength(1);
    setErrorSink(() => {}); // reset so later tests aren't affected
  });
});
