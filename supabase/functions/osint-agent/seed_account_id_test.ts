// seed_account_id_test.ts — a platform account ID is not a phone (edge half of #651).
//
// E.164 caps a phone number at 15 digits. A longer bare digit run is a platform
// account ID — a 17–20 digit Discord/Twitter snowflake, a Steam64 ID — and
// detectSeedServer classified it as `phone`, which routed a Discord-ID case into
// phone tooling and logged seed_kind=phone. The client mirror is src/lib/seed.ts.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { detectSeedServer } from "./validation.ts";

const SNOWFLAKE = "1234567890123456789"; // 19 digits, synthetic

Deno.test("a 17-20 digit snowflake is an account id (`other`), not a phone or a username", () => {
  for (const id of [SNOWFLAKE, "12345678901234567", "76561197960287930", "12345678901234567890"]) {
    const d = detectSeedServer(id);
    assertEquals(d?.kind, "other", id);
    assertEquals(d?.normalized, id, "kept verbatim");
  }
});

Deno.test("real phone numbers, including 15-digit E.164, still classify as phone", () => {
  for (const p of ["+1 (555) 010-0199", "555-010-0199", "+15550100199", "+442071838750", "123456789012345"]) {
    assertEquals(detectSeedServer(p)?.kind, "phone", p);
  }
});

Deno.test("a punctuated value past 15 digits is not a phone either", () => {
  assert(detectSeedServer("+1 234 567 890 123 456 78")?.kind !== "phone");
});

Deno.test("the server pins the 15-digit E.164 ceiling (client mirror: src/lib/seed.ts)", async () => {
  const server = await Deno.readTextFile(new URL("./validation.ts", import.meta.url));
  assert(server.includes("const E164_MAX_DIGITS = 15;"), "server ceiling");
});
