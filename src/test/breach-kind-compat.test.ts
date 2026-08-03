/**
 * breach-kind-compat.test.ts — end-to-end downstream compatibility for the
 * auto-persist collapse (docs/design/confidence-corroboration.md §10).
 *
 * The collapse replaced many `kind:"breach"` artifacts with `breach_exposure`
 * rows. Six consumers matched the literal string `"breach"` and would each have
 * changed behaviour silently — the sidebar counter reading 0, the CaseReport
 * breach note never firing, collapsed rows falling out of the Breach group, and
 * so on. The extraction unit-suite was green throughout, which is precisely why
 * these exist: they assert SEMANTIC equivalence at each consumer, not extraction
 * shape.
 *
 * Every test here fails against the pre-fix code.
 */
import { describe, it, expect } from "vitest";
import { BREACH_ARTIFACT_KINDS, isBreachKind, isDateableBreachKind } from "@/lib/breach-kinds";
import { groupForKind } from "@/lib/intel";
import { toEntityType } from "@/lib/entityIcons";

describe("isBreachKind — the single predicate", () => {
  it("accepts the collapsed kind and the legacy kind alike", () => {
    expect(isBreachKind("breach")).toBe(true);
    expect(isBreachKind("breach_exposure")).toBe(true);
    expect(isBreachKind("credential_exposure")).toBe(true);
    expect(isBreachKind("leak_paste")).toBe(true);
  });

  it("is case-insensitive and null-safe", () => {
    expect(isBreachKind("Breach_Exposure")).toBe(true);
    expect(isBreachKind("  BREACH  ")).toBe(true);
    expect(isBreachKind(null)).toBe(false);
    expect(isBreachKind(undefined)).toBe(false);
    expect(isBreachKind("")).toBe(false);
  });

  it("does not swallow unrelated kinds", () => {
    for (const k of ["email", "phone", "name", "url", "username", "address"]) {
      expect(isBreachKind(k)).toBe(false);
    }
  });
});

describe("downstream consumers treat breach_exposure exactly like breach", () => {
  it("stays in the Breach group rather than falling through to other", () => {
    // Pre-fix: KIND_TO_GROUP had no breach_exposure entry, so the collapsed row
    // left the Breach category entirely.
    expect(groupForKind("breach_exposure")).toBe(groupForKind("breach"));
    expect(groupForKind("breach_exposure")).not.toBe("other");
  });

  it("gets the breach icon, not the generic document fallback", () => {
    // Pre-fix: entityIcons matched only "breach"/"leak", so a collapsed row
    // rendered with the document icon.
    expect(toEntityType("breach_exposure")).toBe("breach");
    expect(toEntityType("breach_exposure")).toBe(toEntityType("breach"));
  });
});

describe("the ageing badge is deliberately NARROWER", () => {
  it("does not age a collapsed row that spans many corpora with many dates", () => {
    // This is the one place the broad predicate would be WRONG: a
    // breach_exposure row has no single breach date to age against, so calling
    // it a "Stale breach" would assert something the row does not know.
    expect(isDateableBreachKind("breach")).toBe(true);
    expect(isDateableBreachKind("breach_exposure")).toBe(false);
    expect(isBreachKind("breach_exposure")).toBe(true); // still a breach record
  });
});

describe("the kind set is the only place to edit", () => {
  it("every dateable kind is also a breach kind", () => {
    for (const k of ["breach", "leak", "stealer_log"]) {
      expect(isDateableBreachKind(k)).toBe(true);
      expect(BREACH_ARTIFACT_KINDS.has(k)).toBe(true);
    }
  });
});
