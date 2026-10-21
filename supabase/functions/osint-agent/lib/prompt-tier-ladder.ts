// lib/prompt-tier-ladder.ts — P1 (2026-10-21, JD-approved). The tier WORDS the model is told to
// write come from the same ladder the analyst sees.
//
// The prompt used to carry three ladders at once: `[CONFIRMED] (≥80)` in the confidence rules,
// `Possible (≥50) / Weak (≥30)` in the per-cycle format, and the UI's 90/75/55/35
// (src/lib/confidence-tier.ts `tierOf`, duplicated and pinned as CONFIDENCE_TIERS in
// lib/evidence-record.ts). So prose said "Confirmed (80)" beside a badge reading Likely, and
// "Possible (52)" beside one reading Weak — the live 2026-10-20 audit (D4) and a 2026-10-21 run
// both published "CONFIRMED" over rows the engine never adjudicated.
//
// SCOPE: the model's free-text vocabulary only. Scores, caps, `record_finding`, SourceClass and
// lib/cluster.ts `tierFor` (the 50/30 ladder stamped into metadata.confidence_tier) are unchanged.
//
// Import-free except the ladder itself, which is import-free: frontend vitest loads this.
// /health proof key: checks.prompt_tier_ladder.
import { CONFIDENCE_TIERS } from "./evidence-record.ts";

export const T = CONFIDENCE_TIERS;

/** "Confirmed (≥90) / Likely (≥75) / Possible (≥55) / Weak (≥35) / Unverified (<35)" */
export function tierLadderSlashed(): string {
  return `Confirmed (≥${T.CONFIRMED}) / Likely (≥${T.LIKELY}) / Possible (≥${T.POSSIBLE}) / Weak (≥${T.WEAK}) / Unverified (<${T.WEAK})`;
}

/** "≥90 Confirmed · ≥75 Likely · ≥55 Possible · ≥35 Weak · else Unverified." */
export function tierLadderDotted(): string {
  return `≥${T.CONFIRMED} Confirmed · ≥${T.LIKELY} Likely · ≥${T.POSSIBLE} Possible · ≥${T.WEAK} Weak · else Unverified.`;
}

/** The one rule that keeps prose labels from claiming analyst authority. */
export const VERIFIED_IS_ANALYST_ONLY =
  `Tier words name a 0-100 score band and nothing else. Never write "Verified" as a label in report prose: that word is reserved for an analyst's confirmation in the app (metadata.status values are unaffected). ` +
  `Two breach corpora, or two mirrors of one leak, are ONE source class, not two.`;

/**
 * Proof the running build tells the model the analyst's ladder. Pure: inspects the two strings
 * the orchestrator actually sends. ok:false names what drifted.
 */
export function promptTierLadderSelfTest(systemPrompt: string, perCycleDirective: string): { ok: boolean; detail: string } {
  const wrong: string[] = [];
  if (!systemPrompt.includes(tierLadderSlashed())) wrong.push("system prompt per-cycle ladder != CONFIDENCE_TIERS");
  const confirmedThresholds = [...systemPrompt.matchAll(/\[CONFIRMED\]\s*\(≥(\d+)\)/g)].map((m) => Number(m[1]));
  if (confirmedThresholds.length === 0) wrong.push("no [CONFIRMED] threshold stated");
  if (confirmedThresholds.some((n) => n !== T.CONFIRMED)) wrong.push(`[CONFIRMED] threshold(s) ${confirmedThresholds.join(",")} != ${T.CONFIRMED}`);
  if (!systemPrompt.includes(VERIFIED_IS_ANALYST_ONLY)) wrong.push("analyst-only Verified rule missing");
  if (!perCycleDirective.includes(tierLadderDotted())) wrong.push("per-cycle directive ladder != CONFIDENCE_TIERS");
  return wrong.length === 0
    ? { ok: true, detail: `ladder ${T.CONFIRMED}/${T.LIKELY}/${T.POSSIBLE}/${T.WEAK}` }
    : { ok: false, detail: wrong.join("; ") };
}
