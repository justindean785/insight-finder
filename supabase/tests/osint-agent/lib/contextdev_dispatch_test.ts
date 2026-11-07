// lib/contextdev_dispatch_test.ts — the contextdev_* tools through the REAL cache wrapper.
//
// Codex P2 on #973: the wrapper's selector detection (cache.ts detectSelectorType/Value)
// reads email/username/url/… but not `query`, so contextdev_people_search dispatched with
// an EMPTY selector and PREMIUM_TOOLS membership enforced nothing — the same 10-credit page
// could be bought again with `countries` omitted versus `countries: []` (different cache
// keys, identical provider request). These tests drive the wrapper, not the module.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { Tool } from "npm:ai@6";
import type { createClient } from "npm:@supabase/supabase-js@2";
import { wrapToolsWithCache } from "../../../functions/osint-agent/cache.ts";
import { clearRuntime } from "../../../functions/osint-agent/runtime-policy.ts";
import * as circuit from "../../../functions/osint-agent/circuit.ts";
import { contextdevQuerySelector } from "../../../functions/osint-agent/lib/contextdev.ts";

type SupabaseClient = ReturnType<typeof createClient>;
type Exec = { execute: (input: unknown, opts: unknown) => Promise<Record<string, unknown>> };

function inertChain(): Record<string, unknown> {
  const n: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "order", "update", "limit", "range"]) n[m] = () => n;
  n.maybeSingle = () => Promise.resolve({ data: null, error: null });
  n.then = (r: (x: { data: unknown; error: unknown }) => void) => r({ data: [], error: null });
  n.insert = () => Promise.resolve({ error: null });
  n.upsert = () => Promise.resolve({ error: null });
  return n;
}
function db(): SupabaseClient {
  return { from: () => inertChain(), rpc: () => Promise.resolve({ data: null, error: null }) } as unknown as SupabaseClient;
}

const PERSON = { name: "Stranger One", headline: "CTO at Acme", profiles: ["https://www.linkedin.com/in/stranger-one/"], location: {}, role: {} };
const PAGE = { ok: true, provider: "context.dev", authority: "lead", results: [PERSON], count: 1, deduped: 0, dropped_invalid: 0, empty: false, has_more: false };

let seq = 0;
function wrapPeople(calls: { n: number }) {
  seq += 1;
  const investigationId = `44444444-5555-4666-8777-${String(seq).padStart(12, "0")}`;
  clearRuntime(investigationId);
  circuit.clearThread(investigationId);
  const counting = {
    description: "contextdev_people_search stand-in",
    execute: () => { calls.n += 1; return Promise.resolve({ ...PAGE }); },
  } as unknown as Tool;
  return wrapToolsWithCache({ contextdev_people_search: counting }, { investigationId, userId: "u1", supabase: db() });
}

Deno.test("selector: contextdev search tools expose their query as the governance selector; other tools do not", () => {
  assertEquals(contextdevQuerySelector("contextdev_people_search", { query: "  CTOs at   Solar companies " }), "ctos at solar companies");
  assertEquals(contextdevQuerySelector("contextdev_web_search", { query: "Jordan Vale site:github.com" }), "jordan vale site:github.com");
  assertEquals(contextdevQuerySelector("contextdev_scrape", { url: "https://a.example/" }), null);
  assertEquals(contextdevQuerySelector("exa_search", { query: "unchanged for other tools" }), null);
  assertEquals(contextdevQuerySelector("contextdev_people_search", { query: "" }), null);
  assertEquals(contextdevQuerySelector("contextdev_people_search", {}), null);
});

Deno.test("dispatch: the same people query asked twice — with `countries` omitted then `[]` — buys ONE page; the repeat is refused by the premium gate", async () => {
  const calls = { n: 0 };
  const exec = (wrapPeople(calls).contextdev_people_search as unknown as Exec).execute;
  await exec({ query: "CTOs at solar companies in California" }, { toolCallId: "p1", messages: [] });
  const second = await exec({ query: "  ctos at solar   companies in california ", countries: [] }, { toolCallId: "p2", messages: [] });
  assertEquals(calls.n, 1, "the 10-credit page must not be bought twice");
  assertEquals(second.ok, false);
  assert(JSON.stringify(second).includes("already ran for this entity"), JSON.stringify(second));
});

Deno.test("dispatch: a different people query still runs", async () => {
  const calls = { n: 0 };
  const exec = (wrapPeople(calls).contextdev_people_search as unknown as Exec).execute;
  await exec({ query: "CTOs at solar companies in California" }, { toolCallId: "q1", messages: [] });
  await exec({ query: "VPs of sales at wind companies in Texas" }, { toolCallId: "q2", messages: [] });
  assertEquals(calls.n, 2);
});
