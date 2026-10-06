// opsis_wiring_test.ts — the opsis_* tools as the runtime actually ships them.
//
// lib/opsis_test.ts covers the client. This file drives the WIRING: the real
// registry closure, the real cache wrapper's dispatch guard, the paid-budget
// predicate and the schema readiness gate. A behavioural test must drive the
// shipped control flow, never re-describe it.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { Tool } from "npm:ai@6";
import type { createClient } from "npm:@supabase/supabase-js@2";
import { buildTools, type ToolContext } from "./tool-registry.ts";
import { paidBudgetTier, wrapToolsWithCache } from "./cache.ts";
import { costForTool } from "./costs.ts";
import { discoverCapabilities } from "./capabilities.ts";
import { clearRuntime } from "./runtime-policy.ts";
import * as circuit from "./circuit.ts";
import { REJECTED_DISPATCH_REFUSAL_MARKER } from "./lib/dispatch-rejection.ts";

type SupabaseClient = ReturnType<typeof createClient>;
type Exec = { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> };

const OPSIS_TOOLS = ["opsis_search", "opsis_results", "opsis_balance", "opsis_status"];

function stubCtx(): ToolContext {
  return {
    supabase: {},
    supabaseAdmin: {},
    userId: "opsis-wiring-user",
    threadId: "opsis-wiring-thread",
    archiveEnabled: false,
    detectedSeedType: "username",
    messages: [],
    manualOverrideSelector: null,
  } as unknown as ToolContext;
}

// ── Registry ────────────────────────────────────────────────────────────────

Deno.test("registry: all four opsis tools are built", () => {
  const { tools } = buildTools(stubCtx());
  for (const n of OPSIS_TOOLS) assert(n in tools, `${n} missing from buildTools()`);
});

Deno.test("registry: with no key, the shipped opsis_search closure skips without a network call", async () => {
  const saved = Deno.env.get("OPSIS_API_KEY");
  Deno.env.delete("OPSIS_API_KEY");
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (() => { fetched += 1; return Promise.reject(new Error("no network in this test")); }) as typeof fetch;
  try {
    const { tools } = buildTools(stubCtx());
    const out = await (tools.opsis_search as unknown as Exec).execute(
      { kind: "username", value: "jordanvale" },
      { toolCallId: "t1", messages: [] },
    );
    assertEquals(out.skipped, true);
    assertEquals(out.provider_attempted, false);
    assertEquals(out.error, "OPSIS_API_KEY not configured");
    assertEquals(fetched, 0);
  } finally {
    globalThis.fetch = realFetch;
    if (saved !== undefined) Deno.env.set("OPSIS_API_KEY", saved);
  }
});

// Codex P2 on #659: costs.ts prices per tool NAME, so a 2-credit premium search
// would be booked as 1. Premium is therefore not offered to the model.
Deno.test("registry: opsis_search offers no premium input (its 2nd credit cannot be priced)", async () => {
  const { tools } = buildTools(stubCtx());
  const schema = (tools.opsis_search as unknown as { inputSchema: unknown }).inputSchema as Record<string, unknown>;
  const src = await Deno.readTextFile(new URL("./tool-registry.ts", import.meta.url));
  const block = src.slice(src.indexOf("opsis_search: tool({"), src.indexOf("opsis_results: tool({"));
  assert(block.length > 0);
  assertEquals(/premium\s*:/.test(block), false, "no premium field in the opsis_search schema or call");
  assert(schema !== undefined);
});

// ── Paid budget ─────────────────────────────────────────────────────────────

Deno.test("budget: a search takes a paid slot; reading a run, balance and status do not", () => {
  assert(paidBudgetTier(costForTool("opsis_search"), "opsis_search") !== "free");
  for (const n of ["opsis_results", "opsis_balance", "opsis_status"]) {
    assertEquals(paidBudgetTier(costForTool(n), n), "free", n);
  }
});

// ── Schema readiness gate ───────────────────────────────────────────────────

Deno.test("capabilities: no key removes every opsis tool from the schema; a key restores them", () => {
  const without = discoverCapabilities({}, "username").filter((c) => OPSIS_TOOLS.includes(c.tool));
  assertEquals(without.length, OPSIS_TOOLS.length);
  assert(without.every((c) => !c.available && c.reason === "missing_key"));
  const withKey = discoverCapabilities({ OPSIS_API_KEY: true }, "username").filter((c) => OPSIS_TOOLS.includes(c.tool));
  assert(withKey.every((c) => c.available));
});

// ── Dispatch guard ──────────────────────────────────────────────────────────
//
// The input is {kind, value} ON PURPOSE: the wrapper's selector detection reads
// `kind`/`value` (and email/username/domain) but not `type`/`query`. With the
// brief's original {type, query} shape the selector would read as empty, and the
// analyst-rejection guard and the quarantine taint would silently not apply.

const REJECTED_HANDLE = "jordan.vale";
const REJECTED_EMAIL = "wrong.person@example.test";

function chain(v: { data: unknown; error: unknown }): Record<string, unknown> {
  const n: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "order", "update", "limit", "range"]) n[m] = () => n;
  n.maybeSingle = () => Promise.resolve(v);
  n.then = (r: (x: { data: unknown; error: unknown }) => void) => r(v);
  n.insert = () => Promise.resolve({ error: null });
  n.upsert = () => Promise.resolve({ error: null });
  return n;
}

function db(): SupabaseClient {
  const artifacts = chain({
    data: [
      { id: "a1", kind: "handle", value: REJECTED_HANDLE, confidence: 60, source: "sherlock", metadata: {} },
      { id: "a2", kind: "email", value: REJECTED_EMAIL, confidence: 70, source: "hibp", metadata: {} },
    ],
    error: null,
  });
  const reviews = chain({
    data: [
      { artifact_id: "a1", state: "wrong", note: null },
      { artifact_id: "a2", state: "dismissed", note: null },
    ],
    error: null,
  });
  const inert = chain({ data: [], error: null });
  return {
    from: (t: string) => (t === "artifacts" ? artifacts : t === "artifact_reviews" ? reviews : inert),
    rpc: () => Promise.resolve({ data: null, error: null }),
  } as unknown as SupabaseClient;
}

let seq = 0;
const COMPLETED = { ok: true, source: "opsis", run_id: "r", run_status: "completed", complete: true, results: [] };
const PARTIAL = { ok: true, partial: true, source: "opsis", run_id: "r", run_status: "running", complete: false, results: [] };

function wrapOpsis(calls: { n: number }, result: Record<string, unknown> = COMPLETED) {
  seq += 1;
  const investigationId = `33333333-4444-4555-8666-${String(seq).padStart(12, "0")}`;
  clearRuntime(investigationId);
  circuit.clearThread(investigationId);
  const counting = {
    description: "opsis_search stand-in",
    execute: () => { calls.n += 1; return Promise.resolve({ ...result }); },
  } as unknown as Tool;
  return wrapToolsWithCache({ opsis_search: counting }, { investigationId, userId: "u1", supabase: db() });
}

for (const [label, input] of [
  ["a rejected username", { kind: "username", value: "Jordan.Vale" }],
  ["a rejected email", { kind: "email", value: "Wrong.Person@Example.test" }],
] as const) {
  Deno.test(`dispatch: ${label} is refused before opsis_search runs (no credit spent)`, async () => {
    const calls = { n: 0 };
    const wrapped = wrapOpsis(calls);
    const out = await (wrapped.opsis_search as unknown as Exec).execute({ ...input }, { toolCallId: "d1", messages: [] });
    assertEquals(calls.n, 0, "the paid tool must never run on a rejected selector");
    assertEquals(out.ok, false);
    assertEquals(out.refused_by, REJECTED_DISPATCH_REFUSAL_MARKER);
  });
}

Deno.test("dispatch: a clean selector still runs (the guard is not a blanket refusal)", async () => {
  const calls = { n: 0 };
  const wrapped = wrapOpsis(calls);
  await (wrapped.opsis_search as unknown as Exec).execute({ kind: "username", value: "someone_else" }, { toolCallId: "d2", messages: [] });
  assertEquals(calls.n, 1);
});

Deno.test("dispatch: a repeat search of a COMPLETED run replays from cache — no second credit", async () => {
  const calls = { n: 0 };
  const exec = (wrapOpsis(calls).opsis_search as unknown as Exec).execute;
  await exec({ kind: "username", value: "done_handle" }, { toolCallId: "c1", messages: [] });
  const again = await exec({ kind: "username", value: "done_handle" }, { toolCallId: "c2", messages: [] });
  assertEquals(calls.n, 1);
  assertEquals(again._cached, true);
});

Deno.test("dispatch: a repeat search of a PARTIAL run is refused free — finish it with opsis_results", async () => {
  // A partial run is never cached (cache.ts isCacheableToolResult), so without
  // PREMIUM_TOOLS the repeat would reach Opsis and spend a second credit.
  const calls = { n: 0 };
  const exec = (wrapOpsis(calls, PARTIAL).opsis_search as unknown as Exec).execute;
  await exec({ kind: "username", value: "slow_handle" }, { toolCallId: "p1", messages: [] });
  const second = await exec({ kind: "username", value: "Slow_Handle" }, { toolCallId: "p2", messages: [] });
  assertEquals(calls.n, 1, "the paid search must not run twice for one entity");
  assert(JSON.stringify(second).includes("already ran for this entity"), JSON.stringify(second));
  // A different entity is unaffected.
  await exec({ kind: "username", value: "another_handle" }, { toolCallId: "p3", messages: [] });
  assertEquals(calls.n, 2);
});
