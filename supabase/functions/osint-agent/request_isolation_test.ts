// request_isolation_test.ts — Finding #8: guard/routingGuard/triageState used to
// be mutable MODULE-LEVEL singletons, reset at the top of the Deno.serve handler.
// On a warm edge isolate serving overlapping/concurrent requests, one
// investigation's seed, triage decisions, or correlate counters could bleed into
// another's mid-flight request. The fix threads a fresh, request-scoped
// RequestState (guard.ts's createRequestState()) through ToolContext explicitly.
//
// These tests exercise the REAL caller path (buildTools().tools.*.execute), not
// just guard.ts's raw functions (see correlate_autofire_test.ts for that lower-
// level coverage) — two independent buildTools() calls, each given its OWN fresh
// requestState, proving state cannot cross between them under both genuinely
// interleaved async execution and plain sequential reuse (the sequential case
// matters too: the pre-fix module-level singleton bled state even WITHOUT true
// concurrency, any time a warm isolate handled a second request).
import { assert, assertEquals } from "jsr:@std/assert@^1";
import { buildTools, type ToolContext } from "./tool-registry.ts";
import { createRequestState } from "./guard.ts";
import * as circuit from "./circuit.ts";

function makeMockSupabase(insertedArtifacts: Array<Record<string, unknown>>) {
  const builder: Record<string, unknown> = {
    then: (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res),
  };
  for (const m of ["select", "eq", "or", "order", "limit", "is", "update"]) builder[m] = () => builder;
  return {
    from(_table: string) {
      return {
        insert(rows: unknown) {
          if (Array.isArray(rows)) insertedArtifacts.push(...(rows as Record<string, unknown>[]));
          else insertedArtifacts.push(rows as Record<string, unknown>);
          return Promise.resolve({ error: null });
        },
        select: () => builder,
        update: () => builder,
      };
    },
    rpc(name: string, _args: Record<string, unknown>) {
      if (name === "append_evidence") return Promise.resolve({ data: [{ id: "ev1", seq: 1, chain_hash: "h" }], error: null });
      return Promise.resolve({ data: [], error: null });
    },
  };
}

function ctxFor(threadId: string, requestState: ReturnType<typeof createRequestState>, insertedArtifacts: Array<Record<string, unknown>>): ToolContext {
  circuit.clearThread(threadId);
  return {
    supabase: makeMockSupabase(insertedArtifacts),
    supabaseAdmin: makeMockSupabase(insertedArtifacts),
    userId: `user-${threadId}`,
    threadId,
    archiveEnabled: false,
    detectedSeedType: "email",
    detectedSeedValue: null,
    messages: [],
    manualOverrideSelector: null,
    requestState,
  } as unknown as ToolContext;
}

Deno.test("finding #8: two requests' triageState.seed never cross-contaminate (sequential — the bug bit even without real concurrency)", async () => {
  const stateA = createRequestState();
  const stateB = createRequestState();
  const insertedA: Array<Record<string, unknown>> = [];
  const insertedB: Array<Record<string, unknown>> = [];
  const ctxA = ctxFor("iso-thread-A", stateA, insertedA);
  const ctxB = ctxFor("iso-thread-B", stateB, insertedB);

  const toolsA = buildTools(ctxA).tools as Record<string, { execute: (i: unknown, o: unknown) => Promise<unknown> }>;
  const toolsB = buildTools(ctxB).tools as Record<string, { execute: (i: unknown, o: unknown) => Promise<unknown> }>;

  await toolsA.triage_seed.execute({ seed: "seedA@example.com", type: "email" }, {});
  await toolsB.triage_seed.execute({ seed: "seedB@example.com", type: "email" }, {});

  assertEquals(stateA.triageState.seed, "seedA@example.com", "request A must see only its own seed");
  assertEquals(stateB.triageState.seed, "seedB@example.com", "request B must see only its own seed");
  assert(stateA.triageState.seed !== stateB.triageState.seed, "the two requests' seeds must never be equal-by-contamination");
  assert(stateA !== stateB, "the two requests must hold genuinely distinct state objects, not the same reference");

  circuit.clearThread("iso-thread-A"); circuit.clearThread("iso-thread-B");
});

Deno.test("finding #8: genuinely INTERLEAVED triage_seed calls (Promise.all) still never cross-contaminate", async () => {
  const stateA = createRequestState();
  const stateB = createRequestState();
  const insertedA: Array<Record<string, unknown>> = [];
  const insertedB: Array<Record<string, unknown>> = [];
  const ctxA = ctxFor("iso-thread-C", stateA, insertedA);
  const ctxB = ctxFor("iso-thread-D", stateB, insertedB);

  const toolsA = buildTools(ctxA).tools as Record<string, { execute: (i: unknown, o: unknown) => Promise<unknown> }>;
  const toolsB = buildTools(ctxB).tools as Record<string, { execute: (i: unknown, o: unknown) => Promise<unknown> }>;

  // Both fire "at once" — proves independence isn't an accident of call ordering.
  await Promise.all([
    toolsA.triage_seed.execute({ seed: "raceA", type: "username" }, {}),
    toolsB.triage_seed.execute({ seed: "raceB", type: "username" }, {}),
  ]);

  assertEquals(stateA.triageState.seed, "raceA");
  assertEquals(stateB.triageState.seed, "raceB");

  circuit.clearThread("iso-thread-C"); circuit.clearThread("iso-thread-D");
});

Deno.test("finding #8: guard.artifactsSinceCorrelate (the correlate-nudge counter) stays per-request under interleaving", async () => {
  const stateA = createRequestState();
  const stateB = createRequestState();
  const insertedA: Array<Record<string, unknown>> = [];
  const insertedB: Array<Record<string, unknown>> = [];
  const ctxA = ctxFor("iso-thread-E", stateA, insertedA);
  const ctxB = ctxFor("iso-thread-F", stateB, insertedB);

  const toolsA = buildTools(ctxA).tools as Record<string, { execute: (i: unknown, o: unknown) => Promise<unknown> }>;
  const toolsB = buildTools(ctxB).tools as Record<string, { execute: (i: unknown, o: unknown) => Promise<unknown> }>;

  // Request A records 3 artifacts; request B records 1 — interleaved.
  await Promise.all([
    toolsA.record_artifacts.execute({ artifacts: [
      { kind: "email", value: "a1@example.com", source: "test" },
      { kind: "email", value: "a2@example.com", source: "test" },
      { kind: "email", value: "a3@example.com", source: "test" },
    ] }, {}),
    toolsB.record_artifacts.execute({ artifacts: [
      { kind: "email", value: "b1@example.com", source: "test" },
    ] }, {}),
  ]);

  assertEquals(stateA.guard.artifactsSinceCorrelate, 3, "request A's counter reflects only its own 3 artifacts");
  assertEquals(stateB.guard.artifactsSinceCorrelate, 1, "request B's counter reflects only its own 1 artifact — never inflated by A's activity");

  circuit.clearThread("iso-thread-E"); circuit.clearThread("iso-thread-F");
});

Deno.test("finding #8: a fresh createRequestState() is independent from any prior call's state (no leftover module-level residue)", () => {
  const first = createRequestState();
  first.triageState.seed = "leftover-from-a-prior-request";
  first.guard.artifactsSinceCorrelate = 99;

  const second = createRequestState();
  assertEquals(second.triageState.seed, null, "a brand-new request state must never inherit a prior request's seed");
  assertEquals(second.guard.artifactsSinceCorrelate, 0, "a brand-new request state must never inherit a prior request's counter");
});
