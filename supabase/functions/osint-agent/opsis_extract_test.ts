// opsis_extract_test.ts — how an Opsis run becomes artifacts (auto-persist-findings.ts §12b).
//
// Opsis is account enumeration: a hit says a string is registered somewhere,
// nothing about who owns it. So it is persisted like a sweep, a completed run
// only, at sweep confidence, with Opsis's own scores kept out of ours.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { extractFindings } from "./auto-persist-findings.ts";
import { UNPROVEN_LINKAGE_KEY, unprovenLinkageMarker } from "./lib/unproven-linkage.ts";

const row = (platform: string, value: string | null = `https://${platform}.example/jordanvale`) => ({
  platform,
  value,
  type: "account",
  module: `${platform}_module`,
  opsis_confidence: 1,
});

function run(results: unknown[], over: Record<string, unknown> = {}) {
  return {
    ok: true,
    source: "opsis",
    run_id: "run-1",
    run_status: "completed",
    complete: true,
    kind: "username",
    value: "jordanvale",
    total_results: results.length,
    results_returned: results.length,
    results,
    ...over,
  };
}

Deno.test("a completed run with 3+ results collapses to ONE social_footprint row at sweep confidence", () => {
  const out = extractFindings("opsis_search", run([row("github"), row("gitlab"), row("reddit"), row("keybase", null)]));
  assertEquals(out.length, 1);
  const f = out[0];
  assertEquals(f.kind, "social_footprint");
  assertEquals(f.value, "jordanvale — 4 Opsis results (unverified)");
  assertEquals(f.rawConfidence, 30);
  const ctx = f.context as Record<string, unknown>;
  assertEquals(ctx.via, "opsis");
  assertEquals(ctx.handle, "jordanvale");
  assertEquals(ctx.opsis_run_id, "run-1");
  assertEquals(ctx.platform_count, 4);
  assertEquals((ctx.urls as string[]).length, 3, "a null value is counted, never invented as a URL");
  assertEquals(ctx.opsis_platforms, ["github", "gitlab", "reddit", "keybase"]);
});

Deno.test("Opsis's own scores and module names never reach our confidence or source fields", () => {
  const out = extractFindings("opsis_search", run([row("github"), row("gitlab"), row("last.fm")]));
  const ctx = out[0].context as Record<string, unknown>;
  for (const k of ["source", "sources", "platform", "confidence", "opsis_confidence", "module"]) {
    assertEquals(k in ctx, false, `metadata must not carry '${k}'`);
  }
  assertEquals(out[0].rawConfidence, 30);
});

Deno.test("fewer than 3 results surface individually as URLs; non-URL values are not invented as URLs", () => {
  const out = extractFindings("opsis_search", run([row("github"), row("telegram", "jordanvale")]));
  assertEquals(out.map((f) => f.kind), ["url"]);
  assertEquals(out[0].value, "https://github.example/jordanvale");
  assertEquals((out[0].context as Record<string, unknown>).via, "opsis");
});

Deno.test("a PARTIAL run persists nothing; its completion (opsis_results) persists once", () => {
  const partial = run([row("github"), row("gitlab"), row("reddit")], { ok: true, partial: true, run_status: "running", complete: false });
  assertEquals(extractFindings("opsis_search", partial), []);
  const done = extractFindings("opsis_results", run([row("github"), row("gitlab"), row("reddit"), row("x")]));
  assertEquals(done.length, 1);
  assertEquals(done[0].kind, "social_footprint");
});

Deno.test("a failed run, an error, or a non-Opsis shape persists nothing", () => {
  assertEquals(extractFindings("opsis_search", { ok: false, error: "opsis search failed upstream", code: "run_failed", source: "opsis", complete: false, results: [row("github")] }), []);
  assertEquals(extractFindings("opsis_search", { ok: false, status: 402, error: "opsis account is out of API credits" }), []);
  assertEquals(extractFindings("opsis_search", { ok: true, complete: true, results: [row("github"), row("a"), row("b")] }), [], "no source:'opsis', no rows");
});

Deno.test("an email or domain run is never filed under a handle", () => {
  const out = extractFindings("opsis_search", run([row("github"), row("gitlab"), row("reddit")], { kind: "email", value: "a@b.test" }));
  const ctx = out[0].context as Record<string, unknown>;
  assertEquals("handle" in ctx, false);
  assertEquals(ctx.opsis_kind, "email");
  assertEquals(out[0].value, "a@b.test — 3 Opsis results (unverified)");
});

Deno.test("a run on a QUARANTINED selector yields quarantined findings (authority is not inherited)", () => {
  const tainted = {
    ...run([row("github"), row("gitlab"), row("reddit")]),
    _runtime: { [UNPROVEN_LINKAGE_KEY]: unprovenLinkageMarker("username", "jordanvale", "harvested from a name-only query") },
  };
  const out = extractFindings("opsis_search", tainted);
  assert(out.length > 0);
  for (const f of out) assertEquals((f.context as Record<string, unknown>).subject_unlinked, true);

  const few = { ...run([row("github")]), _runtime: tainted._runtime };
  const one = extractFindings("opsis_search", few);
  assertEquals(one.length, 1);
  assertEquals((one[0].context as Record<string, unknown>).subject_unlinked, true);
});

// Codex P2 on #659: `results` is capped for the prompt, so the headline must
// count what Opsis found (total_results), not the truncated array.
Deno.test("a truncated run's headline counts the provider's total, not the capped array", () => {
  const rows = Array.from({ length: 100 }, (_, i) => row(`p${i}`));
  const out = extractFindings("opsis_search", run(rows, { total_results: 350, results_returned: 100, results_truncated: 250 }));
  assertEquals(out.length, 1);
  assertEquals(out[0].value, "jordanvale — 350 Opsis results (unverified)");
  const ctx = out[0].context as Record<string, unknown>;
  assertEquals(ctx.platform_count, 350);
  assertEquals((ctx.urls as string[]).length, 100, "the URL list stays bounded");
  assertEquals(ctx.opsis_results_truncated, 250);
});

Deno.test("a total smaller than the rows held is ignored (never under-counts)", () => {
  const out = extractFindings("opsis_search", run([row("a"), row("b"), row("c"), row("d")], { total_results: 2 }));
  assertEquals(out[0].value, "jordanvale — 4 Opsis results (unverified)");
});
