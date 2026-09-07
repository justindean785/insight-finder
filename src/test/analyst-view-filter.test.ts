import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { STATUS_FILTER_GROUPS } from "@/components/ResourcesPanel";
import { authorityFor } from "@/lib/authority";

/**
 * Analyst view — the Evidence board's default.
 *
 * Measured 2026-09-03: an average scan lands 60 artifacts of which 4.8 are
 * unquarantined at confidence >= 65. The board already resolved the noise
 * correctly; only the DEFAULT was wrong, so this drives the same composition the
 * component uses — `authorityFor(...)` piped through the group set — rather than
 * restating the set's contents.
 */
const art = (over: Partial<Artifact> & Pick<Artifact, "id" | "kind" | "value">): Artifact => ({
  confidence: 45,
  source: "oathnet_lookup",
  created_at: "2026-09-03T00:00:00Z",
  metadata: null,
  ...over,
});

const admits = (a: Artifact) => STATUS_FILTER_GROUPS.analyst!.has(authorityFor(a).state);

describe("analyst view admits work, hides audit trail", () => {
  it("hides a quarantined row — the single biggest source of board noise", () => {
    const quarantined = art({
      id: "q", kind: "address", value: "101 Example Street, Springfield, IL",
      metadata: { subject_unlinked: true, subject_unlinked_reason: "harvested from a name-only query — same-name collision axis" },
    });
    expect(authorityFor(quarantined).state).toBe("quarantined");
    expect(admits(quarantined)).toBe(false);
  });

  it("hides an excluded collision, which resolves to quarantined via isClusterIneligible", () => {
    const collision = art({
      id: "x", kind: "excluded_collision", value: "namesake in an unrelated corpus",
      confidence: 60, metadata: { excluded_collision: true },
    });
    expect(admits(collision)).toBe(false);
  });

  it("ADMITS strong evidence", () => {
    const strong = art({
      id: "s", kind: "email", value: "someone@example.invalid", confidence: 85,
      source: "jina_reader_scrape",
      metadata: { sources: ["jina_reader_scrape", "github_user"], source_category: "direct_profile" },
    });
    const state = authorityFor(strong).state;
    expect(STATUS_FILTER_GROUPS.strong!.has(state) || STATUS_FILTER_GROUPS.review!.has(state)).toBe(true);
    expect(admits(strong)).toBe(true);
  });

  it("is exactly the union of Findings and Needs-review — not a third taxonomy", () => {
    const union = new Set([...STATUS_FILTER_GROUPS.strong!, ...STATUS_FILTER_GROUPS.review!]);
    expect([...STATUS_FILTER_GROUPS.analyst!].sort()).toEqual([...union].sort());
  });

  it("NEGATIVE: 'all' still admits everything, so the audit trail stays one click away", () => {
    expect(STATUS_FILTER_GROUPS.all).toBeNull();
  });
});

describe("the board is wired to the analyst view and can always escape it", () => {
  const src = readFileSync("src/components/ResourcesPanel.tsx", "utf8");

  it("defaults to analyst view", () => {
    expect(src).toMatch(/useState<EvidenceStatusFilter>\("analyst"\)/);
  });

  it("a filter hiding everything renders its own state, never the empty-case panel", () => {
    expect(src).toMatch(/items\.length > 0 && filtered\.length === 0/);
    expect(src).toMatch(/onShowAll/);
  });
});
