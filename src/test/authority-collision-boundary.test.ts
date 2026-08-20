import { describe, it, expect } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { authorityFor, tallyAuthority } from "@/lib/authority";
import { isClusterIneligible } from "@/lib/report-hygiene";

/**
 * The board may not out-rank the engine.
 *
 * `isClusterIneligible` is what actually bars a row from identity clusters,
 * graph identity edges and confidence dimensions. `authorityFor` is what the
 * analyst reads. Before this file, the two disagreed on an entire class of row:
 * the projection tested quarantine only, while `isClusterIneligible` is
 * quarantine OR a collision flag. `evidenceStatus` consults NONE of the
 * collision flags, so a `possible_collision` row with two independent source
 * classes was projected "Verified" — it led the Overview's strongest findings
 * and counted in the case header's verified tally, while every engine surface
 * treated it as an unrelated namesake.
 *
 * Same defect shape as the promote boundary (#448), one layer up: the control
 * existed and the surface was not made to honour it.
 *
 * These tests drive the shipped expression rather than restating it — the
 * property test at the bottom fails for ANY future flag that `isClusterIneligible`
 * starts covering and the projection does not, which is the failure mode that
 * produced this bug in the first place.
 */

const NOW = new Date("2026-08-14T00:00:00Z").toISOString();
const NO_REVIEW = () => undefined;

let seq = 0;
/** Deliberately STRONG: two independent classes and a high number, so any
 *  demotion below is caused by the flag under test and nothing else. */
function strong(meta: Record<string, unknown> = {}, over: Partial<Artifact> = {}): Artifact {
  seq += 1;
  return {
    id: `coll-${seq}`,
    kind: "email",
    value: `row${seq}@example.com`,
    confidence: 94,
    source: "hunter_verify",
    created_at: NOW,
    metadata: { sources: ["hunter_verify", "exa_search"], corroborations: 2, ...meta },
    ...over,
  } as Artifact;
}

/** Every metadata shape `isCollisionArtifact` recognises, plus the kind route. */
const COLLISION_SHAPES: Array<{ name: string; art: () => Artifact }> = [
  { name: "possible_collision", art: () => strong({ possible_collision: true }) },
  { name: "collision", art: () => strong({ collision: true }) },
  { name: "excluded_collision", art: () => strong({ excluded_collision: true }) },
  { name: 'status: "excluded"', art: () => strong({ status: "excluded" }) },
  { name: "kind excluded_collision", art: () => strong({}, { kind: "excluded_collision" }) },
];

describe("collision rows cannot be promoted by the presentation layer", () => {
  it("baseline: the same fixture without a collision flag DOES reach verified", () => {
    // Without this, every assertion below would pass on a fixture that was
    // never strong enough to be promoted in the first place.
    const v = authorityFor(strong(), undefined);
    expect(v.state).toBe("verified");
    expect(v.inert).toBe(false);
  });

  for (const shape of COLLISION_SHAPES) {
    it(`${shape.name}: never presents as identity-bearing`, () => {
      const a = shape.art();
      const v = authorityFor(a, undefined);

      // The engine's verdict, and the board's, must agree.
      expect(isClusterIneligible(a)).toBe(true);
      expect(["verified", "probable", "infrastructure"]).not.toContain(v.state);
      expect(v.inert).toBe(true);

      // Withheld authority always says why — a silent demotion is unreadable.
      expect(v.caveat).toBeTruthy();
      expect(v.caveatKind).toBe("linkage");
    });
  }

  it("keeps the underlying strength visible while withholding authority", () => {
    // The two axes stay separate: the row is still good evidence that the VALUE
    // exists, and hiding that would misrepresent it in the other direction.
    const v = authorityFor(strong({ possible_collision: true }), undefined);
    expect(v.underlying).toBe("verified");
    expect(v.state).not.toBe("verified");
  });

  it("a contradiction still outranks the cordon, and still discloses it", () => {
    const v = authorityFor(strong({ possible_collision: true, conflict: true }), undefined);
    expect(v.state).toBe("conflict");
    // Precedence names the row; it must not delete the second condition.
    expect(v.inert).toBe(true);
    expect(v.hint).toMatch(/collision/i);
  });

  it("quarantine wording is used for quarantine, collision wording for collision", () => {
    // One visual state, two reasons. A collision row must not be told it was
    // flagged subject_unlinked, and vice versa.
    const coll = authorityFor(strong({ possible_collision: true }), undefined);
    const quar = authorityFor(strong({ subject_unlinked: true }), undefined);
    expect(coll.state).toBe("quarantined");
    expect(quar.state).toBe("quarantined");
    expect(coll.hint).not.toMatch(/subject_unlinked/);
    expect(quar.hint).toMatch(/subject_unlinked/);
  });

  it("prefers the pipeline's own reason over the canonical collision sentence", () => {
    const v = authorityFor(
      strong({ possible_collision: true, reason_not_confirmed: "two Jordan Vales in the same city" }),
      undefined,
    );
    expect(v.caveat).toBe("two Jordan Vales in the same city");
  });

  it("does not quarantine an ordinary row that merely lacks corroboration", () => {
    // The cordon must stay narrow: it is the engine's predicate, not a mood.
    const v = authorityFor(
      strong({ sources: ["hunter_verify"], corroborations: 1, reason_not_confirmed: "single source" }),
      undefined,
    );
    expect(v.state).not.toBe("quarantined");
    expect(v.inert).toBe(false);
    // Its caveat is a STATUS statement, not a linkage cordon — this is what
    // stops the conflict/status caveat rendering with quarantine chrome.
    expect(v.caveatKind).toBe("status");
  });

  it("PROPERTY: no ineligible row may carry an identity-bearing state", () => {
    // The general form. This is the assertion that survives a future flag being
    // added to isCollisionArtifact: the projection defers to that predicate, so
    // widening it there cannot silently leave this surface behind.
    const rows = [
      strong(),
      strong({ possible_collision: true }),
      strong({ collision: true }),
      strong({ status: "excluded" }),
      strong({ subject_unlinked: true }),
      strong({ subject_unlinked: true, linkage_confirmed: true }),
      strong({ excluded_collision: true }),
      strong({}, { kind: "excluded_collision" }),
    ];
    for (const a of rows) {
      const v = authorityFor(a, undefined);
      if (isClusterIneligible(a)) {
        expect(["verified", "probable", "infrastructure"]).not.toContain(v.state);
        expect(v.inert).toBe(true);
      }
    }
  });

  it("release still works: a confirmed linkage promotes, a collision flag does not", () => {
    // The asymmetry the promote boundary depends on. `linkage_confirmed` is an
    // explicit human claim about PROVENANCE and clears quarantine. There is no
    // equivalent hatch for a collision flag, and this must not accidentally
    // become one.
    const released = strong({ subject_unlinked: true, linkage_confirmed: true });
    expect(isClusterIneligible(released)).toBe(false);
    expect(authorityFor(released, undefined).state).toBe("verified");

    const collisionReleased = strong({ possible_collision: true, linkage_confirmed: true });
    expect(isClusterIneligible(collisionReleased)).toBe(true);
    expect(authorityFor(collisionReleased, undefined).state).toBe("quarantined");
  });

  it("the tally counts collision rows as withheld, not as verified", () => {
    // The header and Overview read this. Before the fix a collision row landed
    // in `verified` here, which is how it reached the case-posture badge.
    const t = tallyAuthority([strong(), strong({ possible_collision: true })], NO_REVIEW);
    expect(t.verified).toBe(1);
    expect(t.quarantined).toBe(1);
  });
});

describe("tallyAuthority applies analyst verdicts", () => {
  it("a dismissed row is Excluded in the tally, not Verified", () => {
    // The case header called tallyAuthority without the review getter while the
    // ledger and Overview passed it, so the header kept reporting a dismissed
    // row as Verified. The parameter is now required; this pins the behaviour
    // that makes it worth requiring.
    const rows = [strong(), strong()];
    const dismissed = rows[1]!.id;

    const blind = tallyAuthority(rows, () => undefined);
    expect(blind.verified).toBe(2);
    expect(blind.failed).toBe(0);

    const aware = tallyAuthority(rows, (id) => (id === dismissed ? "dismissed" : undefined));
    expect(aware.verified).toBe(1);
    expect(aware.failed).toBe(1);
  });
});

describe("a caveat that repeats the chip is suppressed, a specific one is not", () => {
  /**
   * Measured on a live 98-artifact case: 89 rows (91%) carried the identical
   * backend default "needs second independent class of evidence" under an
   * identical "Needs review" chip. Nine carried something specific. Rendering all
   * 98 buries the nine.
   */
  const GENERIC = "needs second independent class of evidence";
  const SPECIFIC = "Russian phone number +7 916 533 8635 — different country code, different person";

  it("drops the backend default that only restates the status", () => {
    const v = authorityFor(strong({ sources: ["hunter_verify"], corroborations: 1, reason_not_confirmed: GENERIC }), undefined);
    expect(v.caveat).toBeNull();
    // The information is not lost — the chip and hint still carry it.
    expect(v.hint).toBeTruthy();
  });

  it("keeps a reason that says something the chip does not", () => {
    const v = authorityFor(strong({ sources: ["hunter_verify"], corroborations: 1, reason_not_confirmed: SPECIFIC }), undefined);
    expect(v.caveat).toBe(SPECIFIC);
    expect(v.caveatKind).toBe("status");
  });

  it("NEVER suppresses a quarantine or collision reason", () => {
    // Those branches carry the only statement of WHY authority is withheld, and
    // the chip does not say it. Suppression there would be the original defect.
    const q = authorityFor(strong({ subject_unlinked: true, reason_not_confirmed: GENERIC }), undefined);
    expect(q.caveat).toBeTruthy();
    const c = authorityFor(strong({ possible_collision: true, reason_not_confirmed: GENERIC }), undefined);
    expect(c.caveat).toBeTruthy();
  });

  it("matches case and trailing-period variants", () => {
    for (const s of ["Needs Second Independent Class Of Evidence", "needs second independent class of evidence."]) {
      expect(authorityFor(strong({ sources: ["hunter_verify"], corroborations: 1, reason_not_confirmed: s }), undefined).caveat).toBeNull();
    }
  });
});
