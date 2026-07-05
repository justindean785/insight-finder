// Regression tests for the leakcheck/oathnet request shapes (the 400/502 fixes).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildLeakcheckUrl, buildOathnetUrl } from "./breach-request.ts";

Deno.test("leakcheck: omits type when auto/undefined (the HTTP 400 fix)", () => {
  // LeakCheck v2 rejects an explicit type=auto with 400 — auto-detect = omit it.
  assertEquals(
    buildLeakcheckUrl("gormanforever@gmail.com", "auto"),
    "https://leakcheck.io/api/v2/query/gormanforever%40gmail.com",
  );
  assertEquals(
    buildLeakcheckUrl("someuser", undefined),
    "https://leakcheck.io/api/v2/query/someuser",
  );
  assertEquals(buildLeakcheckUrl("  spaced  ", null), "https://leakcheck.io/api/v2/query/spaced");
});

Deno.test("leakcheck: appends concrete (non-auto) type", () => {
  assertEquals(
    buildLeakcheckUrl("a@b.com", "email"),
    "https://leakcheck.io/api/v2/query/a%40b.com?type=email",
  );
  assert(buildLeakcheckUrl("x", "phone").endsWith("?type=phone"));
  // No raw "type=auto" must ever reach the wire.
  assert(!buildLeakcheckUrl("x", "auto").includes("type="));
});

Deno.test("leakcheck: phone values are normalized to bare digits (the E.164 400 fix)", () => {
  // LeakCheck v2 /query rejects "+"/separators on phone → 400 (verified in prod
  // from tool_usage_log.input_json, e.g. "+19165629177"). Normalize to digits.
  assertEquals(
    buildLeakcheckUrl("+19165629177", "phone"),
    "https://leakcheck.io/api/v2/query/19165629177?type=phone",
  );
  assertEquals(
    buildLeakcheckUrl("+1 (916) 562-9177", "phone"),
    "https://leakcheck.io/api/v2/query/19165629177?type=phone",
  );
  // Non-phone types are NOT digit-stripped.
  assert(buildLeakcheckUrl("a@b.com", "email").includes("a%40b.com"));
});

Deno.test("leakcheck: keyword is not offered (names route to oathnet type:name)", async () => {
  // The tool schema must not accept 'keyword' — LeakCheck v2 /query 400s on it.
  const { buildTools } = await import("./tool-registry.ts");
  const ctx = {
    supabase: {}, supabaseAdmin: {}, userId: "t", threadId: "t",
    archiveEnabled: false, detectedSeedType: "email", messages: [], manualOverrideSelector: null,
  } as unknown as import("./tool-registry.ts").ToolContext;
  const tools = buildTools(ctx).tools as Record<string, { inputSchema: { safeParse(v: unknown): { success: boolean } } }>;
  const lc = tools.leakcheck_lookup;
  const parsed = lc.inputSchema.safeParse({ value: "chester dean", type: "keyword" });
  assert(!parsed.success, "leakcheck_lookup must reject type:'keyword'");
  // Concrete supported types still parse.
  assert(lc.inputSchema.safeParse({ value: "a@b.com", type: "email" }).success);
});

Deno.test("oathnet: ip uses ip-info; others use v2 breach search", () => {
  assertEquals(
    buildOathnetUrl("ip", "8.8.8.8"),
    "https://oathnet.org/api/service/ip-info?ip=8.8.8.8",
  );
  const email = buildOathnetUrl("email", "a@b.com");
  assert(email.startsWith("https://oathnet.org/api/service/v2/breach/search?"));
  assert(email.includes("q=a%40b.com"));
  assert(email.includes("limit=50"));
  // domain maps to email_domain, not q.
  const domain = buildOathnetUrl("domain", "example.com");
  assert(domain.includes("email_domain=example.com"));
  assert(!domain.includes("q="));
});

Deno.test("oathnet: a person NAME goes through the free-text q= breach search", () => {
  // The enum unblock (type:'name') relies on name falling into the same q=
  // branch as email/username/phone — NOT email_domain, NOT ip-info.
  const name = buildOathnetUrl("name", "Catherine Beth Washburn");
  assert(name.startsWith("https://oathnet.org/api/service/v2/breach/search?"));
  assert(name.includes("q=Catherine+Beth+Washburn"));
  assert(name.includes("limit=50"));
  assert(!name.includes("email_domain="));
  assert(!name.includes("ip-info"));
});
