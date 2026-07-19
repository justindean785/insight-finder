import { describe, expect, it } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { labelForArtifact } from "@/lib/intel";
import { sanitizeValueForLabel, isCollisionArtifact } from "@/lib/report-hygiene";
import { extractRecommendedPivots } from "@/lib/recommended-pivots";

// Additive, cross-cutting integrity contracts. These lock must-not-regress
// invariants that the single-function suites assert only by representative
// example. No production code is exercised for change here — only observed.
//
// Minimal Artifact shape (mirrors src/test/identity-clusters.test.ts) — the
// remaining Artifact fields are optional at these call sites.
function art(over: Partial<Artifact> = {}): Artifact {
  return {
    id: over.id ?? "a1",
    kind: over.kind ?? "email",
    value: over.value ?? "person@example.com",
    confidence: over.confidence ?? 60,
    source: over.source ?? "test_source",
    created_at: over.created_at ?? "2026-06-01T00:00:00.000Z",
    metadata: over.metadata ?? null,
  } as Artifact;
}

// ---------------------------------------------------------------------------
// Confidence ceiling: breach-derived data is a lead, never a conclusion. The
// label ceiling must be independent of the raw confidence number — a breach
// row at confidence 100 must NOT read CONFIRMED. (This is the exact failure
// mode behind an over-scored summary: a high number silently becoming a hard
// claim.)
// ---------------------------------------------------------------------------
describe("integrity: breach-only sensitive PII never reaches CONFIRMED, at any confidence", () => {
  for (const kind of ["name", "phone", "address"]) {
    for (const confidence of [40, 70, 90, 100]) {
      it(`${kind} @ confidence ${confidence} is not CONFIRMED (breach-only, no seed link)`, () => {
        const label = labelForArtifact(
          art({ kind, source: "breach_check", confidence, metadata: { sources: ["breach_check"] } }),
        );
        expect(label).not.toBe("CONFIRMED");
        // Not seed-linked and single corpus → cannot be CORRELATED either.
        expect(label).not.toBe("CORRELATED");
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Collision safety: a row the pipeline flagged as a namesake / unrelated entity
// must never carry a positive evidentiary label, and must be recognized by the
// quarantine predicate through EVERY marker the pipeline can emit — so a future
// edit can't silently drop one and let a namesake seed the subject.
// ---------------------------------------------------------------------------
describe("integrity: collision-flagged artifacts are quarantined, never promoted", () => {
  it("labelForArtifact returns CONFLICT for conflict/collision metadata", () => {
    expect(labelForArtifact(art({ metadata: { collision: true } }))).toBe("CONFLICT");
    expect(labelForArtifact(art({ metadata: { conflict: true } }))).toBe("CONFLICT");
  });

  it("isCollisionArtifact recognizes every quarantine marker", () => {
    expect(isCollisionArtifact(art({ kind: "excluded_collision" }))).toBe(true);
    expect(isCollisionArtifact(art({ metadata: { status: "excluded" } }))).toBe(true);
    expect(isCollisionArtifact(art({ metadata: { status: "EXCLUDED" } }))).toBe(true); // case-insensitive
    expect(isCollisionArtifact(art({ metadata: { excluded_collision: true } }))).toBe(true);
    expect(isCollisionArtifact(art({ metadata: { collision: true } }))).toBe(true);
    expect(isCollisionArtifact(art({ metadata: { possible_collision: true } }))).toBe(true);
  });

  it("isCollisionArtifact does NOT flag an ordinary artifact", () => {
    expect(isCollisionArtifact(art())).toBe(false);
    expect(isCollisionArtifact(art({ metadata: { status: "observed" } }))).toBe(false);
    expect(isCollisionArtifact(art({ metadata: { collision: false } }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed value sanitation: stripping promotional "CONFIRMED" wording from
// an unconfirmed value must never yield an EMPTY label (which would erase the
// value entirely), and must never leave the bare "CONFIRMED" token behind.
// ---------------------------------------------------------------------------
describe("integrity: sanitizeValueForLabel is fail-closed (never empties a value)", () => {
  const promoOnlyInputs = ["CONFIRMED", "— CONFIRMED via 2 independent classes", "CONFIRMED: subject match", "  CONFIRMED  "];

  for (const input of promoOnlyInputs) {
    it(`keeps a non-empty label and drops the bare CONFIRMED token for ${JSON.stringify(input)}`, () => {
      const out = sanitizeValueForLabel(input, false);
      expect(out.length).toBeGreaterThan(0);
      expect(out).not.toMatch(/\bCONFIRMED\b/);
    });
  }

  it("returns the value untouched when the row really is CONFIRMED", () => {
    expect(sanitizeValueForLabel("john@example.com — CONFIRMED", true)).toBe("john@example.com — CONFIRMED");
  });

  it("preserves the substantive value while stripping only the promo tail", () => {
    const out = sanitizeValueForLabel("john@example.com — CONFIRMED across sources", false);
    expect(out).toContain("john@example.com");
    expect(out).not.toMatch(/\bCONFIRMED\b/);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed pivot blocking: a recommended next-step must NEVER be surfaced
// when it names a secret/credential or a minor. Enumerated over every keyword
// so a regex edit can't silently drop one from the block set.
// ---------------------------------------------------------------------------
describe("integrity: recommended pivots fail closed on secrets and minors", () => {
  const SECRET_WORDS = ["password", "passcode", "plaintext", "secret", "token", "cookie", "session", "ssid", "credential", "hash", "2fa", "otp", "cvv", "ssn"];
  const MINOR_WORDS = ["minor", "underage", "child", "teen"];

  // Control: the same structural line WITHOUT a blocked word is emitted, so a
  // length-0 result below is attributable to the block, not a parse failure.
  it("control — a benign pivot line IS emitted", () => {
    const pivots = extractRecommendedPivots("## Recommended Next Pivots\n- Investigate target@example.com — corroborate ownership\n");
    expect(pivots).toHaveLength(1);
  });

  for (const word of [...SECRET_WORDS, ...MINOR_WORDS]) {
    it(`blocks a pivot mentioning "${word}"`, () => {
      const text = `## Recommended Next Pivots\n- Investigate target@example.com ${word} exposure — lead\n`;
      const pivots = extractRecommendedPivots(text);
      expect(pivots.map((p) => p.label)).not.toContainEqual(expect.stringContaining(word));
      expect(pivots).toHaveLength(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Analyst-negative + false-positive rows must fail closed to FAILED so a
// dismissed / known-wrong finding can never render as live evidence.
// ---------------------------------------------------------------------------
describe("integrity: dismissed / false-positive rows fail closed to FAILED", () => {
  it("returns FAILED for an analyst dismissal or a false_positive flag", () => {
    expect(labelForArtifact(art(), "dismissed")).toBe("FAILED");
    expect(labelForArtifact(art(), "wrong")).toBe("FAILED");
    expect(labelForArtifact(art({ metadata: { false_positive: true } }))).toBe("FAILED");
  });
});
