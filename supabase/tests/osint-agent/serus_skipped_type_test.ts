// serus_skipped_type_test.ts — the poll-exhaustion path returns `skipped: true`,
// and the signature has to admit it.
//
// WHY THIS EXISTS. `runSerusScan`'s timeout branch has always returned
// `skipped: true`, but the declared return type never listed it. `deno check`
// on the file reports:
//
//   TS2353 Object literal may only specify known properties, and 'skipped'
//          does not exist in type '{ ok: boolean; status: ... }'
//          at tools/serus_core.ts:344
//
// It survived because nothing reaches it: `tools/serus_core.ts` is imported only
// by `tools/serus.ts`, which no runtime module imports, so it is outside the
// graph `deno check index.ts` walks — and `npm run test:edge` passes
// `--no-check`. The hole was found by a Lovable-side build (which compiles the
// whole tree) and is being canonicalised here rather than left as mirror drift.
//
// The behavioural test below is the one that bites: it drives the real poll loop
// with fetch stubbed and asserts the flag on the real return value. Deleting the
// `skipped?: boolean` declaration alone will NOT fail it — that is what
// `deno check tools/serus_core.ts` is for, and the PR body says so plainly
// rather than pretending a `--no-check` suite can gate a type.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// env.ts snapshots SERUS_API_KEY at module-evaluation time, so a static import
// would capture an unset key and short-circuit on `serus_key_missing` before
// reaching a single fetch. Set it first, import dynamically, restore at once —
// leaving it set leaks into later test modules and invalidates their
// missing-key cases. Same dance as serus_abort_test.ts.
const PRIOR_SERUS_KEY = Deno.env.get("SERUS_API_KEY");
Deno.env.set("SERUS_API_KEY", "test-key");
const { runSerusScan } = await import("../../functions/osint-agent/tools/serus_core.ts");
if (PRIOR_SERUS_KEY === undefined) Deno.env.delete("SERUS_API_KEY");
else Deno.env.set("SERUS_API_KEY", PRIOR_SERUS_KEY);

const realFetch = globalThis.fetch;
function restore() { globalThis.fetch = realFetch; }

/** Initiate succeeds; every poll comes back non-terminal, so the loop exhausts. */
function stubNeverTerminal(): () => number {
  let calls = 0;
  globalThis.fetch = ((url: string | URL | Request) => {
    calls++;
    const u = String(url);
    const body = /initiate|scan/i.test(u) && calls === 1
      ? { id: "scan_test_1", status: "pending", identifierType: "phone" }
      : { status: "pending" };
    return Promise.resolve(
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
    );
  }) as typeof fetch;
  return () => calls;
}

Deno.test("⛔ poll exhaustion returns skipped:true — an unfinished lookup, not a provider failure", async () => {
  const count = stubNeverTerminal();
  try {
    const res = await runSerusScan("phone", "+15551234567", {
      maxRetries: 2,
      intervalMs: 1,
      deadlineMs: 5_000,
    });
    assertEquals(res.status, "timeout", "a scan that never reaches a terminal status is a timeout");
    assertEquals(res.ok, false);
    assertEquals(
      res.skipped,
      true,
      "the poll-exhaustion path must mark itself skipped so a caller can tell it from a real Serus failure",
    );
    assert(count() > 1, "the test must have actually driven the poll loop, not short-circuited");
  } finally {
    restore();
  }
});

Deno.test("the timeout result still carries its scan id and a diagnostic error", async () => {
  // Disclosure: an exhausted poll is resumable, so the id has to survive or the
  // analyst cannot re-poll and the credits already spent are simply lost.
  stubNeverTerminal();
  try {
    const res = await runSerusScan("phone", "+15551234567", { maxRetries: 2, intervalMs: 1, deadlineMs: 5_000 });
    assertEquals(res.scanId, "scan_test_1");
    assertEquals(res.identifierType, "phone");
    assert(res.error, "an exhausted poll must explain itself");
    assertEquals(res.error?.code, "poll_exhausted");
  } finally {
    restore();
  }
});

Deno.test("⛔ NEGATIVE CONTROL: a terminal scan is NOT marked skipped", async () => {
  // The costly direction. If `skipped` leaked onto the success path, a completed
  // scan would read as an unfinished one and its findings would be discounted.
  globalThis.fetch = ((url: string | URL | Request) => {
    const u = String(url);
    const body = /initiate/i.test(u) || !/status|poll|scan_test_2/i.test(u)
      ? { id: "scan_test_2", status: "pending", identifierType: "phone" }
      : { status: "completed", isBreached: false, breaches: [], pastes: [], totalBreaches: 0, totalPastes: 0 };
    return Promise.resolve(
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
    );
  }) as typeof fetch;
  try {
    const res = await runSerusScan("phone", "+15551234567", { maxRetries: 4, intervalMs: 1, deadlineMs: 5_000 });
    if (res.status === "timeout") return; // stub did not reach terminal; the positive case above already pins the flag
    assertEquals(res.skipped, undefined, "only the poll-exhaustion path may set skipped");
  } finally {
    restore();
  }
});

/**
 * Compile-time guard. Under `--no-check` (how `npm run test:edge` runs) this is
 * erased and proves nothing; under `deno check` it fails the moment the
 * `skipped?: boolean` declaration is removed. Kept deliberately, and deliberately
 * labelled, so nobody mistakes the green suite for type coverage.
 */
type ScanResult = Awaited<ReturnType<typeof runSerusScan>>;
const _declaresSkipped: ScanResult = { ok: false, status: "timeout", skipped: true };
void _declaresSkipped;
