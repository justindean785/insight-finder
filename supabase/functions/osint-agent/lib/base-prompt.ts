// lib/base-prompt.ts — the orchestrator's base system prompt, assembled in ONE place.
//
// index.ts used to concatenate this inline at two sites (the `baseSystemPrompt` shared by
// streamText's step overrides and the finalize phase, and the default `system` on the
// streamText call). Extracting it keeps those two byte-identical and makes the ASSEMBLED
// runtime prompt testable instead of only its pieces. Behaviour-preserving: with the
// kill switch on (or off) the result is exactly what the inline expression produced.
//
// The Memory wording variant is chosen at CALL TIME (MEMORY_AUTHORITY_WORDING_DISABLED),
// so a switch flip needs no deploy.

import {
  SYSTEM_PROMPT_FULL,
  SYSTEM_PROMPT_FULL_LEGACY_FINDING,
  SYSTEM_PROMPT_FULL_LEGACY_MEMORY,
  SYSTEM_PROMPT_FULL_LEGACY_MEMORY_AND_FINDING,
} from "../system-prompt.ts";
import { FINDING_LABELS } from "../catalog.ts";
import { buildWorkflowAddendum } from "../workflow_prompt.ts";
import { memoryAuthorityWordingDisabled } from "./memory-provenance.ts";
import { responseLanguageBlock } from "./response-language.ts";
import { findingPromptV2Disabled } from "./finding-prompt.ts";

// Two independent wording switches, both read at CALL TIME so a flip needs no deploy:
//   MEMORY_AUTHORITY_WORDING_DISABLED (#831, lib/memory-provenance.ts) and FINDING_PROMPT_V2_DISABLED (lib/finding-prompt.ts).
export function staticSystemPrompt(): string {
  // The output-language rule (lib/response-language.ts, switch RESPONSE_LANGUAGE_RULE_DISABLED) rides the
  // static prompt so finalize and the report see it; orchestrator-finalize.ts repeats it on every
  // intermediate step. It is appended to WHICHEVER wording variant the two switches above select.
  return selectStaticPrompt() + responseLanguageBlock();
}

function selectStaticPrompt(): string {
  const legacyMemory = memoryAuthorityWordingDisabled();
  const legacyFinding = findingPromptV2Disabled();
  if (legacyMemory && legacyFinding) return SYSTEM_PROMPT_FULL_LEGACY_MEMORY_AND_FINDING;
  if (legacyMemory) return SYSTEM_PROMPT_FULL_LEGACY_MEMORY;
  if (legacyFinding) return SYSTEM_PROMPT_FULL_LEGACY_FINDING;
  return SYSTEM_PROMPT_FULL;
}

export function assembleBaseSystemPrompt(input: {
  detectedSeedType: Parameters<typeof buildWorkflowAddendum>[0];
  visionIntakeSummary: string;
  /** "" at the streamText default site, which never carried the analyst-decisions block. */
  analystDecisionsBlock?: string;
}): string {
  return staticSystemPrompt() + FINDING_LABELS + buildWorkflowAddendum(input.detectedSeedType) +
    input.visionIntakeSummary + (input.analystDecisionsBlock ?? "");
}
