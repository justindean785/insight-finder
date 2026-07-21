// cdf02ff8 Fix 1: socialfetch multi-platform calls must not share one circuit key,
// and skipped:true results must not poison later platforms as "prior other".
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  shouldRun,
  recordResult,
  classifyResult,
  clearThread,
  callKey,
  circuitSelectorFor,
} from "./circuit.ts";

Deno.test("circuitSelectorFor includes platform and kind for socialfetch_lookup", () => {
  const sel = circuitSelectorFor(
    "socialfetch_lookup",
    { platform: "Instagram", handle: "@WalidAlAmriki", kind: "profile" },
    "walidalamriki",
  );
  assertEquals(sel, "instagram|profile|walidalamriki");
  const twitch = circuitSelectorFor(
    "socialfetch_lookup",
    { platform: "twitch", handle: "walidalamriki" },
    "walidalamriki",
  );
  assertEquals(twitch, "twitch|profile|walidalamriki");
  assertEquals(
    callKey("socialfetch_lookup", sel),
    "socialfetch_lookup::instagram|profile|walidalamriki::default",
  );
  assertEquals(sel === twitch, false, "different platforms must produce different selectors");
});

Deno.test("circuitSelectorFor leaves non-socialfetch selectors unchanged", () => {
  assertEquals(
    circuitSelectorFor("jina_reader_scrape", { url: "https://example.com" }, "https://example.com"),
    "https://example.com",
  );
});

Deno.test("two socialfetch platforms on same handle both allow after first ok", () => {
  const thread = "t-sf-multi-platform";
  clearThread(thread);
  const ig = "instagram|profile|walidalamriki";
  const gh = "github|profile|walidalamriki";
  assertEquals(shouldRun(thread, "socialfetch_lookup", ig).allow, true);
  recordResult(thread, "socialfetch_lookup", ig, "default", { status: "ok", artifactCount: 0 });
  assertEquals(shouldRun(thread, "socialfetch_lookup", gh).allow, true, "github platform must not collide with instagram key");
  clearThread(thread);
});

Deno.test("classifyResult only treats explicit benign skips as ok", () => {
  assertEquals(
    classifyResult({
      ok: false,
      skipped: true,
      circuit_benign_skip: true,
      reason: "socialfetch_lookup does not support platform='github'",
    }, null),
    "ok",
  );
  assertEquals(
    classifyResult({ ok: false, skipped: true, reason: "run tool-call cap reached" }, null),
    "other",
  );
  const thread = "t-sf-skip-ok";
  clearThread(thread);
  const gh = "github|profile|walidalamriki";
  const ig = "instagram|profile|walidalamriki";
  recordResult(thread, "socialfetch_lookup", gh, "default", {
    status: classifyResult({ ok: false, skipped: true, circuit_benign_skip: true, reason: "unsupported" }, null),
  });
  assertEquals(shouldRun(thread, "socialfetch_lookup", ig).allow, true);
  // Same platform+kind after a skipped ok still allows (artifactCount 0) — only
  // a later success with artifacts would dedup; live wrapper records 0.
  assertEquals(shouldRun(thread, "socialfetch_lookup", gh).allow, true);
  clearThread(thread);
});
