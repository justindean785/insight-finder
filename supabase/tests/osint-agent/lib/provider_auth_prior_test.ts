// provider_auth_prior_test.ts — a 401/402 from an earlier invocation of the case
// suppresses the provider for this run; a later real answer clears it.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildProviderAuthPrior, loadProviderAuthPrior, providerAuthPriorEnabled, providerAuthPriorSelfTest,
  PROVIDER_AUTH_PRIOR_ROWS, PROVIDER_AUTH_PRIOR_DISABLED_ENV,
} from "../../../functions/osint-agent/lib/provider-auth-prior.ts";
import { providerForTool, suppressProviderAuthPrior, shouldRun, clearThread, AUTH_REFUSAL_REASON } from "../../../functions/osint-agent/circuit.ts";
import { classifyToolOutcome } from "../../../functions/osint-agent/tool-outcome.ts";

const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();

Deno.test("buildProviderAuthPrior: the latest real answer decides — a 401 with no later success carries", () => {
  const r = buildProviderAuthPrior([
    { tool_name: "oathnet_lookup", status_code: 401, outcome: "failed", created_at: at(1) },
    { tool_name: "oathnet_stealer_search", status_code: 401, outcome: "failed", created_at: at(2) },
  ], providerForTool);
  assertEquals(r, [{ provider: "oathnet", tool: "oathnet_stealer_search", status: 401 }]);
});

Deno.test("buildProviderAuthPrior: a later ok/empty from ANY tool of the provider clears the refusal (rotated key recovers)", () => {
  const r = buildProviderAuthPrior([
    { tool_name: "oathnet_lookup", status_code: 402, outcome: "failed", created_at: at(1) },
    { tool_name: "oathnet_subdomains", status_code: 200, outcome: "empty", created_at: at(5) },
  ], providerForTool);
  assertEquals(r, []);
  // …and the order of the rows as given does not matter — created_at does.
  const r2 = buildProviderAuthPrior([
    { tool_name: "oathnet_subdomains", status_code: 200, outcome: "empty", created_at: at(5) },
    { tool_name: "oathnet_lookup", status_code: 402, outcome: "failed", created_at: at(1) },
  ], providerForTool);
  assertEquals(r2, []);
  // but a success BEFORE the refusal does not clear it
  const r3 = buildProviderAuthPrior([
    { tool_name: "oathnet_subdomains", status_code: 200, outcome: "ok", created_at: at(1) },
    { tool_name: "oathnet_lookup", status_code: 401, outcome: "failed", created_at: at(5) },
  ], providerForTool);
  assertEquals(r3.length, 1);
});

Deno.test("buildProviderAuthPrior: 403, 5xx, cache replays, skips and status strings are handled conservatively", () => {
  const r = buildProviderAuthPrior([
    { tool_name: "reddit_user", status_code: 403, outcome: "failed", created_at: at(1) },
    { tool_name: "hunter_combined", status_code: 500, outcome: "failed", created_at: at(1) },
    { tool_name: "indicia_email", status_code: 402, outcome: "failed", created_at: at(1), cached: true },
    { tool_name: "indicia_phone", status_code: "402", outcome: "failed", created_at: at(2) }, // a numeric string still counts
    { tool_name: "exa_search", status_code: 401, outcome: "skipped", created_at: at(3) },
  ], providerForTool);
  assertEquals(r, [{ provider: "indicia", tool: "indicia_phone", status: 402 }]);
});

Deno.test("loadProviderAuthPrior: one bounded read on the thread, newest first; a DB error fails OPEN", async () => {
  const calls: Record<string, unknown>[] = [];
  const dbOk = {
    from: (table: string) => {
      const q: Record<string, unknown> = { table };
      const chain = {
        select: (c: string) => { q.select = c; return chain; },
        eq: (k: string, v: string) => { q[k] = v; return chain; },
        in: (k: string, v: unknown) => { q[`in_${k}`] = v; return chain; },
        order: (k: string, o: unknown) => { q.order = [k, o]; return chain; },
        limit: (n: number) => { q.limit = n; calls.push(q); return Promise.resolve({ data: [
          { tool_name: "oathnet_lookup", status_code: 401, outcome: "failed", created_at: at(1) },
        ], error: null }); },
      };
      return chain;
    },
  };
  const r = await loadProviderAuthPrior(dbOk, "thread-1", providerForTool);
  assertEquals(r.refusals.length, 1);
  assertEquals(r.rowsRead, 1);
  assertEquals(calls[0].table, "tool_usage_log");
  assertEquals(calls[0].thread_id, "thread-1");
  assertEquals(calls[0].limit, PROVIDER_AUTH_PRIOR_ROWS);
  assertEquals(calls[0].order, ["created_at", { ascending: false }]);
  const dbErr = { from: () => ({ select: () => ({ eq: () => ({ in: () => ({ order: () => ({ limit: () => Promise.resolve({ data: null, error: { message: "boom" } }) }) }) }) }) }) };
  const e = await loadProviderAuthPrior(dbErr, "thread-1", providerForTool);
  assertEquals(e.refusals, []);
  assertEquals(e.error, "boom");
  const dbThrow = { from: () => { throw new Error("down"); } };
  const t = await loadProviderAuthPrior(dbThrow, "thread-1", providerForTool);
  assertEquals(t.refusals, []);
});

Deno.test("applied through circuit: the refusal is a legible SKIP, not a failure, for tool-outcome classification", () => {
  const thread = "auth-prior-t1";
  clearThread(thread);
  suppressProviderAuthPrior(thread, "oathnet_lookup", 401);
  const d = shouldRun(thread, "oathnet_scanner", "example.com");
  assert(!d.allow);
  const reason = (d as { reason: string }).reason;
  assert(reason.includes(AUTH_REFUSAL_REASON));
  assertEquals(classifyToolOutcome(reason, null), "skipped");
  clearThread(thread);
});

Deno.test("kill switch + self-test", () => {
  assertEquals(providerAuthPriorEnabled(() => undefined), true);
  assertEquals(providerAuthPriorEnabled((k) => (k === PROVIDER_AUTH_PRIOR_DISABLED_ENV ? "true" : undefined)), false);
  const st = providerAuthPriorSelfTest();
  assert(st.ok, st.detail);
});

Deno.test("wiring: index.ts applies the prior at run start and hides suppressed tools per step; /health reports the key", () => {
  const index = Deno.readTextFileSync(new URL("../../../functions/osint-agent/index.ts", import.meta.url));
  assert(index.includes("loadProviderAuthPrior("), "prior must be loaded at run start");
  assert(index.indexOf("loadProviderAuthPrior(") > index.indexOf("circuit.applyBaselineDisables(threadId)"));
  assert(index.includes("circuit.suppressedToolsOf(threadId, normalActiveTools)"), "suppressed tools must be withheld from activeTools");
  const health = Deno.readTextFileSync(new URL("../../../functions/osint-agent/health-handler.ts", import.meta.url));
  assert(health.includes("r.checks.provider_auth_prior = providerAuthPriorSelfTest()"));
});
