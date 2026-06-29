import { describe, it, expect } from "vitest";
import { isActiveThreadStatus } from "@/lib/thread-status";

describe("isActiveThreadStatus", () => {
  it("treats only null/undefined/'active' as active", () => {
    expect(isActiveThreadStatus("active")).toBe(true);
    expect(isActiveThreadStatus(null)).toBe(true);
    expect(isActiveThreadStatus(undefined)).toBe(true);
  });

  it("treats every terminal/unknown status as NOT active (so it lands in Finished)", () => {
    // Regression: the sidebar previously matched only finished|stopped, so any
    // other status vanished from both groups. The finished bucket must be the
    // exact complement of active — these must all be NOT active.
    for (const s of ["finished", "stopped", "failed_context_limit", "completed", "weird_future_status"]) {
      expect(isActiveThreadStatus(s)).toBe(false);
    }
  });
});
