// lib/socialfetch_input_test.ts — strict near-miss repair for socialfetch_lookup, driven through the REAL schema built
// by buildTools(). Synthetic identifiers only (example_user, example.profile); no real handles, URLs or provider bodies.
import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildTools, type ToolContext } from "../../../functions/osint-agent/tool-registry.ts";
import {
  platformFromUrl,
  repairSocialfetchInput,
  socialfetchCoercionSelfTest,
} from "../../../functions/osint-agent/lib/socialfetch-input.ts";
import { _resetParkedCoercions, takeInputCoercions } from "../../../functions/osint-agent/lib/tool-input-coercion.ts";

type Rec = Record<string, unknown>;
type Parse = { success: boolean; data?: unknown; error?: { issues: Array<{ path: unknown[]; code: string }> } };

function schema() {
  const ctx = {
    supabase: {}, supabaseAdmin: {}, userId: "t", threadId: "sf", archiveEnabled: false,
    detectedSeedType: "username", messages: [], manualOverrideSelector: null,
  } as unknown as ToolContext;
  return (buildTools(ctx).tools as Record<string, { inputSchema: { safeParse: (v: unknown) => Parse } }>).socialfetch_lookup.inputSchema;
}
const ok = (input: unknown): Rec => {
  const r = schema().safeParse(input);
  assert(r.success, `${JSON.stringify(input)} → ${JSON.stringify(r.error?.issues)}`);
  return r.data as Rec;
};
const rejected = (input: unknown) => assertFalse(schema().safeParse(input).success, `${JSON.stringify(input)} should be rejected`);

async function withEnv<T>(key: string, value: string | undefined, fn: () => T | Promise<T>): Promise<T> {
  const prev = Deno.env.get(key);
  if (value === undefined) Deno.env.delete(key); else Deno.env.set(key, value);
  try { return await fn(); } finally {
    if (prev === undefined) Deno.env.delete(key); else Deno.env.set(key, prev);
  }
}

Deno.test("PRODUCTION username/identifier/url each fill a missing handle", () => {
  for (const field of ["username", "identifier"]) {
    const d = ok({ platform: "instagram", [field]: "example_user" });
    assertEquals(d.handle, "example_user", field);
    assertFalse(field in d);
  }
  const d = ok({ platform: "tiktok", url: "https://www.tiktok.com/@example_user" });
  assertEquals(d.handle, "example_user");
});

Deno.test("`value` is accepted only when it is alone", () => {
  assertEquals(ok({ platform: "twitter", value: "example_user" }).handle, "example_user");
  rejected({ platform: "twitter", value: "one", username: "two" });
  rejected({ platform: "twitter", value: "one", handle: "two" });
});

Deno.test("conflicting aliases are REJECTED, even when an explicit handle alone would validate", () => {
  rejected({ platform: "instagram", handle: "one", username: "two" });
  rejected({ platform: "instagram", username: "one", identifier: "two" });
  // agreeing aliases are not a conflict
  assertEquals(ok({ platform: "instagram", handle: "one", username: "one" }).handle, "one");
});

Deno.test("`query` is NOT an alias: {query, platform} is REJECTED, never read as the handle (paid tool; prose is not a selector)", () => {
  rejected({ platform: "twitter", query: "example_user" });
  rejected({ platform: "twitter", query: "https://twitter.com/example_user" });
});

Deno.test("platform is inferred from an EXACT supported host (subdomains ok)", () => {
  const cases: Array<[string, string]> = [
    ["https://www.instagram.com/example_user/", "instagram"],
    ["https://instagram.com/example_user", "instagram"],
    ["https://www.tiktok.com/@example_user", "tiktok"],
    ["https://x.com/example_user", "twitter"],
    ["https://mobile.twitter.com/example_user", "twitter"],
  ];
  for (const [url, platform] of cases) {
    const d = ok({ url });
    assertEquals(d.platform, platform, url);
    assertEquals(d.handle, "example_user", url);
  }
});

Deno.test("facebook keeps the FULL URL as the handle", () => {
  const u = "https://www.facebook.com/example.profile";
  const d = ok({ url: u });
  assertEquals(d.platform, "facebook");
  assertEquals(d.handle, u);
  assertEquals(ok({ platform: "fb", handle: u, kind: "profile" }).handle, u);
});

Deno.test("tiktok kind=video keeps the full video URL", () => {
  const u = "https://www.tiktok.com/@example_user/video/1234567890";
  const d = ok({ url: u, kind: "video" });
  assertEquals(d.platform, "tiktok");
  assertEquals(d.handle, u);
});

Deno.test("a bare handle never yields a platform", () => {
  rejected({ handle: "example_user" });
  rejected({ username: "example_user" });
});

Deno.test("a look-alike or unsupported host never yields a platform", () => {
  for (const u of [
    "https://evil-instagram.com/example_user",
    "https://instagram.com.evil.example/example_user",
    "https://www.youtube.com/@example_user",
    "https://user:pw@instagram.com/example_user",
    "instagram.com/example_user",
  ]) {
    assertEquals(platformFromUrl(u), null, u);
    rejected({ url: u });
  }
});

Deno.test("a supplied platform that conflicts with the URL host is REJECTED", () => {
  rejected({ platform: "tiktok", url: "https://www.instagram.com/example_user/" });
  rejected({ platform: "youtube", url: "https://www.instagram.com/example_user/" });
  // spellings of the SAME platform agree
  assertEquals(ok({ platform: "x", url: "https://twitter.com/example_user" }).handle, "example_user");
  assertEquals(ok({ platform: "IG", handle: "https://instagram.com/example_user" }).handle, "example_user");
});

Deno.test("a profile URL with no readable handle is rejected, not guessed", () => {
  rejected({ url: "https://www.instagram.com/p/AbCdEf123/" });
  rejected({ url: "https://www.tiktok.com/discover" });
  rejected({ url: "https://x.com/" });
});

Deno.test("an already-valid call is returned untouched", () => {
  const input = { platform: "instagram", handle: "example_user", kind: "profile" };
  assertEquals(repairSocialfetchInput(input).kind, "none");
  assertEquals(ok(input).handle, "example_user");
});

Deno.test("a repair is parked for the tool_usage_log trail; a rejection is not", () => {
  _resetParkedCoercions();
  const d = ok({ platform: "instagram", username: "example_user" });
  const recs = takeInputCoercions("socialfetch_lookup", d);
  assert(recs?.some((r) => r.field === "handle" && r.coercion === "field_alias"));
  _resetParkedCoercions();
  rejected({ platform: "instagram", handle: "one", username: "two" });
  assertEquals(takeInputCoercions("socialfetch_lookup", { platform: "instagram" }), null);
});

Deno.test("rejection logs carry a reason code and never a value", () => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try { rejected({ platform: "instagram", handle: "secret_handle_one", username: "secret_handle_two" }); } finally { console.log = orig; }
  const log = lines.join("\n");
  assert(log.includes("tool_input_rejected") && log.includes("conflicting_handle_aliases"));
  assertFalse(log.includes("secret_handle"));
});

Deno.test("kill switches restore the strict schema", async () => {
  await withEnv("SOCIALFETCH_COERCION_DISABLED", "true", () => {
    rejected({ platform: "instagram", username: "example_user" });
    rejected({ url: "https://www.instagram.com/example_user/" });
    // the explicit-handle conflict is also back to today's behaviour (handle wins)
    assertEquals(ok({ platform: "instagram", handle: "one", username: "two" }).handle, "one");
  });
  await withEnv("INPUT_COERCION_DISABLED", "true", () => {
    rejected({ platform: "instagram", username: "example_user" });
  });
});

Deno.test("self-test: passes, reports the switch, and is LEGACY under the kill switch", async () => {
  const t = socialfetchCoercionSelfTest();
  assert(t.ok, t.detail);
  assertEquals(t.switch, "SOCIALFETCH_COERCION_DISABLED=false");
  await withEnv("SOCIALFETCH_COERCION_DISABLED", "true", () => {
    assert(socialfetchCoercionSelfTest().detail.startsWith("LEGACY"));
  });
});
