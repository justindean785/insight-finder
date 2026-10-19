// input_coercion_test.ts — near-miss tool inputs are coerced INSIDE the real input schemas, before the AI SDK would
// reject them; everything else is still rejected exactly as before.
//
// Each "PRODUCTION" test reproduces a rejection measured on case 035a1a4e (an ADDRESS seed, orchestrator GLM-5.2) or
// the previous case's audit, driven through the REAL schema built by buildTools() — and, for one of them, through the
// REAL AI SDK. Synthetic values only (CLAUDE.md forbids real investigation PII in this repo).
import { assert, assertEquals, assertFalse, assertStrictEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { asSchema, generateText, stepCountIs, tool } from "npm:ai@6";
import { MockLanguageModelV3 } from "npm:ai@6/test";
import type { Tool } from "npm:ai@6";
import type { createClient } from "npm:@supabase/supabase-js@2";
import { buildTools, type ToolContext } from "../../functions/osint-agent/tool-registry.ts";
import { wrapToolsWithCache } from "../../functions/osint-agent/cache.ts";
import { clearRuntime } from "../../functions/osint-agent/runtime-policy.ts";
import { harvestQueryFamily } from "../../functions/osint-agent/dork-queries.ts";
import {
  _resetParkedCoercions,
  coerceToolInput,
  INPUT_KIND_ALIASES,
  inputCoercionSelfTest,
  takeInputCoercions,
} from "../../functions/osint-agent/lib/tool-input-coercion.ts";
import { canonicalKind, KIND_ALIASES } from "../../functions/osint-agent/lib/kind-alias.ts";

const SWITCH = "INPUT_COERCION_DISABLED";
async function withEnv<T>(key: string, value: string | undefined, fn: () => T | Promise<T>): Promise<T> {
  const prev = Deno.env.get(key);
  if (value === undefined) Deno.env.delete(key); else Deno.env.set(key, value);
  try { return await fn(); } finally {
    if (prev === undefined) Deno.env.delete(key); else Deno.env.set(key, prev);
  }
}

type Rec = Record<string, unknown>;
type Parse = { success: boolean; data?: unknown; error?: { issues: Array<{ path: unknown[]; code: string }> } };
type SchemaLike = { safeParse: (v: unknown) => Parse };

function realTools() {
  const ctx = {
    supabase: {}, supabaseAdmin: {}, userId: "t", threadId: "coerce", archiveEnabled: false,
    detectedSeedType: "address", messages: [], manualOverrideSelector: null,
  } as unknown as ToolContext;
  return buildTools(ctx).tools as Record<string, { inputSchema: SchemaLike }>;
}
const schemaOf = (name: string) => realTools()[name].inputSchema;
const ADDR = "16 Example St Apt 302 Springfield MA 01101";

function parse(name: string, input: unknown): Parse {
  return schemaOf(name).safeParse(input);
}
function ok(name: string, input: unknown): Rec {
  const r = parse(name, input);
  assert(r.success, `${name} ${JSON.stringify(input)} → ${JSON.stringify(r.error?.issues)}`);
  return r.data as Rec;
}
function rejected(name: string, input: unknown): Parse {
  const r = parse(name, input);
  assertFalse(r.success, `${name} ${JSON.stringify(input)} should be rejected`);
  return r;
}

// ── PRODUCTION rejections, now coerced ─────────────────────────────────────────

Deno.test("PRODUCTION gemini_deep_dork `{query}` only: query becomes seed, kind defaults to \"other\"", () => {
  const d = ok("gemini_deep_dork", { query: ADDR });
  assertEquals(d.seed, ADDR);
  assertEquals(d.kind, "other");
  assertFalse("query" in d);
});

Deno.test("PRODUCTION gemini_deep_dork `{seed, kind, focus}` on an ADDRESS case: \"address\" (and its aliases) validate", () => {
  for (const kind of ["address", "Address", "location", "street_address", "street address"]) {
    const d = ok("gemini_deep_dork", { seed: ADDR, kind, focus: "property records" });
    assertEquals(d.kind, "address", kind);
    assertEquals(d.focus, "property records");
  }
});

Deno.test("PRODUCTION google_dorks kind alias spellings map onto its own enum", () => {
  const cases: Array<[string, string]> = [
    ["location", "address"], ["street_address", "address"], ["full_name", "name"], ["phone_number", "phone"],
    ["user", "username"], ["handle", "username"], ["domain_name", "domain"], ["ip_address", "ip"],
    ["Address", "address"], [" EMAIL ", "email"], ["crypto", "crypto_wallet"], ["wallet", "crypto_wallet"],
    ["email_address", "email"],
  ];
  for (const [sent, want] of cases) {
    assertEquals(ok("google_dorks", { seed: "x", kind: sent }).kind, want, sent);
  }
  // already-valid kinds pass through untouched, including the legacy "person"
  assertEquals(ok("google_dorks", { seed: "x", kind: "person" }).kind, "person");
});

Deno.test("PRODUCTION jina_reader_scrape maxChars:\"15000\" (string) validates as the number 15000", () => {
  const d = ok("jina_reader_scrape", { url: "https://example.com/page", maxChars: "15000" });
  assertStrictEquals(d.maxChars, 15000);
});

Deno.test("PRODUCTION oathnet_lookup type alias spellings validate; value number→string and trimmed", () => {
  assertEquals(ok("oathnet_lookup", { type: "email_address", value: "a@example.invalid" }).type, "email");
  assertEquals(ok("oathnet_lookup", { type: "ip_address", value: "192.0.2.1" }).type, "ip");
  assertEquals(ok("oathnet_lookup", { type: "phone_number", value: "6175550100" }).type, "phone");
  assertEquals(ok("oathnet_lookup", { type: "Email", value: "a@example.invalid" }).type, "email");
  assertEquals(ok("oathnet_lookup", { type: "full_name", value: "Jane Example" }).type, "name");
  const n = ok("oathnet_lookup", { type: "phone", value: 6175550100 });
  assertStrictEquals(n.value, "6175550100");
  assertEquals(ok("oathnet_lookup", { type: "email", value: "  a@example.invalid " }).value, "a@example.invalid");
});

Deno.test("PRODUCTION (prior audit) minimax_correlate seed sent as a number validates as its string", () => {
  const d = ok("minimax_correlate", { seed: 6175550100, artifacts: [{ kind: "phone", value: "6175550100" }] });
  assertStrictEquals(d.seed, "6175550100");
});

Deno.test("PRODUCTION (prior audit) rapidapi_breach_search email with surrounding whitespace is trimmed and validates", () => {
  assertEquals(ok("rapidapi_breach_search", { email: "  a@example.invalid\n" }).email, "a@example.invalid");
});

// ── address on the dork tools: only where the implementation can build it ─────

Deno.test("dork_harvest: \"address\" (and aliases) validate; max_queries numeric string → number", () => {
  assertEquals(ok("dork_harvest", { seed: ADDR, kind: "address" }).kind, "address");
  assertEquals(ok("dork_harvest", { seed: ADDR, kind: "location" }).kind, "address");
  assertStrictEquals(ok("dork_harvest", { seed: ADDR, kind: "address", max_queries: "3" }).max_queries, 3);
  assertEquals(ok("dork_harvest", { query: ADDR, kind: "address" }).seed, ADDR);
});

Deno.test("dork_harvest has no address family of its own: address runs the NAME family (deed/assessor/docket/FEC), never domain", () => {
  assertEquals(harvestQueryFamily("address"), "name");
  assertEquals(harvestQueryFamily("person"), "name");
  for (const k of ["email", "username", "phone", "name", "domain", "ip", "hash", "crypto_wallet"]) {
    assertEquals(harvestQueryFamily(k), k);
  }
});

Deno.test("WIRING (source): dork_harvest picks its query family via harvestQueryFamily but records the REAL seed_kind", async () => {
  const src = await Deno.readTextFile(new URL("../../functions/osint-agent/tool-registry.ts", import.meta.url));
  const at = src.indexOf("dork_harvest: tool({");
  const body = src.slice(at, src.indexOf("gemini_deep_dork: tool({", at));
  assert(body.includes("QUERIES[harvestQueryFamily(kind)]"), "query family must come from harvestQueryFamily");
  assert(body.includes("seed_kind: kind,"), "provenance keeps the kind the call was made with");
});

Deno.test("google_dorks keeps its own address family (it already had one) — no new capability claimed elsewhere", () => {
  assertEquals(ok("google_dorks", { seed: ADDR, kind: "address" }).kind, "address");
});

// ── still rejected ─────────────────────────────────────────────────────────────

Deno.test("STILL REJECTED: unknown kinds, non-numeric strings, out-of-range numbers, invalid emails, missing required fields", () => {
  rejected("google_dorks", { seed: "x", kind: "planet" });
  rejected("google_dorks", { seed: "x" }); // no default kind, and "x" has no recognisable shape to infer one from
  rejected("google_dorks", { kind: "email" });
  rejected("gemini_deep_dork", { seed: "x", kind: "planet" }); // an unknown kind is NOT widened to "other"
  rejected("gemini_deep_dork", {}); // no seed, no query
  rejected("oathnet_lookup", { type: "address", value: "x" }); // oathnet has no address capability
  rejected("oathnet_lookup", { type: "location", value: "x" });
  rejected("jina_reader_scrape", { url: "https://example.com", maxChars: "15k" });
  rejected("jina_reader_scrape", { url: "https://example.com", maxChars: "999999" }); // coerces, but fails max → raw
  rejected("jina_reader_scrape", { url: "https://example.com", maxChars: "1500.5" }); // not an int
  rejected("rapidapi_breach_search", { email: "  not-an-email " });
  rejected("dork_harvest", { seed: "x", kind: "planet" });
  rejected("minimax_correlate", { seed: { a: 1 }, artifacts: [] });
});

Deno.test("STILL REJECTED with the SAME issues as before: a call that coercion cannot rescue is passed through RAW", async () => {
  // maxChars "15000" would coerce, but kind-less url is invalid → the raw input (with its string maxChars) is what the
  // SDK sees, so the issue set is identical to the strict schema's.
  const input = { url: "not a url", maxChars: "15000" };
  const now = rejected("jina_reader_scrape", input).error!.issues.map((i) => `${i.path.join(".")}:${i.code}`).sort();
  const strict = await withEnv(SWITCH, "true", () =>
    rejected("jina_reader_scrape", input).error!.issues.map((i) => `${i.path.join(".")}:${i.code}`).sort());
  assertEquals(now, strict);
  assert(now.includes("maxChars:invalid_type"));
});

// ── kill switch ────────────────────────────────────────────────────────────────

Deno.test("KILL SWITCH: INPUT_COERCION_DISABLED=true restores every production rejection, including \"address\"", async () => {
  await withEnv(SWITCH, "true", () => {
    rejected("gemini_deep_dork", { query: ADDR });
    rejected("gemini_deep_dork", { seed: ADDR, kind: "address" });
    rejected("dork_harvest", { seed: ADDR, kind: "address" });
    rejected("google_dorks", { seed: "x", kind: "location" });
    rejected("jina_reader_scrape", { url: "https://example.com/page", maxChars: "15000" });
    rejected("oathnet_lookup", { type: "email_address", value: "a@example.invalid" });
    rejected("minimax_correlate", { seed: 6175550100, artifacts: [] });
    rejected("rapidapi_breach_search", { email: " a@example.invalid " });
    // and the untouched strict paths still pass
    ok("google_dorks", { seed: ADDR, kind: "address" });
    ok("gemini_deep_dork", { seed: "x", kind: "other" });
    assertEquals(inputCoercionSelfTest().detail, "LEGACY via INPUT_COERCION_DISABLED (strict schemas)");
  });
  // read at call time: flipping it back re-enables coercion with no rebuild
  ok("gemini_deep_dork", { query: ADDR });
});

// ── the alias table is input-only: dedup/rejection keys do not move ────────────

Deno.test("INPUT_KIND_ALIASES does not alter lib/kind-alias.ts — dedup and rejection keys are unchanged", () => {
  for (const k of ["location", "street_address", "full_name", "phone_number", "user", "domain_name", "email_address"]) {
    assertEquals(canonicalKind(k), k, `${k} must still key as itself in dedup/rejection`);
    assertFalse(k in KIND_ALIASES);
  }
  assert(Object.keys(INPUT_KIND_ALIASES).length > 0);
  // the shared table is READ for input coercion (e.g. "social" → username), never extended
  assertEquals(coerceToolInput({ kind: "social" }, { enumFields: { kind: ["username", "email"] } }).value, { kind: "username" });
});

Deno.test("coerceToolInput is a no-op (same object) when nothing applies, and never touches non-plain input", () => {
  const already = { seed: "x", kind: "email" };
  assertStrictEquals(coerceToolInput(already, { enumFields: { kind: ["email"] } }).value, already);
  for (const v of [null, undefined, "x", 3, [1], true]) assertStrictEquals(coerceToolInput(v, { trimFields: ["a"] }).value, v);
  // prototype-polluting spellings are never looked up
  assertEquals(coerceToolInput({ kind: "__proto__" }, { enumFields: { kind: ["email"] } }).records, []);
  assertEquals(coerceToolInput({ kind: "constructor" }, { enumFields: { kind: ["email"] } }).records, []);
});

// ── the model-facing JSON schema is unchanged in shape ─────────────────────────

Deno.test("model-facing JSON schemas stay objects with the same properties; gemini/dork_harvest kind enums now list \"address\"", async () => {
  const tools = realTools();
  const props = async (n: string) => (await asSchema(tools[n].inputSchema as never).jsonSchema) as { type?: string; properties?: Rec; required?: string[] };
  const g = await props("google_dorks");
  assertEquals(g.type, "object");
  assertEquals(Object.keys(g.properties ?? {}).sort(), ["kind", "seed"]);
  const gd = await props("gemini_deep_dork");
  assertEquals(Object.keys(gd.properties ?? {}).sort(), ["focus", "kind", "seed"]);
  assert(JSON.stringify(gd.properties?.kind).includes("\"address\""));
  const dh = await props("dork_harvest");
  assert(JSON.stringify(dh.properties?.kind).includes("\"address\""));
  const j = await props("jina_reader_scrape");
  assertEquals(Object.keys(j.properties ?? {}).sort(), ["maxChars", "url"]);
  const o = await props("oathnet_lookup");
  assertEquals(Object.keys(o.properties ?? {}).sort(), ["dbnames", "filter_id", "type", "value"]);
});

// ── logging: value-free event per coerced field ────────────────────────────────

Deno.test("each coercion logs one value-free `tool_input_coerced` event (tool, field, coercion — never the value)", () => {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  try {
    ok("gemini_deep_dork", { query: "SECRET-SEED-VALUE-123" });
  } finally {
    console.log = orig;
  }
  const events = logs.filter((l) => l.includes("tool_input_coerced")).map((l) => JSON.parse(l) as Rec);
  assertEquals(events.map((e) => `${e.tool}:${e.field}:${e.coercion}`).sort(), [
    "gemini_deep_dork:kind:default_kind",
    "gemini_deep_dork:seed:seed_from_query",
  ]);
  for (const l of logs) assertFalse(l.includes("SECRET-SEED-VALUE-123"), "a value reached the log");
});

Deno.test("a call that coercion cannot rescue logs NOTHING and parks nothing", () => {
  _resetParkedCoercions();
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  try {
    rejected("google_dorks", { seed: 5, kind: "planet" });
  } finally {
    console.log = orig;
  }
  assertEquals(logs.filter((l) => l.includes("tool_input_coerced")), []);
  assertEquals(takeInputCoercions("google_dorks", { seed: "5", kind: "planet" }), null);
});

// ── durable trail: tool_usage_log.input_json.runtime.input_coercion ────────────

type SupabaseClient = ReturnType<typeof createClient>;
function makeDb() {
  const usage: Rec[] = [];
  const q: Record<string, unknown> = {};
  const chain = () => q;
  for (const k of ["select", "in", "order", "limit", "update", "eq", "gte", "lt", "neq", "is", "not", "or", "range"]) q[k] = chain;
  q.maybeSingle = () => Promise.resolve({ data: null, error: null });
  q.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null, count: 0 }).then(res);
  let table = "";
  q.insert = (r: Rec) => { if (table === "tool_usage_log") usage.push(r); return Promise.resolve({ error: null }); };
  q.upsert = () => Promise.resolve({ error: null });
  const db = { from: (t: string) => { table = t; return q; }, rpc: () => Promise.resolve({ data: null, error: null }) } as unknown as SupabaseClient;
  return { db, usage };
}

Deno.test("DURABLE: the wrapper stamps input_coercion into tool_usage_log input_json.runtime for the coerced call only", async () => {
  _resetParkedCoercions();
  const parsed = ok("google_dorks", { seed: "durable.example", kind: "domain_name" });
  const thread = "coerce-durable";
  clearRuntime(thread);
  const { db, usage } = makeDb();
  const wrapped = wrapToolsWithCache(
    { google_dorks: { description: "t", execute: () => Promise.resolve({ ok: true, dorks: [{ q: 1 }] }) } as unknown as Tool },
    { investigationId: thread, userId: `u-${thread}`, supabase: db, supabaseAdmin: db },
  );
  const exec = wrapped.google_dorks.execute as (i: unknown, o: unknown) => Promise<unknown>;
  await exec(parsed, { toolCallId: "c1", messages: [] });
  // a second, NOT coerced call with a different seed must not claim anything
  await exec({ seed: "other.example", kind: "domain" }, { toolCallId: "c2", messages: [] });
  await new Promise((r) => setTimeout(r, 40));
  const rows = usage.filter((u) => u.tool_name === "google_dorks");
  assertEquals(rows.length, 2);
  const rt = (r: Rec) => ((r.input_json as Rec | null)?.runtime ?? {}) as Rec;
  assertEquals(rt(rows[0]).input_coercion, [{ field: "kind", coercion: "kind_alias" }]);
  assertFalse("input_coercion" in rt(rows[1]));
  // values never ride the coercion record
  assertFalse(JSON.stringify(rt(rows[0]).input_coercion).includes("durable.example"));
});

Deno.test("takeInputCoercions matches on the coerced VALUE and is consumed once", () => {
  _resetParkedCoercions();
  ok("oathnet_lookup", { type: "ip_address", value: "192.0.2.7" });
  assertEquals(takeInputCoercions("oathnet_lookup", { type: "email", value: "192.0.2.7" }), null, "different coerced value");
  assertEquals(takeInputCoercions("google_dorks", { type: "ip", value: "192.0.2.7" }), null, "different tool");
  assertEquals(takeInputCoercions("oathnet_lookup", { type: "ip", value: "192.0.2.7" }), [{ field: "type", coercion: "kind_alias" }]);
  assertEquals(takeInputCoercions("oathnet_lookup", { type: "ip", value: "192.0.2.7" }), null, "consumed once");
});

// ── through the REAL AI SDK ────────────────────────────────────────────────────

const USAGE = { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
async function sdkCall(name: string, input: Rec): Promise<{ received: unknown[]; invalid: boolean }> {
  const received: unknown[] = [];
  const t = tool({ description: "spy", inputSchema: schemaOf(name) as never, execute: (i: unknown) => { received.push(i); return Promise.resolve({ ok: true }); } });
  let n = 0;
  const model = new MockLanguageModelV3({
    doGenerate: () => {
      n++;
      return Promise.resolve((n === 1
        ? { content: [{ type: "tool-call", toolCallId: "c1", toolName: name, input: JSON.stringify(input) }], finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage: USAGE, warnings: [] }
        : { content: [{ type: "text", text: "done" }], finishReason: { unified: "stop", raw: "stop" }, usage: USAGE, warnings: [] }) as never);
    },
  });
  const r = await generateText({ model, tools: { [name]: t } as never, stopWhen: stepCountIs(3) as never, prompt: "go" });
  const invalid = r.steps[0].toolCalls.some((c) => (c as { invalid?: boolean }).invalid === true);
  return { received, invalid };
}

Deno.test("REAL SDK: gemini_deep_dork `{query}` reaches execute (it used to be rejected before execute)", async () => {
  const { received, invalid } = await sdkCall("gemini_deep_dork", { query: ADDR });
  assertFalse(invalid);
  assertEquals(received.length, 1);
  assertEquals((received[0] as Rec).seed, ADDR);
  assertEquals((received[0] as Rec).kind, "other");
});

Deno.test("REAL SDK: jina maxChars \"15000\" reaches execute as a number; under the kill switch it is rejected again", async () => {
  const a = await sdkCall("jina_reader_scrape", { url: "https://example.com/p", maxChars: "15000" });
  assertEquals(a.received.length, 1);
  assertStrictEquals((a.received[0] as Rec).maxChars, 15000);
  await withEnv(SWITCH, "true", async () => {
    const b = await sdkCall("jina_reader_scrape", { url: "https://example.com/p", maxChars: "15000" });
    assert(b.invalid);
    assertEquals(b.received.length, 0);
  });
});

// ── /health ────────────────────────────────────────────────────────────────────

Deno.test("/health: checks.input_coercion is wired, passes, and reports the switch state", async () => {
  const st = inputCoercionSelfTest();
  assertEquals(st.ok, true, st.detail);
  assertEquals(st.switch, "INPUT_COERCION_DISABLED=false");
  const health = await Deno.readTextFile(new URL("../../functions/osint-agent/health-handler.ts", import.meta.url));
  assert(health.includes("r.checks.input_coercion = inputCoercionSelfTest();"));
  await withEnv(SWITCH, "true", () => assertEquals(inputCoercionSelfTest().switch, "INPUT_COERCION_DISABLED=true"));
});

// ---------------------------------------------------------------------------
// 2026-10-19 hardening: stringified-JSON roots/fields, bare arrays, enclosing
// quotes, number→string on every selector field (GENERIC_SELECTOR_SPEC via
// memoSchema), pinned against the REAL schemas built by buildTools().
// ---------------------------------------------------------------------------
import { GENERIC_SELECTOR_SPEC, mergeInputSpecs } from "../../functions/osint-agent/lib/tool-input-coercion.ts";

Deno.test("coerceToolInput: a stringified-JSON root parses to the object (root_json)", () => {
  const r = coerceToolInput('{"email":"a@example.com"}', {});
  assertEquals(r.value, { email: "a@example.com" });
  assertEquals(r.records, [{ field: "", coercion: "root_json" }]);
});

Deno.test("coerceToolInput: a root string that is not JSON is left alone (rejected as before)", () => {
  const r = coerceToolInput("not json", {});
  assertStrictEquals(r.value, "not json");
  assertEquals(r.records, []);
});

Deno.test("coerceToolInput: a bare array is wrapped under wrapArrayAs; without it, left alone", () => {
  const arr = [{ kind: "lesson", subject: "s", content: "abc" }];
  assertEquals(coerceToolInput(arr, { wrapArrayAs: "entries" }).value, { entries: arr });
  assertStrictEquals(coerceToolInput(arr, {}).value, arr);
});

Deno.test("coerceToolInput: jsonFields parses a stringified object/array field, including a fenced block", () => {
  const r = coerceToolInput({ artifacts: "```json\n[{\"kind\":\"email\",\"value\":\"a@b.c\"}]\n```" }, { jsonFields: ["artifacts"] });
  assertEquals(r.value, { artifacts: [{ kind: "email", value: "a@b.c" }] });
  assertEquals(r.records, [{ field: "artifacts", coercion: "json_parsed" }]);
  const bad = coerceToolInput({ artifacts: "[not json" }, { jsonFields: ["artifacts"] });
  assertEquals(bad.records, []);
});

Deno.test("coerceToolInput: enclosing quotes are stripped on trim fields; an inner quote is not", () => {
  const spec = { trimFields: ["email", "username"] };
  assertEquals(coerceToolInput({ email: "'a@example.com'" }, spec).value, { email: "a@example.com" });
  assertEquals(coerceToolInput({ email: ' "a@example.com" ' }, spec).value, { email: "a@example.com" });
  assertEquals(coerceToolInput({ username: "`handle`" }, spec).value, { username: "handle" });
  assertEquals(coerceToolInput({ email: "'a@example.com'" }, spec).records, [{ field: "email", coercion: "unquoted" }]);
  // O'Brien keeps its apostrophe; a lone quote is not a pair.
  assertEquals(coerceToolInput({ username: "o'brien" }, spec).records, []);
  assertEquals(coerceToolInput({ username: "'" }, spec).records, []);
});

Deno.test("mergeInputSpecs: the tool's lists are unioned with the generic ones, its enums win", () => {
  const m = mergeInputSpecs(GENERIC_SELECTOR_SPEC, { trimFields: ["identifierValue"], enumFields: { kind: ["a"] } });
  assert(m.trimFields!.includes("identifierValue") && m.trimFields!.includes("email"));
  assertEquals(m.enumFields, { kind: ["a"] });
});

Deno.test("PRODUCTION (2026-10-18): rapidapi_breach_search email with enclosing quotes + whitespace validates", async () => {
  await withEnv(SWITCH, undefined, () => {
    assertEquals(ok("rapidapi_breach_search", { email: " 'person@example.com' " }).email, "person@example.com");
  });
});

Deno.test("PRODUCTION (2026-10-18): minimax_correlate numeric seed + stringified artifacts validate", async () => {
  await withEnv(SWITCH, undefined, () => {
    const d = ok("minimax_correlate", { seed: 6175550100, artifacts: '[{"kind":"phone","value":"6175550100"}]' });
    assertEquals(d.seed, "6175550100");
    assertEquals((d.artifacts as Array<{ kind: string }>)[0].kind, "phone");
  });
});

Deno.test("PRODUCTION (2026-10-18): record_artifacts sent as a stringified-JSON root validates", async () => {
  await withEnv(SWITCH, undefined, () => {
    const d = ok("record_artifacts", '{"artifacts":[{"kind":"email","value":"a@example.com"}]}');
    assertEquals((d.artifacts as Array<{ value: string }>)[0].value, "a@example.com");
  });
});

Deno.test("PRODUCTION (2026-10-18): memory_save sent as a bare array (no {entries}) validates", async () => {
  await withEnv(SWITCH, undefined, () => {
    const d = ok("memory_save", [{ kind: "lesson", subject: "example.com", content: "domain is parked" }]);
    assertEquals((d.entries as Array<{ subject: string }>)[0].subject, "example.com");
    assertEquals(d.scope, "global");
    ok("memory_save", '{"entries":[{"kind":"lesson","subject":"example.com","content":"domain is parked"}]}');
  });
});

Deno.test("memoSchema: a plain tool (no explicit spec) still trims and unquotes its selector field", async () => {
  await withEnv(SWITCH, undefined, () => {
    assertEquals(ok("gravatar_profile", { email: " 'a@example.com' " }).email, "a@example.com");
  });
});

Deno.test("kill switch: INPUT_COERCION_DISABLED=true rejects the quoted email and the bare array again", async () => {
  await withEnv(SWITCH, "true", () => {
    rejected("rapidapi_breach_search", { email: "'person@example.com'" });
    rejected("memory_save", [{ kind: "lesson", subject: "s", content: "abc" }]);
  });
});
