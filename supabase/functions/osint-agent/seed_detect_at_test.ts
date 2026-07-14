// seed_detect_at_test.ts — WP1a: a leading "@" handle must classify as a username
// (not `other`) so the run hits the username playbook + anchor read.
// Run: deno test --no-check seed_detect_at_test.ts
import { assert, assertEquals } from "jsr:@std/assert@^1";
import { detectSeedServer } from "./validation.ts";

Deno.test("@pjsmakka classifies as username with a folded normalized key", () => {
  const d = detectSeedServer("@pjsmakka");
  assertEquals(d?.kind, "username");
  assertEquals(d?.normalized, "pjsmakka");
});

Deno.test("@-strip is case-insensitive and preserves raw", () => {
  const d = detectSeedServer("@PjSmakka");
  assertEquals(d?.kind, "username");
  assertEquals(d?.normalized, "pjsmakka");
  assertEquals(d?.raw, "@PjSmakka");
});

Deno.test("bare handle still works; email and multi-@ are unaffected", () => {
  assertEquals(detectSeedServer("pjsmakka")?.kind, "username");
  assertEquals(detectSeedServer("a@b.com")?.kind, "email");
  // A stray "@" in front of an email-shaped string is still an email (EMAIL wins first).
  assert(detectSeedServer("a@b.com")?.kind !== "username");
});
