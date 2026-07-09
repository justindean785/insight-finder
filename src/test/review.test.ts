import { describe, it, expect, vi } from "vitest";
import {
  REVIEW_STATES,
  REVIEW_LABEL,
  REVIEW_SHORT,
  REVIEW_HELP,
  REVIEW_CONFIDENCE_DELTA,
  REVIEW_CLASS,
  recheckPrompt,
  launchRecheckInChat,
  type ReviewState,
} from "@/lib/review";

// Importing the REAL maps guards against the drift the old inline test masked
// (e.g. REVIEW_SHORT.confirmed is "Confirm", not "CONF").

const ALL: ReviewState[] = ["new", "confirmed", "key", "recheck", "wrong", "dismissed"];

describe("review state maps", () => {
  it("REVIEW_STATES lists every state exactly once", () => {
    expect([...REVIEW_STATES].sort()).toEqual([...ALL].sort());
    expect(new Set(REVIEW_STATES).size).toBe(REVIEW_STATES.length);
  });

  it.each(["label", "short", "help", "delta", "class"] as const)(
    "every state has a %s entry",
    (which) => {
      const map = { label: REVIEW_LABEL, short: REVIEW_SHORT, help: REVIEW_HELP, delta: REVIEW_CONFIDENCE_DELTA, class: REVIEW_CLASS }[which];
      for (const s of ALL) expect(map[s]).toBeDefined();
    },
  );

  it("short labels match the real source (catches the old fabricated values)", () => {
    expect(REVIEW_SHORT.confirmed).toBe("Confirm");
    expect(REVIEW_SHORT.key).toBe("Key");
    expect(REVIEW_SHORT.dismissed).toBe("Dismiss");
  });

  it("confidence deltas reward confirm/key and punish recheck/wrong", () => {
    expect(REVIEW_CONFIDENCE_DELTA.new).toBe(0);
    expect(REVIEW_CONFIDENCE_DELTA.confirmed).toBeGreaterThan(0);
    expect(REVIEW_CONFIDENCE_DELTA.key).toBeGreaterThan(REVIEW_CONFIDENCE_DELTA.confirmed);
    expect(REVIEW_CONFIDENCE_DELTA.recheck).toBeLessThan(0);
    expect(REVIEW_CONFIDENCE_DELTA.wrong).toBeLessThan(REVIEW_CONFIDENCE_DELTA.recheck);
  });

  it("dismissed has no confidence delta (handled as a FAILED override)", () => {
    expect(REVIEW_CONFIDENCE_DELTA.dismissed).toBe(0);
  });
});

describe("recheck → chatbot handoff", () => {
  it("recheckPrompt scopes to the exact value+kind and asks for independent re-verification", () => {
    const p = recheckPrompt("john.doe@example.com", "email");
    expect(p).toContain('"john.doe@example.com"');
    expect(p).toContain("(email)");
    expect(p.toLowerCase()).toContain("independent");
    // No kind → no empty parens.
    expect(recheckPrompt("somevalue")).not.toContain("()");
  });

  it("launchRecheckInChat flips to the Chat tab AND fires a scoped run on the pivot bus", () => {
    const nav = vi.fn();
    const pivot = vi.fn();
    window.addEventListener("swarmbot:navigate", nav as EventListener);
    window.addEventListener("proximity:run-pivot", pivot as EventListener);
    try {
      launchRecheckInChat("thread-123", { value: "acme-handle", kind: "username" });

      expect(nav).toHaveBeenCalledTimes(1);
      expect((nav.mock.calls[0][0] as CustomEvent).detail).toEqual({ tab: "chat" });

      expect(pivot).toHaveBeenCalledTimes(1);
      const detail = (pivot.mock.calls[0][0] as CustomEvent).detail;
      expect(detail.threadId).toBe("thread-123");
      expect(detail.value).toBe("acme-handle");
      expect(detail.type).toBe("username");
      expect(detail.prompt).toBe(recheckPrompt("acme-handle", "username"));
    } finally {
      window.removeEventListener("swarmbot:navigate", nav as EventListener);
      window.removeEventListener("proximity:run-pivot", pivot as EventListener);
    }
  });
});
