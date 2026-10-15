// catalog_param_names_test.ts — the catalog's advertised INPUT field names must be the tool's real
// zod field names.
//
// `catalog_contract_test.ts` proves every catalog entry names a tool that exists. It never looked
// at the PARAMETERS. The catalog is what the model is told to send, so a wrong name here is a
// tool call the AI SDK rejects before `execute` runs (measured 2026-10-06: 3 of 26 calls on one
// live case were rejected on input validation, and nothing recorded them — see
// lib/tool-input-failure.ts). Drift found when this test was written:
//   • shodan_internetdb  — catalog `{ value }`                 schema `{ ip }`
//   • hackertarget       — catalog `{ kind, value }`           schema `{ mode, query }`
//   • triage_seed        — catalog `{ seed_value, seed_type }` schema `{ seed, type }`
//   • opsis_search       — catalog `premium?` (deliberately removed from the schema: its 2nd credit
//                          cannot be priced per tool name)
//   • username_search    — catalog `platforms?`, schema has no such field
//
// Rules, per catalog entry (read from the REAL schema built by buildTools):
//   1. every field the catalog names exists in the schema;
//   2. when the catalog gives ONE input shape (no `OR` alternatives), every REQUIRED schema field
//      is named — and is not marked optional (`?`) in the catalog.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildTools, type ToolContext } from "../../functions/osint-agent/tool-registry.ts";
import { TOOL_CATALOG } from "../../functions/osint-agent/catalog.ts";

type Field = { name: string; optional: boolean };

/** Top-level `{ ... }` groups of an input string (alternatives joined by OR), depth- and quote-aware. */
function groups(input: string): string[] {
  const out: string[] = [];
  let depth = 0, start = -1, quote = "";
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) { if (ch === quote) quote = ""; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "{") { if (depth === 0) start = i + 1; depth++; }
    else if (ch === "}") { depth--; if (depth === 0 && start >= 0) { out.push(input.slice(start, i)); start = -1; } }
  }
  return out;
}

/** The top-level field names in one group: `a, b?: type, c: 'x'|'y'` → a, b(opt), c. */
function fields(group: string): Field[] {
  const parts: string[] = [];
  let depth = 0, quote = "", cur = "";
  for (const ch of group) {
    if (quote) { cur += ch; if (ch === quote) quote = ""; continue; }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if ("{[(<".includes(ch)) depth++;
    else if ("}])>".includes(ch)) depth--;
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  const out: Field[] = [];
  for (const p of parts) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(\?)?/.exec(p);
    if (m) out.push({ name: m[1], optional: m[2] === "?" });
  }
  return out;
}

type ZodLike = {
  shape?: Record<string, ZodLike>;
  isOptional?: () => boolean;
  _def?: { schema?: ZodLike; innerType?: ZodLike };
};

function schemaShape(schema: unknown): Record<string, ZodLike> | null {
  let s = schema as ZodLike | null | undefined;
  for (let i = 0; s && i < 4; i++) {
    if (s.shape && typeof s.shape === "object") return s.shape;
    s = s._def?.schema ?? s._def?.innerType ?? null; // ZodEffects / ZodOptional wrappers
  }
  return null;
}

function stubCtx(): ToolContext {
  return {
    supabase: {}, supabaseAdmin: {}, userId: "t", threadId: "t-catalog",
    archiveEnabled: false, detectedSeedType: "ip", messages: [], manualOverrideSelector: null,
  } as unknown as ToolContext;
}

Deno.test("tokenizer: depth-, quote- and alternative-aware (so the contract below is not vacuous)", () => {
  assertEquals(fields("platform, handle, kind?").map((f) => `${f.name}${f.optional ? "?" : ""}`), ["platform", "handle", "kind?"]);
  assertEquals(
    fields("mode: 'a'|'b', query: string").map((f) => f.name),
    ["mode", "query"],
  );
  assertEquals(
    fields("entries: Array<{kind:'pattern'|'lesson', subject:string}>, scope?: 'global'|'case'").map((f) => f.name),
    ["entries", "scope"],
  );
  assertEquals(groups("{ username } OR { user_id }"), [" username ", " user_id "]);
  assertEquals(fields("query (any format)").map((f) => f.name), ["query"]);
});

Deno.test("every catalog input names the tool's real zod fields (and every required field)", () => {
  const tools = buildTools(stubCtx()).tools as Record<string, { inputSchema?: unknown }>;
  const problems: string[] = [];
  let checked = 0;
  const unreadable: string[] = [];
  for (const entry of TOOL_CATALOG.tools) {
    const tool = tools[entry.name];
    if (!tool) continue; // a missing tool is catalog_contract_test's concern
    const shape = schemaShape(tool.inputSchema);
    if (!shape) { unreadable.push(entry.name); continue; }
    const gs = groups(entry.input);
    if (gs.length === 0) { unreadable.push(entry.name); continue; }
    checked++;
    const schemaKeys = Object.keys(shape);
    for (const g of gs) {
      for (const f of fields(g)) {
        if (!schemaKeys.includes(f.name)) problems.push(`${entry.name}: catalog advertises \`${f.name}\`, schema has [${schemaKeys.join(", ")}]`);
      }
    }
    if (gs.length === 1) {
      const named = new Map(fields(gs[0]).map((f) => [f.name, f.optional]));
      for (const k of schemaKeys) {
        const required = !(shape[k]?.isOptional?.() ?? false);
        if (!required) continue;
        if (!named.has(k)) problems.push(`${entry.name}: required schema field \`${k}\` is missing from the catalog input`);
        else if (named.get(k) === true) problems.push(`${entry.name}: \`${k}\` is required by the schema but marked optional (?) in the catalog`);
      }
    }
  }
  assert(checked >= 100, `only ${checked} catalog entries were checked — the parser stopped reading them (unreadable: ${unreadable.join(", ")})`);
  assertEquals(problems, [], `catalog/schema drift:\n  ${problems.join("\n  ")}`);
});
