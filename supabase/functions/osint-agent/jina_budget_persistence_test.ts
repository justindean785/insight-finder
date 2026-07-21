import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { Tool } from "npm:ai@6";
import type { createClient } from "npm:@supabase/supabase-js@2";
import { wrapToolsWithCache } from "./cache.ts";
import { clearRuntime } from "./runtime-policy.ts";
import { clearThread } from "./circuit.ts";
import { MAX_TOOL_CALLS_PER_RUN } from "./orchestrator-budget.ts";

type SupabaseClient = ReturnType<typeof createClient>;

function chain(result: { data: unknown; error: unknown; count?: number }) {
  const node: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "order", "update", "limit"]) node[method] = () => node;
  node.maybeSingle = () => Promise.resolve(result);
  node.then = (resolve: (value: unknown) => void) => resolve(result);
  return node;
}

Deno.test("three concurrent Jina calls respect provider concurrency, run cap, and persistence", async () => {
  const threadId = "jina-budget-persist";
  clearRuntime(threadId);
  clearThread(threadId);

  const inserted: Array<Record<string, unknown>> = [];
  const inert = chain({ data: [], error: null });
  inert.insert = () => Promise.resolve({ error: null });
  inert.upsert = () => Promise.resolve({ error: null });
  const artifacts = chain({ data: [], error: null });
  artifacts.insert = (rows: Array<Record<string, unknown>>) => {
    inserted.push(...rows);
    return Promise.resolve({ error: null });
  };
  const supabase = {
    from: (table: string) => table === "artifacts" ? artifacts : inert,
    rpc: () => Promise.resolve({ data: null, error: null }),
  } as unknown as SupabaseClient;

  let activeJina = 0;
  let maxActiveJina = 0;
  let jinaExecutions = 0;
  const jina = {
    description: "test Jina",
    execute: async () => {
      jinaExecutions++;
      activeJina++;
      maxActiveJina = Math.max(maxActiveJina, activeJina);
      await new Promise((resolve) => setTimeout(resolve, 15));
      activeJina--;
      return { ok: true, markdown: "public profile text" };
    },
  } as unknown as Tool;
  const github = {
    description: "test GitHub",
    execute: async () => ({
      ok: true,
      user: { login: "octocat", html_url: "https://github.com/octocat" },
    }),
  } as unknown as Tool;

  const budget = {
    genuine: MAX_TOOL_CALLS_PER_RUN - 4,
    reserved: MAX_TOOL_CALLS_PER_RUN - 4,
    capped: false,
  };
  const wrapped = wrapToolsWithCache(
    { jina_reader_scrape: jina, github_user: github },
    {
      investigationId: threadId,
      userId: "u-jina-combined",
      supabase,
      supabaseAdmin: supabase,
      toolCallBudget: budget,
    },
  );
  const runJina = wrapped.jina_reader_scrape.execute as (input: unknown, opts: unknown) => Promise<unknown>;
  const runGithub = wrapped.github_user.execute as (input: unknown, opts: unknown) => Promise<unknown>;

  await Promise.all([
    runJina({ url: "https://example.com/a", force: true }, { toolCallId: "jina-a", messages: [] }),
    runJina({ url: "https://example.com/b", force: true }, { toolCallId: "jina-b", messages: [] }),
    runJina({ url: "https://example.com/c", force: true }, { toolCallId: "jina-c", messages: [] }),
    runGithub({ username: "octocat", force: true }, { toolCallId: "github", messages: [] }),
  ]);
  const capped = await runJina(
    { url: "https://example.com/d", force: true },
    { toolCallId: "jina-d", messages: [] },
  ) as { run_capped?: boolean };

  assertEquals(jinaExecutions, 3, "exactly three Jina calls execute");
  assert(maxActiveJina >= 1 && maxActiveJina <= 3,
    "runtime throttling may queue admitted calls, but provider execution must never exceed three");
  assertEquals(budget.reserved, MAX_TOOL_CALLS_PER_RUN, "combined calls stop exactly at the run cap");
  assertEquals(capped.run_capped, true, "the next Jina call is capped before execution");
  assert(inserted.some((row) => row.kind === "github_account" && row.value === "octocat"),
    "a concurrent finding-producing call still persists through the scrubbed auto-persist path");

  clearRuntime(threadId);
  clearThread(threadId);
});
