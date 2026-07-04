import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { creditsCharged } from "./billing.ts";

const COST = 5_000;

Deno.test("creditsCharged: failed paid call charges 0", () => {
  assertEquals(creditsCharged({ ok: false, cached: false, free: false, baseCost: COST }), 0);
});

Deno.test("creditsCharged: cache hit never bills", () => {
  assertEquals(creditsCharged({ ok: true, cached: true, free: false, baseCost: COST }), 0);
});

Deno.test("creditsCharged: free stub never bills", () => {
  assertEquals(creditsCharged({ ok: true, cached: false, free: true, baseCost: COST }), 0);
});

Deno.test("creditsCharged: successful paid call charges baseCost", () => {
  assertEquals(creditsCharged({ ok: true, cached: false, free: false, baseCost: COST }), COST);
});
