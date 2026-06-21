import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { tagSkipState } from "./cache.ts";

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
