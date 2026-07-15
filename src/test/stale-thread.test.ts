import { describe, it, expect } from "vitest";
import { isStaleActiveThread, selectStaleActiveIds, STALE_ACTIVE_MS } from "@/lib/stale-thread";

const NOW = 1_700_000_000_000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe("isStaleActiveThread", () => {
  it("flags an active thread with no writes past the staleness window", () => {
    expect(isStaleActiveThread("active", iso(STALE_ACTIVE_MS + 1_000), NOW)).toBe(true);
  });

  it("does NOT flag an active thread that wrote recently (still running)", () => {
    expect(isStaleActiveThread("active", iso(30_000), NOW)).toBe(false);
    expect(isStaleActiveThread("active", iso(STALE_ACTIVE_MS - 1_000), NOW)).toBe(false);
  });

  it("never flags a thread that already reached a terminal status", () => {
    expect(isStaleActiveThread("finished", iso(STALE_ACTIVE_MS * 10), NOW)).toBe(false);
    expect(isStaleActiveThread("stopped", iso(STALE_ACTIVE_MS * 10), NOW)).toBe(false);
  });

  it("treats a null status as active (matches isActiveThreadStatus) and can flag it", () => {
    expect(isStaleActiveThread(null, iso(STALE_ACTIVE_MS + 1_000), NOW)).toBe(true);
    expect(isStaleActiveThread(null, iso(10_000), NOW)).toBe(false);
  });

  it("is resilient to a missing or unparseable timestamp", () => {
    expect(isStaleActiveThread("active", null, NOW)).toBe(false);
    expect(isStaleActiveThread("active", "not-a-date", NOW)).toBe(false);
  });
});

describe("selectStaleActiveIds", () => {
  it("returns only the ids of stale-active rows", () => {
    const rows = [
      { id: "dead", status: "active", updated_at: iso(STALE_ACTIVE_MS + 60_000) },
      { id: "running", status: "active", updated_at: iso(15_000) },
      { id: "done", status: "finished", updated_at: iso(STALE_ACTIVE_MS * 5) },
    ];
    expect(selectStaleActiveIds(rows, NOW)).toEqual(["dead"]);
  });

  it("returns an empty array when nothing is stale", () => {
    const rows = [{ id: "a", status: "active", updated_at: iso(1_000) }];
    expect(selectStaleActiveIds(rows, NOW)).toEqual([]);
  });
});
