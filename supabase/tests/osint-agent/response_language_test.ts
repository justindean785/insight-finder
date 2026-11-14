// response_language_test.ts — the orchestrator is told, in the base prompt AND on every intermediate step, to write
// in English. Pinned after a production GLM-5.2 run (2026-10-31) drifted into Chinese mid-run and wrote its whole
// report in Chinese. Source-level reads need --allow-read.
import { assert, assertEquals, assertFalse, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  RESPONSE_LANGUAGE_RULE, RESPONSE_LANGUAGE_SWITCH, responseLanguageBlock, responseLanguageRuleDisabled, responseLanguageSelfTest,
} from "../../functions/osint-agent/lib/response-language.ts";
import { staticSystemPrompt } from "../../functions/osint-agent/lib/base-prompt.ts";
import { buildPerCycleCompactDirective } from "../../functions/osint-agent/orchestrator-finalize.ts";
import { SYSTEM_PROMPT_FULL, SYSTEM_PROMPT_FULL_LEGACY_MEMORY } from "../../functions/osint-agent/system-prompt.ts";

const HEALTH = await Deno.readTextFile(new URL("../../functions/osint-agent/health-handler.ts", import.meta.url));

async function withSwitch(value: string | undefined, fn: () => void | Promise<void>) {
  const prev = Deno.env.get(RESPONSE_LANGUAGE_SWITCH);
  if (value === undefined) Deno.env.delete(RESPONSE_LANGUAGE_SWITCH); else Deno.env.set(RESPONSE_LANGUAGE_SWITCH, value);
  try { await fn(); } finally { if (prev === undefined) Deno.env.delete(RESPONSE_LANGUAGE_SWITCH); else Deno.env.set(RESPONSE_LANGUAGE_SWITCH, prev); }
}

Deno.test("rule: names English, covers tool-argument prose, protects evidence values, forbids mid-run switching", () => {
  assertStringIncludes(RESPONSE_LANGUAGE_RULE, "OUTPUT LANGUAGE: ENGLISH");
  assertStringIncludes(RESPONSE_LANGUAGE_RULE, "memory_save");
  assertStringIncludes(RESPONSE_LANGUAGE_RULE, "record_finding");
  assertStringIncludes(RESPONSE_LANGUAGE_RULE, "never translate");
  assertStringIncludes(RESPONSE_LANGUAGE_RULE, "mid-run");
  assert(RESPONSE_LANGUAGE_RULE.length < 700, "the rule rides the cached base prompt; keep it short");
});

Deno.test("switch: ships OFF (rule ON); only the literal 'true' disables it", () => {
  assertFalse(responseLanguageRuleDisabled(() => undefined));
  assertFalse(responseLanguageRuleDisabled(() => ""));
  assertFalse(responseLanguageRuleDisabled(() => "false"));
  assert(responseLanguageRuleDisabled(() => "true"));
  assert(responseLanguageRuleDisabled(() => " TRUE "));
  assertEquals(responseLanguageBlock(() => "true"), "");
  assertEquals(responseLanguageBlock(() => undefined), RESPONSE_LANGUAGE_RULE);
});

Deno.test("base prompt: the rule is present in BOTH memory-wording variants and absent when the switch is on", async () => {
  await withSwitch(undefined, () => {
    const p = staticSystemPrompt();
    assertStringIncludes(p, "OUTPUT LANGUAGE: ENGLISH");
    assert(p === SYSTEM_PROMPT_FULL + RESPONSE_LANGUAGE_RULE || p === SYSTEM_PROMPT_FULL_LEGACY_MEMORY + RESPONSE_LANGUAGE_RULE, "rule is appended, nothing else changes");
  });
  await withSwitch("true", () => {
    const p = staticSystemPrompt();
    assertFalse(p.includes("OUTPUT LANGUAGE"), "kill switch restores the pre-rule prompt");
    assert(p === SYSTEM_PROMPT_FULL || p === SYSTEM_PROMPT_FULL_LEGACY_MEMORY, "pre-rule bytes exactly");
  });
});

Deno.test("intermediate steps: the per-cycle directive ends with the rule (mid-run drift is where it happened)", async () => {
  await withSwitch(undefined, () => {
    const d = buildPerCycleCompactDirective();
    assert(d.endsWith(RESPONSE_LANGUAGE_RULE), "the rule is the directive's tail");
    assertStringIncludes(d, "PER-CYCLE OUTPUT: COMPACT ONLY"); // the directive itself is intact
  });
  await withSwitch("true", () => {
    assertFalse(buildPerCycleCompactDirective().includes("OUTPUT LANGUAGE"));
  });
});

Deno.test("health: self-test shape and the proof key is registered", async () => {
  await withSwitch(undefined, () => {
    const r = responseLanguageSelfTest();
    assertEquals(r.ok, true);
    assertEquals(r.switch, RESPONSE_LANGUAGE_SWITCH);
    assertStringIncludes(r.detail, "rule ON");
  });
  await withSwitch("true", () => {
    const r = responseLanguageSelfTest();
    assertEquals(r.ok, true);
    assertStringIncludes(r.detail, "LEGACY");
  });
  assertStringIncludes(HEALTH, "r.checks.response_language = responseLanguageSelfTest();");
});
