import { describe, it, expect } from "vitest";
import {
  phaseKey, phaseLabel, cycleTitle, outcomeWord, describeCycle, formatPayloadMeta,
} from "@/lib/run-timeline";
import { conciseToolLabel } from "@/lib/tool-display";

describe("phase lexicon", () => {
  it("maps every runtime stage token to one analyst word, never the token", () => {
    expect(phaseLabel("TRIAGE")).toBe("Triage");
    expect(phaseLabel("REVIEW")).toBe("Review");
    expect(phaseLabel("TARGETED_PIVOT")).toBe("Pivot");
    expect(phaseLabel("VERIFY")).toBe("Verify");
    expect(phaseLabel("REPORT")).toBe("Report");
    expect(phaseKey("targeted_pivot")).toBe("pivot");
    expect(phaseKey("")).toBe("review");
    expect(phaseKey(null)).toBe("review");
  });
  it("humanises an unknown token instead of leaking SNAKE_CASE", () => {
    expect(phaseKey("SOME_FUTURE_STAGE")).toBe("other");
    expect(phaseLabel("SOME_FUTURE_STAGE")).toBe("Some future stage");
  });
  it("cycleTitle carries the cycle id as a mono chip only when resolved", () => {
    expect(cycleTitle("TARGETED_PIVOT", 2)).toEqual({ phase: "Pivot", cycle: "C2" });
    expect(cycleTitle("REVIEW", -1)).toEqual({ phase: "Review", cycle: null });
    expect(cycleTitle("REVIEW", 0).cycle).toBeNull();
  });
});

describe("outcome words", () => {
  it("one word per outcome, no authority vocabulary", () => {
    expect(outcomeWord("completed")).toBe("completed");
    expect(outcomeWord("cached")).toBe("from cache");
    expect(outcomeWord("skipped")).toBe("skipped");
    expect(outcomeWord("partial")).toBe("no result");
    expect(outcomeWord("running")).toBe("running");
    for (const w of ["completed", "cached", "skipped", "partial", "running"] as const) {
      expect(outcomeWord(w)).not.toMatch(/verified|confirmed|likely/i);
    }
  });
});

describe("describeCycle", () => {
  it("names what the cycle did from its tools, de-duplicated and capped, never a raw tool id", () => {
    const d = describeCycle(
      ["oathnet_lookup", "breach_check", "oathnet_lookup", "username_sweep", "record_artifacts"],
      ["iamfoxxx3@yahoo.com", "iamfoxxx3@yahoo.com", "iamfoxxx"],
    );
    expect(d.purpose).toBe("breach/profile lookup · breach lookup +2");
    expect(d.purpose).not.toMatch(/_/);
    expect(d.selectors).toEqual(["iamfoxxx3@yahoo.com", "iamfoxxx"]);
    expect(d.extraSelectors).toBe(0);
  });
  it("caps selectors and counts the rest; blanks are dropped", () => {
    const d = describeCycle(["memory_recall"], ["a", "", "b", "c", "a"], { maxSelectors: 2 });
    expect(d.purpose).toBe("memory recall");
    expect(d.selectors).toEqual(["a", "b"]);
    expect(d.extraSelectors).toBe(1);
  });
  it("conciseToolLabel covers the run's own bookkeeping steps and falls back to the action label", () => {
    expect(conciseToolLabel("record_artifacts")).toBe("artifacts recorded");
    expect(conciseToolLabel("memory_save")).toBe("memory save");
    expect(conciseToolLabel("triage_seed")).toBe("seed triage");
    expect(conciseToolLabel("some_unknown_tool")).toBe("some unknown tool");
    expect(conciseToolLabel("hunter_verify")).toBe("hunter verify");
    expect(conciseToolLabel("")).toBe("");
  });
});

describe("formatPayloadMeta", () => {
  it("keeps bytes as bytes below 1 KB (the '40 lines · 1b' defect)", () => {
    expect(formatPayloadMeta(40, 812)).toBe("40 lines · 812 B");
    expect(formatPayloadMeta(1, 0)).toBe("1 line · 0 B");
    expect(formatPayloadMeta(53, 2765)).toBe("53 lines · 2.7 KB");
    expect(formatPayloadMeta(9000, 3 * 1024 * 1024)).toBe("9000 lines · 3.0 MB");
  });
});
