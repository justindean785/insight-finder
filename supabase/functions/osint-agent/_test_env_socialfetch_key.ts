// _test_env_socialfetch_key.ts — test-only bootstrap.
//
// env.ts resolves SOCIALFETCH_API_KEY as a MODULE-LEVEL constant
// (`Deno.env.get(...)` evaluated once at import time), so a `Deno.env.set(...)`
// call made from inside a `Deno.test` body runs too late — env.ts has already
// been evaluated (transitively, via tool-registry.ts) by then, and ES modules
// evaluate exactly once per process.
//
// Importing THIS module FIRST (as the very first import statement in a test
// file, before tool-registry.ts) sets the env var during this module's own
// evaluation, which happens strictly before any sibling import listed after it
// in the same file — so env.ts sees the key already set. Test-only; nothing in
// the shipped runtime imports this file.
if (!Deno.env.get("SOCIALFETCH_API_KEY")) {
  Deno.env.set("SOCIALFETCH_API_KEY", "test-socialfetch-key");
}
