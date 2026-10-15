/**
 * rdap_wiring_test.ts — the composition, not the unit.
 *
 * WHY THIS FILE EXISTS. `rdap_test.ts` injects its own fetch stub, so it
 * verifies rdapLookup's retry policy in isolation and is structurally blind to
 * what the RUNTIME passes in. Review caught exactly that gap: the call site
 * originally passed `fetchRetry`, which defaults to retries:2 (three attempts)
 * and retries 429/5xx — the same class rdapLookup retries. Composed, a failing
 * registry got three attempts multiplied by rdapLookup's one retry: SIX
 * requests, from a module documenting "exactly one retry". Every unit test
 * still passed.
 *
 * The assertion therefore has to read the source, in the same style as
 * reviews_wiring_test.ts. Requires --allow-read.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const REGISTRY = await Deno.readTextFile(new URL("../../functions/osint-agent/tool-registry.ts", import.meta.url));

Deno.test("wiring: whois_lookup passes a ONE-SHOT fetch into rdapLookup", () => {
  const call = REGISTRY.match(/return await rdapLookup\([^;]*\);/)?.[0] ?? "";
  assert(call, "could not find the rdapLookup call site");
  assert(
    /fetchT\(/.test(call),
    `rdapLookup must be given a one-shot, timeout-bounded fetch. Found: ${call}`,
  );
  assert(
    !/fetchRetry\(/.test(call),
    "fetchRetry multiplies rdapLookup's own retry — retry policy belongs to rdapLookup alone. " +
      `Found: ${call}`,
  );
});

Deno.test("wiring: no other retrying wrapper reaches rdapLookup", () => {
  // Guards the same defect re-entering under a different helper name.
  const call = REGISTRY.match(/return await rdapLookup\([^;]*\);/)?.[0] ?? "";
  assertEquals(
    /retr(y|ies)/i.test(call),
    false,
    `the rdapLookup call site must not mention retry at all: ${call}`,
  );
});
