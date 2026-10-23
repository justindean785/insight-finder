import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { SYSTEM_PROMPT_FULL, buildSystemPromptFull } from "../../functions/osint-agent/system-prompt.ts";
import { buildPerCycleCompactDirective } from "../../functions/osint-agent/orchestrator-finalize.ts";
import { CONFIDENCE_TIERS, confidenceTierLabel } from "../../functions/osint-agent/lib/evidence-record.ts";
import {
  promptTierLadderSelfTest,
  tierLadderDotted,
  tierLadderSlashed,
  VERIFIED_IS_ANALYST_ONLY,
} from "../../functions/osint-agent/lib/prompt-tier-ladder.ts";

// P1 (2026-10-21): the tier words the model writes must use the analyst's ladder
// (CONFIDENCE_TIERS, pinned to src/lib/confidence-tier.ts). The prompt had told it
// "[CONFIRMED] (≥80)" and "Possible (≥50) / Weak (≥30)".

Deno.test("system prompt: the per-cycle ladder is the analyst's 90/75/55/35", () => {
  assert(SYSTEM_PROMPT_FULL.includes("Confirmed (≥90) / Likely (≥75) / Possible (≥55) / Weak (≥35) / Unverified (<35)"));
  assert(!SYSTEM_PROMPT_FULL.includes("Possible (≥50)"), "old 50 threshold gone");
  assert(!SYSTEM_PROMPT_FULL.includes("Weak (≥30)"), "old 30 threshold gone");
});

Deno.test("system prompt: every [CONFIRMED] threshold is 90, and the 80 one is gone", () => {
  const ns = [...SYSTEM_PROMPT_FULL.matchAll(/\[CONFIRMED\]\s*\(≥(\d+)\)/g)].map((m) => Number(m[1]));
  assert(ns.length > 0);
  assert(ns.every((n) => n === CONFIDENCE_TIERS.CONFIRMED), `got ${ns.join(",")}`);
  assert(!SYSTEM_PROMPT_FULL.includes("[CONFIRMED] (≥80)"));
});

Deno.test("system prompt: 'Verified' is analyst-only and breach corpora are one class", () => {
  assert(SYSTEM_PROMPT_FULL.includes(VERIFIED_IS_ANALYST_ONLY));
  assert(/Never write "Verified"/.test(SYSTEM_PROMPT_FULL));
  assert(/Two breach corpora[^.]*ONE source class/.test(SYSTEM_PROMPT_FULL));
});

Deno.test("system prompt: scoring guidance numbers are untouched (2+ sources = 80+, single = 40-60)", () => {
  // These say what SCORE to record, not which tier word to print; P1 leaves them alone.
  assert(SYSTEM_PROMPT_FULL.includes("corroborated by 2+ sources = 80+, single source = 40-60"));
  assert(SYSTEM_PROMPT_FULL.includes("[INFERRED] at most 50"));
});

Deno.test("system prompt: both reveal postures carry the same ladder", () => {
  for (const reveal of [true, false]) assert(buildSystemPromptFull(reveal).includes(tierLadderSlashed()));
});

Deno.test("per-cycle directive: ladder line is the analyst's", () => {
  const d = buildPerCycleCompactDirective();
  assert(d.includes("≥90 Confirmed · ≥75 Likely · ≥55 Possible · ≥35 Weak · else Unverified."));
  assert(d.includes(tierLadderDotted()));
});

Deno.test("the stated ladder maps scores exactly like the Evidence Record's label", () => {
  // Boundaries the prompt states, checked against the renderer that prints beside them.
  const cases: [number, string][] = [[90, "Confirmed"], [89, "Likely"], [75, "Likely"], [74, "Possible"], [55, "Possible"], [54, "Weak"], [35, "Weak"], [34, "Unverified"]];
  for (const [score, label] of cases) assertEquals(confidenceTierLabel(score), label, `score ${score}`);
});

Deno.test("checks.prompt_tier_ladder: ok on the shipped strings, names the drift otherwise", () => {
  const ok = promptTierLadderSelfTest(SYSTEM_PROMPT_FULL, buildPerCycleCompactDirective());
  assertEquals(ok.ok, true, ok.detail);
  assertEquals(ok.detail, "ladder 90/75/55/35");

  const stale = promptTierLadderSelfTest(
    SYSTEM_PROMPT_FULL.replace("[CONFIRMED] (≥90)", "[CONFIRMED] (≥80)"),
    buildPerCycleCompactDirective().replace("≥55 Possible", "≥50 Possible"),
  );
  assertEquals(stale.ok, false);
  assert(stale.detail.includes("80"), stale.detail);
  assert(stale.detail.includes("per-cycle directive"), stale.detail);

  const noRule = promptTierLadderSelfTest(SYSTEM_PROMPT_FULL.replace(VERIFIED_IS_ANALYST_ONLY, ""), buildPerCycleCompactDirective());
  assertEquals(noRule.ok, false);
  assert(noRule.detail.includes("Verified"), noRule.detail);
});
