// correlate_seed_default_test.ts — a minimax_correlate call with no seed uses the request's own seed.
//
// MEASURED (thread 0ea52455, 2026-10-21): `{artifacts: "<json>"}` with no `seed`, rejected before
// execute. The schema cache is module-global, so the fallback resolves in execute from the
// request (lib/thread-seed.ts). Synthetic values only.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildTools, type ToolContext } from "../../functions/osint-agent/tool-registry.ts";
import { detectSeedServer } from "../../functions/osint-agent/validation.ts";
import {
  THREAD_SEED_KINDS,
  correlateSeedDefaultSelfTest,
  firstUserText,
  resolveCorrelateSeed,
  threadSeedFromMessages,
} from "../../functions/osint-agent/lib/thread-seed.ts";

type Row = Record<string, unknown>;
const user = (text: string) => ({ role: "user", parts: [{ type: "text", text }] });

Deno.test("firstUserText: the FIRST user message's text parts, joined; assistant and non-text parts ignored", () => {
  const msgs = [
    { role: "assistant", parts: [{ type: "text", text: "hello" }] },
    { role: "user", parts: [{ type: "file", text: "nope" }, { type: "text", text: " a " }, { type: "text", text: "b" }] },
    user("later"),
  ];
  assertEquals(firstUserText(msgs).replace(/\s+/g, " "), "a b");
  assertEquals(firstUserText([]), "");
  assertEquals(firstUserText(null), "");
});

Deno.test("threadSeedFromMessages: a STRUCTURAL selector in the first message is the seed; prose (which detectSeedServer labels `person`), `other`, blanks and oversize are null", () => {
  assertEquals(threadSeedFromMessages([user(" Synthetic.Person@Example.test ")], detectSeedServer), "synthetic.person@example.test");
  assertEquals(threadSeedFromMessages([user("@Synthetic_Handle")], detectSeedServer), "synthetic_handle");
  assertEquals(threadSeedFromMessages([user("203.0.113.9")], detectSeedServer), "203.0.113.9");
  // Measured 2026-10-23: detectSeedServer returns kind "person" for these — a word count, not a shape.
  assertEquals(detectSeedServer("please look into the thing I mentioned yesterday")?.kind, "person");
  assertEquals(threadSeedFromMessages([user("please look into the thing I mentioned yesterday")], detectSeedServer), null);
  assertEquals(threadSeedFromMessages([user("Synthetic Person")], detectSeedServer), null, "a name is never a fallback seed");
  assert(!THREAD_SEED_KINDS.has("person") && !THREAD_SEED_KINDS.has("other"));
  assertEquals(threadSeedFromMessages([user("")], detectSeedServer), null);
  assertEquals(threadSeedFromMessages([user("x".repeat(600))], detectSeedServer), null);
  assertEquals(threadSeedFromMessages([user("a@b.c")], () => { throw new Error("boom"); }), null, "a detector fault is a null, never a throw");
});

Deno.test("resolveCorrelateSeed: sent seed wins; then the subject name; then the thread seed; else null with what was tried", () => {
  const msgs = [user("synthetic.person@example.test")];
  assertEquals(resolveCorrelateSeed({ seed: " sent ", subjectName: "S", messages: msgs, detect: detectSeedServer }), { seed: "sent", source: "input", tried: [] });
  assertEquals(resolveCorrelateSeed({ seed: "", subjectName: " Synthetic Person ", messages: msgs, detect: detectSeedServer }), { seed: "Synthetic Person", source: "subject_name", tried: [] });
  assertEquals(resolveCorrelateSeed({ seed: undefined, subjectName: "", messages: msgs, detect: detectSeedServer }), { seed: "synthetic.person@example.test", source: "thread_seed", tried: ["subject_name"] });
  assertEquals(resolveCorrelateSeed({ seed: 42, subjectName: null, messages: [user("some prose")], detect: detectSeedServer }), { seed: "", source: null, tried: ["subject_name", "thread_seed"] });
});

Deno.test("health self-test passes and says what it proves", () => {
  const t = correlateSeedDefaultSelfTest();
  assert(t.ok, t.detail);
  assertStringIncludes(t.detail, "never prose");
});

// ── The real tool ────────────────────────────────────────────────────────

function toolsWith(messages: unknown[], subjectName = "") {
  const ctx = {
    supabase: {}, supabaseAdmin: {}, userId: "seed-user", threadId: "seed-thread", archiveEnabled: false,
    detectedSeedType: "email", messages, manualOverrideSelector: null,
    getSubjectSeedName: () => subjectName,
  } as unknown as ToolContext;
  return buildTools(ctx).tools as Record<string, { execute: (i: unknown, o: unknown) => Promise<unknown> }>;
}
const ARTS = [{ kind: "email", value: "synthetic.person@example.test" }];

Deno.test("execute: no seed and nothing to fall back to → the existing uncharged skip, now naming what was tried (provider never called)", async () => {
  const out = await toolsWith([user("look into this for me")]).minimax_correlate.execute({ artifacts: ARTS }, { toolCallId: "c1", messages: [] }) as Row;
  assertEquals(out.ok, false);
  assertEquals(out.skipped, true);
  assertEquals(out.provider_attempted, false);
  assertStringIncludes(String(out.detail), "seed missing");
  assertStringIncludes(String(out.detail), "tried: subject_name, thread_seed");
  assertEquals((out.guard_state as Row).seedSource, null);
});

Deno.test("execute: no seed, but the first user message is a selector → the call proceeds past the input guard with seed_source disclosed", async () => {
  const logged: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
  let out: Row;
  try {
    out = await toolsWith([user("synthetic.person@example.test")]).minimax_correlate.execute({ artifacts: ARTS }, { toolCallId: "c2", messages: [], abortSignal: AbortSignal.abort() }) as Row;
  } finally {
    console.log = orig;
  }
  // Past the guard: the provider call is handed an already-aborted signal (providers.ts bails on
  // it, no network), so whatever shape comes back, this is NOT the input skip.
  assert(out.skipped !== true, JSON.stringify(out));
  assert(!String(out.detail ?? "").includes("no valid inputs"), JSON.stringify(out));
  const evt = logged.map((l) => { try { return JSON.parse(l) as Row; } catch { return null; } }).find((e) => e?.event === "correlate_seed_defaulted");
  assert(evt, "a correlate_seed_defaulted event is logged");
  assertEquals(evt!.source, "thread_seed");
  assertEquals(evt!.thread_id, "seed-thread");
  assert(!logged.some((l) => l.includes("synthetic.person@example.test")), "the event never carries the value");
});

Deno.test("execute: the person seed outranks the first message", async () => {
  const logged: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
  try {
    await toolsWith([user("synthetic.person@example.test")], "Synthetic Person").minimax_correlate.execute({ artifacts: ARTS }, { toolCallId: "c3", messages: [], abortSignal: AbortSignal.abort() });
  } finally {
    console.log = orig;
  }
  const evt = logged.map((l) => { try { return JSON.parse(l) as Row; } catch { return null; } }).find((e) => e?.event === "correlate_seed_defaulted");
  assertEquals(evt?.source, "subject_name");
});

Deno.test("execute: a sent seed is used as before and logs no default event", async () => {
  const logged: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
  try {
    await toolsWith([user("synthetic.person@example.test")]).minimax_correlate.execute({ seed: "sent_seed", artifacts: ARTS }, { toolCallId: "c4", messages: [], abortSignal: AbortSignal.abort() });
  } finally {
    console.log = orig;
  }
  assert(!logged.some((l) => l.includes("correlate_seed_defaulted")));
});

Deno.test("wiring (source-level): execute resolves the seed before the input guard, never from triageState; /health registers the key", async () => {
  const src = await Deno.readTextFile(new URL("../../functions/osint-agent/tool-registry.ts", import.meta.url));
  const start = src.indexOf("minimax_correlate: tool({");
  const end = src.indexOf("minimax_plan_pivots: tool({", start);
  const body = src.slice(start, end);
  const resolveAt = body.indexOf("resolveCorrelateSeed({");
  assert(resolveAt > 0, "execute must call the resolver");
  assert(resolveAt < body.indexOf("skipStub("), "resolve before the input guard");
  assert(!body.includes("triageState.seed"), "never the module-global triage state");
  assert(body.includes("seed: z.string().optional()"), "seed is optional at the schema");
  const h = await Deno.readTextFile(new URL("../../functions/osint-agent/health-handler.ts", import.meta.url));
  assert(h.includes("r.checks.correlate_seed_default = correlateSeedDefaultSelfTest();"));
});
