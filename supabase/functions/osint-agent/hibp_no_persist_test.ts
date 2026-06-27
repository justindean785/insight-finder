/**
 * hibp_no_persist_test.ts — FIX 1 (Codex 3485661427): the HIBP k-anon tool's
 * input (a plaintext password or full 40-hex SHA-1) must NEVER be persisted to
 * tool_usage_log.input_json or tool_call_cache.input_json. Two guarantees:
 *   1. The tool is in NO_CACHE_TOOLS → the cache wrapper's no-cache branch never
 *      writes input_json at all (it logs with input_json = null).
 *   2. redactSensitiveToolInput() strips the password / full hash before any
 *      persistence, leaving only a non-reversible 5-char SHA-1 prefix.
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import { NO_CACHE_TOOLS, SENSITIVE_INPUT_TOOLS, redactSensitiveToolInput } from "./validation.ts";

const TOOL = "hibp_pwned_passwords_kanon";
const PASSWORD = "hunter2-SuperSecret";
const FULL_SHA1 = "5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8"; // SHA-1("password")

Deno.test("HIBP tool is no-cache and marked sensitive", () => {
  assert(NO_CACHE_TOOLS.has(TOOL), "must be in NO_CACHE_TOOLS so input_json is never cached");
  assert(SENSITIVE_INPUT_TOOLS.has(TOOL), "must be in SENSITIVE_INPUT_TOOLS for log redaction");
});

Deno.test("redactSensitiveToolInput strips password and full sha1, keeps only a 5-char prefix", () => {
  const redacted = redactSensitiveToolInput(TOOL, { password: PASSWORD, sha1: FULL_SHA1 }) as Record<string, unknown>;
  const serialized = JSON.stringify(redacted);
  // The persisted blob must contain NEITHER the plaintext password NOR the full hash.
  assert(!serialized.includes(PASSWORD), "plaintext password must not be persisted");
  assert(!serialized.includes(FULL_SHA1), "full 40-char sha1 must not be persisted");
  assert(!serialized.toLowerCase().includes(FULL_SHA1.toLowerCase()), "full sha1 (any case) must not be persisted");
  assertEquals(redacted.password, undefined, "password key dropped");
  assertEquals(redacted.sha1, undefined, "full sha1 key dropped");
  assertEquals(redacted.sha1_prefix, "5BAA6", "only the non-reversible 5-char prefix is kept");
  assertEquals(redacted.redacted, true);
});

Deno.test("redactSensitiveToolInput is a no-op for non-sensitive tools", () => {
  const input = { domain: "acme.com" };
  assertEquals(redactSensitiveToolInput("crtsh_lookup", input), input);
});
