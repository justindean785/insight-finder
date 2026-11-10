// seed_handle_guard_test.ts — a shortened form of the seed handle is a different account.
//
// Measured 2026-11-10: the seed was a dotted handle (here `sample.handle`); the model swept and breach-searched
// `sample`, a common handle owned by other people. The guard does not refuse that lookup. It taints it
// (`unproven_linkage`) so what it returns carries no subject authority, and it tells the model the exact handle.
//
// Driven through the REAL wrapper (wrapToolsWithCache) and the REAL extractor (extractFindings), because the
// property that matters is what reaches the artifact table. Values are synthetic.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { Tool } from "npm:ai@6";
import type { createClient } from "npm:@supabase/supabase-js@2";
import { wrapToolsWithCache } from "../../functions/osint-agent/cache.ts";
import { clearRuntime } from "../../functions/osint-agent/runtime-policy.ts";
import * as circuit from "../../functions/osint-agent/circuit.ts";
import { extractFindings } from "../../functions/osint-agent/auto-persist-findings.ts";
import { UNPROVEN_LINKAGE_KEY } from "../../functions/osint-agent/lib/unproven-linkage.ts";
import { detectSeedServer } from "../../functions/osint-agent/validation.ts";
import {
  isShortenedSeedHandle,
  seedHandleGuardSelfTest,
  shortenedSeedLookup,
} from "../../functions/osint-agent/lib/seed-handle-guard.ts";

type SupabaseClient = ReturnType<typeof createClient>;
const SEED = "sample.handle";
const SHORT = "sample";

function makeChain(resolveValue: { data: unknown; error: unknown }): Record<string, unknown> {
  const node: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "order", "update", "limit"]) node[m] = () => node;
  node.range = () => ({ then: (r: (x: unknown) => void) => r({ data: [], count: 0, error: null }) });
  node.maybeSingle = () => Promise.resolve(resolveValue);
  node.then = (r: (v: { data: unknown; error: unknown }) => void) => r(resolveValue);
  node.insert = () => Promise.resolve({ error: null });
  node.upsert = () => Promise.resolve({ error: null });
  return node;
}
function emptyDb(): SupabaseClient {
  const inert = makeChain({ data: [], error: null });
  return { from: () => inert, rpc: () => Promise.resolve({ data: null, error: null }) } as unknown as SupabaseClient;
}

/** A sweep-shaped result: two confirmed profile URLs for whatever handle was asked. */
function sweepTool(calls: { n: number }): Tool {
  return {
    description: "test",
    execute: (i: unknown) => {
      calls.n += 1;
      const u = String((i as { username?: string; value?: string }).username ?? (i as { value?: string }).value ?? "");
      return Promise.resolve({
        ok: true,
        username: u,
        found: [
          { site: "SiteA", url: `https://a.example/${u}` },
          { site: "SiteB", url: `https://b.example/${u}` },
        ],
        checked: 2,
      });
    },
  } as unknown as Tool;
}

let seq = 0;
function wrap(calls: { n: number }, seedHandle: string | null | undefined) {
  seq += 1;
  const investigationId = `22222222-2222-4333-8444-${String(seq).padStart(12, "0")}`;
  clearRuntime(investigationId);
  circuit.clearThread(investigationId);
  return wrapToolsWithCache(
    { username_sweep: sweepTool(calls), oathnet_lookup: sweepTool(calls), breach_check: sweepTool(calls) },
    { investigationId, userId: "u1", supabase: emptyDb(), ...(seedHandle === undefined ? {} : { seedHandle }) },
  );
}
// deno-lint-ignore no-explicit-any
const run = (tools: Record<string, Tool>, name: string, input: unknown) => (tools[name] as any).execute(input, {}) as Promise<Record<string, any>>;
const marker = (out: Record<string, unknown>) => (out._runtime as Record<string, unknown> | undefined)?.[UNPROVEN_LINKAGE_KEY] as Record<string, unknown> | undefined;
const hint = (out: Record<string, unknown>) => (out._runtime as Record<string, unknown> | undefined)?.seed_handle_hint as string | undefined;

// ── the predicate ─────────────────────────────────────────────────────────────
Deno.test("a shortened form is a proper prefix of the dotted seed, cut at a dot — nothing else", () => {
  assert(isShortenedSeedHandle(SEED, "sample"));
  assert(isShortenedSeedHandle(SEED, "@Sample"));
  assert(isShortenedSeedHandle("first.last.priv", "first.last"));
  assert(isShortenedSeedHandle("first.last.priv", "first"));
  assert(!isShortenedSeedHandle(SEED, SEED), "the exact seed");
  assert(!isShortenedSeedHandle(SEED, "samplehandle"), "the cluster engine treats the stripped spelling as the same handle");
  assert(!isShortenedSeedHandle(SEED, "sam"), "not cut at a dot");
  assert(!isShortenedSeedHandle(SEED, "handle"), "a suffix label");
  assert(!isShortenedSeedHandle(SEED, "sample.handle.extra"), "longer than the seed");
  assert(!isShortenedSeedHandle("samplehandle", "sample"), "an undotted seed never engages");
  assert(!isShortenedSeedHandle(SEED, ""));
});

Deno.test("only handle lookups engage; a run with no username seed never does", () => {
  assert(shortenedSeedLookup(SEED, ["username"], SHORT));
  assert(shortenedSeedLookup(SEED, ["value", "username"], SHORT), "oathnet {type:'username', value}");
  assert(shortenedSeedLookup(SEED, ["value"], SHORT), "breach_check {value}");
  assertEquals(shortenedSeedLookup(SEED, ["email"], SHORT), null);
  assertEquals(shortenedSeedLookup(SEED, ["domain"], SHORT), null);
  assertEquals(shortenedSeedLookup(null, ["username"], SHORT), null);
  assertEquals(shortenedSeedLookup("", ["username"], SHORT), null);
});

// ── through the real wrapper ──────────────────────────────────────────────────
Deno.test("END TO END: a dotted seed types as a username, and the handle the guard holds is the full dotted value", () => {
  const d = detectSeedServer(SEED);
  assertEquals(d?.kind, "username");
  assertEquals(d?.normalized, SEED);
});

Deno.test("a sweep of the EXACT seed handle runs clean: no taint, no hint, findings keep subject authority", async () => {
  const calls = { n: 0 };
  const tools = wrap(calls, SEED);
  const out = await run(tools, "username_sweep", { username: SEED });
  assertEquals(calls.n, 1);
  assertEquals(marker(out), undefined);
  assertEquals(hint(out), undefined);
  const findings = extractFindings("username_sweep", out, { username: SEED });
  assert(findings.length > 0, "the sweep yields findings");
  for (const f of findings) assert((f.context as Record<string, unknown>)?.subject_unlinked !== true, `${f.kind} stayed linked`);
});

Deno.test("a sweep of the SHORTENED handle still runs, tainted, and every finding it yields is subject_unlinked", async () => {
  const calls = { n: 0 };
  const tools = wrap(calls, SEED);
  const out = await run(tools, "username_sweep", { username: SHORT });
  assertEquals(calls.n, 1, "the lookup is allowed — nothing is refused");
  assertEquals(out.ok, true);
  const m = marker(out);
  assert(m, "the result carries the unproven-linkage marker");
  assertEquals(m!.parent_type, "username");
  assertEquals(m!.parent_value, SHORT);
  assert(String(m!.parent_reason).includes(SEED), "the reason names the exact seed handle");
  assert(hint(out)?.includes(`exact handle "${SEED}"`), "the model is told which handle to look up");

  const findings = extractFindings("username_sweep", out, { username: SHORT });
  assert(findings.length > 0);
  for (const f of findings) {
    const ctx = f.context as Record<string, unknown>;
    assertEquals(ctx.subject_unlinked, true, `${f.kind} must not inherit subject authority`);
    assertEquals(ctx.unproven_linkage_parent, `username:${SHORT}`);
  }
});

Deno.test("the typed and untyped breach slots are covered too", async () => {
  const calls = { n: 0 };
  const tools = wrap(calls, SEED);
  assert(marker(await run(tools, "oathnet_lookup", { type: "username", value: SHORT })), "oathnet {type:'username'}");
  assert(marker(await run(tools, "breach_check", { value: SHORT })), "breach_check {value}");
  assertEquals(marker(await run(tools, "oathnet_lookup", { type: "username", value: SEED })), undefined, "the exact handle is clean");
  assertEquals(marker(await run(tools, "oathnet_lookup", { type: "email", value: "sample@example.test" })), undefined, "an email is not a handle lookup");
});

Deno.test("`force` does not shed the taint", async () => {
  const calls = { n: 0 };
  const out = await run(wrap(calls, SEED), "username_sweep", { username: SHORT, force: true });
  assert(marker(out));
});

Deno.test("no seed handle (any non-username seed, or a caller that does not pass one) ⇒ the wrapper behaves as before", async () => {
  for (const seedHandle of [null, undefined, ""]) {
    const calls = { n: 0 };
    const out = await run(wrap(calls, seedHandle), "username_sweep", { username: SHORT });
    assertEquals(marker(out), undefined);
    assertEquals(hint(out), undefined);
  }
});

Deno.test("kill switch SEED_HANDLE_GUARD_DISABLED=true (read at call time) removes the taint and /health reports LEGACY", async () => {
  const prior = Deno.env.get("SEED_HANDLE_GUARD_DISABLED");
  try {
    Deno.env.set("SEED_HANDLE_GUARD_DISABLED", "true");
    const calls = { n: 0 };
    const out = await run(wrap(calls, SEED), "username_sweep", { username: SHORT });
    assertEquals(marker(out), undefined);
    const t = seedHandleGuardSelfTest();
    assert(t.ok && !t.enabled && t.detail.startsWith("LEGACY"), t.detail);
  } finally {
    if (prior === undefined) Deno.env.delete("SEED_HANDLE_GUARD_DISABLED"); else Deno.env.set("SEED_HANDLE_GUARD_DISABLED", prior);
  }
  const calls = { n: 0 };
  assert(marker(await run(wrap(calls, SEED), "username_sweep", { username: SHORT })), "back on once the switch is cleared");
});

Deno.test("the /health self-test engages and reports ok", () => {
  const t = seedHandleGuardSelfTest();
  assert(t.ok, t.detail);
  assertEquals(t.switch, "SEED_HANDLE_GUARD_DISABLED=false");
});

Deno.test("WIRING (source assertions): index.ts feeds the guard the username seed, cache.ts applies it, /health publishes it, the prompt says it", async () => {
  const read = (p: string) => Deno.readTextFile(new URL(`../../functions/osint-agent/${p}`, import.meta.url));
  const index = await read("index.ts");
  assert(index.includes('return s && s.kind === "username" ? s.normalized : null;'));
  assert(index.includes("seedHandle: seedHandleForGuard,"));
  const cache = await read("cache.ts");
  assert(cache.includes("shortenedSeedLookup(ctx.seedHandle, candidateTypes, selectorValue)"));
  assert(cache.includes("...(seedHandleHint ? { seed_handle_hint: seedHandleHint } : {}),"));
  const health = await read("health-handler.ts");
  assert(health.includes("r.checks.seed_handle_guard = seedHandleGuardSelfTest();"));
  const prompt = await read("system-prompt.ts");
  assert(prompt.includes("Never drop a suffix"));
});
