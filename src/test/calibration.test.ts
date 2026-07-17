import { describe, it, expect } from "vitest";
import {
  wilson, brierScore, reliabilityBuckets, expectedCalibrationError,
  precisionByBand, rateByGroup, falseConfirmationRate, falseLinkRate,
  confidenceToProb, type LabelPoint,
} from "@/lib/calibration";

const pts = (spec: Array<[number, 0 | 1]>): LabelPoint[] => spec.map(([p, y]) => ({ p, y }));

describe("wilson interval", () => {
  it("n=0 is fully uncertain [0,1] with null point", () => {
    expect(wilson(0, 0)).toEqual({ p: null, lo: 0, hi: 1, n: 0 });
  });
  it("point estimate is k/n and interval brackets it", () => {
    const w = wilson(8, 10);
    expect(w.p).toBe(0.8);
    expect(w.lo).toBeGreaterThan(0);
    expect(w.lo).toBeLessThan(0.8);
    expect(w.hi).toBeGreaterThan(0.8);
    expect(w.hi).toBeLessThanOrEqual(1);
  });
  it("larger n gives a tighter interval at the same rate", () => {
    const small = wilson(8, 10);
    const large = wilson(800, 1000);
    expect(large.hi - large.lo).toBeLessThan(small.hi - small.lo);
  });
  it("all-success does not produce a nonsense upper bound > 1", () => {
    const w = wilson(5, 5);
    expect(w.hi).toBeLessThanOrEqual(1);
    expect(w.lo).toBeGreaterThan(0);
  });
});

describe("brierScore", () => {
  it("perfect confident forecasts score 0", () => {
    expect(brierScore(pts([[1, 1], [0, 0]])).score).toBe(0);
  });
  it("confidently wrong scores 1", () => {
    expect(brierScore(pts([[0, 1], [1, 0]])).score).toBe(1);
  });
  it("always-0.5 scores 0.25", () => {
    expect(brierScore(pts([[0.5, 1], [0.5, 0]])).score).toBe(0.25);
  });
  it("empty is null", () => {
    expect(brierScore([]).score).toBeNull();
  });
});

describe("expectedCalibrationError", () => {
  it("perfectly calibrated → 0", () => {
    // 0.5 predicted, 50% observed in that bin.
    const { ece } = expectedCalibrationError(pts([[0.5, 1], [0.5, 0], [0.5, 1], [0.5, 0]]));
    expect(ece).toBe(0);
  });
  it("confident-but-wrong → gap equals the miscalibration", () => {
    // predicted 0.9, observed 0 → |0 - 0.9| = 0.9
    const { ece } = expectedCalibrationError(pts([[0.9, 0], [0.9, 0]]));
    expect(ece).toBeCloseTo(0.9, 10);
  });
  it("empty is null", () => {
    expect(expectedCalibrationError([]).ece).toBeNull();
  });
});

describe("reliabilityBuckets", () => {
  it("routes p=1 into the last (closed) bin", () => {
    const buckets = reliabilityBuckets(pts([[1, 1]]), 10);
    const last = buckets[buckets.length - 1];
    expect(last.n).toBe(1);
    expect(buckets.slice(0, -1).every((b) => b.n === 0)).toBe(true);
  });
  it("reports gap = observed − predicted (positive = under-confident)", () => {
    // predicted ~0.35, observed 1.0 → positive gap (under-confident), mirrors the
    // real prod finding that low bands are under-confident.
    const buckets = reliabilityBuckets(pts([[0.35, 1], [0.35, 1]]), 10);
    const bin = buckets.find((b) => b.n > 0)!;
    expect(bin.gap).toBeGreaterThan(0);
  });
});

describe("precisionByBand", () => {
  it("buckets by 0-100 confidence and counts confirmations", () => {
    const stats = precisionByBand([
      { confidence: 95, y: 1 }, { confidence: 92, y: 1 },
      { confidence: 60, y: 1 }, { confidence: 60, y: 0 },
      { confidence: 10, y: 0 },
    ]);
    const top = stats.find((s) => s.band === "90-100")!;
    expect(top.n).toBe(2);
    expect(top.confirmed).toBe(2);
    expect(top.rate.p).toBe(1);
    const mid = stats.find((s) => s.band === "55-74")!;
    expect(mid.n).toBe(2);
    expect(mid.rate.p).toBe(0.5);
  });
  it("empty band has n=0 and full-uncertainty interval", () => {
    const stats = precisionByBand([{ confidence: 95, y: 1 }]);
    const empty = stats.find((s) => s.band === "0-34")!;
    expect(empty.n).toBe(0);
    expect(empty.rate).toEqual({ p: null, lo: 0, hi: 1, n: 0 });
  });
});

describe("rateByGroup", () => {
  it("aggregates per key, sorted by n desc", () => {
    const stats = rateByGroup([
      { key: "oathnet", y: 1 }, { key: "oathnet", y: 1 }, { key: "oathnet", y: 0 },
      { key: "jina", y: 0 },
    ]);
    expect(stats[0].key).toBe("oathnet");
    expect(stats[0].n).toBe(3);
    expect(stats[0].confirmed).toBe(2);
    expect(stats[0].rejected).toBe(1);
    expect(stats[1].key).toBe("jina");
  });
});

describe("false-rate ground-truth signals", () => {
  it("falseConfirmationRate counts confirmed-then-reversed over confirmed", () => {
    const r = falseConfirmationRate([
      { everConfirmed: true, finalY: 1 },
      { everConfirmed: true, finalY: 0 }, // reversed
      { everConfirmed: false, finalY: 0 }, // ignored (never confirmed)
    ]);
    expect(r.n).toBe(2);
    expect(r.p).toBe(0.5);
  });
  it("falseLinkRate counts merges later split/corrected over merges", () => {
    const r = falseLinkRate([
      { merged: true, laterSplitOrCorrected: true },
      { merged: true, laterSplitOrCorrected: false },
      { merged: false, laterSplitOrCorrected: false },
    ]);
    expect(r.n).toBe(2);
    expect(r.p).toBe(0.5);
  });
});

describe("confidenceToProb", () => {
  it("maps 0-100 → 0-1 and clamps", () => {
    expect(confidenceToProb(90)).toBe(0.9);
    expect(confidenceToProb(150)).toBe(1);
    expect(confidenceToProb(-5)).toBe(0);
  });
});
