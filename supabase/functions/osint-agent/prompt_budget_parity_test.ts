import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { runtimeLimits, MAX_PAID_CALLS, MAX_TOTAL_CALLS } from "./runtime-policy.ts";
import { SYSTEM_PROMPT_FULL } from "./system-prompt.ts";

/**
 * The budget line in the system prompt must advertise the ENFORCED limits.
 *
 * `startCall` enforces `runtimeLimits.*`, each of which resolves from an env var
 * and falls back to a compile-time constant. The prompt used to interpolate the
 * CONSTANTS, so it told the truth only while no override was set. Raising
 * MAX_PAID_CALLS_PER_RUN to 40 let the runtime allow 40 while the model was
 * still told it had 12 — so it self-throttled and announced "switching to free
 * tools only now" mid-run. That made the env knob decorative: the paid-call cap
 * could not actually be raised without editing system-prompt.ts.
 *
 * Source-level assertion (like reviews_wiring_test.ts) because SYSTEM_PROMPT is
 * a module-level template literal: it captures its values at import, so an
 * env-override test would need a subprocess to observe the difference.
 */
Deno.test("system prompt interpolates enforced runtime limits, not raw constants", async () => {
  const src = await Deno.readTextFile(new URL("./system-prompt.ts", import.meta.url));

  const budgetLine = src.split("\n").find((l) => l.includes("YOU HAVE A REAL, ENFORCED BUDGET"));
  assert(budgetLine, "budget line not found in system-prompt.ts");

  // The three enforced numbers must come from runtimeLimits-derived bindings.
  for (const binding of ["ENFORCED_TOTAL_CALLS", "ENFORCED_PAID_CALLS", "ENFORCED_SAME_TOOL_CALLS"]) {
    assertStringIncludes(budgetLine, `\${${binding}}`);
  }

  // And those bindings must read runtimeLimits, not the constants.
  assertStringIncludes(src, "const ENFORCED_PAID_CALLS = runtimeLimits.maxPaidCallsPerRun");
  assertStringIncludes(src, "const ENFORCED_TOTAL_CALLS = runtimeLimits.maxTotalToolCallsPerRun");
  assertStringIncludes(src, "const ENFORCED_SAME_TOOL_CALLS = runtimeLimits.maxSameToolCallsPerRun");

  // Regression: the raw constants must not be interpolated into the budget line.
  for (const constant of ["MAX_PAID_CALLS", "MAX_TOTAL_CALLS", "MAX_SAME_TOOL_CALLS"]) {
    assert(
      !budgetLine.includes(`\${${constant}}`),
      `budget line still interpolates the constant ${constant}; an env override would desynchronise the prompt from what startCall enforces`,
    );
  }
});

Deno.test("with no env override the advertised budget still equals the constants", () => {
  // Guards the fallback path: default deployments must be unchanged by the fix.
  if (!Deno.env.get("MAX_PAID_CALLS_PER_RUN")) {
    assertEquals(runtimeLimits.maxPaidCallsPerRun, MAX_PAID_CALLS);
    assertStringIncludes(SYSTEM_PROMPT_FULL, `${MAX_PAID_CALLS} paid`);
  }
  if (!Deno.env.get("MAX_TOTAL_TOOL_CALLS_PER_RUN")) {
    assertEquals(runtimeLimits.maxTotalToolCallsPerRun, MAX_TOTAL_CALLS);
  }
});

Deno.test("the enforced paid cap is a usable number, not NaN or Infinity", () => {
  // envNumber() returning NaN from a malformed env value would disable the cap
  // silently, since `state.paidCalls >= NaN` is always false.
  const paid = runtimeLimits.maxPaidCallsPerRun;
  assert(!Number.isNaN(paid), "maxPaidCallsPerRun is NaN — the cap would never trigger");
  assert(paid > 0, "maxPaidCallsPerRun must be positive");
});
