// credential_health_test.ts — can /health tell a rotated key from a dead one?
//
// The check this covers exists because `/health`'s tools line is a PRESENCE test
// (`has(env.X_API_KEY)`), so it read "17/20 optional tool APIs configured" while
// github_code_search 401'd on every call, and did not move when those keys were
// fixed. These tests pin the two questions an operator actually asks: who is
// refusing us, and did my rotation take?
import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  AUTH_FAILURE_CODES,
  describeCredentialHealth,
  summarizeCredentialHealth,
  type CredentialRow,
} from "./lib/credential-health.ts";

const row = (tool: string, at: string, status: number | null, outcome: string): CredentialRow =>
  ({ tool_name: tool, created_at: at, status_code: status, outcome });

Deno.test("a success AFTER the last refusal reads as recovered", () => {
  // This is the rotation signal: the operator fixed the key, and the next real
  // call proves it. Nothing else in the probe can show this.
  const h = summarizeCredentialHealth([
    row("github_code_search", "2026-09-01T10:00:00Z", 401, "failed"),
    row("github_code_search", "2026-09-02T10:00:00Z", 401, "failed"),
    row("github_code_search", "2026-09-12T10:00:00Z", 200, "ok"),
  ]);
  assertEquals(h.failing.length, 0);
  assertEquals(h.recovered.length, 1);
  assertEquals(h.recovered[0].tool, "github_code_search");
  assertEquals(h.recovered[0].auth_failures, 2);
  assertEquals(h.recovered[0].last_success_at, "2026-09-12T10:00:00Z");
});

Deno.test("a success BEFORE the last refusal is not recovery", () => {
  // Ordering is the whole point. A tool that worked last week and 403s today is
  // still broken today.
  const h = summarizeCredentialHealth([
    row("rapidapi_breach_search", "2026-09-01T10:00:00Z", 200, "ok"),
    row("rapidapi_breach_search", "2026-09-12T10:00:00Z", 403, "failed"),
  ]);
  assertEquals(h.recovered.length, 0);
  assertEquals(h.failing.length, 1);
  assertEquals(h.failing[0].last_success_at, "2026-09-01T10:00:00Z");
  assertEquals(h.failing[0].recovered, false);
});

Deno.test("an EMPTY negative counts as a working credential", () => {
  // "This target has no record" proves the key works. Excluding empties would
  // mark a healthy, low-hit provider as permanently unrecovered — the same
  // conflation that once made gravatar_profile read 35% reliable.
  const h = summarizeCredentialHealth([
    row("leakcheck_lookup", "2026-09-01T10:00:00Z", 401, "failed"),
    row("leakcheck_lookup", "2026-09-05T10:00:00Z", 404, "empty"),
  ]);
  assertEquals(h.recovered.length, 1);
  assertEquals(h.recovered[0].tool, "leakcheck_lookup");
});

Deno.test("a governance skip is not evidence the credential works", () => {
  // Skips never reach the provider, so they say nothing about the key.
  const h = summarizeCredentialHealth([
    row("oathnet_lookup", "2026-09-01T10:00:00Z", 401, "failed"),
    row("oathnet_lookup", "2026-09-05T10:00:00Z", null, "skipped"),
  ]);
  assertEquals(h.recovered.length, 0);
  assertEquals(h.failing.length, 1);
  assertEquals(h.failing[0].last_success_at, null);
});

Deno.test("tools that never refused us are absent entirely", () => {
  const h = summarizeCredentialHealth([
    row("username_sweep", "2026-09-01T10:00:00Z", 200, "ok"),
    row("minimax_web_search", "2026-09-01T10:00:00Z", 500, "failed"),
  ]);
  assertEquals(h.failing.length, 0);
  assertEquals(h.recovered.length, 0);
  // A 500 is a provider fault, not a refusal — it must not be reported here or
  // the line becomes noise nobody reads.
  assertEquals(h.rows_read, 2);
});

Deno.test("only 401 and 403 count as refusals", () => {
  assert(AUTH_FAILURE_CODES.has(401) && AUTH_FAILURE_CODES.has(403));
  assert(!AUTH_FAILURE_CODES.has(429) && !AUTH_FAILURE_CODES.has(500));
});

Deno.test("worst offender sorts first", () => {
  const h = summarizeCredentialHealth([
    row("a_tool", "2026-09-01T10:00:00Z", 403, "failed"),
    row("b_tool", "2026-09-01T10:00:00Z", 401, "failed"),
    row("b_tool", "2026-09-02T10:00:00Z", 401, "failed"),
    row("b_tool", "2026-09-03T10:00:00Z", 401, "failed"),
  ]);
  assertEquals(h.failing.map((f) => f.tool), ["b_tool", "a_tool"]);
});

Deno.test("malformed rows degrade, never throw", () => {
  const h = summarizeCredentialHealth([
    { tool_name: 42, status_code: "abc", outcome: null, created_at: 7 },
    {},
    null,
  ] as unknown as CredentialRow[]);
  assertEquals(h.failing.length, 0);
  assertEquals(h.rows_read, 3);
});

Deno.test("the detail line is specific, and says when it is a floor", () => {
  const clean = summarizeCredentialHealth([row("x", "2026-09-01T10:00:00Z", 200, "ok")]);
  assertEquals(describeCredentialHealth(clean), "no provider authorization failures");

  const mixed = summarizeCredentialHealth([
    row("reddit_user", "2026-09-10T10:00:00Z", 403, "failed"),
    row("reddit_user", "2026-09-11T10:00:00Z", 403, "failed"),
    row("github_code_search", "2026-09-01T10:00:00Z", 401, "failed"),
    row("github_code_search", "2026-09-12T10:00:00Z", 200, "ok"),
  ]);
  const line = describeCredentialHealth(mixed, true);
  assert(line.includes("refusing: reddit_user (2x)"));
  assert(line.includes("recovered: github_code_search"));
  // A truncated window must say so — a count read as complete when it is a floor
  // is the exact failure mode the dispatch-boundary paging bug had.
  assert(line.includes("truncated"));
});

Deno.test("no rows yields a clean, non-aliased result", () => {
  const a = summarizeCredentialHealth([]);
  const b = summarizeCredentialHealth(null);
  assertEquals(a.failing.length, 0);
  assertEquals(b.rows_read, 0);
  a.failing.push({
    tool: "x", last_auth_failure_at: "", last_success_at: null, recovered: false, auth_failures: 1,
  });
  assertEquals(summarizeCredentialHealth(null).failing.length, 0);
});
