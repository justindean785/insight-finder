import { describe, expect, it } from "vitest";
import { isSubmitBlocked } from "@/lib/submit-guard";

describe("isSubmitBlocked — duplicate scan-submit prevention", () => {
  it("allows the first submit when idle and unlocked", () => {
    expect(isSubmitBlocked("ready", false)).toBe(false);
  });

  it("blocks a rapid second click via the lock BEFORE status flips", () => {
    // The regression: status is still 'ready' during the async preamble of the
    // first submit, but the lock is already held → the second click is rejected.
    expect(isSubmitBlocked("ready", true)).toBe(true);
  });

  it("blocks while a run is submitted or streaming (status guard)", () => {
    expect(isSubmitBlocked("submitted", false)).toBe(true);
    expect(isSubmitBlocked("streaming", false)).toBe(true);
  });

  it("allows a fresh submit again once unlocked and idle (post-completion/error)", () => {
    expect(isSubmitBlocked("ready", false)).toBe(false);
    expect(isSubmitBlocked("error", false)).toBe(false);
  });
});
