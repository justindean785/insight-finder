// cache_auto_persist_shapes_test.ts — response-shape coverage for the per-call
// auto-persist hook wired into wrapToolsWithCache, beyond the four canonical
// cases in cache_auto_persist_test.ts.
//
// Focus: that the extractor is neither too strict (misses a real github_user
// hit) nor too loose (invents findings from unrelated successful payloads or
// leaks sensitive fields), and that the live and cached paths agree.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { Tool } from "npm:ai@6";
import type { createClient } from "npm:@supabase/supabase-js@2";
import { wrapToolsWithCache } from "./cache.ts";
import { clearRuntime } from "./runtime-policy.ts";
import { extractFindings } from "./auto-persist-findings.ts";

type SupabaseClient = ReturnType<typeof createClient>;

function makeChain(resolveValue: { data: unknown; error: unknown }): Record<string, unknown> {
  const node: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "order", "update", "limit"]) node[m] = () => node;
  node.maybeSingle = () => Promise.resolve(resolveValue);
  node.then = (resolve: (v: { data: unknown; error: unknown }) => void) => resolve(resolveValue);
  return node;
}

/** `existing` seeds the artifacts SELECT, i.e. what the DB-backed dedup set sees. */
function fakeSupabase(
  onArtifactsInsert: (rows: Array<Record<string, unknown>>) => void,
  existing: Array<{ kind: string; value: string }> = [],
): SupabaseClient {
  const inert = makeChain({ data: [], error: null });
  inert.insert = () => Promise.resolve({ error: null });
  inert.upsert = () => Promise.resolve({ error: null });

  const artifacts = makeChain({ data: existing, error: null });
  artifacts.insert = (rows: Array<Record<string, unknown>>) => {
    onArtifactsInsert(rows);
    return Promise.resolve({ error: null });
  };

  return {
    from: (t: string) => (t === "artifacts" ? artifacts : inert),
    rpc: () => Promise.resolve({ data: null, error: null }),
  } as unknown as SupabaseClient;
}

async function runOnce(
  toolName: string,
  threadId: string,
  impl: () => unknown,
  existing: Array<{ kind: string; value: string }> = [],
): Promise<Array<Record<string, unknown>>> {
  clearRuntime(threadId);
  const inserted: Array<Record<string, unknown>> = [];
  const supabase = fakeSupabase((rows) => inserted.push(...rows), existing);
  const wrapped = wrapToolsWithCache(
    { [toolName]: { description: "test tool", execute: async () => impl() } as unknown as Tool },
    { investigationId: threadId, userId: `u-${threadId}`, supabase, supabaseAdmin: supabase },
  );
  const execute = wrapped[toolName].execute as (i: unknown, o: unknown) => Promise<unknown>;
  await execute({ value: `${threadId}-probe`, purpose: "probe", force: true }, { toolCallId: `${threadId}-1`, messages: [] });
  clearRuntime(threadId);
  return inserted;
}

Deno.test("auto-persist: github_user success carries source and provenance onto the row", async () => {
  const inserted = await runOnce("github_user", "shape-gh-prov", () => ({
    ok: true,
    user: { login: "octocat", html_url: "https://github.com/octocat" },
  }));
  const account = inserted.find((r) => r.kind === "github_account");
  assertEquals(account?.value, "octocat");
  assertEquals(account?.source, "github_user", "the originating tool must be recorded as the source");
  const meta = (account?.metadata ?? {}) as Record<string, unknown>;
  assertEquals(meta.auto_persist_source, "tool_return_extractor", "provenance marker must survive");
  assertEquals(meta.tool, "github_user");
});

Deno.test("auto-persist: github_user with NO login persists no account (profile URL only)", async () => {
  const inserted = await runOnce("github_user", "shape-gh-nologin", () => ({
    ok: true,
    user: { html_url: "https://github.com/ghost" },
  }));
  assertEquals(
    inserted.some((r) => r.kind === "github_account"),
    false,
    "a missing login must never yield a github_account",
  );
});

Deno.test("auto-persist: github_user with an empty user object persists nothing", async () => {
  const inserted = await runOnce("github_user", "shape-gh-empty", () => ({ ok: true, user: {} }));
  assertEquals(inserted.length, 0);
});

Deno.test("auto-persist: a github_user error shape never persists even with a populated user", async () => {
  // Guards the `typeof o.error === "string"` arm — ok is absent but the payload
  // still describes a failure.
  const inserted = await runOnce("github_user", "shape-gh-err", () => ({
    error: "rate limited",
    user: { login: "octocat", html_url: "https://github.com/octocat" },
  }));
  assertEquals(inserted.length, 0, "an error payload is never a finding");
});

Deno.test("auto-persist: a duplicate live result persists exactly once", async () => {
  // The dedup set is DB-backed, so seeding the artifacts SELECT with the value
  // reproduces "this already landed on an earlier call in the same run".
  const inserted = await runOnce(
    "github_user",
    "shape-gh-dup",
    () => ({ ok: true, user: { login: "octocat", html_url: "https://github.com/octocat" } }),
    [{ kind: "github_account", value: "octocat" }, { kind: "url", value: "https://github.com/octocat" }],
  );
  assertEquals(inserted.length, 0, "an already-persisted (kind,value) must not be inserted twice");
});

Deno.test("auto-persist: sensitive github_user fields are never auto-persisted", async () => {
  const inserted = await runOnce("github_user", "shape-gh-secrets", () => ({
    ok: true,
    user: {
      login: "octocat",
      html_url: "https://github.com/octocat",
      // None of these are extractable kinds — they must not reach the table.
      access_token: "ghp_supersecrettokenvalue",
      two_factor_authentication: true,
      private_gists: 12,
    },
  }));
  const serialized = JSON.stringify(inserted);
  assertEquals(serialized.includes("ghp_supersecrettokenvalue"), false, "a token must never be persisted");
  assertEquals(serialized.includes("two_factor"), false, "secret metadata must never be persisted");
  assertEquals(
    inserted.every((r) => ["github_account", "url"].includes(String(r.kind))),
    true,
    "only whitelisted kinds may be emitted",
  );
});

Deno.test("auto-persist: an unrelated successful payload yields no false positives", async () => {
  const inserted = await runOnce("crtsh_lookup", "shape-unrelated", () => ({
    ok: true,
    status: "complete",
    checked_at: "2026-07-20T00:00:00Z",
    count: 0,
  }));
  assertEquals(inserted.length, 0);
});

Deno.test("auto-persist: cached and live results normalize to the SAME candidates", async () => {
  // The hook runs on both execute paths, so the two must not disagree — a value
  // that persists live and not from cache (or vice versa) would be a silent
  // coverage hole. extractFindings is the shared normalizer, so comparing its
  // output on the identical payload pins that contract.
  const payload = { ok: true, user: { login: "octocat", html_url: "https://github.com/octocat" } };
  const live = extractFindings("github_user", payload);
  const cached = extractFindings("github_user", JSON.parse(JSON.stringify(payload)));
  assertEquals(
    live.map((f) => `${f.kind}:${f.value}`).sort(),
    cached.map((f) => `${f.kind}:${f.value}`).sort(),
    "live and cached payloads must normalize identically",
  );
  assertEquals(live.length > 0, true);
});

Deno.test("auto-persist: every denylisted tool stays denylisted through the wrapper", async () => {
  for (const [i, tool] of ["record_artifacts", "memory_recall", "dork_harvest", "gemini_vision"].entries()) {
    const inserted = await runOnce(tool, `shape-deny-${i}`, () => ({
      ok: true,
      user: { login: "octocat", html_url: "https://github.com/octocat" },
      citations: [{ url: "https://example.com/x" }],
    }));
    assertEquals(inserted.length, 0, `${tool} must never auto-persist`);
  }
});
