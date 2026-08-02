// gemini_vision timeout leniency — see PR. A timeout on a huge document must not
// take vision offline for every remaining attachment in the run.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { GENERAL_MULTI_ORIGIN_TOOLS, TIMEOUT_SUPPRESS_CONSECUTIVE } from "./circuit.ts";

Deno.test("gemini_vision is granted per-input timeout leniency", () => {
  assert(
    GENERAL_MULTI_ORIGIN_TOOLS.has("gemini_vision"),
    "gemini_vision lost its timeout leniency — one oversized PDF will again suppress vision for the whole run",
  );
});

Deno.test("the existing multi-origin readers keep their leniency", () => {
  for (const t of ["jina_reader_scrape", "socialfetch_web_read"]) {
    assert(GENERAL_MULTI_ORIGIN_TOOLS.has(t), `${t} lost its leniency`);
  }
});

Deno.test("leniency is bounded — it is 3 consecutive timeouts, not unlimited", () => {
  // If this ever became large, a genuinely dead provider would be retried for the
  // whole run at full fetch-timeout cost per call. The point is tolerance, not
  // blindness.
  assertEquals(TIMEOUT_SUPPRESS_CONSECUTIVE, 3);
});

Deno.test("membership is deliberate and small — no accidental additions", () => {
  assertEquals(
    [...GENERAL_MULTI_ORIGIN_TOOLS].sort(),
    ["gemini_vision", "jina_reader_scrape", "socialfetch_web_read"],
    "the leniency set changed; every member bypasses the in-flight lock too, so additions need review",
  );
});
