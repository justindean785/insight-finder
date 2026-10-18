// dispatch_selector_aliases_test.ts — tools whose selector lives in a field the
// central detector does not read.
//
// `detectSelectorType` / `detectSelectorValue` (cache.ts) recognise `value`,
// `email`, `username`, … but not Serus's `identifierValue` / `identifierType`,
// the Indicia tools' `query`, or CordCat's `discord_id`. For those calls the
// selector came out EMPTY, and an empty selector fails open at both dispatch
// checks: an analyst-REJECTED email still reached a paid Serus or Indicia call,
// and a QUARANTINED selector was dispatched WITHOUT the `unproven_linkage` taint,
// so its results could persist at full subject authority.
//
// These tests drive the REAL wrap path (wrapToolsWithCache). The cache and
// circuit identity of every call must not change: the extra candidates are for
// the two dispatch checks only.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { Tool } from "npm:ai@6";
import type { createClient } from "npm:@supabase/supabase-js@2";
import { wrapToolsWithCache } from "../../functions/osint-agent/cache.ts";
import { clearRuntime } from "../../functions/osint-agent/runtime-policy.ts";
import * as circuit from "../../functions/osint-agent/circuit.ts";
import { REJECTED_DISPATCH_REFUSAL_MARKER } from "../../functions/osint-agent/lib/dispatch-rejection.ts";
import { UNPROVEN_LINKAGE_KEY } from "../../functions/osint-agent/lib/unproven-linkage.ts";

type SupabaseClient = ReturnType<typeof createClient>;
type Exec = { execute: (i: unknown, o: unknown) => Promise<unknown> };

const REJECTED_EMAIL = "wrong.person@example.test";
const REJECTED_HANDLE = "jordan.vale";
// Stored the way validation.ts writes phones: canonical E.164.
const REJECTED_PHONE = "+15550100000";
const REJECTED_DOMAIN = "example.com";
const REJECTED_DISCORD = "123456789012345678";
const QUARANTINED_EMAIL = "namesake@example.test";
const QUARANTINED_PHONE = "+15550109999";
const CLEAN_EMAIL = "real@example.test";

function makeChain(resolveValue: { data: unknown; error: unknown }): Record<string, unknown> {
  const node: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "order", "update", "limit", "gte", "neq", "not", "is", "or"]) node[m] = () => node;
  const all = Array.isArray(resolveValue.data) ? resolveValue.data as unknown[] : null;
  node.range = (from: number, to: number) => {
    const v = all === null ? resolveValue : { data: all.slice(from, to + 1), count: all.length, error: resolveValue.error };
    return { then: (r: (x: unknown) => void) => r(v) };
  };
  node.maybeSingle = () => Promise.resolve(resolveValue);
  node.then = (r: (v: { data: unknown; error: unknown }) => void) => r(resolveValue);
  return node;
}

function fakeSupabase(cacheWrites: Array<Record<string, unknown>> = []): SupabaseClient {
  const artifactRows = [
    { id: "r1", kind: "email", value: REJECTED_EMAIL, confidence: 70, source: "hibp", metadata: {} },
    { id: "r2", kind: "handle", value: REJECTED_HANDLE, confidence: 60, source: "sherlock", metadata: {} },
    { id: "r3", kind: "phone", value: REJECTED_PHONE, confidence: 60, source: "indicia_phone", metadata: {} },
    { id: "r4", kind: "account_id", value: REJECTED_DISCORD, confidence: 55, source: "cordcat", metadata: {} },
    {
      id: "q1", kind: "email", value: QUARANTINED_EMAIL, confidence: 60, source: "minimax_web_search",
      metadata: { subject_unlinked: true, subject_unlinked_reason: "name-only echo" },
    },
    { id: "r5", kind: "domain", value: REJECTED_DOMAIN, confidence: 60, source: "crtsh", metadata: {} },
    {
      id: "q2", kind: "phone", value: QUARANTINED_PHONE, confidence: 55, source: "minimax_web_search",
      metadata: { subject_unlinked: true, subject_unlinked_reason: "name-only echo" },
    },
    { id: "c1", kind: "email", value: CLEAN_EMAIL, confidence: 90, source: "hibp", metadata: {} },
  ];
  const reviewRows = [
    { artifact_id: "r1", state: "dismissed", note: null },
    { artifact_id: "r2", state: "wrong", note: null },
    { artifact_id: "r3", state: "dismissed", note: null },
    { artifact_id: "r4", state: "wrong", note: null },
    { artifact_id: "r5", state: "dismissed", note: null },
  ];
  const inert = makeChain({ data: [], error: null });
  inert.insert = () => Promise.resolve({ error: null });
  inert.upsert = () => Promise.resolve({ error: null });
  const cache = makeChain({ data: [], error: null });
  cache.insert = () => Promise.resolve({ error: null });
  cache.upsert = (row: Record<string, unknown>) => {
    cacheWrites.push(row);
    return Promise.resolve({ error: null });
  };
  const artifacts = makeChain({ data: artifactRows, error: null });
  artifacts.insert = () => Promise.resolve({ error: null });
  const reviews = makeChain({ data: reviewRows, error: null });
  return {
    from: (t: string) =>
      t === "artifacts" ? artifacts : t === "artifact_reviews" ? reviews : t === "tool_call_cache" ? cache : inert,
    rpc: () => Promise.resolve({ data: null, error: null }),
  } as unknown as SupabaseClient;
}

function countingTool(calls: { n: number }): Tool {
  return {
    description: "test",
    execute: (_i: unknown, _o: unknown) => { calls.n += 1; return Promise.resolve({ ok: true, hit: true, results: [{ x: 1 }] }); },
  } as unknown as Tool;
}

let threadSeq = 0;
function wrap(calls: { n: number }, db: SupabaseClient = fakeSupabase()) {
  threadSeq += 1;
  const investigationId = `33333333-4444-4555-8666-${String(threadSeq).padStart(12, "0")}`;
  clearRuntime(investigationId);
  circuit.clearThread(investigationId);
  const tool = countingTool(calls);
  return wrapToolsWithCache({
    serus_darkweb_scan: tool,
    indicia_email: tool,
    indicia_phone: tool,
    cordcat_discord_lookup: tool,
    exa_search: tool,
    oathnet_breach_dbnames: tool,
    indicia_web_dbs: tool,
    indicia_hudsonrock: tool,
    // Any tool whose phone sits in the central `phone` field.
    phone_lookup: tool,
  }, { investigationId, userId: "u1", supabase: db });
}

function withSwitch<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const k = "DISPATCH_SELECTOR_ALIASES_DISABLED";
  const prev = Deno.env.get(k);
  if (value === undefined) Deno.env.delete(k); else Deno.env.set(k, value);
  return fn().finally(() => { if (prev === undefined) Deno.env.delete(k); else Deno.env.set(k, prev); });
}

const refusedBy = (out: unknown) => (out as Record<string, unknown>)?.refused_by;
function taintOf(out: unknown): Record<string, unknown> | null {
  const runtime = (out as Record<string, unknown>)?._runtime as Record<string, unknown> | undefined;
  const raw = runtime?.[UNPROVEN_LINKAGE_KEY];
  return raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
}

// ── analyst rejection reaches the paid tools ─────────────────────────────────
Deno.test("Serus {identifierValue, identifierType:'email'} on a rejected email is refused before the call", async () => {
  const calls = { n: 0 };
  const out = await (wrap(calls).serus_darkweb_scan as Exec)
    .execute({ identifierValue: "Wrong.Person@Example.test", identifierType: "email" }, {});
  assertEquals(calls.n, 0, "the paid call must not run");
  assertEquals(refusedBy(out), REJECTED_DISPATCH_REFUSAL_MARKER);
});

Deno.test("Serus keyword search for a rejected handle is refused", async () => {
  const calls = { n: 0 };
  await (wrap(calls).serus_darkweb_scan as Exec).execute({ identifierValue: "@Jordan.Vale", identifierType: "keyword" }, {});
  assertEquals(calls.n, 0);
});

Deno.test("Indicia {query} on a rejected email and on a rejected phone (any format) is refused", async () => {
  const calls = { n: 0 };
  const tools = wrap(calls);
  await (tools.indicia_email as Exec).execute({ query: REJECTED_EMAIL }, {});
  await (tools.indicia_phone as Exec).execute({ query: "+1 (555) 010-0000" }, {});
  assertEquals(calls.n, 0);
});

Deno.test("CordCat {discord_id} on a rejected account id is refused", async () => {
  const calls = { n: 0 };
  const out = await (wrap(calls).cordcat_discord_lookup as Exec).execute({ discord_id: REJECTED_DISCORD }, {});
  assertEquals(calls.n, 0);
  assertEquals(refusedBy(out), REJECTED_DISPATCH_REFUSAL_MARKER);
});

Deno.test("a rejected phone stored as +1… is refused however the call spells it (alias and central field)", async () => {
  const calls = { n: 0 };
  const tools = wrap(calls);
  await (tools.indicia_phone as Exec).execute({ query: "5550100000" }, {});
  await (tools.indicia_phone as Exec).execute({ query: "(555) 010-0000" }, {});
  await (tools.phone_lookup as Exec).execute({ phone: "555-010-0000" }, {});
  await (tools.phone_lookup as Exec).execute({ phone: "15550100000" }, {});
  assertEquals(calls.n, 0, "the stored form is +15550100000; every spelling of that number must be refused");
});

Deno.test("a bare username reaches the boundary on tools whose query IS a selector", async () => {
  const calls = { n: 0 };
  const tools = wrap(calls);
  await (tools.indicia_web_dbs as Exec).execute({ query: "@Jordan.Vale" }, {});
  await (tools.indicia_hudsonrock as Exec).execute({ query: "Jordan.Vale", type: "username" }, {});
  assertEquals(calls.n, 0);
});

Deno.test("oathnet_breach_dbnames q is a database-name fragment, never a selector", async () => {
  const calls = { n: 0 };
  await (wrap(calls).oathnet_breach_dbnames as Exec).execute({ q: REJECTED_DOMAIN }, {});
  assertEquals(calls.n, 1, "a DB-name search for 'example.com' is not a lookup on the rejected domain");
});

// ── quarantine taint reaches them too ─────────────────────────────────────────
Deno.test("Serus on a QUARANTINED email runs, and its result carries the unproven-linkage taint", async () => {
  const calls = { n: 0 };
  const out = await (wrap(calls).serus_darkweb_scan as Exec)
    .execute({ identifierValue: QUARANTINED_EMAIL, identifierType: "email" }, {});
  assertEquals(calls.n, 1, "promotion quarantine: the lookup itself is allowed");
  const taint = taintOf(out);
  assert(taint, "the result must be tainted so nothing it finds inherits subject authority");
});

Deno.test("a QUARANTINED phone stored as +1… taints the same number spelled without the country code", async () => {
  const calls = { n: 0 };
  const out = await (wrap(calls).indicia_phone as Exec).execute({ query: "555 010 9999" }, {});
  assertEquals(calls.n, 1);
  assert(taintOf(out), "the lookup on a quarantined number must carry the unproven-linkage taint");
});

// ── what must NOT change ──────────────────────────────────────────────────────
Deno.test("a clean Serus email still dispatches, untainted", async () => {
  const calls = { n: 0 };
  const out = await (wrap(calls).serus_darkweb_scan as Exec).execute({ identifierValue: CLEAN_EMAIL, identifierType: "email" }, {});
  assertEquals(calls.n, 1);
  assertEquals(taintOf(out), null);
});

Deno.test("a free-text query that merely CONTAINS a rejected email is not refused (exact selector only)", async () => {
  const calls = { n: 0 };
  await (wrap(calls).exa_search as Exec).execute({ query: `"${REJECTED_EMAIL}" leak OR breach` }, {});
  assertEquals(calls.n, 1);
});

Deno.test("a Serus password search is never used as a dispatch selector", async () => {
  const calls = { n: 0 };
  await (wrap(calls).serus_darkweb_scan as Exec).execute({ identifierValue: REJECTED_EMAIL, identifierType: "password" }, {});
  assertEquals(calls.n, 1, "a password value is not a selector and must not be matched against reviews");
});

Deno.test("the cache identity of a call is unchanged by the dispatch aliases", async () => {
  const on: Array<Record<string, unknown>> = [];
  const off: Array<Record<string, unknown>> = [];
  const input = { identifierValue: CLEAN_EMAIL, identifierType: "email" };
  await withSwitch(undefined, () => (wrap({ n: 0 }, fakeSupabase(on)).serus_darkweb_scan as Exec).execute(input, {}));
  await withSwitch("true", () => (wrap({ n: 0 }, fakeSupabase(off)).serus_darkweb_scan as Exec).execute(input, {}));
  assertEquals(on.length, 1, "the clean call is cached once");
  assertEquals(off.length, 1);
  const id = (w: Record<string, unknown>) =>
    ({ input_hash: w.input_hash, selector_type: w.selector_type, selector_normalized: w.selector_normalized, params_hash: w.params_hash });
  assertEquals(id(on[0]), id(off[0]));
});

Deno.test("KILL SWITCH: DISPATCH_SELECTOR_ALIASES_DISABLED=true restores the previous behaviour", async () => {
  const calls = { n: 0 };
  await withSwitch("true", async () => {
    const tools = wrap(calls);
    await (tools.serus_darkweb_scan as Exec).execute({ identifierValue: REJECTED_EMAIL, identifierType: "email" }, {});
    await (tools.phone_lookup as Exec).execute({ phone: "5550100000" }, {});
  });
  assertEquals(calls.n, 2, "with the switch on, the old dispatch is restored: no aliases, no phone spellings");
});
