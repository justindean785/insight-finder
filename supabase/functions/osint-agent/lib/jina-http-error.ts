// lib/jina-http-error.ts — shape a NON-OK HTTP answer from r.jina.ai.
//
// A raw 403 from r.jina.ai is the target page refusing the reader, not a dead
// Jina credential. Measured 2026-10-18 (tool_usage_log, 30 days): 11 `jina 403`
// failures, and in every thread where Jina ran again within 15 minutes it read
// other URLs successfully before and after the 403. Returned as `{status:403}`,
// `circuit.classifyResult` filed it `http_403` and suppressed the whole provider
// as "401/403 unauthorized", so 4 later reads of healthy pages were refused.
//
// So a 403 travels the way the 200-wrapped origin errors already do
// (lib/negative-lookup.ts shapeJinaBody): `origin_error:true` with the code in
// `target_status`, never `status`. The read is still logged `failed` (the page
// was not read); the breaker just doesn't count it against Jina's health.
// 401 (bad key), 402 (balance) and every other status keep the provider shape.
//
// KILL SWITCH, read at CALL TIME: JINA_TARGET_403_DISABLED=true restores the old
// `{status:403}` shape on the running build with no deploy.

export function jinaTarget403Disabled(): boolean {
  return (Deno.env.get("JINA_TARGET_403_DISABLED") ?? "").trim().toLowerCase() === "true";
}

/** The result jina_reader_scrape returns when r.jina.ai answers `status` (not ok). */
export function shapeJinaHttpError(url: string, status: number): Record<string, unknown> {
  if (status === 403 && !jinaTarget403Disabled()) {
    return {
      ok: false,
      origin_error: true,
      error: "jina 403",
      target_status: 403,
      url,
      hint: "this page refused the reader — try socialfetch_web_read, wayback_snapshots, or a different result",
    };
  }
  const hint = status === 422
    ? "jina cannot parse this URL — try a different source or wayback snapshot"
    : status === 451 || status === 403
      ? "origin blocked — try wayback_snapshots or a different result"
      : undefined;
  return { error: `jina ${status}`, status, url, hint };
}

/**
 * `/health` → `checks.jina_target_403`. Presence of the key proves this build is
 * deployed; `ok:false` means the rule no longer behaves as documented.
 */
export function jinaTarget403SelfTest(): { ok: boolean; detail: string } {
  if (jinaTarget403Disabled()) {
    return { ok: true, detail: "LEGACY via JINA_TARGET_403_DISABLED: a raw 403 suppresses Jina for the run" };
  }
  const wrong: string[] = [];
  const s403 = shapeJinaHttpError("https://example.test/x", 403);
  if (s403.origin_error !== true || "status" in s403) wrong.push("403 is not an origin error");
  const s401 = shapeJinaHttpError("https://example.test/x", 401);
  if (s401.status !== 401 || "origin_error" in s401) wrong.push("401 no longer a provider failure");
  return wrong.length
    ? { ok: false, detail: wrong.join("; ") }
    : { ok: true, detail: "a raw 403 from r.jina.ai is a failed read of that page and does not suppress Jina; 401/402/5xx still do" };
}
