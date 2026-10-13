// memory_context_test.ts — E3: recalled memory is context, never a source.
// Production 2026-10-07..09: 14 rows listed memory_recall in `source`, e.g.
// "memory_recall + FastPeopleSearch + CA Notary Commission + The Observer".
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { applyMemoryContext, memoryContextSelfTest } from "./lib/memory-context.ts";
import { applyEvidenceCapsLegacyOccurrenceBaseline } from "./confidence.ts";

const KILL = "MEMORY_AS_SOURCE_DISABLED";

Deno.test("a memory token leaves the source label and is disclosed as context", () => {
  const r = applyMemoryContext("memory_recall + FastPeopleSearch + CA Notary Commission + The Observer", {});
  assertEquals(r.source, "FastPeopleSearch + CA Notary Commission + The Observer");
  assertEquals(r.metadata?.context_from_memory, true);
  assertEquals(r.metadata?.memory_context_label, "memory_recall");
  assertEquals(r.memoryOnly, false);
  assert(r.metadata?.status === undefined, "mixed rows keep their own status derivation");
});

Deno.test("all measured shapes are recognised", () => {
  for (const s of [
    "memory_recall (CyberBackgroundChecks.com)",
    "memory_recall (prior investigation), canotary.info, theobserver.media",
    "serus_darkweb_scan + breach_check + leakcheck_lookup + memory_recall (prior OathNet)",
    "user-provided pivot, memory_recall (prior investigation Sep 2026)",
  ]) assert(applyMemoryContext(s, {}).memory, s);
});

Deno.test("a memory-only row keeps its label but needs review", () => {
  const r = applyMemoryContext("memory_recall", { foo: 1 });
  assertEquals(r.source, "memory_recall");
  assertEquals(r.memoryOnly, true);
  assertEquals(r.metadata?.status, "needs_review");
  assertEquals(r.metadata?.memory_only, true);
  assertEquals(r.metadata?.foo, 1, "existing metadata is preserved");
});

Deno.test("never raises: stripped label caps the same or lower than the original", () => {
  const cap = (s: string) =>
    applyEvidenceCapsLegacyOccurrenceBaseline({ rawConfidence: 95, sources: [s], kind: "name" }).cap;
  const orig = "memory_recall + FastPeopleSearch + CA Notary Commission + The Observer";
  assert(cap(applyMemoryContext(orig, {}).source!) <= cap(orig));
});

Deno.test("non-memory labels and non-strings pass through untouched", () => {
  const meta = { a: 1 };
  const r = applyMemoryContext("FastPeopleSearch", meta);
  assertEquals(r.memory, false);
  assert(r.metadata === meta);
  assertEquals(applyMemoryContext(undefined, undefined).memory, false);
  // a source that merely CONTAINS the word is not a memory token
  assertEquals(applyMemoryContext("memorybank.example.com", {}).memory, false);
});

Deno.test("kill switch restores legacy behaviour", () => {
  Deno.env.set(KILL, "true");
  try {
    const r = applyMemoryContext("memory_recall + FastPeopleSearch", {});
    assertEquals(r.memory, false);
    assertEquals(r.source, "memory_recall + FastPeopleSearch");
    assertEquals(memoryContextSelfTest().detail, "LEGACY via MEMORY_AS_SOURCE_DISABLED");
  } finally {
    Deno.env.delete(KILL);
  }
});

Deno.test("health self-test passes with the rule on", () => {
  assert(memoryContextSelfTest().ok);
});

Deno.test("wiring: BOTH record tools apply the rule before the cap (source-level)", async () => {
  const src = await Deno.readTextFile(new URL("./tool-registry.ts", import.meta.url));
  const calls = src.match(/applyMemoryContext\(/g) ?? [];
  assertEquals(calls.length, 2, "record_artifacts and the record_artifact shim must both call it");
  assert(src.indexOf("applyMemoryContext(aRaw.source") < src.indexOf("applyRecordingSourcePolicy({\n            rawConfidence: a.confidence"));
  assert(src.includes("applyMemoryContext(sourceIn, metadataIn)"));
});
