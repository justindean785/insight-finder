// memory_input_normalization_test.ts — memory_save / minimax_correlate input that is right in SUBSTANCE but wrong in SHAPE
// is re-shaped, only when that is unambiguous; no value is ever rewritten.
//
// Seen on the phone: `memory_save: 2 failed, entries.0/1/2.content (invalid_type)`. The tool already tolerates `entries` as a
// JSON string / single object / array of JSON strings; it does not tolerate the entry fields at the top level, a different
// field name, or a list of sentences for `content`. These tests drive the REAL tool schemas through the REAL AI SDK.
// Synthetic values only (CLAUDE.md forbids real investigation PII in this repo).
import { assert, assertEquals, assertFalse, assertStrictEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { asSchema, generateText, stepCountIs, tool } from "npm:ai@6";
import { MockLanguageModelV3 } from "npm:ai@6/test";
import { buildTools, type ToolContext } from "../../functions/osint-agent/tool-registry.ts";
import {
  memoryInputNormalizationSelfTest,
  normalizeMemoryEntry,
  parseStringArtifactElements,
  wrapFlatMemoryEntry,
} from "../../functions/osint-agent/lib/memory-input-normalization.ts";

const SWITCH = "MEMORY_INPUT_NORMALIZATION_DISABLED";
async function withEnv<T>(key: string, value: string | undefined, fn: () => T | Promise<T>): Promise<T> {
  const prev = Deno.env.get(key);
  if (value === undefined) Deno.env.delete(key); else Deno.env.set(key, value);
  try { return await fn(); } finally {
    if (prev === undefined) Deno.env.delete(key); else Deno.env.set(key, prev);
  }
}

type Rec = Record<string, unknown>;
const ENTRY = { kind: "lesson", subject: "synthetic.handle", content: "This handle is always parked." };

// ── flat entry ─────────────────────────────────────────────────────────────────

Deno.test("a flat entry (no `entries`) is wrapped; `scope` rides along untouched", () => {
  assertEquals(wrapFlatMemoryEntry({ ...ENTRY }), { entries: [ENTRY] });
  assertEquals(wrapFlatMemoryEntry({ ...ENTRY, scope: "case" }), { entries: [ENTRY], scope: "case" });
  const full = { ...ENTRY, subject_kind: "username", related_values: ["a", "b"], confidence: 70 };
  assertEquals(wrapFlatMemoryEntry({ ...full }), { entries: [full] });
});

Deno.test("AMBIGUOUS flat input is returned UNCHANGED: entries present, unknown extra key, a field missing, a wrong type", () => {
  const cases: Rec[] = [
    { entries: [], ...ENTRY },
    { entries: undefined, ...ENTRY },
    { ...ENTRY, surprise: "x" },
    { kind: "lesson", subject: "s" },
    { kind: "lesson", content: "abc" },
    { subject: "s", content: "abc" },
    { ...ENTRY, subject: 42 },
    { ...ENTRY, content: { a: 1 } },
  ];
  for (const c of cases) assertStrictEquals(wrapFlatMemoryEntry(c), c, JSON.stringify(c));
  for (const v of [null, undefined, "x", 3, [ENTRY], true]) assertStrictEquals(wrapFlatMemoryEntry(v), v);
});

Deno.test("scope is NEVER defaulted or repaired: a bad scope stays bad (it is not widened to global)", () => {
  const r = wrapFlatMemoryEntry({ ...ENTRY, scope: "everywhere" }) as Rec;
  assertEquals(r.scope, "everywhere");
  const r2 = wrapFlatMemoryEntry({ ...ENTRY }) as Rec;
  assertFalse("scope" in r2, "no scope in, no scope out — the schema's own default applies, not ours");
});

// ── element aliases ────────────────────────────────────────────────────────────

Deno.test("an unambiguous field-name alias is renamed; its VALUE is untouched", () => {
  assertEquals(normalizeMemoryEntry({ type: "lesson", subject: "s", content: "abc" }), { kind: "lesson", subject: "s", content: "abc" });
  assertEquals(normalizeMemoryEntry({ kind: "lesson", subject: "s", text: "abc" }), { kind: "lesson", subject: "s", content: "abc" });
  assertEquals(normalizeMemoryEntry({ kind: "lesson", value: "s", learning: "abc" }), { kind: "lesson", subject: "s", content: "abc" });
  assertEquals(normalizeMemoryEntry({ kind: "lesson", selector: "s", note: "abc" }), { kind: "lesson", subject: "s", content: "abc" });
});

Deno.test("NO kind synonyms: a kind VALUE is never mapped (a `lesson` bypasses the write gate; an `identity` escalates authority)", () => {
  for (const kind of ["insight", "finding", "note", "Lesson", "LESSON", "learning", "fact", "person", "memory"]) {
    const e = { kind, subject: "s", content: "abc" };
    assertStrictEquals(normalizeMemoryEntry(e), e);
  }
  // and the alias path carries the value through verbatim, so the schema still has the last word
  assertEquals((normalizeMemoryEntry({ type: "insight", subject: "s", content: "abc" }) as Rec).kind, "insight");
});

Deno.test("AMBIGUOUS aliases are left alone: two aliases for one field, or an alias beside its canonical field", () => {
  const two = { kind: "lesson", subject: "s", text: "a", note: "b" };
  assertStrictEquals(normalizeMemoryEntry(two), two);
  const both = { kind: "lesson", subject: "s", content: "canonical", text: "alias" };
  assertStrictEquals(normalizeMemoryEntry(both), both);
  const bothKind = { kind: "lesson", type: "identity", subject: "s", content: "abc" };
  assertStrictEquals(normalizeMemoryEntry(bothKind), bothKind);
});

Deno.test("a list of sentences for `content` is joined; anything else is left to be rejected", () => {
  assertEquals((normalizeMemoryEntry({ ...ENTRY, content: ["First point.", "  Second point.  "] }) as Rec).content, "First point. Second point.");
  for (const bad of [[], [""], ["a", ""], ["a", 1], [{ a: 1 }], { a: "b" }, 5, true, null, Array.from({ length: 9 }, () => "x")]) {
    const e = { ...ENTRY, content: bad };
    assertStrictEquals(normalizeMemoryEntry(e), e, JSON.stringify(bad));
  }
});

Deno.test("confidence, related_values, subject_kind and unknown keys pass through untouched", () => {
  const e = { type: "lesson", subject: "s", content: "abc", confidence: "high", related_values: "x", subject_kind: 7, extra: { a: 1 } };
  assertEquals(normalizeMemoryEntry(e), { kind: "lesson", subject: "s", content: "abc", confidence: "high", related_values: "x", subject_kind: 7, extra: { a: 1 } });
});

Deno.test("valid input is returned as the SAME object", () => {
  assertStrictEquals(normalizeMemoryEntry(ENTRY), ENTRY);
  assertStrictEquals(normalizeMemoryEntry("not an object"), "not an object");
  const root = { entries: [ENTRY], scope: "case" };
  assertStrictEquals(wrapFlatMemoryEntry(root), root);
});

// ── minimax_correlate ──────────────────────────────────────────────────────────

Deno.test("artifacts elements that are JSON strings are parsed — only when they parse to an object", () => {
  const a = { kind: "email", value: "a@example.invalid" };
  assertEquals(parseStringArtifactElements([JSON.stringify(a), a]), [a, a]);
  const bad = ["not json", "[1,2]", "5", "null", '"str"', ""];
  const input = [...bad];
  assertStrictEquals(parseStringArtifactElements(input), input, "nothing parseable → the SAME array");
  assertEquals(parseStringArtifactElements([JSON.stringify(a), "not json"]), [a, "not json"]);
  assertStrictEquals(parseStringArtifactElements("x"), "x");
});

// ── through the REAL schemas and the REAL SDK ──────────────────────────────────

function realTools() {
  const ctx = { supabase: {}, supabaseAdmin: {}, userId: "t", threadId: "min", archiveEnabled: false, detectedSeedType: "username", messages: [], manualOverrideSelector: null } as unknown as ToolContext;
  return buildTools(ctx).tools as Record<string, { inputSchema: { safeParse: (v: unknown) => { success: boolean; data?: unknown } } }>;
}

Deno.test("REAL memory_save schema: flat entry, aliases and a sentence list all validate to the same canonical entries", () => {
  const schema = realTools().memory_save.inputSchema;
  const want = { entries: [{ kind: "lesson", subject: "synthetic.handle", content: "One. Two.", confidence: 60 }], scope: "global" };
  for (const input of [
    { entries: [{ kind: "lesson", subject: "synthetic.handle", content: "One. Two." }] },
    { kind: "lesson", subject: "synthetic.handle", content: "One. Two." },
    { kind: "lesson", subject: "synthetic.handle", content: ["One.", "Two."] },
    { entries: [{ type: "lesson", value: "synthetic.handle", text: "One. Two." }] },
    { entries: JSON.stringify([{ type: "lesson", value: "synthetic.handle", learning: "One. Two." }]) },
  ]) {
    const r = schema.safeParse(input);
    assert(r.success, JSON.stringify(input));
    assertEquals(r.data, want);
  }
});

Deno.test("REAL memory_save schema: ambiguous / value-changing input is still REJECTED or dropped exactly as before", () => {
  const schema = realTools().memory_save.inputSchema;
  assertFalse(schema.safeParse({ kind: "insight", subject: "s", content: "abc" }).success, "no kind synonyms");
  assertFalse(schema.safeParse({ kind: "lesson", subject: "s", content: "abc", scope: "everywhere" }).success, "a bad scope is not widened to global");
  assertFalse(schema.safeParse({ kind: "lesson", subject: "s", content: "abc", surprise: 1 }).success, "unknown extra key beside flat fields");
  assertFalse(schema.safeParse({ kind: "lesson", subject: "s", content: { summary: "x" } }).success, "an object `content` is ambiguous");
  assertFalse(schema.safeParse({ entries: [{ kind: "lesson", subject: "s", text: "a", note: "b" }] }).success, "two aliases for one field");
  assertFalse(schema.safeParse({ kind: "lesson", subject: "s" }).success, "missing content");
});

Deno.test("REAL memory_save schema: a case-scope flat entry keeps scope \"case\" (never promoted to global)", () => {
  const r = realTools().memory_save.inputSchema.safeParse({ kind: "lesson", subject: "s", content: "abc", scope: "case" });
  assert(r.success);
  assertEquals((r.data as Rec).scope, "case");
});

Deno.test("REAL minimax_correlate schema: stringified ELEMENTS validate; the rest is unchanged", () => {
  const schema = realTools().minimax_correlate.inputSchema;
  const r = schema.safeParse({ seed: "s", artifacts: [JSON.stringify({ kind: "email", value: "a@example.invalid" })] });
  assert(r.success);
  assertEquals((r.data as { artifacts: Rec[] }).artifacts[0].value, "a@example.invalid");
  assertFalse(schema.safeParse({ seed: "s", artifacts: ["not json"] }).success);
});

Deno.test("the model-facing JSON schema of memory_save is unchanged in shape (type object; entries + scope)", async () => {
  const js = await asSchema(realTools().memory_save.inputSchema as never).jsonSchema as { type?: string; properties?: Rec };
  assertEquals(js.type, "object");
  assert(js.properties && "entries" in js.properties && "scope" in js.properties, JSON.stringify(Object.keys(js.properties ?? {})));
});

const USAGE = { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
Deno.test("REAL SDK: a flat memory_save call reaches execute as one canonical entry (it used to be rejected before execute)", async () => {
  const received: unknown[] = [];
  const t = tool({ description: "spy", inputSchema: realTools().memory_save.inputSchema as never, execute: (i: unknown) => { received.push(i); return Promise.resolve({ ok: true }); } });
  let n = 0;
  const model = new MockLanguageModelV3({
    doGenerate: () => {
      n++;
      return Promise.resolve((n === 1
        ? { content: [{ type: "tool-call", toolCallId: "c1", toolName: "memory_save", input: JSON.stringify({ kind: "lesson", subject: "synthetic.handle", content: "abc" }) }], finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage: USAGE, warnings: [] }
        : { content: [{ type: "text", text: "done" }], finishReason: { unified: "stop", raw: "stop" }, usage: USAGE, warnings: [] }) as never);
    },
  });
  await generateText({ model, tools: { memory_save: t } as never, stopWhen: stepCountIs(3), prompt: "go" });
  assertEquals(received.length, 1);
  assertEquals((received[0] as { entries: Rec[] }).entries[0].subject, "synthetic.handle");
});

// ── switch, /health, scope ─────────────────────────────────────────────────────

Deno.test("KILL SWITCH: MEMORY_INPUT_NORMALIZATION_DISABLED=true restores the old behaviour at call time; /health reports LEGACY", async () => {
  await withEnv(SWITCH, "true", () => {
    const flat = { ...ENTRY };
    assertStrictEquals(wrapFlatMemoryEntry(flat), flat);
    const aliased = { type: "lesson", subject: "s", content: "abc" };
    assertStrictEquals(normalizeMemoryEntry(aliased), aliased);
    const el = ['{"kind":"email","value":"a"}'];
    assertStrictEquals(parseStringArtifactElements(el), el);
    assertEquals(memoryInputNormalizationSelfTest().detail, "LEGACY via MEMORY_INPUT_NORMALIZATION_DISABLED");
    assertFalse(realTools().memory_save.inputSchema.safeParse({ ...ENTRY }).success, "the flat entry is rejected again");
  });
  assert(realTools().memory_save.inputSchema.safeParse({ ...ENTRY }).success, "and back on");
});

Deno.test("/health: checks.memory_input_normalization is wired and the self-test passes", async () => {
  const st = memoryInputNormalizationSelfTest();
  assertEquals(st.ok, true, st.detail);
  const health = await Deno.readTextFile(new URL("../../functions/osint-agent/health-handler.ts", import.meta.url));
  assert(health.includes("r.checks.memory_input_normalization = memoryInputNormalizationSelfTest();"));
});

Deno.test("SCOPE: the memory write gates are untouched, and the module sets no authority field", async () => {
  const lib = await Deno.readTextFile(new URL("../../functions/osint-agent/lib/memory-input-normalization.ts", import.meta.url));
  const code = lib.replace(/\/\/.*$/gm, "");
  for (const forbidden of ["reviewed", "confirmed", "linkage_confirmed", "false_positive", "REVEAL_BREACH_DATA", "source_category"]) {
    assertFalse(code.includes(forbidden), `${forbidden} must not appear in the normalizer`);
  }
  const reg = await Deno.readTextFile(new URL("../../functions/osint-agent/tool-registry.ts", import.meta.url));
  assert(reg.includes("refuseConflictingMemoryWrites(toPersist"), "the analyst gate still runs");
  assert(reg.includes("reviewMemoryBatch("), "the C-2 consolidation review still runs");
});

// ── root `entries` aliases and `notes` (measured 2026-10-24, thread ed68091e) ─────────────────────────────────────────

Deno.test("`notes` is a content alias (like `note`); both together stay ambiguous", () => {
  assertEquals(normalizeMemoryEntry({ kind: "lesson", subject: "s", notes: "abc" }), { kind: "lesson", subject: "s", content: "abc" });
  const both = { kind: "lesson", subject: "s", note: "a", notes: "b" };
  assertStrictEquals(normalizeMemoryEntry(both), both);
});

Deno.test("`memories` / `memory_items` / `items` holding an array of objects are renamed to `entries`; scope rides along", () => {
  const list = [{ kind: "lesson", subject: "s", content: "abc" }];
  for (const key of ["memories", "memory_items", "items"]) {
    assertEquals(wrapFlatMemoryEntry({ [key]: list, scope: "case" }), { scope: "case", entries: list }, key);
  }
});

Deno.test("root aliases are left UNCHANGED when ambiguous: two aliases, a string/object/empty/mixed value, or `entries` present", () => {
  const e = { kind: "lesson", subject: "s", content: "abc" };
  const cases: Rec[] = [
    { memories: [e], items: [e] },
    { memory_items: JSON.stringify([e]) },
    { items: e },
    { memories: [] },
    { memories: [e, "x"] },
    { entries: [e], memories: [e] },
  ];
  for (const c of cases) assertStrictEquals(wrapFlatMemoryEntry(c), c, JSON.stringify(c));
});

Deno.test("REAL memory_save schema: an aliased root array validates; values are still never rewritten", () => {
  const schema = realTools().memory_save.inputSchema;
  const r = schema.safeParse({ memories: [{ kind: "lesson", subject: "synthetic.handle", notes: "One. Two." }] });
  assert(r.success);
  assertEquals(r.data, { entries: [{ kind: "lesson", subject: "synthetic.handle", content: "One. Two.", confidence: 60 }], scope: "global" });
  assertFalse(schema.safeParse({ memories: [{ kind: "insight", subject: "s", notes: "abc" }] }).success, "no kind synonyms");
  // The 2026-10-24 flat call still fails on its string-typed confidence / related_values: those are values, not shape.
  assertFalse(schema.safeParse({ scope: "case", kind: "lesson", subject: "s", related_values: "a, b", confidence: "high", notes: "abc" }).success);
});

Deno.test("KILL SWITCH also disables the root aliases and `notes`", async () => {
  const input = { memories: [{ kind: "lesson", subject: "s", content: "abc" }] };
  await withEnv(SWITCH, "true", () => {
    assertStrictEquals(wrapFlatMemoryEntry(input), input);
    const e = { kind: "lesson", subject: "s", notes: "abc" };
    assertStrictEquals(normalizeMemoryEntry(e), e);
  });
});
