// Error hygiene (audit 2026-09-24, F-7b/c). Synthetic keys only.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { redactErrorMessage } from "./lib/redact-error.ts";

Deno.test("redactErrorMessage strips every credential shape the stream path strips", () => {
  const out = redactErrorMessage(
    "401 Incorrect API key provided: sk-abc123XYZ; auth Bearer eyJhbGci.x.y; xai-KEY999; key AIzaSyFAKE_key-1",
  );
  for (const leak of ["sk-abc123XYZ", "eyJhbGci", "xai-KEY999", "AIzaSyFAKE_key-1"]) assert(!out.includes(leak), leak);
  assert(out.includes("sk-[REDACTED]") && out.includes("Bearer [REDACTED]"));
  assertEquals(redactErrorMessage("plain failure"), "plain failure");
});

Deno.test("wiring: the catch-all 500 detail and the stream onError both go through redactErrorMessage", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assert(src.includes("const message = redactErrorMessage(e instanceof Error ? e.message : String(e))"), "500 path");
  assert(src.includes('return redactErrorMessage(m).slice(0, 300) || "Provider stream error";'), "stream path");
  assert(!/detail:\s*e\.message|detail:\s*String\(e\)/.test(src), "no raw error text in a response body");
});

Deno.test("wiring: the zero-artifact log event records the seed's kind and length, not its text", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assert(!src.includes("seed: seedValueRaw.slice("), "raw seed text must not be logged");
  assert(src.includes('seed_kind: detectSeedServer(seedValueRaw)?.kind ?? "unknown"'));
});

Deno.test("health: checks.error_redaction is reported", async () => {
  const src = await Deno.readTextFile(new URL("./health-handler.ts", import.meta.url));
  assert(src.includes("r.checks.error_redaction = { ok: true,"));
});
