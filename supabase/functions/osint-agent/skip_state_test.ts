import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { tagSkipState, isIntentionalSkip } from "./cache.ts";

// tagSkipState bridges backend self-skips to the UI tool-status taxonomy
// (src/lib/tool-run.ts → deriveToolStatus), which renders "skipped" off
// output.skipped === true. The only self-skip class that lacked a flag (and
// matched no UI reason-regex) was a missing-key bail: { error: "X_API_KEY not
// configured" }. tagSkipState tags exactly that, without disturbing anything else.

Deno.test("tagSkipState: missing-key bail (bare error) → skipped", () => {
  const out = tagSkipState({ error: "SYNAPSINT_API_KEY not configured" }) as Record<string, unknown>;
  assertEquals(out.skipped, true);
});

Deno.test("tagSkipState: missing-key bail reported via `note` (exa-style, ok:false) → skipped", () => {
  const out = tagSkipState({ ok: false, status: 0, urls: [], note: "EXA_API_KEY not configured" }) as Record<string, unknown>;
  assertEquals(out.skipped, true);
});

Deno.test("tagSkipState: genuine provider failure is NOT marked skipped", () => {
  const out = tagSkipState({ ok: false, error: "HTTP 500 from upstream provider" }) as Record<string, unknown>;
  assertEquals(out.skipped, undefined);
});

Deno.test("tagSkipState: a real success is left untouched", () => {
  const out = tagSkipState({ ok: true, data: { hits: 3 } }) as Record<string, unknown>;
  assertEquals(out.skipped, undefined);
});

Deno.test("tagSkipState: existing skip/gate/degrade flags are not overwritten", () => {
  // gated wins even if the text also says "not configured" — respect the
  // tool's own classification (e.g. intelbase gate).
  const gated = tagSkipState({ ok: false, gated: true, error: "INTELBASE not configured" }) as Record<string, unknown>;
  assertEquals(gated.gated, true);
  assertEquals(gated.skipped, undefined);

  const degraded = tagSkipState({ ok: false, degraded: true, error: "provider not configured" }) as Record<string, unknown>;
  assertEquals(degraded.degraded, true);
  assertEquals(degraded.skipped, undefined);
});

Deno.test("tagSkipState: idempotent on an already-skipped result", () => {
  const once = tagSkipState({ ok: false, skipped: true, reason: "skipped: guard not met" }) as Record<string, unknown>;
  const twice = tagSkipState(once) as Record<string, unknown>;
  assertEquals(twice.skipped, true);
  assertEquals(twice.reason, "skipped: guard not met");
});

Deno.test("tagSkipState: non-object inputs pass through unchanged", () => {
  assertEquals(tagSkipState("plain string"), "plain string");
  assertEquals(tagSkipState(null), null);
  assertEquals(tagSkipState(undefined), undefined);
  assert(Array.isArray(tagSkipState([1, 2, 3])));
});

// --- isIntentionalSkip: shared classification used by deriveOk (the logged ok
// flag) AND tagSkipState. 2026-06-27 audit: intentional skips were being counted
// as failures in tool_usage_log, inflating the beta failure-rate dashboard.

Deno.test("isIntentionalSkip: missing-key bail → true (not a failure)", () => {
  assert(isIntentionalSkip({ error: "IPQUALITYSCORE_API_KEY not configured" }));
  assert(isIntentionalSkip({ ok: false, note: "EXA_API_KEY not configured" }));
});

Deno.test("isIntentionalSkip: provider disabled in config → true (synapsint 7/7 case)", () => {
  assert(isIntentionalSkip({ ok: false, error: "unavailable: disabled (provider disabled in config)" }));
  assert(isIntentionalSkip({ reason: "provider disabled in config" }));
});

Deno.test("isIntentionalSkip: capability missing_key gate → true", () => {
  assert(isIntentionalSkip({ ok: false, reason: "unavailable: missing_key (DEEPFIND_API_KEY not set)" }));
});

Deno.test("isIntentionalSkip: explicit skipped flag → true", () => {
  assert(isIntentionalSkip({ ok: false, skipped: true, reason: "bosint_phone_timeout" }));
});

Deno.test("isIntentionalSkip: genuine errors → false (stay in failure metric)", () => {
  assertEquals(isIntentionalSkip({ ok: false, error: "HTTP 502 from upstream" }), false);
  assertEquals(isIntentionalSkip({ ok: false, status: 400, error: "bad request" }), false);
  assertEquals(isIntentionalSkip({ ok: true, data: {} }), false);
  assertEquals(isIntentionalSkip("nope"), false);
  assertEquals(isIntentionalSkip(null), false);
});

Deno.test("tagSkipState: provider-disabled now reads as skipped (broadened)", () => {
  const out = tagSkipState({ ok: false, error: "unavailable: disabled (provider disabled in config)" }) as Record<string, unknown>;
  assertEquals(out.skipped, true);
});
