// Tests for classifyToolOutcome — the honest tool-call outcome taxonomy.
// Strings below are taken verbatim from the production tool_usage_log audit so
// the classifier is pinned to REAL governance/empty/failure messages.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifyToolOutcome } from "./tool-outcome.ts";

Deno.test("ok: no error and no status", () => {
  assertEquals(classifyToolOutcome(null, null), "ok");
  assertEquals(classifyToolOutcome("", null), "ok");
});

Deno.test("skipped: governance / budget / concurrency / dedup", () => {
  const skips = [
    "execution plan required for this cycle",
    "duplicate call: prior other",
    "burst limit reached for oathnet_lookup (6/6 on this investigation)",
    "same-tool cycle limit reached (1)",
    "same-tool budget exhausted (4 per run)",
    "paid-call cycle limit reached (2)",
    "paid-call budget exhausted (12 per run)",
    "active-call concurrency limit reached (3)",
    "internal concurrency cap reached (3 parallel calls) — retry momentarily; internal throttle",
    "provider 'minimax' already has a call in-flight — waiting for its result",
    "leakcheck_lookup skipped — high-cost tool already used this seed (0 new artifacts since, needs corroboration)",
    "weak lead blocked: confidence below 50; single-source lead",
    "expected value 52 below 70",
    "disabled after 3 consecutive failures",
    "serus_darkweb_scan degraded this run — skipped",
    "5xx — provider 'serus_darkweb_scan' suppressed for investigation",
    "429 rate-limited — provider 'serus_darkweb_scan' suppressed for investigation",
    "selector blacklisted for serus_darkweb_scan",
    "unavailable: disabled (provider disabled in config)",
    "unavailable: missing_key (HIBP_API_KEY not set)",
    "unavailable: gated (INTELBASE_ENABLED not enabled)",
    "intelbase gated",
    "HIBP_API_KEY not configured",
  ];
  for (const s of skips) assertEquals(classifyToolOutcome(s, null), "skipped", s);
});

Deno.test("skipped wins even when a status code is present", () => {
  // "429 rate-limited — provider X suppressed" must read as a skip, not a 429 failure.
  assertEquals(
    classifyToolOutcome("429 rate-limited — provider 'x' suppressed for investigation", 429),
    "skipped",
  );
});

Deno.test("empty: tool ran, target has no record", () => {
  assertEquals(classifyToolOutcome("tool returned no usable result", null), "empty");
  assertEquals(classifyToolOutcome(null, 404), "empty");        // gravatar/hibp no-record
  assertEquals(classifyToolOutcome("upstream returned HTTP 404", 404), "empty");
});

Deno.test("failed: genuine provider errors", () => {
  const fails: Array<[string | null, number | null]> = [
    ["upstream returned HTTP 500", 500],
    ["upstream returned HTTP 502", 502],
    ["upstream returned HTTP 400", 400],   // real bad-request (not a governance skip)
    ["upstream returned HTTP 401", 401],
    ["upstream returned HTTP 429", 429],    // raw provider rate-limit (no suppression text)
    ["bosint_phone_timeout", null],
    ["AbortError: The signal has been aborted", null],
    ["jina 451", 451],
    ["Invalid or unauthorized key. Please check the API key and try again.", 200],
  ];
  for (const [msg, code] of fails) assertEquals(classifyToolOutcome(msg, code), "failed", String(msg));
});

Deno.test("robust: non-string errorMsg is coerced, never throws (serus regression)", () => {
  // serus_darkweb_scan passed an object as errorMsg, crashing classification
  // with "(errorMsg ?? '').trim is not a function". Coerce instead of throwing.
  const obj = { code: 500, body: "boom" } as unknown as string;
  assertEquals(classifyToolOutcome(obj, 500), "failed");
  assertEquals(classifyToolOutcome(undefined, null), "ok");
});
