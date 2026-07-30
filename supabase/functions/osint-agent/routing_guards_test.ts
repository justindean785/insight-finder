// routing_guards_test.ts — pins the two known-wrong automatic routes fixed in
// the "disable known-wrong routes" pass. Both were silent failures: neither
// surfaced an error the model or the analyst could react to.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { normalizeSocialPlatform } from "./tool-registry.ts";
import { SYSTEM_PROMPT_FULL } from "./system-prompt.ts";
import { MAX_TOTAL_CALLS, MAX_PAID_CALLS } from "./runtime-policy.ts";

// ---------------------------------------------------------------------------
// 1. SocialFetch platform aliasing.
//
// SUPPORTED is keyed 'twitter', but the site is named X. A model passing the
// site's real name hit the unsupported no-op and the corroborated handle was
// never fetched — a silent miss that burned the step.
// ---------------------------------------------------------------------------
const SUPPORTED = new Set(["tiktok", "instagram", "twitter", "facebook"]);

Deno.test("normalizeSocialPlatform: X spellings all resolve to the twitter route", () => {
  for (const spelling of ["x", "X", " x ", "x.com", "X.com", "https://x.com", "https://www.x.com/someone", "twitter", "twitter.com"]) {
    assertEquals(normalizeSocialPlatform(spelling), "twitter", `${spelling} must reach the twitter route`);
    assert(SUPPORTED.has(normalizeSocialPlatform(spelling)), `${spelling} must be SUPPORTED`);
  }
});

Deno.test("normalizeSocialPlatform: host and short forms of the other three platforms resolve", () => {
  const cases: Array<[string, string]> = [
    ["instagram.com", "instagram"], ["https://www.instagram.com/someone", "instagram"], ["ig", "instagram"],
    ["tiktok.com", "tiktok"], ["TikTok", "tiktok"], ["tt", "tiktok"],
    ["facebook.com", "facebook"], ["fb", "facebook"], ["FB.com", "facebook"],
  ];
  for (const [input, expected] of cases) {
    assertEquals(normalizeSocialPlatform(input), expected, `${input} → ${expected}`);
    assert(SUPPORTED.has(normalizeSocialPlatform(input)));
  }
});

Deno.test("normalizeSocialPlatform: UNSUPPORTED hosts must still fall through to the no-op", () => {
  // The whole point of the no-op is to redirect these to socialfetch_web_read,
  // which fetches server-side. Aliasing one of them onto a supported key would
  // send it to a profile route that does not exist for it.
  for (const blocked of ["youtube", "youtube.com", "reddit", "twitch", "linkedin", "soundcloud", "ko-fi.com", "example.com"]) {
    assert(!SUPPORTED.has(normalizeSocialPlatform(blocked)), `${blocked} must NOT be treated as a SocialFetch profile platform`);
  }
});

Deno.test("normalizeSocialPlatform: junk input degrades to a harmless unsupported value", () => {
  for (const junk of ["", "   ", null, undefined, 42, {}]) {
    const out = normalizeSocialPlatform(junk as unknown);
    assertEquals(typeof out, "string");
    assert(!SUPPORTED.has(out), "junk must never resolve to a supported platform");
  }
});

// ---------------------------------------------------------------------------
// 2. The prompt must not contradict the runtime it describes.
//
// The prompt stated the enforced budget AND, six lines later, that "there is no
// paid-call budget to ration; investigation depth is unlimited". The runtime
// really does refuse past MAX_PAID_CALLS, so the model was told both that its
// budget was real and that it did not exist.
// ---------------------------------------------------------------------------
Deno.test("system prompt: states the real enforced budget", () => {
  assertStringIncludes(SYSTEM_PROMPT_FULL, `${MAX_TOTAL_CALLS} total tool calls`);
  assertStringIncludes(SYSTEM_PROMPT_FULL, `${MAX_PAID_CALLS} paid`);
});

Deno.test("system prompt: never denies the paid-call budget it enforces", () => {
  const denials = [
    /no paid-call budget/i,
    /investigation depth is unlimited/i,
    /there is no .{0,20}budget to ration/i,
  ];
  for (const pattern of denials) {
    assert(
      !pattern.test(SYSTEM_PROMPT_FULL),
      `system prompt contradicts the enforced budget (matched ${pattern}). The runtime refuses past MAX_PAID_CALLS=${MAX_PAID_CALLS}; telling the model otherwise produces "switching to free tools only now" mid-run.`,
    );
  }
});

Deno.test("system prompt: still asserts that confirmation status never gates execution", () => {
  // The corrected sentence must keep its original purpose. Losing this would
  // re-open the older failure where the model refused to pivot on an
  // uncorroborated lead because it read a reporting label as a stop sign.
  assert(
    /never one of them|never gates execution|no reporting label/i.test(SYSTEM_PROMPT_FULL),
    "the anti-gating guarantee must survive the budget correction",
  );
});
