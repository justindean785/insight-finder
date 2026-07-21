import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isJinaOriginBlockStatus } from "./jina-policy.ts";

Deno.test("Jina origin blocks remain selector-local", () => {
  assertEquals(isJinaOriginBlockStatus(403), true);
  assertEquals(isJinaOriginBlockStatus(451), true);
  assertEquals(isJinaOriginBlockStatus(401), false);
  assertEquals(isJinaOriginBlockStatus(429), false);
  assertEquals(isJinaOriginBlockStatus(500), false);
});
