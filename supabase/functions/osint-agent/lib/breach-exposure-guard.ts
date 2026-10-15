// breach-exposure-guard.ts — a `breach_exposure` row needs a breach source that actually ran.
//
// THE DEFECT (operator-approved fix, 2026-10-15). `breach_exposure` carries breach-evidence
// authority (it feeds the breach section, the exposure counts and the breach cap), but the KIND
// was whatever the model wrote, and the SOURCE CLASS was derived from the source label the model
// wrote. Nothing checked either against what the run did. Measured:
//   - Caraotta: a Lemon8 post read by `socialfetch_web_read` persisted twice, once as
//     `social_profile` and once as `breach_exposure` at confidence 70.
//   - dizosint: "dizosint - serus_darkweb_scan: 0 breaches, 0 pastes (clean)" at 60 and
//     "Breach exposure: 99.161.169.172 (clean)" at 55 — NEGATIVE results stored as exposures.
//
// THE RULE, checked before persistence on both write paths:
//   1. record_artifacts (model-authored): at least one tool named in the row's source labels must
//      be breach-capable (server classification of the TOOL SLUG, never the model's
//      source_category) AND must have actually run in this thread (tool_usage_log outcome ok or
//      empty). The model naming a breach tool is not enough; the server's log must show it ran.
//   2. a row that reports ZERO hits ("0 breaches", "(clean)", total_breaches = 0) is not an
//      exposure. The empty outcome is already in tool_usage_log and the report's coverage table.
//   3. auto-extraction: a breach_exposure finding is kept only when the extracting tool is
//      breach-capable.
// Unsupported rows are REJECTED with a reason the model can act on (record it under its real
// kind) — legible, never a silent rewrite. Legitimate breach rows are untouched. Nothing
// historical is changed.
//
// KNOWN LIMIT (disclosed, not hidden): rule 1 proves a breach tool ran in this case, not that it
// returned THIS row. A model that cites a breach tool which ran for a different selector still
// passes. Closing that needs call-to-artifact lineage, which this project does not have yet.
//
// KILL SWITCH, read at call time: BREACH_EXPOSURE_GUARD_DISABLED=true restores today's behaviour.
// /health proof key: checks.breach_exposure_guard.

import { classifySource } from "../source-classification.ts";

/** Multi-module tools that run breach checkers but do not classify as `breach` by slug. */
const BREACH_CAPABLE_EXTRA: ReadonlySet<string> = new Set(["opsis_search"]);

export const BREACH_EXPOSURE_KINDS: ReadonlySet<string> = new Set(["breach_exposure"]);

export function breachExposureGuardDisabled(env: (k: string) => string | undefined = readEnv): boolean {
  return (env("BREACH_EXPOSURE_GUARD_DISABLED") ?? "").trim().toLowerCase() === "true";
}

function readEnv(k: string): string | undefined {
  try {
    return Deno.env.get(k);
  } catch {
    return undefined;
  }
}

/** Is this TOOL SLUG one that can produce breach evidence? Server classification only. */
export function isBreachCapableTool(tool: string | null | undefined): boolean {
  const t = (tool ?? "").trim().toLowerCase();
  if (!t) return false;
  return BREACH_CAPABLE_EXTRA.has(t) || classifySource(t) === "breach";
}

/** Tool-slug-shaped tokens named in free-text source labels ("breach_check (stolen.tax/…)"). */
export function toolTokens(labels: readonly string[]): string[] {
  const out = new Set<string>();
  for (const l of labels) {
    for (const tok of String(l).toLowerCase().split(/[^a-z0-9_]+/)) {
      if (tok.length >= 3) out.add(tok);
    }
  }
  return [...out];
}

const ZERO_HIT_VALUE = /\(clean\)|\b0\s+(?:breach(?:es)?|hits?|results?|records?|pastes?)\b|\bno\s+breach(?:es)?\s+found\b/i;

/** Does this row report that nothing was found? Structured counts first, then the value's own wording. */
export function isZeroHitBreachRow(value: string, metadata: Record<string, unknown> | null | undefined): boolean {
  const m = metadata ?? {};
  const counts = ["total_breaches", "breach_count", "hits", "total_hits"]
    .map((k) => m[k])
    .filter((v): v is number => typeof v === "number");
  if (counts.length > 0 && counts.every((n) => n === 0)) {
    const pastes = typeof m.total_pastes === "number" ? m.total_pastes : 0;
    if (pastes === 0) return true;
  }
  return ZERO_HIT_VALUE.test(value);
}

export type BreachGuardVerdict =
  | { ok: true }
  | { ok: false; code: "no_breach_source_ran" | "zero_hit_result"; reason: string };

/** Decide one model-authored breach_exposure row. `ranTools` = tools with an ok/empty outcome in this thread. */
export function checkBreachExposureRow(input: {
  value: string;
  sourceLabels: readonly string[];
  metadata: Record<string, unknown> | null | undefined;
  ranTools: ReadonlySet<string>;
}): BreachGuardVerdict {
  if (isZeroHitBreachRow(input.value, input.metadata)) {
    return {
      ok: false,
      code: "zero_hit_result",
      reason:
        "breach_exposure is for an exposure that was FOUND. This row reports zero hits, which is already recorded as " +
        "the tool's empty result — say it in the report text instead of recording it as breach evidence.",
    };
  }
  const named = toolTokens(input.sourceLabels).filter(isBreachCapableTool);
  const ran = named.filter((t) => input.ranTools.has(t));
  if (ran.length === 0) {
    const cited = input.sourceLabels.join(" | ") || "(no source)";
    return {
      ok: false,
      code: "no_breach_source_ran",
      reason:
        `breach_exposure needs a breach-class tool that actually ran in this case (e.g. breach_check, leakcheck_lookup, ` +
        `oathnet_lookup, serus_darkweb_scan). Source "${cited}" is not one${named.length ? " that ran here" : ""}. ` +
        `Record this item under its real kind (social_profile, weak_lead, …).`,
    };
  }
  return { ok: true };
}

/** Breach-capable tools that ran (ok or empty) in this thread. Fails OPEN to null on a read error. */
export async function loadRanBreachTools(
  // deno-lint-ignore no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  threadId: string,
): Promise<Set<string> | null> {
  try {
    const { data, error } = await db
      .from("tool_usage_log")
      .select("tool_name")
      .eq("thread_id", threadId)
      .in("outcome", ["ok", "empty"])
      .limit(2000);
    if (error) throw error;
    const out = new Set<string>();
    for (const r of (data ?? []) as Array<{ tool_name?: string }>) {
      const t = (r.tool_name ?? "").toLowerCase();
      if (isBreachCapableTool(t)) out.add(t);
    }
    return out;
  } catch (e) {
    console.warn(JSON.stringify({ event: "breach_exposure_guard_read_failed", error: String((e as Error)?.message ?? e) }));
    return null;
  }
}

/** /health → checks.breach_exposure_guard. Pure; presence proves this build. */
export function breachExposureGuardSelfTest(): { ok: boolean; switch: string; detail: string } {
  const sw = "BREACH_EXPOSURE_GUARD_DISABLED";
  if (breachExposureGuardDisabled()) {
    return { ok: true, switch: `${sw}=true`, detail: "LEGACY via BREACH_EXPOSURE_GUARD_DISABLED: breach_exposure rows are not source-checked" };
  }
  const ran = new Set(["breach_check"]);
  const wrong: string[] = [];
  if (!checkBreachExposureRow({ value: "dizosint (breach_check: 1 hit)", sourceLabels: ["breach_check (stolen.tax)"], metadata: {}, ranTools: ran }).ok) {
    wrong.push("a real breach row was rejected");
  }
  if (checkBreachExposureRow({ value: "Lemon8 post #2", sourceLabels: ["socialfetch_web_read"], metadata: {}, ranTools: ran }).ok) {
    wrong.push("a social post passed as breach_exposure");
  }
  if (checkBreachExposureRow({ value: "x", sourceLabels: ["leakcheck_lookup"], metadata: {}, ranTools: ran }).ok) {
    wrong.push("a breach tool that never ran satisfied the guard");
  }
  if (checkBreachExposureRow({ value: "dizosint - serus: 0 breaches, 0 pastes (clean)", sourceLabels: ["breach_check"], metadata: {}, ranTools: ran }).ok) {
    wrong.push("a zero-hit result passed as an exposure");
  }
  return wrong.length
    ? { ok: false, switch: `${sw}=false`, detail: wrong.join("; ") }
    : {
      ok: true,
      switch: `${sw}=false`,
      detail: "breach_exposure needs a breach-class tool that ran in this case and a non-zero result; auto-extraction keeps it only from breach-capable tools",
    };
}
