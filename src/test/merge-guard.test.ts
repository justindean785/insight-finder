import { describe, expect, it } from "vitest";
import {
  evaluateMergeGuard,
  sourceGroup,
  type MergeSignal,
} from "../../supabase/functions/osint-agent/merge_guard.ts";

describe("mergeGuard identity safety policy", () => {
  it("blocks a confirmed person merge based only on common name plus shared DOB", () => {
    const signals: MergeSignal[] = [
      { kind: "name", value: "John Smith", source: "case_report" },
      { kind: "dob", value: "1978-04-03", source: "people_search" },
    ];

    const decision = evaluateMergeGuard({
      leftLabel: "John Smith",
      rightLabel: "John Smith",
      requestedLabel: "CONFIRMED",
      signals,
    });

    expect(decision.allowConfirmedMerge).toBe(false);
    expect(decision.recommendedLabel).toBe("VERIFY");
    expect(decision.reasons.join(" ")).toMatch(/shared DOB plus common\/same name/i);
  });

  it("treats people-search aggregators as one correlated weak source group", () => {
    const decision = evaluateMergeGuard({
      leftLabel: "Jane Doe",
      rightLabel: "Jane Doe",
      signals: [
        { kind: "aggregator_record", value: "Jane Doe DOB 1978", source: "Instant Checkmate" },
        { kind: "aggregator_record", value: "Jane Doe DOB 1978", source: "TruthFinder" },
        { kind: "aggregator_record", value: "Jane Doe DOB 1978", source: "BeenVerified" },
        { kind: "dob", value: "1978-04-03", source: "Truth Finder" },
      ],
    });

    expect(decision.allowConfirmedMerge).toBe(false);
    expect(decision.correlatedSourceGroups).toEqual(["people-search-aggregator"]);
    expect(decision.independentStrongSignals).toBe(0);
  });

  it("treats combolists as correlated breach evidence, not independent confirmations", () => {
    expect(sourceGroup("combo list dump", "breach_record")).toBe("breach-combolist");
    const decision = evaluateMergeGuard({
      leftLabel: "John Smith",
      rightLabel: "John Smith",
      signals: [
        { kind: "name", value: "John Smith", source: "leakcheck" },
        { kind: "dob", value: "1978-04-03", source: "leak combo" },
        { kind: "breach_record", value: "john smith 1978", source: "combolist mirror 1" },
        { kind: "breach_record", value: "john smith 1978", source: "combolist mirror 2" },
      ],
    });

    expect(decision.allowConfirmedMerge).toBe(false);
    expect(decision.correlatedSourceGroups).toEqual(["breach-combolist"]);
  });

  it("allows confirmed merge when an independent strong identifier links the clusters", () => {
    const decision = evaluateMergeGuard({
      leftLabel: "Jane Doe",
      rightLabel: "Jane Doe",
      requestedLabel: "CONFIRMED",
      signals: [
        { kind: "name", value: "Jane Doe", source: "case_report" },
        { kind: "dob", value: "1978-04-03", source: "people_search" },
        { kind: "email", value: "jane@example.com", source: "first_party_profile" },
      ],
    });

    expect(decision.allowConfirmedMerge).toBe(true);
    expect(decision.recommendedLabel).toBe("CONFIRMED");
    expect(decision.independentStrongSignals).toBe(1);
  });

  it("normalizes strong identifiers before counting them", () => {
    const decision = evaluateMergeGuard({
      signals: [
        { kind: "phone", value: "+1 (415) 555-1234", source: "official record" },
        { kind: "phone", value: "+14155551234", source: "official record" },
      ],
    });

    expect(decision.independentStrongSignals).toBe(1);
    expect(decision.allowConfirmedMerge).toBe(true);
  });
});

