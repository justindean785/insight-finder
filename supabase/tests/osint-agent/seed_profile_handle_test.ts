// seed_profile_handle_test.ts — a profile whose URL names the seed handle carries that handle.
//
// Measured 2026-11-10 with synthetic rows shaped like production: a model-recorded profile row carries `platform`
// and no `handle`, so the frontend cluster engine could not join `x.example/sample.handle` to the seed
// `sample.handle`. The stamp adds `metadata.handle` at write time, for the EXACT handle only. Every refusal below
// is a namesake hole kept closed. Values are synthetic.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  profileUrlHandle,
  SEED_PROFILE_HANDLE_BASIS,
  seedProfileHandlePatch,
  seedProfileHandleSelfTest,
} from "../../functions/osint-agent/lib/seed-profile-handle.ts";

const SEED = "sample.handle";
const patch = (value: string, meta: Record<string, unknown> = {}, kind = "social_profile", seed: string | null = SEED) =>
  seedProfileHandlePatch(seed, kind, value, meta);

Deno.test("the handle a profile URL ends in", () => {
  assertEquals(profileUrlHandle("https://x.example/sample.handle"), "sample.handle");
  assertEquals(profileUrlHandle("x.example/Sample.Handle/"), "sample.handle");
  assertEquals(profileUrlHandle("https://x.example/@sample.handle"), "sample.handle");
  assertEquals(profileUrlHandle("https://x.example/~sample.handle"), "sample.handle");
  assertEquals(profileUrlHandle("https://x.example/user/sample.handle"), "sample.handle");
  assertEquals(profileUrlHandle("x.example/user.aspx?username=sample.handle"), "sample.handle");
  assertEquals(profileUrlHandle("x.example/sample.handle — display name 'A B', created 2010"), "sample.handle");
  assertEquals(profileUrlHandle("https://x.example/sample%2Ehandle"), "sample.handle");
  assertEquals(profileUrlHandle("https://sample.handle.x.example"), "", "a host is not a path");
  assertEquals(profileUrlHandle("sample.handle"), "", "a bare token is not a URL");
  assertEquals(profileUrlHandle(""), "");
});

Deno.test("a profile row for the EXACT seed handle is stamped, with its basis disclosed", () => {
  assertEquals(patch("https://x.example/sample.handle"), { handle: SEED, handle_basis: SEED_PROFILE_HANDLE_BASIS });
  assert(patch("x.example/@Sample.Handle — display name 'A B'"));
  assert(patch("https://x.example/sample.handle", { platform: "x" }, "profile"));
  assert(patch("https://x.example/sample.handle", {}, "social_profile", "@Sample.Handle"), "the seed is cleaned the same way");
});

Deno.test("NAMESAKE: the shortened handle, a longer handle and a host label are never stamped", () => {
  assertEquals(patch("https://x.example/sample"), null, "`sample` is not `sample.handle`");
  assertEquals(patch("https://x.example/sample.handle2"), null);
  assertEquals(patch("https://x.example/sample.handle.backup"), null);
  assertEquals(patch("https://x.example/xsample.handle"), null);
  assertEquals(patch("https://x.example/samplehandle"), null, "a different spelling is the cluster engine's call, not this stamp's");
  assertEquals(patch("https://sample.handle.x.example"), null);
  assertEquals(patch("https://x.example/sample.handle/followers"), null, "the handle must be the LAST token");
  assertEquals(patch("sample.handle has an account on x.example"), null, "prose");
});

Deno.test("and the reverse: a seed `sample` does not claim `sample.handle`'s profile", () => {
  assertEquals(patch("https://x.example/sample.handle", {}, "social_profile", "sample"), null);
  assert(patch("https://x.example/sample", {}, "social_profile", "sample"));
});

Deno.test("a row that is excluded, quarantined or lifted from a bio is never stamped", () => {
  const url = "https://x.example/sample.handle";
  assertEquals(patch(url, { subject_unlinked: true }), null);
  assertEquals(patch(url, { excluded_collision: true }), null);
  assertEquals(patch(url, { from_bio: true }), null);
  assertEquals(patch(url, { bio_cross_link: true }), null);
});

Deno.test("an existing handle is never overwritten, and only profile kinds are stamped", () => {
  const url = "https://x.example/sample.handle";
  assertEquals(patch(url, { handle: "someone.else" }), null);
  for (const kind of ["url", "username", "breach_exposure", "excluded_collision", "weak_lead", "name"]) {
    assertEquals(patch(url, {}, kind), null, kind);
  }
});

Deno.test("a run with no username seed, or a handle too short to mean anything, never stamps", () => {
  const url = "https://x.example/sample.handle";
  for (const seed of [null, "", "  "]) assertEquals(patch(url, {}, "social_profile", seed), null);
  assertEquals(patch("https://x.example/ab", {}, "social_profile", "ab"), null);
});

Deno.test("kill switch SEED_PROFILE_HANDLE_DISABLED=true (read at call time) stops the stamp and /health reports LEGACY", () => {
  const url = "https://x.example/sample.handle";
  const prior = Deno.env.get("SEED_PROFILE_HANDLE_DISABLED");
  try {
    Deno.env.set("SEED_PROFILE_HANDLE_DISABLED", "true");
    assertEquals(patch(url), null);
    const t = seedProfileHandleSelfTest();
    assert(t.ok && !t.enabled && t.detail.startsWith("LEGACY"), t.detail);
  } finally {
    if (prior === undefined) Deno.env.delete("SEED_PROFILE_HANDLE_DISABLED"); else Deno.env.set("SEED_PROFILE_HANDLE_DISABLED", prior);
  }
  assert(patch(url));
});

Deno.test("the /health self-test engages and reports ok", () => {
  const t = seedProfileHandleSelfTest();
  assert(t.ok, t.detail);
  assertEquals(t.switch, "SEED_PROFILE_HANDLE_DISABLED=false");
});

Deno.test("WIRING (source assertions): BOTH record writers stamp, after their quarantine stamps; index.ts feeds the username seed; /health publishes it", async () => {
  const read = (p: string) => Deno.readTextFile(new URL(`../../functions/osint-agent/${p}`, import.meta.url));
  const reg = await read("tool-registry.ts");
  const plural = "seedProfileHandlePatch(ctx.getSeedHandle?.() ?? null, finalKind, v.value, meta)";
  const single = "seedProfileHandlePatch(ctx.getSeedHandle?.() ?? null, finalKind, v.value, enrichedMeta)";
  assertEquals(reg.split(plural).length - 1, 1, "record_artifacts");
  assertEquals(reg.split(single).length - 1, 1, "record_artifact (the singular shim)");
  // Order matters: a row the name quarantine stamps must already carry subject_unlinked when the patch is asked for.
  assert(reg.indexOf("inheritedNameQuarantine(v.value, quarantinedNames, quarantineSeed())") < reg.indexOf(plural), "plural: quarantine first");
  assert(reg.indexOf("inheritedNameQuarantine(v.value, await loadQuarantinedNames(), quarantineSeed())") < reg.indexOf(single), "single: quarantine first");
  const index = await read("index.ts");
  assert(index.includes("getSeedHandle: () => seedHandleForGuard,"));
  assert(index.includes('return s && s.kind === "username" ? s.normalized : null;'));
  const health = await read("health-handler.ts");
  assert(health.includes("r.checks.seed_profile_handle = seedProfileHandleSelfTest();"));
});
