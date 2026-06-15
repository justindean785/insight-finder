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

export function enforceNameSeedPriority(
  rawPlan: Record<string, unknown>,
  context: {
    seedType: string | null | undefined;
    alreadyQueried: string[];
  },
): Record<string, unknown> {
  const seedType = (context.seedType ?? "").toLowerCase();
  if (seedType !== "name" && seedType !== "person") return rawPlan;

  const nameSearchComplete = context.alreadyQueried.some((entry) => {
    const normalized = entry.toLowerCase();
    return [...NAME_FIRST_TOOLS].some((name) => normalized.includes(name));
  });
  const proposed = Array.isArray(rawPlan.proposed_calls)
    ? rawPlan.proposed_calls.filter(isRecord).map((call) => {
      if (!USERNAME_SWEEP_TOOLS.has(toolName(call))) return call;
      return {
        ...call,
        expected_value: Math.min(expectedValue(call), nameSearchComplete ? 55 : 45),
        reason: `[VERIFY] Secondary guessed-handle pivot. ${String(call.reason ?? "")}`.trim(),
      };
    })
    : [];

  proposed.sort((a, b) => {
    const aNameFirst = NAME_FIRST_TOOLS.has(toolName(a)) ? 1 : 0;
    const bNameFirst = NAME_FIRST_TOOLS.has(toolName(b)) ? 1 : 0;
    if (aNameFirst !== bNameFirst) return bNameFirst - aNameFirst;
    return expectedValue(b) - expectedValue(a);
  });

  const pivots = Array.isArray(rawPlan.pivots)
    ? rawPlan.pivots.filter(isRecord).map((call) => {
      if (!USERNAME_SWEEP_TOOLS.has(toolName(call))) return call;
      return {
        ...call,
        priority: Math.max(pivotPriority(call), nameSearchComplete ? 6 : 8),
        reason: `[VERIFY] Secondary guessed-handle pivot. ${String(call.reason ?? "")}`.trim(),
      };
    })
    : [];

  pivots.sort((a, b) => {
    const aNameFirst = NAME_FIRST_TOOLS.has(toolName(a)) ? 1 : 0;
    const bNameFirst = NAME_FIRST_TOOLS.has(toolName(b)) ? 1 : 0;
    if (aNameFirst !== bNameFirst) return bNameFirst - aNameFirst;
    return pivotPriority(a) - pivotPriority(b);
  });

  return {
    ...rawPlan,
    ...(Array.isArray(rawPlan.proposed_calls) ? { proposed_calls: proposed } : {}),
    ...(Array.isArray(rawPlan.pivots) ? { pivots } : {}),
  };
}
