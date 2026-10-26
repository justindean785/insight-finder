import { describe, expect, it } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import type { AuthorityState } from "@/lib/authority";
import { summarizeLatestRun } from "@/lib/latest-run";

const art = (id: string, created_at: string): Artifact => ({
  id, kind: "email", value: `${id}@example.com`, confidence: 50, source: "t", created_at, metadata: null,
});

const STATES: Record<string, AuthorityState> = {
  old: "verified", n1: "verified", n2: "probable", n3: "conflict", n4: "quarantined", n5: "review",
};
const stateOf = (a: Artifact) => STATES[a.id];

describe("summarizeLatestRun", () => {
  const start = "2026-10-25T12:00:00.000Z";
  const items = [
    art("old", "2026-10-25T11:59:59.000Z"),
    art("n1", "2026-10-25T12:00:00.000Z"),
    art("n2", "2026-10-25T12:03:00.000Z"),
    art("n3", "2026-10-25T12:04:00.000Z"),
    art("n4", "2026-10-25T12:05:00.000Z"),
    art("n5", "2026-10-25T12:06:00.000Z"),
  ];

  it("returns null when the thread has no run marker (I-1: no marker, no run)", () => {
    expect(summarizeLatestRun(items, null, stateOf)).toBeNull();
    expect(summarizeLatestRun(items, "not a date", stateOf)).toBeNull();
  });

  it("counts only records created at or after the run start", () => {
    const s = summarizeLatestRun(items, start, stateOf)!;
    expect(s.added).toBe(5);
    expect(s.startedAt).toBe(start);
  });

  it("buckets new records through the authority state it is given, never re-deriving it", () => {
    const s = summarizeLatestRun(items, start, stateOf)!;
    expect(s.supported).toBe(2);
    expect(s.conflict).toBe(1);
    expect(s.quarantined).toBe(1);
    expect(s.other).toBe(1);
    expect(s.supported + s.conflict + s.quarantined + s.other).toBe(s.added);
  });

  it("an empty run is reported as zero added, not hidden", () => {
    const s = summarizeLatestRun([art("old", "2026-10-25T11:00:00.000Z")], start, stateOf)!;
    expect(s.added).toBe(0);
  });

  it("skips rows whose created_at does not parse rather than counting them as new", () => {
    const s = summarizeLatestRun([art("n1", "garbage")], start, stateOf)!;
    expect(s.added).toBe(0);
  });
});
