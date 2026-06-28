/**
 * confidence-tier.ts — the single source of truth for turning a numeric
 * confidence (0–100) into a semantic tier, its color token, and its label.
 *
 * Everywhere a confidence renders — the evidence grid badge, the cluster/graph
 * node, the report bars, the radar vertex — must derive its color from HERE so
 * the number, the bar, and any tag on the same row always agree. Tiers map to
 * JD's bands; each tier owns ONE color (the `--conf-*` HSL tokens in index.css).
 *
 * This is display-only. It does NOT compute or alter confidence — the backend
 * (confidence.ts / source-classification.ts) remains the sole authority for the
 * values; this module only decides how an already-computed value looks.
 */

export type ConfidenceTier = "confirmed" | "likely" | "possible" | "weak" | "unverified";

export interface TierInfo {
  tier: ConfidenceTier;
  /** Tailwind/CSS HSL var name, e.g. "--conf-likely". */
  varName: string;
  /** Ready-to-use `hsl(var(--conf-*))` string for inline styles (SVG, etc.). */
  color: string;
  /** Short human label. */
  label: string;
  /** Tailwind text-color class. */
  text: string;
  /** Tailwind bg-color class (full-strength). */
  bg: string;
  /** Tailwind border-color class. */
  border: string;
  /** Whether this tier earns the verified glow treatment (Confirmed only). */
  glow: boolean;
}

const TIERS: Record<ConfidenceTier, Omit<TierInfo, "color">> = {
  confirmed: {
    tier: "confirmed", varName: "--conf-confirmed", label: "Confirmed", glow: true,
    text: "text-conf-confirmed", bg: "bg-conf-confirmed", border: "border-conf-confirmed",
  },
  likely: {
    tier: "likely", varName: "--conf-likely", label: "Likely", glow: false,
    text: "text-conf-likely", bg: "bg-conf-likely", border: "border-conf-likely",
  },
  possible: {
    tier: "possible", varName: "--conf-possible", label: "Possible", glow: false,
    text: "text-conf-possible", bg: "bg-conf-possible", border: "border-conf-possible",
  },
  weak: {
    tier: "weak", varName: "--conf-weak", label: "Weak", glow: false,
    text: "text-conf-weak", bg: "bg-conf-weak", border: "border-conf-weak",
  },
  unverified: {
    tier: "unverified", varName: "--conf-unverified", label: "Unverified", glow: false,
    text: "text-conf-unverified", bg: "bg-conf-unverified", border: "border-conf-unverified",
  },
};

/** Map a 0–100 score to its tier. null/undefined → unverified. */
export function tierOf(score: number | null | undefined): ConfidenceTier {
  if (score == null || !Number.isFinite(score)) return "unverified";
  if (score >= 90) return "confirmed";
  if (score >= 75) return "likely";
  if (score >= 55) return "possible";
  if (score >= 35) return "weak";
  return "unverified";
}

/** Full tier descriptor for a score, including a ready-to-use inline color. */
export function tierInfo(score: number | null | undefined): TierInfo {
  const base = TIERS[tierOf(score)];
  return { ...base, color: `hsl(var(${base.varName}))` };
}

/** Inline color for a score — for SVG fills / style props (radar, graph nodes). */
export function confidenceColor(score: number | null | undefined): string {
  return `hsl(var(${TIERS[tierOf(score)].varName}))`;
}
