import "./_test_env_socialfetch_key.ts";
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildTools,
  isAbortLikeError,
  socialfetchJinaFallback,
  SOCIALFETCH_WRAPPER_BUDGET_MS,
  SOCIALFETCH_FALLBACK_MIN_BUDGET_MS,
  SOCIALFETCH_FALLBACK_MAX_MS,
  SOCIALFETCH_MIN_BODY_CHARS,
  SOCIALFETCH_DEFAULT_TIMEOUT_MS,
  type ToolContext,
} from "../../functions/osint-agent/tool-registry.ts";
import { TOOL_TIMEOUT_OVERRIDE_MS } from "../../functions/osint-agent/cache.ts";

/**
 * socialfetch_web_read's failure taxonomy and its one free jina fallback.
 *
 * The distinctions pinned here are the ones an analyst reads off the trace:
 *   host_unsupported  we never asked (0 credits, 0 network)
 *   timeout           the host was slow — NOT the same fact as "broken"
 *   empty_body        2xx that carried no page — must never become evidence
 *   upstream_5xx      the provider failed
 * Collapsing any of them into a generic `failed` is what made the failed-tools
 * panel unable to tell a slow site from a dead one.
 */

type ExecTool = { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> };
function webRead(): ExecTool {
  const ctx = {
    supabase: {}, supabaseAdmin: {}, userId: "t", threadId: "t-sf-fallback",
    archiveEnabled: false, detectedSeedType: "url", messages: [], manualOverrideSelector: null,
  } as unknown as ToolContext;
  return (buildTools(ctx).tools as Record<string, ExecTool>).socialfetch_web_read;
}

const abort = () => { throw new DOMException("The signal has been aborted", "AbortError"); };
const bigPage = "x".repeat(SOCIALFETCH_MIN_BODY_CHARS + 50);

async function withFetch(h: (url: string) => Response | Promise<Response>, body: () => Promise<void>) {
  const orig = globalThis.fetch;
  try {
    globalThis.fetch = ((i: Request | URL | string) =>
      Promise.resolve(h(i instanceof Request ? i.url : String(i)))) as typeof globalThis.fetch;
    await body();
  } finally { globalThis.fetch = orig; }
}

// ---- the constant that must not drift --------------------------------------

Deno.test("the mirrored wrapper budget still equals cache.ts's real override", () => {
  // tool-registry.ts duplicates this to avoid importing cache.ts. A silent drift
  // would make every budget decision below wrong in the same direction.
  assertEquals(
    SOCIALFETCH_WRAPPER_BUDGET_MS,
    TOOL_TIMEOUT_OVERRIDE_MS.socialfetch_web_read,
    "SOCIALFETCH_WRAPPER_BUDGET_MS must track TOOL_TIMEOUT_OVERRIDE_MS.socialfetch_web_read",
  );
});

Deno.test("the wrapper still sits above the internal cap", () => {
  assert(
    SOCIALFETCH_WRAPPER_BUDGET_MS > SOCIALFETCH_DEFAULT_TIMEOUT_MS,
    "the tool must fail cleanly before the wrapper kills it, or the wrapper orphans the request",
  );
});

// ---- abort detection -------------------------------------------------------

Deno.test("isAbortLikeError matches the shapes fetch actually throws", () => {
  assert(isAbortLikeError(new DOMException("aborted", "AbortError")));
  assert(isAbortLikeError(new DOMException("timed out", "TimeoutError")));
  // fetchRetry can lose the name and leave only the message.
  assert(isAbortLikeError(new Error("The signal has been aborted")));
  assert(isAbortLikeError(new Error("request timed out")));
  assertEquals(isAbortLikeError(new Error("upstream returned HTTP 500")), false);
  assertEquals(isAbortLikeError(new TypeError("network error")), false);
});

// ---- budget arithmetic, tested on the helper directly ----------------------

Deno.test("no fallback when the remaining wrapper budget is under the floor", async () => {
  let called = false;
  await withFetch(() => { called = true; return new Response(bigPage, { status: 200 }); }, async () => {
    // Started long enough ago that less than the floor remains.
    const startedAt = Date.now() - (SOCIALFETCH_WRAPPER_BUDGET_MS - SOCIALFETCH_FALLBACK_MIN_BUDGET_MS + 500);
    assertEquals(await socialfetchJinaFallback("https://slow.example/page", startedAt), null);
    assertEquals(called, false, "a fallback with no runway must not issue a request");
  });
});

Deno.test("fallback runs with budget, returns via:jina_fallback, and is bounded", async () => {
  await withFetch(
    (u) => {
      assert(u.startsWith("https://r.jina.ai/"), `fallback must call jina, got ${u}`);
      return new Response(bigPage, { status: 200 });
    },
    async () => {
      const r = await socialfetchJinaFallback("https://slow.example/page", Date.now());
      assert(r, "a fresh start has full budget");
      assertEquals(r?.ok, true);
      assertEquals(r?.via, "jina_fallback");
      assert((r?.fallback_budget_ms as number) <= SOCIALFETCH_FALLBACK_MAX_MS);
    },
  );
});

Deno.test("no fallback to a host jina hard-blocks — being refused wastes the remainder", async () => {
  let called = false;
  await withFetch(() => { called = true; return new Response(bigPage, { status: 200 }); }, async () => {
    assertEquals(await socialfetchJinaFallback("https://x.com/someone/status/1", Date.now()), null);
    assertEquals(called, false, "x.com is in JINA_HARD_BLOCK_HOSTS — do not spend budget being refused");
  });
});

Deno.test("a thin jina body is not a rescue", async () => {
  await withFetch(() => new Response("nope", { status: 200 }), async () => {
    assertEquals(await socialfetchJinaFallback("https://slow.example/page", Date.now()), null);
  });
});

// ---- end to end through the tool -------------------------------------------

Deno.test("a timeout is classified as timeout, and SocialFetch is never retried", async () => {
  let socialfetchCalls = 0;
  let jinaCalls = 0;
  await withFetch(
    (u) => {
      if (u.includes("api.socialfetch.dev")) { socialfetchCalls++; return abort(); }
      jinaCalls++;
      return new Response(bigPage, { status: 200 });
    },
    async () => {
      const r = await webRead().execute({ url: "https://unpredictable.example/p" }, {});
      assertEquals(socialfetchCalls, 1, "a retry would spend a second credit on a provider that just failed");
      assertEquals(jinaCalls, 1, "exactly one free fallback attempt");
      assertEquals(r.via, "jina_fallback");
      assertEquals(r.primary_failure, "timeout");
      assertEquals(r.ok, true);
    },
  );
});

Deno.test("a timeout with no rescue reports timed_out, not a bare failure", async () => {
  await withFetch(
    (u) => u.includes("api.socialfetch.dev") ? abort() : new Response("", { status: 403 }),
    async () => {
      const r = await webRead().execute({ url: "https://unpredictable.example/p" }, {});
      assertEquals(r.ok, false);
      assertEquals(r.status, "timed_out");
      assertEquals(r.failure_class, "timeout");
      assert(typeof r.elapsed_ms === "number");
    },
  );
});

Deno.test("a 2xx carrying an error envelope or a blank page is NOT a page read", async () => {
  // jina is made to fail here so the primary classification is what is asserted.
  // The rescue path is the next test; keeping them apart is deliberate — a mock
  // that answers every host with a good page hides which reader produced it.
  for (const payload of [
    JSON.stringify({ data: "", error: "target URL returned error 404" }),
    JSON.stringify({ data: "" }),
    JSON.stringify({ data: "too short" }),
  ]) {
    await withFetch(
      (u) => u.includes("api.socialfetch.dev")
        ? new Response(payload, { status: 200 })
        : new Response("", { status: 502 }),
      async () => {
        const r = await webRead().execute({ url: "https://blank.example/p" }, {});
        assertEquals(r.ok, false, payload);
        assertEquals(r.failure_class, "empty_body", payload);
        assertEquals(r.data, undefined, "a rejected body must never arrive as `data`");
      },
    );
  }
});

Deno.test("a thin 2xx spends its intact budget on the free reader", async () => {
  // This is the ONE failure class where nothing timed out, so the fallback has
  // the full wrapper budget rather than the ~3s the full-timeout path leaves it.
  // Before this it did not even try: the credit was spent and the call returned
  // a char count.
  await withFetch(
    (u) => u.includes("api.socialfetch.dev")
      ? new Response(JSON.stringify({ data: "too short" }), { status: 200 })
      : new Response(bigPage, { status: 200 }),
    async () => {
      const r = await webRead().execute({ url: "https://thin.example/p" }, {});
      assertEquals(r.ok, true);
      assertEquals(r.via, "jina_fallback");
      assertEquals(r.primary_failure, "empty_body");
      assertEquals(r.primary_chars, "too short".length);
      assertEquals(r.data, bigPage);
    },
  );
});

Deno.test("when the free reader misses too, the paid-for characters survive", async () => {
  // The floor exists so a blank page cannot enter the case AS a page read, which
  // `ok:false` secures on its own. Discarding the characters as well was a second,
  // unintended loss: a legitimately short page (a stub profile, a one-line bio) is
  // rare but real, and a bare char count gives the model nothing to judge it by.
  await withFetch(
    (u) => u.includes("api.socialfetch.dev")
      ? new Response(JSON.stringify({ data: "Ann Marie — private account." }), { status: 200 })
      : new Response("", { status: 502 }),
    async () => {
      const r = await webRead().execute({ url: "https://stub.example/p" }, {});
      assertEquals(r.ok, false, "still not a successful read");
      assertEquals(r.failure_class, "empty_body");
      assertEquals(r.thin_body, "Ann Marie — private account.");
      assertEquals(r.data, undefined, "deliberately not `data` — nothing may mistake it for a read");
      assertEquals(r.chars, "Ann Marie — private account.".length);
    },
  );
});

Deno.test("a genuinely blank body carries no thin_body key at all", async () => {
  await withFetch(
    (u) => u.includes("api.socialfetch.dev")
      ? new Response(JSON.stringify({ data: "   " }), { status: 200 })
      : new Response("", { status: 502 }),
    async () => {
      const r = await webRead().execute({ url: "https://void.example/p" }, {});
      assertEquals(r.failure_class, "empty_body");
      assertEquals(r.thin_body, undefined);
      assertEquals(r.chars, 0);
    },
  );
});

Deno.test("a real 2xx page is unchanged — the taxonomy must not eat good reads", async () => {
  await withFetch(
    () => new Response(JSON.stringify({ data: bigPage, meta: { title: "t" } }), { status: 200 }),
    async () => {
      const r = await webRead().execute({ url: "https://good.example/p" }, {});
      assertEquals(r.ok, true);
      assertEquals(r.data, bigPage);
      assertEquals(r.failure_class, undefined);
      assertEquals(r.via, undefined, "a direct success is not a fallback");
    },
  );
});

Deno.test("a 5xx takes the fallback and is labelled upstream_5xx", async () => {
  await withFetch(
    (u) => u.includes("api.socialfetch.dev")
      ? new Response("boom", { status: 503 })
      : new Response(bigPage, { status: 200 }),
    async () => {
      const r = await webRead().execute({ url: "https://flaky.example/p" }, {});
      assertEquals(r.via, "jina_fallback");
      assertEquals(r.primary_failure, "upstream_5xx");
      assertEquals(r.primary_status, 503);
    },
  );
});

Deno.test("a skipped host reports host_unsupported and spends nothing", async () => {
  let called = false;
  await withFetch(() => { called = true; return new Response(bigPage, { status: 200 }); }, async () => {
    const r = await webRead().execute({ url: "https://www.youtube.com/watch?v=abc" }, {});
    assertEquals(r.skipped, true);
    assertEquals(r.failure_class, "host_unsupported");
    assertEquals(r.status, "skipped");
    assertEquals(called, false, "a skip must not reach the network, or it is not free");
  });
});
