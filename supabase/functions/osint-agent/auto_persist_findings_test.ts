import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  extractFindings,
  extractStepFindings,
  normalizeFinding,
  persistAutoFindings,
  AUTO_PERSIST_TOOL_DENYLIST,
} from "./auto-persist-findings.ts";

// Minimal artifacts-only fake: captures rows passed to .insert() and lets the
// test force an insert error. Everything persistAutoFindings needs is `from(t).insert`.
function fakeSupabase(capture: (rows: Array<Record<string, unknown>>) => void, insertError: { message: string } | null = null) {
  return {
    from: (_t: string) => ({
      insert: (rows: Array<Record<string, unknown>>) => { capture(rows); return Promise.resolve({ error: insertError }); },
    }),
  } as unknown as Parameters<typeof persistAutoFindings>[0]["supabase"];
}

Deno.test("normalizeFinding rejects invalid values", () => {
  assertEquals(normalizeFinding("url", "not-a-url"), null);
  assertEquals(normalizeFinding("email", "not-an-email"), null);
  assertEquals(normalizeFinding("secret", "anything"), null);
});

Deno.test("normalizeFinding strips utm params from url", () => {
  const n = normalizeFinding("url", "https://example.com/a?utm_source=x&foo=1");
  assertEquals(n?.value, "https://example.com/a?foo=1");
});

Deno.test("extractFindings skips denylisted tools", () => {
  for (const t of AUTO_PERSIST_TOOL_DENYLIST) {
    assertEquals(extractFindings(t, { ok: true, citations: [{ url: "https://ex.com" }] }), []);
  }
});

Deno.test("extractFindings pulls perplexity citations", () => {
  const out = extractFindings("perplexity_search_wrap", {
    ok: true,
    citations: [{ url: "https://ex.com/1" }, "https://ex.com/2", { url: "junk" }],
  });
  assertEquals(out.length, 2);
  assertEquals(out[0].kind, "url");
});

Deno.test("extractFindings pulls hibp breaches", () => {
  const out = extractFindings("hibp_check", {
    ok: true,
    data: { breaches: [{ Name: "LinkedIn" }, { name: "Adobe" }] },
  });
  // Two corpora now collapse into ONE breach_exposure row carrying both names.
  // The artifact count drops; the corpus list does not.
  assertEquals(out.length, 1);
  assertEquals(out[0].kind, "breach_exposure");
  assertEquals(out[0].value, "Breach exposure (hibp_check/hibp_style)");
  assertEquals(out[0].rawConfidence, 55, "shape change only — the confidence value must not move");
  assertEquals(out[0].context?.breach_corpora, ["Adobe", "LinkedIn"], "sorted, and lossless");
  assertEquals(out[0].context?.breach_corpus_count, 2);
});

Deno.test("breach corpus names never become standalone artifacts again", () => {
  // The regression this guards: 47 of 83 artifacts on one production board were
  // bare corpus names at a flat 55, and 708 such rows exist across 45 threads
  // (mean 43.5, max 88). ALLOWED_KINDS no longer contains "breach", so the
  // extractor cannot mint one even if a future branch tries.
  const out = extractFindings("hibp_check", {
    ok: true,
    data: { breaches: Array.from({ length: 60 }, (_, i) => ({ Name: `Corpus${String(i).padStart(2, "0")}` })) },
  });
  assertEquals(out.filter((f) => f.kind === "breach").length, 0, "no bare breach artifacts");
  assertEquals(out.length, 1, "60 corpora collapse to exactly one row");
  assertEquals(out[0].context?.breach_corpus_count, 60, "every corpus is still counted");
  assertEquals((out[0].context?.breach_corpora as string[]).length, 60, "and every name retained");
});

Deno.test("the collapsed row survives the per-call cap that used to evict findings", () => {
  // extractFindings stops at MAX_AUTO_PERSIST_PER_TOOL_CALL with a hard break.
  // Corpus names used to consume that budget and push real identity findings out.
  const out = extractFindings("hibp_check", {
    ok: true,
    data: { breaches: Array.from({ length: 40 }, (_, i) => ({ Name: `C${i}` })) },
    items: Array.from({ length: 20 }, (_, i) => ({ email: `p${i}@example.com` })),
  });
  assertEquals(out[0].kind, "breach_exposure", "the exposure row is never the one evicted");
  const emails = out.filter((f) => f.kind === "email").length;
  assert(emails >= 15, `real findings should now fit the budget, got ${emails}`);
});

Deno.test("extractFindings handles github_user", () => {
  const out = extractFindings("github_user", {
    ok: true,
    user: { login: "octocat", html_url: "https://github.com/octocat", email: "OCT@example.com", blog: "https://oct.example" },
    repos: [{ url: "https://github.com/octocat/repo" }],
  });
  const kinds = out.map((f) => f.kind).sort();
  assert(kinds.includes("github_account"));
  assert(kinds.includes("email"));
  assert(kinds.includes("url"));
  // email is normalized to lowercase
  assertEquals(out.find((f) => f.kind === "email")?.value, "oct@example.com");
});

Deno.test("extractFindings skips explicit tool errors", () => {
  assertEquals(extractFindings("hibp_check", { ok: false, error: "bad key" }), []);
  assertEquals(extractFindings("hibp_check", { error: "boom" }), []);
});

Deno.test("extractStepFindings dedups across tool calls", () => {
  const results = [
    { toolName: "perplexity_search_wrap", output: { ok: true, citations: [{ url: "https://ex.com/a" }] } },
    { toolName: "perplexity_search_wrap", output: { ok: true, citations: [{ url: "https://ex.com/a" }, { url: "https://ex.com/b" }] } },
  ];
  const out = extractStepFindings(results);
  assertEquals(out.length, 2);
});

Deno.test("extractStepFindings caps per-step at 60", () => {
  const citations: string[] = [];
  for (let i = 0; i < 200; i++) citations.push(`https://ex.com/${i}`);
  const results = [{ toolName: "perplexity_search_wrap", output: { ok: true, citations } }];
  const out = extractStepFindings(results);
  assert(out.length <= 60);
});

// The insert half — exercised by the per-step onStepFinish backstop in index.ts.
Deno.test("persistAutoFindings inserts scrubbed rows tagged with thread/user and dedups against seen", async () => {
  const inserted: Array<Record<string, unknown>> = [];
  const supabase = fakeSupabase((rows) => inserted.push(...rows));
  const seen = new Set<string>();
  const res = await persistAutoFindings(
    { supabase, threadId: "t1", userId: "u1", seen },
    [
      { kind: "url", value: "https://ex.com/a", toolName: "socialfetch_lookup", rawConfidence: 30 },
      { kind: "url", value: "https://ex.com/b", toolName: "socialfetch_lookup", rawConfidence: 30 },
    ],
  );
  assertEquals(res.inserted, 2);
  assertEquals(inserted.length, 2);
  assert(inserted.every((r) => r.thread_id === "t1" && r.user_id === "u1"));
  // Every persisted (kind,value) is now marked seen, so a second pass is a no-op.
  const inserted2: Array<Record<string, unknown>> = [];
  const supabase2 = fakeSupabase((rows) => inserted2.push(...rows));
  const res2 = await persistAutoFindings(
    { supabase: supabase2, threadId: "t1", userId: "u1", seen },
    [{ kind: "url", value: "https://ex.com/a", toolName: "socialfetch_lookup", rawConfidence: 30 }],
  );
  assertEquals(res2.inserted, 0);
  assertEquals(res2.skipped_duplicates, 1);
  assertEquals(inserted2.length, 0);
});

Deno.test("persistAutoFindings never throws on insert error and reports zero inserted", async () => {
  const supabase = fakeSupabase(() => {}, { message: "boom" });
  const res = await persistAutoFindings(
    { supabase, threadId: "t1", userId: "u1", seen: new Set<string>() },
    [{ kind: "url", value: "https://ex.com/c", toolName: "socialfetch_lookup", rawConfidence: 30 }],
  );
  assertEquals(res.inserted, 0);
});

Deno.test("persistAutoFindings is a no-op for an empty finding list", async () => {
  let called = false;
  const supabase = fakeSupabase(() => { called = true; });
  const res = await persistAutoFindings({ supabase, threadId: "t1", userId: "u1", seen: new Set<string>() }, []);
  assertEquals(res.inserted, 0);
  assertEquals(called, false);
});
