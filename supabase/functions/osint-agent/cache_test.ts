import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  extractEvidenceSeed,
  markCached,
  tagTier,
} from "./cache.ts";

Deno.test("extractEvidenceSeed: prefers email then value fields", () => {
  assertEquals(extractEvidenceSeed({ email: "a@b.com", value: "other" }), "a@b.com");
  assertEquals(extractEvidenceSeed({ value: "seed-1" }), "seed-1");
  assertEquals(extractEvidenceSeed(null), "");
});

Deno.test("extractEvidenceSeed: trims and caps length at 200", () => {
  const long = "x".repeat(250);
  assertEquals(extractEvidenceSeed({ email: `  ${long}  ` }).length, 200);
});

Deno.test("tagTier: tags plain objects without overwriting existing tier", () => {
  assertEquals(
    tagTier({ hits: 2, _tier: "smart", _model: "m1" }, "fast", "m2"),
    { hits: 2, _tier: "smart", _model: "m1" },
  );
  assertEquals(
    tagTier({ hits: 2 }, "fast", "mini"),
    { hits: 2, _tier: "fast", _model: "mini" },
  );
});

Deno.test("tagTier: wraps non-object results", () => {
  assertEquals(tagTier("raw", "fast", "mini"), { value: "raw", _tier: "fast", _model: "mini" });
});

Deno.test("markCached: stamps cache metadata on objects and primitives", () => {
  const at = "2026-07-04T00:00:00Z";
  assertEquals(
    markCached({ ok: true }, at, "thread"),
    { ok: true, _cached: true, _cached_at: at, _cache_layer: "thread" },
  );
  assertEquals(
    markCached("x", at, "user"),
    { value: "x", _cached: true, _cached_at: at, _cache_layer: "user" },
  );
});
