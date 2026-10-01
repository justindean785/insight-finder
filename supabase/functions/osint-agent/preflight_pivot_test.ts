// Gate on the preflight pivot to gemini-direct (lib/preflight-pivot.ts).
//
// Measured 2026-09-24: gemini-direct finished 0 of 16 runs it was pivoted onto
// (15 "Bad Request", 1 "Too Many Requests", all at step 0). A failed DeepSeek
// preflight now keeps DeepSeek unless GEMINI_PREFLIGHT_PIVOT_ENABLED=true.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  GEMINI_PREFLIGHT_PIVOT_ENV,
  geminiPreflightPivotEnabled,
  preflightPivotHealthDetail,
  shouldPivotOnPreflight,
} from "./lib/preflight-pivot.ts";

const GEMINI = { provider: "gemini-direct" };
const LOVABLE = { provider: "lovable-gateway" };

Deno.test("preflight pivot: a 4xx/5xx preflight does NOT pivot to gemini-direct by default", () => {
  for (const status of [400, 401, 404, 429, 500, 503]) {
    assertEquals(shouldPivotOnPreflight({ ok: false, status }, GEMINI, false), false, `status ${status}`);
  }
});

Deno.test("preflight pivot: the operator switch restores the gemini-direct pivot", () => {
  assertEquals(shouldPivotOnPreflight({ ok: false, status: 429 }, GEMINI, true), true);
});

Deno.test("preflight pivot: the Lovable-gateway target is unchanged (still pivots on an explicit failure)", () => {
  assertEquals(shouldPivotOnPreflight({ ok: false, status: 503 }, LOVABLE, false), true);
});

Deno.test("preflight pivot: the ambiguity policy is unchanged — ok, a timeout, or no target never pivot", () => {
  assertEquals(shouldPivotOnPreflight({ ok: true, status: 200 }, GEMINI, true), false);
  assertEquals(shouldPivotOnPreflight({ ok: false, status: 0 }, GEMINI, true), false);
  assertEquals(shouldPivotOnPreflight({ ok: false, status: 0 }, LOVABLE, true), false);
  assertEquals(shouldPivotOnPreflight({ ok: false, status: 500 }, null, true), false);
});

Deno.test("preflight pivot: the switch is read from env, default OFF, only an explicit 'true' enables it", () => {
  const env = (v: string | undefined) => (k: string) => (k === GEMINI_PREFLIGHT_PIVOT_ENV ? v : undefined);
  assertEquals(geminiPreflightPivotEnabled(env(undefined)), false);
  assertEquals(geminiPreflightPivotEnabled(env("")), false);
  assertEquals(geminiPreflightPivotEnabled(env("1")), false);
  assertEquals(geminiPreflightPivotEnabled(env("false")), false);
  assertEquals(geminiPreflightPivotEnabled(env(" TRUE ")), true);
});

Deno.test("preflight pivot: the /health detail names the setting in force", () => {
  assertStringIncludes(preflightPivotHealthDetail(false), "keeps the primary");
  assertStringIncludes(preflightPivotHealthDetail(true), GEMINI_PREFLIGHT_PIVOT_ENV);
});

Deno.test("wiring: the DeepSeek preflight decides through shouldPivotOnPreflight, never a bare status check", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assert(
    src.includes("if (shouldPivotOnPreflight(lastDeepseekProbe, fallbackTarget, geminiPreflightPivotEnabled())) {"),
    "the preflight pivot must go through the gate",
  );
  assert(
    !/lastDeepseekProbe\.status >= 400\)\s*\{\s*useFallback = true/.test(src),
    "no ungated `status >= 400 → useFallback = true` may remain",
  );
  assert(src.includes('event: "preflight_pivot_suppressed"'), "a suppressed pivot must be logged, not silent");
});

Deno.test("wiring: /health reports checks.preflight_pivot from the same switch", async () => {
  const src = await Deno.readTextFile(new URL("./health-handler.ts", import.meta.url));
  assert(
    src.includes("r.checks.preflight_pivot = { ok: true, detail: preflightPivotHealthDetail(geminiPreflightPivotEnabled()) };"),
    "the proof key must be reported from the call-time switch",
  );
});
