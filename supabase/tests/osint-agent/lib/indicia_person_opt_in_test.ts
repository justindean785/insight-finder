// lib/indicia_person_opt_in_test.ts — indicia_person's missing-first-name search is an explicit boolean opt-in:
// default off, never auto-set, never repaired from a string, ledgered at its real (2x) cost. Synthetic names only.
import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { indicia_person } from "../../../functions/osint-agent/tools/indicia.ts";
import {
  costForTool, costForToolCall, indiciaPersonOptInSelfTest, INDICIA_MISSING_FIRST_NAME_COST_MULTIPLIER,
} from "../../../functions/osint-agent/costs.ts";
import { repairExactBooleanInput } from "../../../functions/osint-agent/lib/exact-boolean-repair.ts";

const SW = "INDICIA_MISSING_FIRST_NAME_DISABLED";
async function withEnv<T>(k: string, v: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = Deno.env.get(k);
  if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v);
  try { return await fn(); } finally { if (prev === undefined) Deno.env.delete(k); else Deno.env.set(k, prev); }
}
type Exec = { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>>; inputSchema: { safeParse: (v: unknown) => { success: boolean } } };
const tool = indicia_person as unknown as Exec;

async function bodySent(input: unknown): Promise<Record<string, unknown>> {
  const origFetch = globalThis.fetch;
  const origKey = Deno.env.get("INDICIA_API_KEY");
  Deno.env.set("INDICIA_API_KEY", "test-key");
  let body: Record<string, unknown> = {};
  globalThis.fetch = ((_u: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body ?? "{}"));
    return Promise.resolve(new Response(JSON.stringify({ success: true, data: { web: [] } }), { status: 200 }));
  }) as typeof fetch;
  try { await tool.execute(input, {}); } finally {
    globalThis.fetch = origFetch;
    if (origKey === undefined) Deno.env.delete("INDICIA_API_KEY"); else Deno.env.set("INDICIA_API_KEY", origKey);
  }
  return body;
}

Deno.test("default: the flag is NOT sent (absent or false), and the schema keeps it optional", async () => {
  assertFalse("allowMissingFirstName" in await bodySent({ name: "Example" }));
  assertFalse("allowMissingFirstName" in await bodySent({ name: "Example", allowMissingFirstName: false }));
  assert(tool.inputSchema.safeParse({ name: "Example" }).success);
});

Deno.test("an explicit boolean true is sent to the provider", async () => {
  const b = await bodySent({ name: "Example", state: "MA", allowMissingFirstName: true });
  assertEquals(b.allowMissingFirstName, true);
  assertEquals(b.state, "MA");
});

Deno.test("a string is never accepted for the flag, and the exact-boolean repair refuses to fix it", () => {
  assertFalse(tool.inputSchema.safeParse({ name: "Example", allowMissingFirstName: "true" }).success);
  const err = { name: "AI_InvalidToolInputError", cause: { name: "AI_TypeValidationError", cause: { name: "ZodError", issues: [{ code: "invalid_type", expected: "boolean", received: "string", path: ["allowMissingFirstName"] }] } } };
  assertEquals(repairExactBooleanInput('{"name":"Example","allowMissingFirstName":"true"}', err), null);
});

Deno.test("ledger cost: 2x only for an opted-in indicia_person; every other call is the list price", () => {
  const base = costForTool("indicia_person");
  assertEquals(costForToolCall("indicia_person", { name: "x" }), base);
  assertEquals(costForToolCall("indicia_person", { allowMissingFirstName: false }), base);
  assertEquals(costForToolCall("indicia_person", { allowMissingFirstName: "true" }), base);
  assertEquals(costForToolCall("indicia_person", { allowMissingFirstName: true }), base * INDICIA_MISSING_FIRST_NAME_COST_MULTIPLIER);
  assertEquals(costForToolCall("indicia_email", { allowMissingFirstName: true }), costForTool("indicia_email"));
  assertEquals(costForToolCall("indicia_person", null), base);
});

Deno.test("kill switch: the flag is not sent and the cost is the list price", async () => {
  await withEnv(SW, "true", async () => {
    assertFalse("allowMissingFirstName" in await bodySent({ name: "Example", allowMissingFirstName: true }));
    assertEquals(costForToolCall("indicia_person", { allowMissingFirstName: true }), costForTool("indicia_person"));
    assert(indiciaPersonOptInSelfTest().detail.startsWith("LEGACY"));
  });
});

Deno.test("self-test, /health wiring and the logUsage call site use the per-call cost", async () => {
  const t = indiciaPersonOptInSelfTest();
  assert(t.ok, t.detail);
  assertEquals(t.switch, `${SW}=false`);
  const health = await Deno.readTextFile(new URL("../../../functions/osint-agent/health-handler.ts", import.meta.url));
  assert(health.includes("r.checks.indicia_person_opt_in = indiciaPersonOptInSelfTest();"));
  const cache = await Deno.readTextFile(new URL("../../../functions/osint-agent/cache.ts", import.meta.url));
  assert(cache.includes("costForToolCall(name,") && cache.includes("baseCost: callCost"));
});
