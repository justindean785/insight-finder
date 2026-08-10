// system_prompt_disabled_tools_test.ts — the SYSTEM PROMPT must not instruct the
// model to call a tool that config has disabled.
//
// THE BUG THIS CLOSES (production, 2026-07-09 -> 2026-08-09):
// `disabled_tools_advertised_test.ts` closed the same defect for the CATALOG and
// the live registry — list_tools now derives its disabled set from
// PROVIDER_REQUIREMENTS, so a disabled tool disappears from the schema. The
// SYSTEM PROMPT was never brought under that contract. It is a static template
// literal with no import of capabilities.ts at all, and it carried:
//
//     "- IMMEDIATELY after `google_dorks`, call `dork_harvest` with the same
//        seed+kind. ... The artifacts it inserts are already saved — do NOT
//        re-record them via record_artifacts."
//
// `dork_harvest` has been `disabled: true` since 2026-07-09. So for eleven months
// the strongest kind of instruction the prompt can give — an IMMEDIATELY /
// MANDATORY directive — pointed at a tool that cannot execute, and the sentence
// went on to tell the model NOT to record what it found, on the strength of a
// save that never happened.
//
// Downstream, `repairUnknownTool` redirects the hallucinated name to
// UNKNOWN_TOOL_SINK, which returns ok:true. So every one of those calls burned a
// step, consumed CPU on a run already under a hard CPU budget, and surfaced in
// the evidence export as "dork_harvest(completed)" — telling an analyst that
// document/leak dorking ran when it never executed. That reaches the
// chain-of-custody record, which is why this is integrity-facing and not merely
// wasteful. The 2026-08-06 zero-artifact run shows exactly this shape: an
// "unknown dork_harvest" warning alongside 0 recorded artifacts and a CPU kill.
//
// THE CONTRACT: a config-disabled tool name may appear in the prompt ONLY inside
// an explicit unavailability disclosure (the pattern `ipqualityscore_lookup`
// already uses correctly — "has been RETIRED (dead key) ... do not attempt it").
// Naming it any other way is an instruction to call it.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { PROVIDER_REQUIREMENTS } from "./capabilities.ts";
import { SYSTEM_PROMPT_FULL } from "./system-prompt.ts";

/** Names config has marked `disabled: true` — derived, never hand-written, so the
 *  next tool disabled in capabilities.ts is covered for free. */
function configDisabledTools(): string[] {
  return Object.entries(PROVIDER_REQUIREMENTS)
    .filter(([, req]) => (req as { disabled?: boolean }).disabled === true)
    .map(([name]) => name);
}

/** A line that tells the model the tool is NOT available. Deliberately narrow:
 *  it must state unavailability, not merely mention the tool in passing. */
const UNAVAILABLE_RE =
  /\b(retired|removed|disabled|deprecated|not currently available|no longer available|do not attempt|is unavailable)\b/i;

function linesMentioning(text: string, tool: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.includes(tool));
}

Deno.test("config-disabled tools are a real, non-empty set (guards a vacuous pass)", () => {
  const disabled = configDisabledTools();
  assert(
    disabled.length > 0,
    "no provider is marked disabled:true — either capabilities.ts changed shape or the " +
      "import broke, and the contract below would pass without testing anything",
  );
});

Deno.test("the system prompt never instructs the model to call a disabled tool", () => {
  const offenders: string[] = [];
  for (const tool of configDisabledTools()) {
    for (const line of linesMentioning(SYSTEM_PROMPT_FULL, tool)) {
      if (UNAVAILABLE_RE.test(line)) continue; // an explicit "not available" disclosure is fine
      offenders.push(`${tool}: ${line.trim().slice(0, 160)}`);
    }
  }
  assertEquals(
    offenders,
    [],
    "the system prompt names a config-disabled tool without disclosing that it is unavailable. " +
      "Either delete the mention or rewrite it as an explicit unavailability notice " +
      `(the ipqualityscore_lookup line is the model to copy). Offenders:\n${offenders.join("\n")}`,
  );
});

Deno.test("dork_harvest specifically is gone as a call directive (the regression that shipped)", () => {
  // Pinned by name because this exact instruction survived two separate audits
  // that both concluded disabled tools were no longer advertised.
  assert(
    !/call\s+\\?`?dork_harvest/i.test(SYSTEM_PROMPT_FULL),
    "the prompt still contains a directive to CALL dork_harvest, which is disabled:true",
  );
  assert(
    !/dork_harvest.*(?:AUTO-RECORD|already saved)/i.test(SYSTEM_PROMPT_FULL),
    "the prompt still claims dork_harvest saves its own artifacts — it cannot run, so " +
      "anything relying on that save is lost",
  );
});

Deno.test("the recording directive still names a tool that DOES auto-record", () => {
  // Guards the opposite failure: stripping dork_harvest must not leave the prompt
  // claiming nothing auto-records, which would push the model to double-record
  // gemini_deep_dork's rows.
  assert(
    SYSTEM_PROMPT_FULL.includes("gemini_deep_dork"),
    "gemini_deep_dork is key-gated, not disabled — it must remain documented as the auto-recording tool",
  );
  assert(
    !configDisabledTools().includes("gemini_deep_dork"),
    "gemini_deep_dork became disabled — the recording directive above now names an uncallable tool",
  );
});

Deno.test("google_dorks is disclosed as NOT auto-recording", () => {
  // The removed dork_harvest sentence was the only place the prompt explained what
  // happens to google_dorks output. Without a replacement the model is left with
  // no instruction to persist document/leak URLs at all — the zero-artifact shape.
  const line = linesMentioning(SYSTEM_PROMPT_FULL, "google_dorks")
    .find((l) => /does NOT record|are LOST unless/i.test(l));
  assert(
    line !== undefined,
    "the prompt must tell the model that google_dorks output is not persisted for it " +
      "and must be recorded via record_artifacts",
  );
});
