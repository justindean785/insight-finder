// lib/response-language.ts — the orchestrator writes in ENGLISH, always.
//
// WHY. Nothing in the prompt ever named an output language. The seed is a selector
// (an email, a handle), which has no language, and on 2026-10-31 a GLM-5.2 run on
// production drifted into Chinese after its second step and wrote the entire closing
// report in Chinese (case 5663c718). Tool output, recalled memory and earlier
// assistant turns are all legitimate inputs in any language, so the rule has to be
// explicit, and it has to be present on EVERY intermediate step (the drift happened
// mid-run, not at the start) as well as in the cached base prompt (finalize/report).
//
// The rule also covers prose the model writes INTO tool arguments (record_finding
// text, memory_save content): a lesson saved in Chinese today is recalled tomorrow
// and seeds the next drift. Evidence VALUES are data and are never translated.
//
// Kill switch RESPONSE_LANGUAGE_RULE_DISABLED=true (read at call time, no deploy)
// restores the exact pre-rule prompt bytes. The switch ships OFF (rule ON).

type EnvReader = (k: string) => string | undefined;

function readEnvSafe(k: string): string | undefined {
  try {
    return (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get(k);
  } catch {
    return undefined;
  }
}

export const RESPONSE_LANGUAGE_SWITCH = "RESPONSE_LANGUAGE_RULE_DISABLED";

export function responseLanguageRuleDisabled(env: EnvReader = readEnvSafe): boolean {
  return (env(RESPONSE_LANGUAGE_SWITCH) ?? "").trim().toLowerCase() === "true";
}

/** The rule text. One block, four lines, so the base prompt budget barely moves. */
export const RESPONSE_LANGUAGE_RULE = [
  "",
  "=== OUTPUT LANGUAGE: ENGLISH ===",
  "Write ALL narration, status lines, finding lines, report sections, and any prose you put into tool arguments (record_finding text, memory_save content) in English — regardless of the language of the seed, tool output, recalled memory, or earlier assistant turns.",
  "Non-English evidence VALUES (names, handles, breach fields, quoted page text) are data: quote them verbatim inside English sentences, never translate them.",
  "Never switch the language of your narration mid-run.",
].join("\n");

/** The block to append to a prompt, or "" when the switch is on. */
export function responseLanguageBlock(env: EnvReader = readEnvSafe): string {
  return responseLanguageRuleDisabled(env) ? "" : RESPONSE_LANGUAGE_RULE;
}

/** /health probe. Pure. PRESENCE proves the deployed bundle carries the rule module. */
export function responseLanguageSelfTest(): { ok: boolean; switch: string; detail: string } {
  if (responseLanguageRuleDisabled()) {
    return { ok: true, switch: RESPONSE_LANGUAGE_SWITCH, detail: `LEGACY via ${RESPONSE_LANGUAGE_SWITCH}: no output-language rule in the prompt` };
  }
  const block = responseLanguageBlock(() => undefined);
  const ok = block.includes("OUTPUT LANGUAGE: ENGLISH") && block.includes("memory_save") && block.includes("never translate") &&
    responseLanguageBlock(() => "true") === "";
  return { ok, switch: RESPONSE_LANGUAGE_SWITCH, detail: ok ? `rule ON (${block.length} chars; base prompt + every intermediate step)` : "probe failed" };
}
