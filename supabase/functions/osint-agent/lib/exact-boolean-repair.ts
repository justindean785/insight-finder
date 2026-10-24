// lib/exact-boolean-repair.ts — a boolean field sent as the EXACT string "true" / "false" is repaired, nothing else is.
//
// Why. The model sometimes sends a boolean parameter as the string "true"/"false" (serus_darkweb_scan `reveal`,
// exa/include flags, `skip_cache`, …). The AI SDK rejects the call on its input schema BEFORE `execute` runs, the step is
// burnt, and the analyst sees a failed tool for what the model plainly meant. This runs in `experimental_repairToolCall`
// (index.ts), i.e. only for a call that ALREADY failed validation, and only when the failing issue is exactly
// `invalid_type` expected boolean / received string at a path whose value is one of the two lowercase strings. The
// SDK then re-validates the repaired call against the unchanged schema.
//
// What it will NOT do (each pinned by a test):
//   • no coercion beyond the two exact strings — "True", "TRUE", " true", "yes", "1", 1, "on", "" are all left alone;
//   • no consent flags — a path ending in `confirm` (oathnet_victim_archive / oathnet_scanner are MANUAL-CONSENT ONLY)
//     must be a real boolean, so a string never satisfies it;
//   • no change to the schema the model sees, to any tool's `execute`, or to any policy. In particular the effective
//     breach-reveal policy (`reveal || REVEAL_BREACH_DATA` in tools/serus.ts) is untouched: this only lets
//     `reveal:"false"` reach it as `false` instead of being rejected, exactly as a real `false` would;
//   • no repair of a call whose other fields are also invalid — those stay invalid and are reported as before.
//
// Value-free: only field PATHS are ever logged. KILL SWITCH, read at call time: EXACT_BOOLEAN_REPAIR_DISABLED=true.
// /health proof key: checks.exact_boolean_repair.

export function exactBooleanRepairDisabled(): boolean {
  return (Deno.env.get("EXACT_BOOLEAN_REPAIR_DISABLED") ?? "").trim().toLowerCase() === "true";
}

/** Consent / authorization / cost-raising opt-in flags: their LAST path segment must be a real boolean. */
const NEVER_REPAIR = new Set(["confirm", "allowMissingFirstName"]);
const UNSAFE_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_FIELDS = 12;

type AnyErr = { issues?: unknown; cause?: unknown } & Record<string, unknown>;

/** zod issues from the SDK error chain (InvalidToolInputError → TypeValidationError → ZodError). */
function issuesOf(err: unknown): Array<Record<string, unknown>> {
  let e = err as AnyErr | undefined;
  for (let depth = 0; e && typeof e === "object" && depth < 5; depth++) {
    if (Array.isArray(e.issues)) return e.issues.filter((i): i is Record<string, unknown> => !!i && typeof i === "object");
    e = e.cause as AnyErr | undefined;
  }
  return [];
}

export type ExactBooleanRepair = { input: string; fields: string[] };

/**
 * Repair the exact-boolean-string issues of one rejected call. Returns null when there is nothing to repair (the common
 * case), when the input is not a JSON object, or when the switch is thrown. Pure and never throws.
 */
export function repairExactBooleanInput(input: unknown, error: unknown): ExactBooleanRepair | null {
  try {
    if (exactBooleanRepairDisabled() || typeof input !== "string") return null;
    const targets = issuesOf(error).filter((i) =>
      i.code === "invalid_type" && i.expected === "boolean" && i.received === "string" &&
      Array.isArray(i.path) && i.path.length > 0 &&
      i.path.every((p) => (typeof p === "string" && !UNSAFE_SEGMENTS.has(p)) || (typeof p === "number" && Number.isInteger(p) && p >= 0))
    );
    if (targets.length === 0) return null;
    const root: unknown = JSON.parse(input);
    if (!root || typeof root !== "object" || Array.isArray(root)) return null;
    const fields: string[] = [];
    for (const issue of targets) {
      const path = issue.path as Array<string | number>;
      if (NEVER_REPAIR.has(String(path[path.length - 1]))) continue;
      let parent: unknown = root;
      for (let i = 0; i < path.length - 1 && parent && typeof parent === "object"; i++) {
        parent = (parent as Record<string | number, unknown>)[path[i]];
      }
      if (!parent || typeof parent !== "object") continue;
      const key = path[path.length - 1];
      const value = (parent as Record<string | number, unknown>)[key];
      if (value !== "true" && value !== "false") continue; // exact, lowercase, untrimmed — nothing else
      (parent as Record<string | number, unknown>)[key] = value === "true";
      if (fields.length < MAX_FIELDS) fields.push(path.join("."));
    }
    return fields.length ? { input: JSON.stringify(root), fields } : null;
  } catch {
    return null; // a malformed call must never break the step; the SDK reports it as before
  }
}

/** /health → checks.exact_boolean_repair. Presence proves this build; ok:false means the repair failed its own probe. */
export function exactBooleanRepairSelfTest(): { ok: boolean; detail: string } {
  if (exactBooleanRepairDisabled()) return { ok: true, detail: "LEGACY via EXACT_BOOLEAN_REPAIR_DISABLED" };
  const err = (path: Array<string | number>) => ({
    name: "AI_InvalidToolInputError",
    cause: { name: "AI_TypeValidationError", cause: { name: "ZodError", issues: [{ code: "invalid_type", expected: "boolean", received: "string", path }] } },
  });
  const wrong: string[] = [];
  const ok = repairExactBooleanInput('{"reveal":"false","q":"x"}', err(["reveal"]));
  if (!ok || ok.input !== '{"reveal":false,"q":"x"}' || ok.fields.join() !== "reveal") wrong.push("exact string not repaired");
  if (repairExactBooleanInput('{"reveal":"False"}', err(["reveal"]))) wrong.push("a non-exact string was coerced");
  if (repairExactBooleanInput('{"confirm":"true"}', err(["confirm"]))) wrong.push("a consent flag was coerced");
  return wrong.length
    ? { ok: false, detail: wrong.join("; ") }
    : { ok: true, detail: 'only exact "true"/"false" strings on a rejected call are repaired; other strings and consent flags are not' };
}
