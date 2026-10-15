/**
 * system_prompt_reveal_policy_test.ts — the prompt must state the SAME breach-value
 * policy the tool layer enforces, in both directions.
 *
 * WHY THIS FILE EXISTS. `trimStealerItems` / `trimVictimItems` gate on
 * REVEAL_BREACH_DATA and, when it is on, hand the model unmasked passwords, hashes
 * and DOBs. The prompt used to carry an UNCONDITIONAL hard stop:
 *
 *     "Credential masking: … NEVER paste full plaintext credentials into chat
 *      replies or report tables — refer to them as (masked, N chars, source X)."
 *
 * So on a reveal-ON account the values arrived and the model was instructed to
 * discard them. The artifacts came back holding exposed-field CLASSES ("Email",
 * "Password") and no concrete content, and nothing logged a loss — from the
 * recorder's side nothing WAS lost, the model just never wrote them. Source and
 * CI both looked fine the whole time. These tests pin the two halves together so
 * the prompt can never again instruct the opposite of what the code does.
 *
 * Two invariants are asserted in BOTH modes, because they are not reveal's to
 * decide: the possible-minor hard stop, and this system's own auth secrets.
 */
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildBreachRevealDirective,
  buildCredentialSafetyRail,
  buildSystemPrompt,
  buildSystemPromptFull,
  SYSTEM_PROMPT_FULL,
} from "../../functions/osint-agent/system-prompt.ts";
import { REVEAL_BREACH_DATA } from "../../functions/osint-agent/env.ts";

const ON = buildSystemPromptFull(true);
const OFF = buildSystemPromptFull(false);

/**
 * The masking INSTRUCTION — the directive to substitute a placeholder for every
 * credential. Matching the bare substring "(masked, N chars" would be wrong: the
 * reveal-ON rail quotes that placeholder in order to FORBID it ("Do NOT write
 * (masked, N chars) about a value that actually came back"), and a test that
 * cannot tell an instruction from its own negation would force that warning out
 * of the prompt.
 */
const MASK_INSTRUCTION = /refer to them as "\(masked, N chars, source X\)"/;
const FORBID_PLAINTEXT = /NEVER paste full plaintext credentials/i;

Deno.test("reveal ON: the prompt orders concrete values recorded, not masked", () => {
  const rail = buildCredentialSafetyRail(true);
  assertStringIncludes(rail, "REVEAL IS ON");
  assertStringIncludes(rail, "artifact metadata");
  assert(
    /print the real values/i.test(rail),
    "reveal-ON rail must tell the model to print real values in chat and report tables",
  );
  assert(
    !MASK_INSTRUCTION.test(rail),
    'reveal-ON rail must NOT instruct the model to substitute "(masked, N chars, source X)" — that is the bug this file pins',
  );
  assert(
    !FORBID_PLAINTEXT.test(rail),
    "reveal-ON rail must not forbid the plaintext the tool layer deliberately unmasked",
  );
  // The rail must still warn against the false claim, which is what makes the
  // substring-vs-instruction distinction above load-bearing rather than pedantic.
  assert(
    /Do NOT write "\(masked, N chars\)" about a value that actually came back/.test(rail),
    "reveal-ON rail must explicitly forbid describing a returned value as masked",
  );
});

Deno.test("reveal ON: the unconditional credential-masking hard stop is gone from the whole prompt", () => {
  assert(
    !MASK_INSTRUCTION.test(ON),
    "the masking instruction must not survive anywhere in the reveal-ON prompt",
  );
  assert(
    !FORBID_PLAINTEXT.test(ON),
    "the reveal-ON prompt must not forbid pasting the very values the tool layer unmasked",
  );
  // …and it must still be there when reveal is off, or this fix would have
  // removed the rail outright instead of making it follow the policy.
  assert(MASK_INSTRUCTION.test(OFF), "the masking instruction must survive in the reveal-OFF prompt");
  assert(FORBID_PLAINTEXT.test(OFF), "the plaintext prohibition must survive in the reveal-OFF prompt");
});

Deno.test("reveal OFF: masking is restored, verbatim", () => {
  const rail = buildCredentialSafetyRail(false);
  assertStringIncludes(rail, "REVEAL IS OFF");
  assertStringIncludes(rail, "auto-masked at insert");
  assertStringIncludes(rail, "NEVER paste full plaintext credentials into chat replies or report tables");
  assert(MASK_INSTRUCTION.test(rail), "reveal-OFF rail must keep the (masked, N chars, source X) instruction");
});

Deno.test("reveal OFF: the prompt records the exposure without concrete values", () => {
  const directive = buildBreachRevealDirective(false);
  assertStringIncludes(directive, "reveal DISABLED");
  assert(
    /never reconstruct, guess, or infer a masked value/i.test(directive),
    "reveal-OFF directive must forbid reconstructing a masked value",
  );
  assert(
    !/MUST record every concrete value/i.test(directive),
    "reveal-OFF directive must not order concrete values recorded",
  );
});

Deno.test("reveal ON: the serus directive orders every concrete value into metadata", () => {
  const directive = buildBreachRevealDirective(true);
  assertStringIncludes(directive, "AUTHORIZED full breach reveal");
  assertStringIncludes(directive, "MUST record every concrete value returned");
  assert(
    /Do not withhold/i.test(directive),
    "reveal-ON directive must forbid withholding a returned value",
  );
  // The directive is reached through the breach-source policy section, not just
  // exported in isolation — a builder nobody interpolates would pass every
  // assertion above while shipping nothing.
  assertStringIncludes(ON, directive);
  assertStringIncludes(OFF, buildBreachRevealDirective(false));
});

Deno.test("the possible-minor hard stop is unconditional — it survives BOTH modes", () => {
  for (const [mode, prompt] of [["ON", ON], ["OFF", OFF]] as const) {
    assertStringIncludes(prompt, "Minor-safety detection");
    assertStringIncludes(prompt, "metadata.possible_minor=true");
    assertStringIncludes(
      prompt,
      "Possible minor-related signal detected in profile text. Do not expand or expose details without lawful purpose and manual review.",
    );
    assert(
      /STOP further auto-pivots on that account/.test(prompt),
      `minor-safety stop must survive with reveal ${mode}`,
    );
  }
});

Deno.test("this system's own secrets are redacted in BOTH modes", () => {
  for (const reveal of [true, false]) {
    const rail = buildCredentialSafetyRail(reveal);
    assertStringIncludes(rail, "ALWAYS redacted, in BOTH reveal modes");
    for (const token of ["bearer tokens", "session cookies", "private keys", "`Authorization` headers"]) {
      assertStringIncludes(rail, token);
    }
    assert(
      /Never print, record, or echo one/.test(rail),
      `system-secret rail must forbid echoing with reveal ${reveal}`,
    );
  }
});

Deno.test("the HARD STOPS summary line tracks the mode", () => {
  // Reveal ON: credential masking is no longer one of the things that stops a pivot.
  assertStringIncludes(ON, "the HARD STOPS below (minors, this system's own secrets)");
  assertStringIncludes(OFF, "the HARD STOPS below (minors, this system's own secrets, credential masking)");
});

Deno.test("the two modes actually differ, and only in the policy blocks", () => {
  assert(ON !== OFF, "the reveal modes must produce different prompt text");
  // Everything outside the two policy blocks and the hard-stop summary is shared.
  const strip = (s: string) =>
    s
      .replace(buildBreachRevealDirective(true), "<DIRECTIVE>")
      .replace(buildBreachRevealDirective(false), "<DIRECTIVE>")
      .replace(buildCredentialSafetyRail(true), "<RAIL>")
      .replace(buildCredentialSafetyRail(false), "<RAIL>")
      .replace(/the HARD STOPS below \([^)]*\)/, "<HARDSTOPS>");
  assertEquals(
    strip(ON),
    strip(OFF),
    "reveal must change ONLY the breach directive, the credential rail, and the hard-stop summary",
  );
});

Deno.test("the shipped prompt is the builder bound to the deployed flag", () => {
  // Without this, the builders could be correct while production interpolates
  // something else entirely — which is exactly the class of bug being fixed.
  assertEquals(SYSTEM_PROMPT_FULL, buildSystemPromptFull(REVEAL_BREACH_DATA));
  assertEquals(SYSTEM_PROMPT_FULL, REVEAL_BREACH_DATA ? ON : OFF);
});

Deno.test("buildSystemPrompt is pure — repeated calls are byte-identical", () => {
  assertEquals(buildSystemPrompt(true), buildSystemPrompt(true));
  assertEquals(buildSystemPrompt(false), buildSystemPrompt(false));
});

Deno.test("the flag is parsed in exactly ONE place", () => {
  // Two copies of `Deno.env.get("REVEAL_BREACH_DATA") ?? "true"` is how the
  // prompt and the tools drift apart again — one gets a fix, the other doesn't.
  // env.ts must RE-EXPORT the leaf, never re-derive it.
  const envSrc = Deno.readTextFileSync(new URL("../../functions/osint-agent/env.ts", import.meta.url));
  assert(
    /export \{ REVEAL_BREACH_DATA \} from "\.\/reveal-policy\.ts"/.test(envSrc),
    "env.ts must re-export REVEAL_BREACH_DATA from ./reveal-policy.ts, not define its own",
  );
  assert(
    !/REVEAL_BREACH_DATA["']?\s*\)\s*\?\?/.test(envSrc),
    "env.ts must not parse REVEAL_BREACH_DATA itself — that is a second source of truth",
  );
});

Deno.test("system-prompt.ts does not import env.ts", () => {
  // Not style — a build gate. env.ts carries `npm:@ai-sdk/openai-compatible@1`,
  // which Vite cannot resolve, and src/test/runtime-policy.test.ts imports this
  // prompt module. Adding `from "./env.ts"` here fails that suite at COLLECTION
  // time with a transform error that names a vite internal, not this file — an
  // expensive thing to diagnose from the symptom. Import the leaf instead.
  const src = Deno.readTextFileSync(new URL("../../functions/osint-agent/system-prompt.ts", import.meta.url));
  assert(
    !/from\s+"\.\/env\.ts"/.test(src),
    'system-prompt.ts must import REVEAL_BREACH_DATA from "./reveal-policy.ts", never from "./env.ts"',
  );
  assert(
    /from\s+"\.\/reveal-policy\.ts"/.test(src),
    "system-prompt.ts must source the flag from the leaf module",
  );
});
