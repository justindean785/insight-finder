// lib/malformed-json-repair.ts — a tool call whose JSON text will not parse is repaired ONLY for two lossless syntax slips.
//
// Why. Production tool_input_failure_log shows calls rejected as `invalid_json` (AI_InvalidToolInputError > AI_JSONParseError):
// the text never parsed, so there is nothing for zod to coerce. The AI SDK (ai@6) hands such a call to
// `experimental_repairToolCall` (index.ts) BEFORE it gives up, and re-validates whatever comes back against the unchanged
// input schema. That is the only supported pre-validation hook; this uses it, after the exact-boolean repair.
//
// What it repairs (each pinned by a test), and nothing else:
//   • one enclosing markdown code fence (```json … ```) around the whole input;
//   • trailing commas before `}` or `]`, outside string literals.
// What it will NOT do — these change what the model said, and the tools behind this are PAID:
//   • close a truncated object/array/string (a cut-off email or handle would run a lookup on a different selector);
//   • convert single quotes, add quotes to keys, drop comments, strip surrounding prose, or merge several objects;
//   • accept a result that is not a plain JSON object.
// Value-free: only fix CODES are ever logged. KILL SWITCH (read at call time): MALFORMED_JSON_REPAIR_DISABLED=true.
// /health proof key: checks.malformed_json_repair.

export function malformedJsonRepairDisabled(): boolean {
  return (Deno.env.get("MALFORMED_JSON_REPAIR_DISABLED") ?? "").trim().toLowerCase() === "true";
}

const MAX_INPUT_CHARS = 200_000;
type AnyErr = { name?: unknown; cause?: unknown };

/** True when the SDK error chain contains an AI_JSONParseError (the text itself did not parse). */
function isJsonParseFailure(err: unknown): boolean {
  let e = err as AnyErr | undefined;
  for (let depth = 0; e && typeof e === "object" && depth < 6; depth++) {
    if (/JSONParse/i.test(String(e.name ?? ""))) return true;
    e = e.cause as AnyErr | undefined;
  }
  return false;
}

/** Remove commas that sit directly before `}` / `]` (whitespace between allowed), skipping string literals. */
function stripTrailingCommas(text: string): { text: string; removed: number } {
  let out = "";
  let removed = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") { if (i + 1 < text.length) out += text[++i]; } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === "}" || text[j] === "]") { removed++; continue; }
    }
    out += c;
  }
  return { text: out, removed };
}

export type MalformedJsonRepair = { input: string; fixes: Array<"code_fence" | "trailing_comma"> };

/**
 * Repair one rejected call's raw input text. Returns null when there is nothing safe to repair (the common case), when the
 * error is not a JSON-parse failure, when the result still does not parse to a plain object, or when the switch is thrown.
 * Pure and never throws.
 */
export function repairMalformedJsonInput(input: unknown, error: unknown): MalformedJsonRepair | null {
  try {
    if (malformedJsonRepairDisabled() || typeof input !== "string" || input.length === 0 || input.length > MAX_INPUT_CHARS) return null;
    if (!isJsonParseFailure(error)) return null;
    const fixes: MalformedJsonRepair["fixes"] = [];
    let text = input.trim();
    const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i.exec(text);
    if (fenced) { text = fenced[1].trim(); fixes.push("code_fence"); }
    const stripped = stripTrailingCommas(text);
    if (stripped.removed > 0) { text = stripped.text; fixes.push("trailing_comma"); }
    if (fixes.length === 0) return null;
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) return null;
    return { input: JSON.stringify(parsed), fixes };
  } catch {
    return null; // still malformed: the SDK reports it as before
  }
}

/** /health → checks.malformed_json_repair. Presence proves this build; ok:false means a rule failed its own probe. */
export function malformedJsonRepairSelfTest(): { ok: boolean; switch: string; detail: string } {
  const sw = "MALFORMED_JSON_REPAIR_DISABLED";
  if (malformedJsonRepairDisabled()) return { ok: true, switch: `${sw}=true`, detail: `LEGACY via ${sw} (a malformed call is rejected as invalid_json)` };
  const err = { name: "AI_InvalidToolInputError", cause: { name: "AI_JSONParseError" } };
  const wrong: string[] = [];
  const a = repairMalformedJsonInput('{"a":"x","b":[1,2,],}', err);
  if (!a || a.input !== '{"a":"x","b":[1,2]}' || a.fixes.join() !== "trailing_comma") wrong.push("trailing comma not removed");
  const b = repairMalformedJsonInput('```json\n{"a":"x"}\n```', err);
  if (!b || b.input !== '{"a":"x"}' || b.fixes.join() !== "code_fence") wrong.push("code fence not removed");
  if (repairMalformedJsonInput('{"a":"x', err)) wrong.push("a truncated call was closed");
  if (repairMalformedJsonInput("{'a':'x',}", err)) wrong.push("single quotes were converted");
  const c = repairMalformedJsonInput('{"a":"x,}",}', err);
  if (!c || c.input !== '{"a":"x,}"}') wrong.push("a comma inside a string was touched");
  if (repairMalformedJsonInput('{"a":"x",}', { name: "AI_InvalidToolInputError", cause: { name: "ZodError" } })) wrong.push("a schema failure was treated as a parse failure");
  return wrong.length
    ? { ok: false, switch: `${sw}=false`, detail: wrong.join("; ") }
    : {
      ok: true,
      switch: `${sw}=false`,
      detail: "a call whose JSON text did not parse is repaired only by removing one enclosing code fence and trailing commas; truncation, quotes, prose and non-objects are never repaired",
    };
}
