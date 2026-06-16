import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { coerceArtifactsInput } from "./validation.ts";

// record_artifacts artifact-coercion (the z.preprocess body extracted from
// index.ts). A real array passes through; a stringified JSON array parses; a
// malformed/non-JSON string returns the original string so the strict z.array
// downstream rejects it.

Deno.test("(6) coerceArtifactsInput leaves a real array unchanged", () => {
  const arr = [{ kind: "email", value: "x" }];
  assertEquals(coerceArtifactsInput(arr), arr);
});

Deno.test("(7) coerceArtifactsInput parses a stringified JSON array", () => {
  assertEquals(
    coerceArtifactsInput('[{"kind":"email","value":"x"}]'),
    [{ kind: "email", value: "x" }],
  );
});

Deno.test("(8) coerceArtifactsInput returns the original string for non-JSON", () => {
  assertEquals(coerceArtifactsInput("not json"), "not json");
});

Deno.test("coerceArtifactsInput strips a ```json fence then parses", () => {
  assertEquals(
    coerceArtifactsInput('```json\n[{"kind":"email","value":"x"}]\n```'),
    [{ kind: "email", value: "x" }],
  );
});

Deno.test("coerceArtifactsInput wraps a single object in an array", () => {
  assertEquals(
    coerceArtifactsInput({ kind: "email", value: "x" }),
    [{ kind: "email", value: "x" }],
  );
});
