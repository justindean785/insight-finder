import { describe, expect, it } from "vitest";
import { isSubmitBlocked, submitRefusal, submitRefusalMessage } from "@/lib/submit-guard";

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

describe("submitRefusal — the refusal says which state refused", () => {
  // Operator report, 2026-09-30: "I'll click on continue and it won't do
  // anything and then I'll click off and click back and it ran the whole
  // thing." Both halves are this guard firing without a word: Continue is live
  // exactly while the lock is held and `status` has not yet flipped, and
  // remounting ChatWindow resets the ref.
  it("names the lock-held window Continue is clickable in", () => {
    expect(submitRefusal("ready", true)).toBe("starting");
  });

  it("names a live stream separately — it asks something different of the analyst", () => {
    expect(submitRefusal("submitted", false)).toBe("running");
    expect(submitRefusal("streaming", false)).toBe("running");
  });

  it("prefers `running` when both hold — the stream is the more useful fact", () => {
    expect(submitRefusal("streaming", true)).toBe("running");
  });

  it("returns null when the submit may proceed", () => {
    expect(submitRefusal("ready", false)).toBeNull();
    expect(submitRefusal("error", false)).toBeNull();
  });

  it("every refusal has a message, and neither is blank", () => {
    for (const r of ["starting", "running"] as const) {
      expect(submitRefusalMessage(r).length).toBeGreaterThan(10);
    }
    expect(submitRefusalMessage("starting")).not.toBe(submitRefusalMessage("running"));
  });
});

describe("isSubmitBlocked keeps its exact truth table", () => {
  // The predicate is load-bearing at five call sites and one of them
  // (retryLastUser) records why: the server has no idempotency key and does not
  // reject overlaps, so this ref is all that stands between a double-click and
  // two billed runs. Reimplementing it on top of submitRefusal must not have
  // moved it by one cell.
  it("agrees with `locked || submitted || streaming` on every combination", () => {
    for (const status of ["ready", "submitted", "streaming", "error", "whatever"]) {
      for (const locked of [true, false]) {
        expect(isSubmitBlocked(status, locked), `${status}/${locked}`)
          .toBe(locked || status === "submitted" || status === "streaming");
      }
    }
  });
});

describe("server-side run (stream idle, server live)", () => {
  it("refuses a send while the server still reports a live run", () => {
    expect(submitRefusal("ready", false, true)).toBe("server_running");
    expect(isSubmitBlocked("ready", false, true)).toBe(true);
  });
  it("this tab's own stream and the click lock still win", () => {
    expect(submitRefusal("streaming", false, true)).toBe("running");
    expect(submitRefusal("ready", true, true)).toBe("starting");
  });
  it("is off by default, so existing callers are unchanged", () => {
    expect(submitRefusal("ready", false)).toBeNull();
  });
  it("explains the refusal as a second run, not a generic busy", () => {
    expect(submitRefusalMessage("server_running")).toMatch(/second run/);
  });
});
