/**
 * calibration.ts — pure, dependency-free calibration metrics.
 *
 * Turns analyst ground-truth labels (from analyst_feedback_events, via the
 * v_analyst_feedback_clean view) into MEASURABLE calibration: is a stored
 * confidence of 90 actually confirmed ~90% of the time? These functions ONLY
 * measure; they never change any confidence. Every metric returns its sample
 * size and an uncertainty interval so a number backed by n=3 is never read as
 * if it were backed by n=3000 (a hard requirement of the milestone).
 *
 * Convention: `p` is a probability in [0,1]. Use confidenceToProb() to convert a
 * 0–100 stored confidence. `y` is the observed outcome: 1 = analyst-confirmed,
 * 0 = analyst-rejected. Unresolved/contradictory labels are excluded upstream
 * (the SQL view), so callers pass clean points only.
 */

export interface LabelPoint {
  /** Predicted probability in [0,1] (the model's confidence at judgment time). */
  p: number;
  /** Observed outcome: 1 confirmed, 0 rejected. */
  y: 0 | 1;
}

export interface Interval {
  /** Point estimate (null when n = 0). */
  p: number | null;
  lo: number;
  hi: number;
  n: number;
}

export function confidenceToProb(confidence: number): number {
  return clamp01(confidence / 100);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Wilson score interval for a binomial proportion — far better than normal
 * approximation at small n or extreme rates (the regime this project lives in).
 * z defaults to 1.96 (95%). n = 0 → fully uncertain [0,1].
 */
export function wilson(k: number, n: number, z = 1.96): Interval {
  if (n <= 0) return { p: null, lo: 0, hi: 1, n: 0 };
  const phat = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (phat + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n)) / denom;
  return { p: phat, lo: clamp01(center - half), hi: clamp01(center + half), n };
}

/**
 * Brier score: mean squared error of the probabilistic forecast. 0 = perfect,
 * 0.25 = always predicting 0.5, 1 = confidently wrong. Lower is better.
 */
export function brierScore(points: LabelPoint[]): { score: number | null; n: number } {
  if (points.length === 0) return { score: null, n: 0 };
  const s = points.reduce((acc, { p, y }) => acc + (p - y) * (p - y), 0);
  return { score: s / points.length, n: points.length };
}

export interface ReliabilityBin {
  label: string;
  /** Lower/upper edge of the predicted-probability bin, in [0,1]. */
  from: number;
  to: number;
  n: number;
  /** Mean predicted probability in the bin. */
  predicted: number | null;
  /** Empirical confirm rate in the bin, with Wilson interval. */
  observed: Interval;
  /** Signed gap observed − predicted (positive = under-confident). */
  gap: number | null;
}

/**
 * Reliability buckets over equal-width probability bins. Each bin reports mean
 * predicted vs. empirical-observed (with a Wilson interval) and their gap.
 */
export function reliabilityBuckets(points: LabelPoint[], bins = 10): ReliabilityBin[] {
  const width = 1 / bins;
  const out: ReliabilityBin[] = [];
  for (let i = 0; i < bins; i++) {
    const from = i * width;
    const to = i === bins - 1 ? 1 : (i + 1) * width;
    // Last bin is closed on the right so p = 1 lands somewhere.
    const inBin = points.filter((pt) => pt.p >= from && (i === bins - 1 ? pt.p <= to : pt.p < to));
    const n = inBin.length;
    const k = inBin.reduce((a, pt) => a + pt.y, 0);
    const predicted = n > 0 ? inBin.reduce((a, pt) => a + pt.p, 0) / n : null;
    const observed = wilson(k, n);
    out.push({
      label: `${Math.round(from * 100)}-${Math.round(to * 100)}`,
      from, to, n, predicted, observed,
      gap: predicted != null && observed.p != null ? observed.p - predicted : null,
    });
  }
  return out;
}

/**
 * Expected Calibration Error: sample-weighted mean gap between predicted and
 * observed across bins. 0 = perfectly calibrated. Returns the per-bin detail too.
 */
export function expectedCalibrationError(
  points: LabelPoint[],
  bins = 10,
): { ece: number | null; n: number; bins: ReliabilityBin[] } {
  const buckets = reliabilityBuckets(points, bins);
  const N = points.length;
  if (N === 0) return { ece: null, n: 0, bins: buckets };
  let ece = 0;
  for (const b of buckets) {
    if (b.n > 0 && b.predicted != null && b.observed.p != null) {
      ece += (b.n / N) * Math.abs(b.observed.p - b.predicted);
    }
  }
  return { ece, n: N, bins: buckets };
}

export interface BandStat {
  band: string;
  n: number;
  confirmed: number;
  /** Empirical confirm rate (precision) with Wilson interval. */
  rate: Interval;
}

/** Default display bands, matching src/lib/confidence-tier.ts cut-points. */
export const DEFAULT_BANDS: Array<{ band: string; from: number; to: number }> = [
  { band: "90-100", from: 90, to: 100 },
  { band: "75-89", from: 75, to: 89 },
  { band: "55-74", from: 55, to: 74 },
  { band: "35-54", from: 35, to: 54 },
  { band: "0-34", from: 0, to: 34 },
];

/**
 * Precision by confidence band: empirical P(confirmed | score in band). Input
 * points carry a 0–100 confidence (not a probability) to align with the stored
 * column and the display tiers.
 */
export function precisionByBand(
  points: Array<{ confidence: number; y: 0 | 1 }>,
  bands = DEFAULT_BANDS,
): BandStat[] {
  return bands.map(({ band, from, to }) => {
    const inBand = points.filter((pt) => pt.confidence >= from && pt.confidence <= to);
    const n = inBand.length;
    const k = inBand.reduce((a, pt) => a + pt.y, 0);
    return { band, n, confirmed: k, rate: wilson(k, n) };
  });
}

export interface GroupStat {
  key: string;
  n: number;
  confirmed: number;
  rejected: number;
  rate: Interval;
}

/** Confirm/reject rate grouped by an arbitrary key (tool, source family, kind, …). */
export function rateByGroup(
  points: Array<{ key: string; y: 0 | 1 }>,
): GroupStat[] {
  const groups = new Map<string, { n: number; k: number }>();
  for (const { key, y } of points) {
    const g = groups.get(key) ?? { n: 0, k: 0 };
    g.n += 1; g.k += y;
    groups.set(key, g);
  }
  return [...groups.entries()]
    .map(([key, { n, k }]) => ({ key, n, confirmed: k, rejected: n - k, rate: wilson(k, n) }))
    .sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));
}

/**
 * False-confirmation rate: of the labels an analyst confirmed at some point, the
 * fraction whose FINAL resolved outcome is a rejection (i.e. the confirmation was
 * later reversed). A quality signal on the ground truth itself. With a Wilson
 * interval so a tiny denominator is visible.
 */
export function falseConfirmationRate(
  records: Array<{ everConfirmed: boolean; finalY: 0 | 1 | null }>,
): Interval {
  const confirmed = records.filter((r) => r.everConfirmed);
  const n = confirmed.length;
  const k = confirmed.filter((r) => r.finalY === 0).length;
  return wilson(k, n);
}

/**
 * False-link rate: of the entity merges an analyst made, the fraction later split
 * or corrected — the core cluster-integrity ground-truth signal (feeds the
 * username-merge milestone that follows this one).
 */
export function falseLinkRate(
  records: Array<{ merged: boolean; laterSplitOrCorrected: boolean }>,
): Interval {
  const merged = records.filter((r) => r.merged);
  const n = merged.length;
  const k = merged.filter((r) => r.laterSplitOrCorrected).length;
  return wilson(k, n);
}
