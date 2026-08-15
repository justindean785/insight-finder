import { describe, it, expect } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { authorityFor, tallyAuthority, LEDGER_SORT_RANK, type AuthorityState } from "@/lib/authority";
import { quarantineReason } from "@/lib/quarantine";
import { buildReportMarkdown } from "@/lib/intel";

/**
 * `authorityFor` — the frontend's single presentation projection.
 *
 * WHAT THIS MODULE IS ALLOWED TO DO, and therefore what these tests police:
 * project decisions ALREADY made elsewhere. Strength comes from the evidence
 * engine (`evidenceStatus` / `labelForArtifact`); eligibility comes from the
 * authority-denial predicates (`isClusterIneligible` — active quarantine or a
 * flagged collision — plus conflict / false-positive). `authorityFor` only
 * renders those two verdicts as one UI state.
 *
 * It has no thresholds and no scoring, and it
 * must never move a row UP the ladder. The tests below are mostly a combination
 * table, because the only way this abstraction can fail is by mixing two
 * orthogonal axes — evidence STRENGTH ("how good is this observation?") and
 * subject AUTHORITY ("may it speak for the subject?") — and silently dropping
 * one of them.
 *
 * The released-row row of that table is the important one. It proves this new
 * abstraction did not quietly resurrect raw `subject_unlinked` semantics after
 * `quarantineSets` and `isClusterIneligible` were migrated off them.
 */

const NOW = new Date("2026-08-14T00:00:00Z").toISOString();
const REASON = "harvested from a name-only query — same-name collision axis; linkage to the subject is unproven";

let seq = 0;
function art(meta: Record<string, unknown> = {}, over: Partial<Artifact> = {}): Artifact {
  seq += 1;
  return {
    id: `auth-${seq}`,
    kind: "email",
    value: `row${seq}@example.com`,
    confidence: 92,
    source: "hunter_verify",
    created_at: NOW,
    // Two independent classes — the strong baseline, so anything weaker in the
    // table below is weaker because of the flag under test, not the fixture.
    metadata: { sources: ["hunter_verify", "exa_search"], corroborations: 2, ...meta },
    ...over,
  } as Artifact;
}

const QUARANTINE = { subject_unlinked: true, subject_unlinked_reason: REASON };
const RELEASE = { ...QUARANTINE, linkage_confirmed: true };

describe("authorityFor — the combination table", () => {
  // [name, metadata, review, expected state, expected inert]
  const cases: Array<[string, Record<string, unknown>, "confirmed" | undefined, AuthorityState, boolean]> = [
    ["ordinary corroborated row",        {},                                undefined,   "verified",    false],
    ["ordinary attested row",            {},                                "confirmed", "verified",    false],
    ["ordinary conflict",                { conflict: true },                undefined,   "conflict",    true],
    ["ordinary failed",                  { false_positive: true },          undefined,   "failed",      true],
    ["corroborated + active quarantine", QUARANTINE,                        undefined,   "quarantined", true],
    ["attested + active quarantine",     QUARANTINE,                        "confirmed", "quarantined", true],
    ["conflict + active quarantine",     { ...QUARANTINE, conflict: true }, undefined,   "conflict",    true],
    ["failed + active quarantine",       { ...QUARANTINE, false_positive: true }, undefined, "failed",  true],
    ["RELEASED quarantine",              RELEASE,                           undefined,   "verified",   false],
    ["RELEASED + attested",              RELEASE,                           "confirmed", "verified",   false],
  ];

  for (const [name, meta, review, state, inert] of cases) {
    it(`${name} → ${state} (inert: ${inert})`, () => {
      const v = authorityFor(art(meta), review);
      expect({ state: v.state, inert: v.inert }).toEqual({ state, inert });
    });
  }

  it("never promotes: a quarantined row cannot present as verified or probable", () => {
    for (const review of [undefined, "confirmed", "key"] as const) {
      const v = authorityFor(art(QUARANTINE), review);
      expect(["verified", "probable", "infrastructure"]).not.toContain(v.state);
    }
  });
});

describe("authorityFor — the two axes stay separate", () => {
  it("keeps the underlying evidence characterization on a quarantined row", () => {
    // The whole point of `underlying`: a quarantined row can have genuinely
    // strong evidence that the VALUE is real while having no authority to say it
    // is the SUBJECT'S. Flattening it into an invented low-confidence state
    // would be a lie in the other direction.
    const v = authorityFor(art(QUARANTINE));
    expect(v.state).toBe("quarantined");
    expect(v.underlying).not.toBe("verified"); // the engine's own ceiling still applies
    expect(v.basis).toBeTruthy();
  });

  it("discloses quarantine in the hint even when a louder state wins", () => {
    // Precedence decides PRESENTATION priority; it must not erase a second
    // authority condition that is still true. A row that is both contradicted
    // and quarantined reads "Conflict" — and still has to say the linkage is
    // unproven, or the loudest warning swallows the other one.
    for (const meta of [{ ...QUARANTINE, conflict: true }, { ...QUARANTINE, false_positive: true }]) {
      const v = authorityFor(art(meta));
      expect(v.state).not.toBe("quarantined");
      expect(v.hint).toContain("subject_unlinked");
      expect(v.caveat).toBe(REASON);
      expect(v.inert).toBe(true);
    }
  });

  it("does not fabricate a caveat for an ordinary row", () => {
    expect(authorityFor(art()).caveat).toBeNull();
  });

  it("drops the caveat once quarantine is released", () => {
    // History is retained in metadata and in the report's collision section; the
    // ROW-LEVEL caveat is an authority statement, and there is no longer one.
    expect(authorityFor(art(RELEASE)).caveat).toBeNull();
  });
});

describe("quarantineReason — one wording, two surfaces", () => {
  it("quotes the backend's recorded reason verbatim", () => {
    expect(quarantineReason({ subject_unlinked: true, subject_unlinked_reason: REASON })).toBe(REASON);
  });

  it("falls back to the SAME sentence the report's collision section uses", () => {
    // If these two ever diverge, the Evidence board and the report explain the
    // same row differently — which is how the original `subject_unlinked` bug
    // stayed invisible for so long. Pin them to one string by construction:
    // render a real report for a reason-less quarantined row and assert the
    // fallback appears in it.
    const fallback = quarantineReason({ subject_unlinked: true });
    expect(fallback).toBe("harvested from a name-only query — linkage to the subject is unproven");

    const md = buildReportMarkdown({
      artifacts: [art({ subject_unlinked: true }, { value: "nore@example.com" })],
      seedValue: "subject@northgate.example",
    } as never);
    expect(md).toContain(fallback!);
  });

  it("returns null for a row that was never flagged", () => {
    expect(quarantineReason({})).toBeNull();
    expect(quarantineReason(null)).toBeNull();
  });
});

describe("tallyAuthority + sort order", () => {
  it("counts every row exactly once", () => {
    const rows = [art(), art(QUARANTINE), art({ conflict: true }), art(RELEASE)];
    const t = tallyAuthority(rows, () => undefined);
    expect(Object.values(t).reduce((a, b) => a + b, 0)).toBe(rows.length);
    expect(t.quarantined).toBe(1);
    expect(t.conflict).toBe(1);
    expect(t.verified).toBe(2); // ordinary + released
  });

  it("sorts strongest first and ruled-out last", () => {
    expect(LEDGER_SORT_RANK.verified).toBeLessThan(LEDGER_SORT_RANK.review);
    expect(LEDGER_SORT_RANK.failed).toBe(Math.max(...Object.values(LEDGER_SORT_RANK)));
  });
});
