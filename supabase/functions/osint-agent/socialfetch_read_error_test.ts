// socialfetch_read_error_test.ts — a deliberate fast-timeout must not read as a cancellation.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { socialfetchReadError, socialfetchHostPolicy, SOCIALFETCH_YOUTUBE_FAST_TIMEOUT_MS } from "./tool-registry.ts";
import { classifyToolOutcome } from "./tool-outcome.ts";

const ABORT = new DOMException("The signal has been aborted", "AbortError");

Deno.test("YouTube fast-timeout abort is named as a timeout, and classifies as failed (not skipped)", () => {
  const policy = socialfetchHostPolicy("youtube.com");
  const msg = socialfetchReadError(ABORT, policy);
  assertEquals(msg, `socialfetch_web_read exceeded ${SOCIALFETCH_YOUTUBE_FAST_TIMEOUT_MS}ms fast timeout (host policy: known-slow host)`);
  assertEquals(classifyToolOutcome(msg, null), "failed");
});

Deno.test("an abort on a normal host keeps the raw error, and a non-abort error is untouched", () => {
  assertEquals(socialfetchReadError(ABORT, socialfetchHostPolicy("example.com")), String(ABORT));
  assertEquals(socialfetchReadError(new Error("jina 422"), socialfetchHostPolicy("youtube.com")), "Error: jina 422");
});
