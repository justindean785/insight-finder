const NAME_FIRST_TOOLS = new Set([
  "exa_search",
  "minimax_web_search",
  "google_dorks",
  "dork_harvest",
]);

const USERNAME_SWEEP_TOOLS = new Set([
  "username_sweep",
  "username_search",
]);

export const NAME_SEED_PLANNER_RULES = `
NAME/PERSON SEED ORDERING:
- Lead with real-name discovery: exa_search, minimax_web_search, google_dorks, and dork_harvest.
- Always rank username_sweep or username_search below unresolved real-name search.
- A handle derived from a person's name is a weak candidate, not an identity match. Label sweep hits [VERIFY] until independently corroborated.
`.trim();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolName(call: Record<string, unknown>): string {
  const value = call.tool_name ?? call.tool;
  return typeof value === "string" ? value : "";
}

function expectedValue(call: Record<string, unknown>): number {
  const value = call.expected_value;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function pivotPriority(call: Record<string, unknown>): number {
  const value = call.priority;
  return typeof value === "number" && Number.isFinite(value) ? value : 99;
}

// Known non-name seed identifiers. For these, name-first ordering would be
// wrong, so the plan is returned untouched. ANY other value — "name", "person",
// "unknown", "", null — gets the conservative name-safe treatment below: a
// misclassified person seed must still have its guessed handles labeled
// [VERIFY], never silently promoted. This is labeling/ranking only; it never
// drops or blocks a call.
const NON_NAME_SEEDS = new Set([
  "email", "username", "handle", "phone", "ip", "ip_address",
  "domain", "url", "wallet", "crypto", "crypto_wallet",
]);

export function enforceNameSeedPriority(
  rawPlan: Record<string, unknown>,
  context: {
    seedType: string | null | undefined;
    alreadyQueried: string[];
  },
): Record<string, unknown> {
  const seedType = (context.seedType ?? "").toLowerCase();
  if (NON_NAME_SEEDS.has(seedType)) return rawPlan;

  const nameSearchComplete = context.alreadyQueried.some((entry) => {
    const normalized = entry.toLowerCase();
    return [...NAME_FIRST_TOOLS].some((name) => normalized.includes(name));
  });

  // Preserve every entry. Non-object ("malformed") entries are passed through
  // untouched rather than dropped — a planner-proposed call is never silently
  // lost. Only object entries that are guessed-handle sweeps get re-labeled.
  const labelValue = (call: unknown) => {
    if (!isRecord(call) || !USERNAME_SWEEP_TOOLS.has(toolName(call))) return call;
    return {
      ...call,
      expected_value: Math.min(expectedValue(call), nameSearchComplete ? 55 : 45),
      reason: `[VERIFY] Secondary guessed-handle pivot. ${String(call.reason ?? "")}`.trim(),
    };
  };
  const labelPriority = (call: unknown) => {
    if (!isRecord(call) || !USERNAME_SWEEP_TOOLS.has(toolName(call))) return call;
    return {
      ...call,
      priority: Math.max(pivotPriority(call), nameSearchComplete ? 6 : 8),
      reason: `[VERIFY] Secondary guessed-handle pivot. ${String(call.reason ?? "")}`.trim(),
    };
  };

  // Records sort by name-first then value/priority; non-records keep their
  // relative position at the end (no orderable fields, but still retained).
  const nameRank = (call: unknown) => (isRecord(call) && NAME_FIRST_TOOLS.has(toolName(call)) ? 1 : 0);
  const byValue = (a: unknown, b: unknown) => {
    if (!isRecord(a) || !isRecord(b)) return Number(isRecord(b)) - Number(isRecord(a));
    if (nameRank(a) !== nameRank(b)) return nameRank(b) - nameRank(a);
    return expectedValue(b) - expectedValue(a);
  };
  const byPriority = (a: unknown, b: unknown) => {
    if (!isRecord(a) || !isRecord(b)) return Number(isRecord(b)) - Number(isRecord(a));
    if (nameRank(a) !== nameRank(b)) return nameRank(b) - nameRank(a);
    return pivotPriority(a) - pivotPriority(b);
  };

  const proposed = Array.isArray(rawPlan.proposed_calls)
    ? [...rawPlan.proposed_calls].map(labelValue).sort(byValue)
    : undefined;
  const pivots = Array.isArray(rawPlan.pivots)
    ? [...rawPlan.pivots].map(labelPriority).sort(byPriority)
    : undefined;

  return {
    ...rawPlan,
    ...(proposed ? { proposed_calls: proposed } : {}),
    ...(pivots ? { pivots } : {}),
  };
}
