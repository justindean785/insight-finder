/**
 * source_classification_test.ts — the boundary guard on classifySource.
 *
 * FIXTURES ARE SYNTHETIC. Nothing here is real case data.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifySource } from "../../functions/osint-agent/source-classification.ts";

/* ── the type guard at the function boundary (2026-08-16) ─────────────────
 *
 * `classifySource`'s declared parameter type is a lie at runtime: values reach
 * it from `metadata`, a `z.record(z.unknown())` blob the MODEL authors. A
 * truthy non-string passed the old falsy-only guard and then threw
 * `toolOrSource.toLowerCase is not a function`, failing the whole
 * record_artifacts batch.
 *
 * #463 type-guarded the two call sites in tool-registry.ts. The crash still
 * recurred in production on 2026-08-16 03:59, after #463 was live, because six
 * other call sites hand this function unvalidated values. These tests pin the
 * guard at the BOUNDARY, which is the only place that closes the class.
 */
Deno.test("classifySource never throws on a non-string, whatever the model wrote", () => {
  const hostile: unknown[] = [
    ["oathnet_lookup"],                 // the shape measured in production
    [{ name: "x" }],
    { source: "oathnet_lookup" },
    42,
    true,
    Symbol("s"),
    () => "oathnet_lookup",
    new Date(),
    [[["nested"]]],
  ];
  for (const v of hostile) {
    const cls = classifySource(v as string);
    assertEquals(
      cls,
      "unknown",
      `non-string input must fail closed to "unknown", got ${String(cls)} for ${String(typeof v)}`,
    );
  }
});

Deno.test("the type guard does not disturb ordinary string classification", () => {
  // Fail-closed must narrow only the illegal inputs — a real slug still classifies.
  assertEquals(classifySource("oathnet_lookup") === "unknown", false);
  assertEquals(classifySource(null), "unknown");
  assertEquals(classifySource(undefined), "unknown");
  assertEquals(classifySource(""), "unknown");
});
