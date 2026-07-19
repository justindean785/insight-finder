import { beforeEach, describe, it, expect, vi } from "vitest";

// checkCachedHitSafety() (the fix for the ChatWindow.tsx cache-replay bypass —
// see reviews.ts on the edge function for the matching backend-side bug) reads
// artifact_reviews via the plain client. Mock the query chain it actually
// issues: .from(t).select(cols).eq(col,v).eq(col,v) with NO terminal
// .maybeSingle()/.limit() — the awaited chain itself resolves {data, error}.
const mock = vi.hoisted(() => ({
  reviewRows: [] as Array<{ artifact_id: string; state: string }>,
  reviewError: null as unknown,
  // Reviews recorded against a CLONE of the cache entry, keyed by clone id.
  cloneRows: [] as Array<{ id: string }>,
  cloneReviewRows: [] as Array<{ artifact_id: string; state: string }>,
  cloneError: null as unknown,
}));

// Table-aware so the clone lookup (artifacts) and the clone-review lookup
// (artifact_reviews filtered by artifact_id) can be distinguished. Supports the
// .in() the clone path uses.
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from(table: string) {
      let usedIn = false;
      const builder = {
        select: () => builder,
        eq: () => builder,
        in: () => { usedIn = true; return builder; },
        then: (resolve: (r: { data: unknown; error: unknown }) => unknown) => {
          if (table === "artifacts") {
            return Promise.resolve({ data: mock.cloneRows, error: mock.cloneError }).then(resolve);
          }
          // artifact_reviews: `.in()` is only used for the clone-review lookup.
          const data = usedIn ? mock.cloneReviewRows : mock.reviewRows;
          return Promise.resolve({ data, error: mock.reviewError }).then(resolve);
        },
      };
      return builder;
    },
  },
}));

import {
  REVIEW_STATES,
  REVIEW_LABEL,
  REVIEW_SHORT,
  REVIEW_HELP,
  REVIEW_CONFIDENCE_DELTA,
  REVIEW_CLASS,
  REJECTED_REVIEW_STATES,
  recheckPrompt,
  launchRecheckInChat,
  checkCachedHitSafety,
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

  it("REJECTED_REVIEW_STATES is exactly dismissed+wrong (mirrors reviews.ts on the edge function)", () => {
    expect([...REJECTED_REVIEW_STATES].sort()).toEqual(["dismissed", "wrong"]);
  });
});

// Guards the fix for: ChatWindow.tsx's investigation_cache replay clones
// cached artifacts and re-displays the cached assistant narrative WITHOUT
// ever calling osint-agent, so backend review-filtering never runs on this
// path. A dismissed/wrong verdict made AFTER a run was cached could replay,
// unfiltered, for up to 7 days. checkCachedHitSafety() is the read-time gate
// that closes this: it must FAIL CLOSED (matches the backend's
// reviews.ts loadReviewsForThread, which also fails closed) since the cost
// of a false "safe" here is the exact incident this exists to prevent.
describe("checkCachedHitSafety", () => {
  beforeEach(() => {
    mock.reviewRows = [];
    mock.reviewError = null;
    mock.cloneRows = [];
    mock.cloneReviewRows = [];
    mock.cloneError = null;
  });

  it("CLONE: a verdict on a clone makes the entry unsafe even when the origin is clean", async () => {
    // Cache eviction on review is best-effort. If it fails, a "False" recorded
    // against a CLONE of this entry in another thread must still block replay —
    // the read-time check is the authority, not the eviction.
    mock.reviewRows = [];                                   // origin thread: clean
    mock.cloneRows = [{ id: "clone-1" }];                   // a clone of a1 exists
    mock.cloneReviewRows = [{ artifact_id: "clone-1", state: "dismissed" }];
    const r = await checkCachedHitSafety("thread-1", "user-1", ["a1"]);
    expect(r.safe).toBe(false);
    expect(r.reviewMap.get("clone-1")).toBe("dismissed" satisfies ReviewState);
  });

  it("CLONE: lookup failure fails CLOSED rather than assuming the clone is clean", async () => {
    mock.cloneError = { message: "clone lookup boom" };
    const r = await checkCachedHitSafety("thread-1", "user-1", ["a1"]);
    expect(r.safe).toBe(false);
    expect(r.reason).toMatch(/clone/i);
  });

  it("CLONE: no clones and a clean origin still replays", async () => {
    const r = await checkCachedHitSafety("thread-1", "user-1", ["a1"]);
    expect(r.safe).toBe(true);
  });

  it("is safe when the origin thread has no reviews at all", async () => {
    const r = await checkCachedHitSafety("thread-1", "user-1");
    expect(r.safe).toBe(true);
    expect(r.reviewMap.size).toBe(0);
  });

  it("is UNSAFE when any origin artifact was dismissed", async () => {
    mock.reviewRows = [{ artifact_id: "a1", state: "dismissed" }];
    const r = await checkCachedHitSafety("thread-1", "user-1");
    expect(r.safe).toBe(false);
  });

  it("is UNSAFE when any origin artifact was marked wrong", async () => {
    mock.reviewRows = [{ artifact_id: "a1", state: "wrong" }];
    const r = await checkCachedHitSafety("thread-1", "user-1");
    expect(r.safe).toBe(false);
  });

  it("stays safe when reviews are only confirmed/key (nothing blocks replay)", async () => {
    mock.reviewRows = [
      { artifact_id: "a1", state: "confirmed" },
      { artifact_id: "a3", state: "key" },
    ];
    const r = await checkCachedHitSafety("thread-1", "user-1");
    expect(r.safe).toBe(true);
  });

  it("is UNSAFE on recheck — a frozen narrative cannot be downweighted", async () => {
    // Previously a recheck replayed the cache with the cloned artifact's
    // confidence reduced. That left the original assistant NARRATIVE intact, and
    // that prose still asserts the finding the analyst flagged as suspect. Text
    // cannot be downweighted, so a recheck must bypass the cache and regenerate.
    mock.reviewRows = [
      { artifact_id: "a1", state: "confirmed" },
      { artifact_id: "a2", state: "recheck" },
    ];
    const r = await checkCachedHitSafety("thread-1", "user-1");
    expect(r.safe).toBe(false);
    expect(r.reason).toMatch(/recheck/i);
    expect(r.reviewMap.get("a2")).toBe("recheck" satisfies ReviewState);
  });

  it("FAILS CLOSED on a query error — unsafe, not a silent pass-through", async () => {
    mock.reviewError = { message: "boom" };
    const r = await checkCachedHitSafety("thread-1", "user-1");
    expect(r.safe).toBe(false);
    expect(r.reviewMap.size).toBe(0);
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
