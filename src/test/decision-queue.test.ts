import { describe, it, expect } from "vitest";
import { buildDecisionQueue, isDatasetStranger, type DecisionCandidate } from "@/lib/decision-queue";

const COTENANT =
  "co-tenant row in a breach corpus — this record carries a different value in the field that was queried, so it belongs to another person in the same dataset, not the subject";
const BULK =
  "harvested from a bulk corpus return — this one lookup yielded 67 person identities for a single selector";
const NAME_ONLY = "harvested from a name-only query — same-name collision axis; linkage to the subject is unproven";

const q = (id: string, reason: string | null, confidence = 45): DecisionCandidate<string> => ({
  item: id,
  state: "quarantined",
  metadata: reason === null ? { subject_unlinked: true } : { subject_unlinked: true, subject_unlinked_reason: reason },
  confidence,
});
const c = (id: string, confidence = 50): DecisionCandidate<string> => ({ item: id, state: "conflict", metadata: {}, confidence });

describe("isDatasetStranger", () => {
  it("matches the co-tenant and bulk-corpus reasons the edge writes", () => {
    expect(isDatasetStranger({ subject_unlinked: true, subject_unlinked_reason: COTENANT })).toBe(true);
    expect(isDatasetStranger({ subject_unlinked: true, subject_unlinked_reason: BULK })).toBe(true);
  });
  it("keeps a name-only collision — that row might be the subject", () => {
    expect(isDatasetStranger({ subject_unlinked: true, subject_unlinked_reason: NAME_ONLY })).toBe(false);
    expect(isDatasetStranger({ subject_unlinked: true })).toBe(false);
  });
  it("never fires on a row that is not subject_unlinked", () => {
    expect(isDatasetStranger({ subject_unlinked_reason: COTENANT })).toBe(false);
    expect(isDatasetStranger({ subject_unlinked: "true", subject_unlinked_reason: COTENANT })).toBe(false);
    expect(isDatasetStranger(null)).toBe(false);
  });
});

describe("buildDecisionQueue", () => {
  it("the Caraotta shape: 11 co-tenant rows no longer fill every slot", () => {
    const rows = Array.from({ length: 11 }, (_, i) => q(`ct${i}`, COTENANT));
    const out = buildDecisionQueue([...rows, c("conflict-1")]);
    expect(out.shown).toEqual(["conflict-1"]);
    expect(out.heldBack).toBe(11);
    expect(out.more).toBe(0);
  });

  it("conflicts lead, then quarantined by confidence", () => {
    const out = buildDecisionQueue([q("low", NAME_ONLY, 30), c("cf", 20), q("high", NAME_ONLY, 60)]);
    expect(out.shown).toEqual(["cf", "high", "low"]);
  });

  it("counts actionable rows past the slots instead of dropping them silently", () => {
    const rows = Array.from({ length: 8 }, (_, i) => q(`n${i}`, NAME_ONLY, i));
    const out = buildDecisionQueue(rows);
    expect(out.shown).toHaveLength(5);
    expect(out.more).toBe(3);
    expect(out.heldBack).toBe(0);
  });

  it("a held-back stranger is never in the shown list, even with free slots", () => {
    const out = buildDecisionQueue([q("ct", COTENANT, 99)]);
    expect(out.shown).toEqual([]);
    expect(out.heldBack).toBe(1);
  });
});
