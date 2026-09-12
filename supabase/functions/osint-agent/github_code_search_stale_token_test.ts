// github_code_search_stale_token_test.ts — a rejected token must not be worse
// than no token.
//
// The tool's own description promises "Authenticated via GITHUB_API_TOKEN
// (5,000 req/hr) when configured, else falls back to unauthenticated (60
// req/hr)". That fallback only ever covered "no token set". With a stale or
// revoked token the call 401ed and was simply lost: on the 2026-09-12
// `baig_azhar` case the Health tab read "github_code_search — Config 1 — HTTP
// 401 Provider authentication failed", and the run persisted a `weak_lead`
// artifact recording the search as FAILED, for a query GitHub answers
// unauthenticated.
//
// GITHUB_API_TOKEN is captured at import time (env.ts), so it must be set
// BEFORE the dynamic buildTools import — present-but-dead here, to exercise
// the live-401 path rather than the absent-key one.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.env.set("GITHUB_API_TOKEN", "ghp_dead_token_for_test");

const { buildTools } = await import("./tool-registry.ts");

type AnyRec = Record<string, unknown>;

function stubCtx() {
  const supabase = {
    from: (_t: string) => ({ insert: (_rows: AnyRec[]) => Promise.resolve({ error: null }) }),
  };
  return {
    supabase, supabaseAdmin: supabase, userId: "u", threadId: "t-gh-401",
    archiveEnabled: false, detectedSeedType: "email", messages: [], manualOverrideSelector: null,
  } as unknown as Parameters<typeof buildTools>[0];
}

function getTool(name: string) {
  const { tools } = buildTools(stubCtx());
  return (tools as Record<string, { execute: (a: unknown, o: unknown) => Promise<unknown> }>)[name];
}

const BAD_CREDS = JSON.stringify({ message: "Bad credentials", documentation_url: "https://docs.github.com/rest" });
const HIT = JSON.stringify({
  total_count: 1,
  items: [{
    repository: { full_name: "acme/widgets" },
    path: "src/config.ts",
    html_url: "https://github.com/acme/widgets/blob/main/src/config.ts",
    text_matches: [{ fragment: "owner = baigazhar042@gmail.com" }],
  }],
});

/** Record each call's Authorization header so we can assert on the retry. */
function stubGitHub(responder: (authed: boolean, call: number) => Response) {
  const calls: boolean[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.includes("api.github.com/search/code")) return new Response("{}", { status: 200 });
    const headers = new Headers(
      input instanceof Request ? input.headers : (init?.headers as HeadersInit | undefined),
    );
    const authed = headers.has("authorization");
    calls.push(authed);
    return responder(authed, calls.length);
  }) as typeof globalThis.fetch;
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

Deno.test("a rejected token is retried WITHOUT the credential, and the result is returned", async () => {
  const gh = stubGitHub((authed) => authed ? new Response(BAD_CREDS, { status: 401 }) : new Response(HIT, { status: 200 }));
  try {
    const res = await getTool("github_code_search").execute({ query: "baigazhar042@gmail.com" }, {}) as AnyRec;
    assertEquals(gh.calls, [true, false], "expected one authed attempt then one unauthenticated retry");
    assertEquals(res.ok, true, "the unauthenticated retry answered, so the tool succeeded");
    assertEquals(res.authenticated, false, "the successful call was unauthenticated — say so");
    assertEquals(res.token_rejected, true, "the stale token must remain visible to the operator");
    assertEquals((res.items as AnyRec[]).length, 1);
  } finally {
    gh.restore();
  }
});

Deno.test("a 403 from the token is retried the same way", async () => {
  const gh = stubGitHub((authed) => authed ? new Response(BAD_CREDS, { status: 403 }) : new Response(HIT, { status: 200 }));
  try {
    const res = await getTool("github_code_search").execute({ query: "x" }, {}) as AnyRec;
    assertEquals(gh.calls, [true, false]);
    assertEquals(res.ok, true);
  } finally {
    gh.restore();
  }
});

Deno.test("when the unauthenticated retry ALSO fails, the error names the stale token", async () => {
  // Unauthenticated GitHub search is 60 req/hr, so the retry can be rate
  // limited. The tool must then still report the real cause, not just "401".
  const gh = stubGitHub((authed) =>
    authed
      ? new Response(BAD_CREDS, { status: 401 })
      : new Response(JSON.stringify({ message: "API rate limit exceeded" }), { status: 403 })
  );
  try {
    const res = await getTool("github_code_search").execute({ query: "x" }, {}) as AnyRec;
    assertEquals(gh.calls, [true, false]);
    assertEquals(res.ok, undefined);
    assertEquals(res.status, 403);
    assertEquals(res.token_rejected, true);
    assertEquals(res.authenticated, false);
    assert(String(res.message ?? "").includes("rate limit"), "the retry's real failure must be reported");
  } finally {
    gh.restore();
  }
});

Deno.test("a WORKING token is used once and never retried", async () => {
  const gh = stubGitHub(() => new Response(HIT, { status: 200 }));
  try {
    const res = await getTool("github_code_search").execute({ query: "x" }, {}) as AnyRec;
    assertEquals(gh.calls, [true], "a successful authed call must not spend a second request");
    assertEquals(res.ok, true);
    assertEquals(res.authenticated, true);
    assertEquals(res.token_rejected, undefined);
  } finally {
    gh.restore();
  }
});

Deno.test("a non-auth failure (422) is NOT retried — only credential rejections are", async () => {
  const gh = stubGitHub(() => new Response(JSON.stringify({ message: "Validation Failed" }), { status: 422 }));
  try {
    const res = await getTool("github_code_search").execute({ query: "%%%" }, {}) as AnyRec;
    assertEquals(gh.calls, [true], "a bad query must not be re-sent unauthenticated");
    assertEquals(res.status, 422);
    assertEquals(res.token_rejected, false);
  } finally {
    gh.restore();
  }
});
