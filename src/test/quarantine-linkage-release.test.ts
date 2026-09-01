/**
 * The analyst's release of a linkage quarantine — the missing WRITER for
 * `linkage_confirmed`.
 *
 * Every authority boundary in this product READS `linkage_confirmed`
 * (`isQuarantined`, the pivot engine, the entity graph, the report, the
 * confidence dimensions, and the edge-function dispatch guard from #518).
 * Nothing could write it. #518 made quarantine dispatch-blocking with no `force`
 * override, which turned that gap from a missing convenience into permanent loss
 * of a lead that was auto-quarantined in error.
 *
 * These tests drive the REAL predicate (`isQuarantined`) and the real patch
 * builder — never a restatement of either. That is deliberate: the whole point of
 * `releasePatch` delegating to `isQuarantined` is that the predicate which BLOCKS
 * is the predicate which GATES THE RELEASE, so a future change to one cannot
 * leave the other behind.
 */
import { describe, expect, it } from "vitest";
import { isQuarantined, quarantineReason } from "@/lib/quarantine";
import {
  canReleaseLinkage,
  releasePatch,
  RELEASE_ACTION_LABEL,
  RELEASE_CONFIRM_BODY,
  RELEASE_CONFIRM_TITLE,
} from "@/lib/quarantine-release";
import { adjustedConfidence, labelForArtifact } from "@/lib/intel";
import type { Artifact } from "@/hooks/useThreadArtifacts";

/** A row shaped like the ones production actually quarantined — the 525 SE Tefft
 *  address case, whose 20 URLs carry exactly this metadata. */
const QUARANTINED_META = {
  subject_unlinked: true,
  subject_unlinked_reason:
    "harvested from a name-only query — same-name collision axis; linkage to the subject is unproven",
  confidence_cap_applied: 55,
  promoted_confidence: 30,
  source_category: ["ai_summary"],
  sources: ["minimax_web_search"],
} as const;

const artifact = (meta: Record<string, unknown>): Artifact =>
  ({
    id: "a1", thread_id: "t1", kind: "url", value: "https://example.com/x",
    confidence: 30, source: "minimax_web_search",
    created_at: "2026-09-01T11:39:41.234Z", metadata: meta,
  } as unknown as Artifact);

// ---------------------------------------------------------------------------
// BLOCKED BEFORE RELEASE — the state the analyst is stuck in today.
// ---------------------------------------------------------------------------
describe("a quarantined row is blocked until the analyst releases it", () => {
  it("reads as quarantined through the shared predicate", () => {
    expect(isQuarantined({ ...QUARANTINED_META })).toBe(true);
  });

  it("offers the release action precisely when it is quarantined", () => {
    expect(canReleaseLinkage({ ...QUARANTINED_META })).toBe(true);
  });

  it("a `force` flag in metadata does NOT clear quarantine (#518 is not weakened)", () => {
    // The edge guard ignores `force` by design. Nothing here may create a second,
    // softer door: only `linkage_confirmed` is consulted.
    expect(isQuarantined({ ...QUARANTINED_META, force: true })).toBe(true);
    expect(canReleaseLinkage({ ...QUARANTINED_META, force: true })).toBe(true);
  });

  it("an ordinary review verdict does NOT clear quarantine", () => {
    // `reviewed`/`confirmed`/`key` answer "is this value real?", never "whose is
    // it?". Quarantine is a provenance claim, so only a provenance ruling clears
    // it — see intel.ts on the review control inverting on quarantined rows.
    expect(isQuarantined({ ...QUARANTINED_META, reviewed: true, review_state: "confirmed" })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE ABUSE GUARD — fails closed on anything that is not an active quarantine.
// ---------------------------------------------------------------------------
describe("releasePatch fails closed — the mutation path cannot be abused", () => {
  it("returns null for a row that was never quarantined", () => {
    expect(releasePatch({ sources: ["exa_search"] })).toBeNull();
  });

  it("returns null for a row already released (no double-stamping)", () => {
    expect(releasePatch({ ...QUARANTINED_META, linkage_confirmed: true })).toBeNull();
  });

  it.each([null, undefined, 0, "", "quarantined", [], NaN])(
    "returns null for malformed metadata: %p",
    (bad) => expect(releasePatch(bad)).toBeNull(),
  );

  it("a truthy-but-not-true linkage_confirmed is still quarantined, and still releasable", () => {
    // Mirrors quarantine.ts's strict `!== true`: only the boolean releases.
    expect(isQuarantined({ ...QUARANTINED_META, linkage_confirmed: "yes" })).toBe(true);
    expect(releasePatch({ ...QUARANTINED_META, linkage_confirmed: "yes" })).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// THE RELEASE ITSELF.
// ---------------------------------------------------------------------------
describe("the release persists the ruling and nothing else", () => {
  const patch = releasePatch({ ...QUARANTINED_META }, new Date("2026-09-01T12:00:00.000Z"))!;

  it("sets linkage_confirmed to exactly `true`", () => {
    expect(patch.linkage_confirmed).toBe(true);
  });

  it("records when the ruling was made", () => {
    expect(patch.linkage_confirmed_at).toBe("2026-09-01T12:00:00.000Z");
  });

  it("writes ONLY those two keys — it cannot smuggle a scoring change", () => {
    expect(Object.keys(patch).sort()).toEqual(["linkage_confirmed", "linkage_confirmed_at"]);
  });

  it("the released row stops being quarantined through the EXISTING predicate", () => {
    // Not a new code path: the same isQuarantined every boundary already calls.
    expect(isQuarantined({ ...QUARANTINED_META, ...patch })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PROVENANCE SURVIVES — release is additive, never a rewrite of history.
// ---------------------------------------------------------------------------
describe("quarantine provenance is preserved after release", () => {
  const released = { ...QUARANTINED_META, ...releasePatch({ ...QUARANTINED_META })! };

  it("keeps subject_unlinked", () => {
    expect(released.subject_unlinked).toBe(true);
  });

  it("keeps the backend's recorded reason, verbatim", () => {
    expect(released.subject_unlinked_reason).toBe(QUARANTINED_META.subject_unlinked_reason);
    expect(quarantineReason(released)).toBe(QUARANTINED_META.subject_unlinked_reason);
  });

  it("keeps the recorded confidence cap untouched", () => {
    expect(released.confidence_cap_applied).toBe(55);
  });

  it("keeps the source taxonomy untouched", () => {
    expect(released.source_category).toEqual(["ai_summary"]);
    expect(released.promoted_confidence).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// THE SCORING BOUNDARY — what this PR does NOT do, pinned so a later change
// cannot quietly widen it.
// ---------------------------------------------------------------------------
describe("release changes no scoring input of its own", () => {
  it("the patch contains no confidence, cap, label or source-class key", () => {
    const patch = releasePatch({ ...QUARANTINED_META })! as Record<string, unknown>;
    for (const forbidden of [
      "confidence", "confidence_cap_applied", "promoted_confidence",
      "source_category", "sources", "corroborations", "reviewed", "review_state",
    ]) {
      expect(patch).not.toHaveProperty(forbidden);
    }
  });

  it("release ALONE does not make a row CONFIRMED", () => {
    // The label still needs an analyst review verdict. Release only stops
    // quarantine from vetoing one that already exists.
    const released = artifact({ ...QUARANTINED_META, ...releasePatch({ ...QUARANTINED_META })! });
    expect(labelForArtifact(released, "new")).not.toBe("CONFIRMED");
  });

  it("PRE-EXISTING #448 CONTRACT, documented not introduced: release lifts the quarantine ceiling", () => {
    // This PR adds no confidence logic. But making the hatch operable necessarily
    // exposes #448's existing, mutation-tested behaviour: `adjustedConfidence`
    // gates on `isQuarantined`, so a released row is scored like any other.
    // Pinned HERE so the consequence of shipping the writer is visible in this
    // PR's own suite rather than discovered in production.
    const before = adjustedConfidence(artifact({ ...QUARANTINED_META }));
    const after = adjustedConfidence(artifact({ ...QUARANTINED_META, ...releasePatch({ ...QUARANTINED_META })! }));
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it("the recorded evidence cap STILL binds after release — the ceiling is not removed", () => {
    // confidence-cap-display-invariant.test.ts already states this from the other
    // side. Restated against the release path so the two cannot drift.
    const released = artifact({ ...QUARANTINED_META, ...releasePatch({ ...QUARANTINED_META })! });
    expect(adjustedConfidence(released)).toBeLessThanOrEqual(QUARANTINED_META.confidence_cap_applied);
  });
});

// ---------------------------------------------------------------------------
// THE WORDING IS PART OF THE CONTRACT.
// ---------------------------------------------------------------------------
describe("the action reads as a provenance ruling, not a review approval", () => {
  it("names linkage, not correctness", () => {
    expect(RELEASE_ACTION_LABEL.toLowerCase()).toContain("linkage");
  });

  it("the confirmation asks about the SUBJECT, not about validity", () => {
    expect(RELEASE_CONFIRM_TITLE.toLowerCase()).toContain("subject");
  });

  it("explicitly distinguishes itself from the review controls", () => {
    const body = RELEASE_CONFIRM_BODY.toLowerCase();
    expect(body).toContain("provenance");
    expect(body).toContain("review");
    expect(body).toContain("not about whether the value is real");
  });

  it("tells the analyst the quarantine record is kept", () => {
    expect(RELEASE_CONFIRM_BODY.toLowerCase()).toContain("kept");
  });
});
