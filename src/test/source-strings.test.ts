import { describe, expect, it } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { toSourceStrings } from "@/lib/source-strings";
import { isBreachSource, isUsernameSweepSource, isDirectProfileSource, labelForArtifact } from "@/lib/intel";
import { evidenceStatus } from "@/lib/evidence-status";
import { authorityFor } from "@/lib/authority";

/**
 * Regression: `TypeError: e.toLowerCase is not a function`.
 *
 * Reported from production 2026-09-03 on thread `b4e575a6`, caught by the React
 * error boundary inside a ChatPage `useMemo` — i.e. the whole case rendered as a
 * blank workspace. Every reader of `metadata.sources` cast it to `string[]`
 * unchecked; `breach_check` writes `breach_exposure` rows whose `sources` is an
 * array of OBJECTS. An object is truthy, survives `.filter(Boolean)`, and hits
 * `.toLowerCase()`. Measured: 2 artifacts across 2 of 216 threads.
 *
 * The shape below is the real production payload, with the selector replaced.
 */
const REAL_BAD_SOURCES = [
  { date: "2016-06", name: "Whitepages.com" },
  { date: "2022-01", name: "Twitter.com (scraping data)" },
  { date: "2018-07", name: "ShareThis.com" },
  { date: "2024-04", name: "Pipingrock.com" },
];

const artifact = (over: Partial<Artifact> = {}): Artifact => ({
  id: "a1",
  kind: "breach_exposure",
  value: "someone@example.invalid in breach_check",
  confidence: 55,
  source: "breach_check",
  created_at: "2026-09-03T00:00:00Z",
  metadata: { sources: REAL_BAD_SOURCES },
  ...over,
});

describe("toSourceStrings", () => {
  it("drops non-string elements and keeps usable strings", () => {
    expect(toSourceStrings(["breach_check", "  serus  ", ""])).toEqual(["breach_check", "serus"]);
    expect(toSourceStrings(REAL_BAD_SOURCES)).toEqual([]);
    expect(toSourceStrings(["ok", ...REAL_BAD_SOURCES, 42, null, undefined])).toEqual(["ok"]);
  });

  it("returns [] for anything that is not an array", () => {
    for (const v of [null, undefined, "breach_check", 7, {}, { sources: [] }]) {
      expect(toSourceStrings(v)).toEqual([]);
    }
  });
});

describe("source predicates never throw on a malformed source", () => {
  it("degrades to false instead of throwing", () => {
    for (const bad of [{ name: "Whitepages.com" }, 42, [], true] as unknown as string[]) {
      expect(isBreachSource(bad)).toBe(false);
      expect(isUsernameSweepSource(bad)).toBe(false);
      expect(isDirectProfileSource(bad)).toBe(false);
    }
  });

  it("still classifies real string sources correctly", () => {
    expect(isBreachSource("breach_check")).toBe(true);
    expect(isBreachSource("jina_reader_scrape")).toBe(false);
  });
});

describe("⛔ the production row that blanked the workspace now renders", () => {
  it("labelForArtifact does not throw", () => {
    expect(() => labelForArtifact(artifact())).not.toThrow();
  });

  it("evidenceStatus does not throw", () => {
    expect(() => evidenceStatus(artifact())).not.toThrow();
  });

  it("authorityFor does not throw — this is the frame the boundary caught", () => {
    expect(() => authorityFor(artifact())).not.toThrow();
  });

  it("a row whose sources are ALL malformed behaves as if only a.source existed", () => {
    const bad = labelForArtifact(artifact());
    const baseline = labelForArtifact(artifact({ metadata: {} }));
    expect(bad).toBe(baseline);
  });

  it("NEGATIVE: well-formed string sources are unaffected", () => {
    const good = artifact({ metadata: { sources: ["breach_check", "serus_darkweb_scan"] } });
    expect(() => labelForArtifact(good)).not.toThrow();
    expect(() => authorityFor(good)).not.toThrow();
  });
});
