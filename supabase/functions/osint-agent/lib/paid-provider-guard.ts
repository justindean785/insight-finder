// lib/paid-provider-guard.ts — free-first admission for paid web-data providers.
//
// WHY. Paid scrapers and social-data APIs (Context.dev, SocQ) exist to fill the gap
// where a FREE tool cannot answer: a page that 403s the free reader, a walled-garden
// profile behind a login. Calling them before any free tool has tried pays for data a
// free tool would have returned. This module decides, per paid call, whether a free
// tool has already tried the same selector in this case and come back empty or
// failed — and refuses the call, uncharged, when none has.
//
// WHAT IT IS NOT.
//   • Not a dedup layer. A repeated paid call is already served free by the three
//     cache layers in cache.ts (thread LRU, user tool_call_cache by input hash, and
//     thread-scoped selector reuse that ignores annotation keys). Those run BEFORE
//     this gate, so a cache hit is never refused.
//   • Not an authorization boundary. It is a cost control, so it FAILS OPEN on an
//     unreadable history (the in-run attempts still count), like the dead-target
//     loader it shares a read with.
//
// POLICY SHAPE. Each guarded tool registers which free tools may "clear" it and on
// which outcomes. A paid call is admitted when ANY rule matches an attempt on the
// same normalized selector (tool + type:value — never value alone, the same keying
// rule as the dispatch boundaries). The selector of both the paid call and the free
// attempts is computed by cache.ts with one function, so they agree by construction.
//
// OVERRIDE. `force_second_source: true` with a written `second_source_justification`
// admits the call regardless (a deliberate second source for a lead), and the
// justification is logged in tool_usage_log.input_json.runtime. A bare
// `force_second_source` without a justification is refused.
//
// REFUSAL VOCABULARY. A refusal is a governance SKIP, exactly like the dead-target and
// Opsis guards beside it: `ok:false`, `skipped:true`, `provider_attempted:false`, a
// constant `error` whose head ("paid guard:") is in tool-outcome.ts SKIP_RE, so the row
// logs `skipped`, charges 0 and never trips the provider's circuit breaker for a call
// that was never made. The model still reads `ok:false` and a `try_first` list.
//
// SWITCHES, read at CALL TIME:
//   PAID_PROVIDER_GUARD_DISABLED=true — admit every paid call (no decision made).
//   PAID_PROVIDER_GUARD_DRY_RUN=true  — decide and log `paid_guard_shadow_refusal`,
//                                       but admit. For measuring before enforcing.
//
// Zero imports on purpose: pure, so /health can self-test it.

export const PAID_GUARD_DISABLED_ENV = "PAID_PROVIDER_GUARD_DISABLED";
export const PAID_GUARD_DRY_RUN_ENV = "PAID_PROVIDER_GUARD_DRY_RUN";

/** Constant refusal head. `paid guard:` is in tool-outcome.ts SKIP_RE. */
export const PAID_GUARD_ERROR_PREFIX = "paid guard:";
export const PAID_GUARD_REFUSAL_MARKER = "paid_guard_free_first";

/** A justification shorter than this is not a justification. */
export const MIN_JUSTIFICATION_CHARS = 12;
/** Logged justification cap — it is model-written text going into telemetry. */
export const MAX_LOGGED_JUSTIFICATION_CHARS = 200;

/** Outcomes of a free attempt that show the free tool could not answer. */
export type AttemptOutcome = "ok" | "empty" | "failed" | "skipped";

export interface PaidGuardRule {
  /** Free tools whose attempt on the same selector can clear the paid call. */
  tools: readonly string[];
  /** Which outcomes of those attempts count. */
  outcomes: readonly AttemptOutcome[];
  /** Short label for the admission log, e.g. "free_reader_blocked". */
  label: string;
}

export interface PaidGuardPolicy {
  provider: string;
  rules: readonly PaidGuardRule[];
  /** Named in the refusal so the model knows what to run first. */
  tryFirst: readonly string[];
}

/** One attempt in this case: the tool, its normalized selector (type:value), the outcome. */
export interface Attempt {
  tool: string;
  selector: string;
  outcome: string;
}

/**
 * Guarded tools. Empty in this module's first build on purpose: the guard ships, is
 * self-tested and wired, and changes nothing until a provider registers a policy in
 * its own PR. Mutable so a provider module (and a test) can register.
 */
export const PAID_GUARD_POLICIES = new Map<string, PaidGuardPolicy>();

export function registerPaidGuardPolicy(tool: string, policy: PaidGuardPolicy): void {
  PAID_GUARD_POLICIES.set(tool, policy);
}

export function paidGuardDisabled(env: (k: string) => string | undefined = (k) => Deno.env.get(k)): boolean {
  return (env(PAID_GUARD_DISABLED_ENV) ?? "").trim().toLowerCase() === "true";
}

export function paidGuardDryRun(env: (k: string) => string | undefined = (k) => Deno.env.get(k)): boolean {
  return (env(PAID_GUARD_DRY_RUN_ENV) ?? "").trim().toLowerCase() === "true";
}

export type PaidGuardDecision =
  | { allow: true; admitted_by: "free_attempt"; rule: string; cleared_by: string }
  | { allow: true; admitted_by: "force_second_source"; justification: string }
  | { allow: false; reason: "free_first" | "justification_required" | "no_selector" };

function justificationOf(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

/**
 * Decide one paid call. Pure.
 *
 * `selector` is the paid call's normalized selector; an empty one is refused, since
 * nothing could have been tried on it. `attempts` are this case's attempts (prior
 * turns from tool_usage_log plus this run's live ones), keyed the same way.
 */
export function decidePaidCall(input: {
  policy: PaidGuardPolicy;
  selector: string;
  attempts: readonly Attempt[];
  forceSecondSource?: unknown;
  justification?: unknown;
}): PaidGuardDecision {
  if (input.forceSecondSource === true) {
    const why = justificationOf(input.justification);
    if (why.length < MIN_JUSTIFICATION_CHARS) return { allow: false, reason: "justification_required" };
    return { allow: true, admitted_by: "force_second_source", justification: why.slice(0, MAX_LOGGED_JUSTIFICATION_CHARS) };
  }
  if (!input.selector) return { allow: false, reason: "no_selector" };
  for (const rule of input.policy.rules) {
    const hit = input.attempts.find((a) =>
      a.selector === input.selector && rule.tools.includes(a.tool) &&
      (rule.outcomes as readonly string[]).includes(a.outcome)
    );
    if (hit) return { allow: true, admitted_by: "free_attempt", rule: rule.label, cleared_by: hit.tool };
  }
  return { allow: false, reason: "free_first" };
}

const REFUSAL_NOTE: Record<"free_first" | "justification_required" | "no_selector", string> = {
  free_first: "No free tool has tried this selector yet in this case. Run one of try_first; if it comes back empty or blocked, this paid call is admitted.",
  justification_required: "force_second_source needs a second_source_justification (why a paid second source is worth it).",
  no_selector: "This paid call names no selector (e.g. a free-text search), so nothing can have been tried first. Run it only with force_second_source and a second_source_justification.",
};

/** The refusal envelope the model reads. Constant `error`; never echoes caller text. */
export function paidGuardRefusal(
  tool: string,
  policy: PaidGuardPolicy,
  reason: "free_first" | "justification_required" | "no_selector",
) {
  return {
    ok: false as const,
    skipped: true as const,
    provider_attempted: false as const,
    refused_by: PAID_GUARD_REFUSAL_MARKER,
    paid_guard: reason,
    provider: policy.provider,
    try_first: [...policy.tryFirst],
    reason: REFUSAL_NOTE[reason],
    error: `${PAID_GUARD_ERROR_PREFIX} ${reason} — ${tool} not called, no credit spent`,
  };
}

/** /health → `checks.paid_provider_guard`. Synthetic selectors only. */
export function paidProviderGuardSelfTest(
  disabled = paidGuardDisabled(),
  dryRun = paidGuardDryRun(),
): { ok: boolean; switch: string; mode: string; guarded_tools: number; detail: string } {
  const policy: PaidGuardPolicy = {
    provider: "selftest",
    rules: [{ tools: ["free_reader"], outcomes: ["failed", "empty"], label: "free_reader_blocked" }],
    tryFirst: ["free_reader"],
  };
  const sel = "url:https://example.com/a";
  const none = decidePaidCall({ policy, selector: sel, attempts: [] });
  const okAttempt = decidePaidCall({ policy, selector: sel, attempts: [{ tool: "free_reader", selector: sel, outcome: "ok" }] });
  const blocked = decidePaidCall({ policy, selector: sel, attempts: [{ tool: "free_reader", selector: sel, outcome: "failed" }] });
  const otherSel = decidePaidCall({
    policy,
    selector: sel,
    attempts: [{ tool: "free_reader", selector: "url:https://example.com/b", outcome: "failed" }],
  });
  const bareForce = decidePaidCall({ policy, selector: sel, attempts: [], forceSecondSource: true });
  const forced = decidePaidCall({
    policy, selector: sel, attempts: [], forceSecondSource: true, justification: "corroborating an unverified lead",
  });
  const refusal = paidGuardRefusal("selftest_tool", policy, "free_first");
  const ok = !none.allow && !okAttempt.allow && blocked.allow && !otherSel.allow && !bareForce.allow && forced.allow &&
    refusal.error.startsWith(PAID_GUARD_ERROR_PREFIX) && refusal.provider_attempted === false;
  const mode = disabled ? "disabled" : dryRun ? "dry_run" : "enforcing";
  return {
    ok,
    switch: `${PAID_GUARD_DISABLED_ENV}=${disabled}; ${PAID_GUARD_DRY_RUN_ENV}=${dryRun}`,
    mode,
    guarded_tools: PAID_GUARD_POLICIES.size,
    detail: ok
      ? "a paid web-data call is admitted only after a free tool tried the same selector in this case and came back empty or failed, or with force_second_source + a written justification; a refusal is an uncharged skip that names what to try first"
      : "paid provider guard misbehaving on its own probe",
  };
}
