import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildSeedMemoryContext, normalizeMemorySeed } from "./memory-context.ts";

Deno.test("normalizeMemorySeed trims and normalizes the lookup subject", () => {
  assertEquals(normalizeMemorySeed("  F0reignRican  "), "f0reignrican");
});

Deno.test("buildSeedMemoryContext dedupes lessons and preserves confidence", () => {
  const context = buildSeedMemoryContext([
    { kind: "connection", confidence: 72, content: "Threads and Instagram share the same display name." },
    { kind: "connection", confidence: 72, content: "Threads and Instagram share the same display name." },
    { kind: "platform_lesson", confidence: 60, content: "Jina is blocked for this host; use a direct reader." },
  ]);
  assert(context.includes("[MEMORY:connection 72]"));
  assert(context.includes("[MEMORY:platform_lesson 60]"));
  assertEquals(context.match(/Threads and Instagram/g)?.length, 1);
});

Deno.test("buildSeedMemoryContext never injects raw credentials", () => {
  const context = buildSeedMemoryContext([
    { kind: "note", content: "password: hunter2; SSN=123-45-6789 token=abc123" },
  ]);
  assert(!context.includes("hunter2"));
  assert(!context.includes("123-45-6789"));
  assert(!context.includes("abc123"));
  assertEquals(context.match(/\[REDACTED\]/g)?.length, 3);
});
