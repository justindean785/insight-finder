// input_kind_inference_test.ts — a missing kind is inferred from the selector's SHAPE; serus field aliases.
//
// PRODUCTION (dizosint case, orchestrator GLM-5.2): `google_dorks {query}` with no `kind`, and
// `serus_darkweb_scan {identifier, identifierType}` instead of `identifierValue`, were both rejected by the AI SDK before
// execute. Driven through the REAL schemas built by buildTools(). Synthetic values only.
import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { asSchema } from "npm:ai@6";
import { buildTools, type ToolContext } from "../../functions/osint-agent/tool-registry.ts";
import { detectSeedServer } from "../../functions/osint-agent/validation.ts";
import {
  coerceToolInput,
  inferSelectorKind,
  inputKindInferenceSelfTest,
} from "../../functions/osint-agent/lib/tool-input-coercion.ts";

const SWITCH = "INPUT_COERCION_DISABLED";
async function withEnv<T>(key: string, value: string | undefined, fn: () => T | Promise<T>): Promise<T> {
  const prev = Deno.env.get(key);
  if (value === undefined) Deno.env.delete(key); else Deno.env.set(key, value);
  try { return await fn(); } finally {
    if (prev === undefined) Deno.env.delete(key); else Deno.env.set(key, prev);
  }
}

type Rec = Record<string, unknown>;
type Parse = { success: boolean; data?: unknown; error?: { issues: unknown[] } };
type SchemaLike = { safeParse: (v: unknown) => Parse };

function realTools() {
  const ctx = {
    supabase: {}, supabaseAdmin: {}, userId: "t", threadId: "infer", archiveEnabled: false,
    detectedSeedType: "username", messages: [], manualOverrideSelector: null,
  } as unknown as ToolContext;
  return buildTools(ctx).tools as Record<string, { inputSchema: SchemaLike }>;
}
function ok(name: string, input: unknown): Rec {
  const r = realTools()[name].inputSchema.safeParse(input);
  assert(r.success, `${name} ${JSON.stringify(input)} → ${JSON.stringify(r.error?.issues)}`);
  return r.data as Rec;
}
function rejected(name: string, input: unknown): void {
  assertFalse(realTools()[name].inputSchema.safeParse(input).success, `${name} ${JSON.stringify(input)} should be rejected`);
}

Deno.test("PRODUCTION google_dorks `{query}` with no kind: kind is read off the seed's shape", () => {
  const cases: Array<[string, string]> = [
    ["someone@example.com", "email"],
    ["198.51.100.7", "ip"],
    ["example.com", "domain"],
    ["+1 617 555 0100", "phone"],
    ["sample_handle", "username"],
    ["0x52908400098527886e0f7030069857d2e4169ee7", "crypto_wallet"],
  ];
  for (const [seed, want] of cases) {
    const d = ok("google_dorks", { query: seed });
    assertEquals(d.seed, seed);
    assertEquals(d.kind, want, seed);
    assertFalse("query" in d);
  }
});

Deno.test("google_dorks: an explicit kind always wins over inference", () => {
  assertEquals(ok("google_dorks", { seed: "someone@example.com", kind: "username" }).kind, "username");
});

Deno.test("google_dorks: an ambiguous or unrecognisable seed infers nothing and is still rejected", () => {
  rejected("google_dorks", { query: "John Example Smith" }); // a name is not guessed from prose
  rejected("google_dorks", { query: "\"sample_handle\" site:example.com" }); // a dork string, not a selector
  rejected("google_dorks", { query: "2026-10-15" }); // a date is not a phone
  rejected("google_dorks", { query: "https://example.com/u/sample" }); // a URL has no google_dorks kind
  rejected("google_dorks", { seed: "x" });
});

Deno.test("PRODUCTION serus_darkweb_scan `{identifier, identifierType}`: identifier becomes identifierValue", () => {
  const d = ok("serus_darkweb_scan", { identifier: "someone@example.com", identifierType: "email" });
  assertEquals(d.identifierValue, "someone@example.com");
  assertEquals(d.identifierType, "email");
  assertFalse("identifier" in d);
  const v = ok("serus_darkweb_scan", { value: " someone@example.com ", type: "email" });
  assertEquals(v.identifierValue, "someone@example.com");
  assertEquals(v.identifierType, "email");
});

Deno.test("serus_darkweb_scan: identifierType inferred only from unambiguous shapes; ip maps to origin", () => {
  assertEquals(ok("serus_darkweb_scan", { identifier: "someone@example.com" }).identifierType, "email");
  assertEquals(ok("serus_darkweb_scan", { identifierValue: "198.51.100.7" }).identifierType, "origin");
  assertEquals(ok("serus_darkweb_scan", { identifierValue: "198.51.100.7", identifierType: "ip" }).identifierType, "origin");
  assertEquals(ok("serus_darkweb_scan", { identifierValue: "example.com" }).identifierType, "domain");
  // PAID tool: a bare token is NOT guessed as a username, and a date is not a phone
  rejected("serus_darkweb_scan", { identifierValue: "sample_handle" });
  rejected("serus_darkweb_scan", { identifierValue: "2026-10-15" });
  // the reveal flag is passed through untouched
  assertEquals(ok("serus_darkweb_scan", { identifier: "someone@example.com", identifierType: "email", reveal: true }).reveal, true);
});

Deno.test("KILL SWITCH: INPUT_COERCION_DISABLED=true restores both production rejections", async () => {
  await withEnv(SWITCH, "true", () => {
    rejected("google_dorks", { query: "someone@example.com" });
    rejected("serus_darkweb_scan", { identifier: "someone@example.com", identifierType: "email" });
    ok("serus_darkweb_scan", { identifierValue: "someone@example.com", identifierType: "email" });
    assertEquals(inputKindInferenceSelfTest(detectSeedServer).switch, "INPUT_COERCION_DISABLED=true");
  });
  assertEquals(ok("google_dorks", { query: "someone@example.com" }).kind, "email");
});

Deno.test("model-facing serus JSON schema is unchanged in shape", async () => {
  const s = (await asSchema(realTools().serus_darkweb_scan.inputSchema as never).jsonSchema) as { type?: string; properties?: Rec };
  assertEquals(s.type, "object");
  assertEquals(Object.keys(s.properties ?? {}).sort(), ["identifierType", "identifierValue", "reveal"]);
});

Deno.test("inferSelectorKind: pure, structural, never throws", () => {
  assertEquals(inferSelectorKind("someone@example.com", detectSeedServer), "email");
  assertEquals(inferSelectorKind("sample_handle", detectSeedServer), null);
  assertEquals(inferSelectorKind("sample_handle", detectSeedServer, { allowUsername: true }), "username");
  assertEquals(inferSelectorKind("", detectSeedServer), null);
  assertEquals(inferSelectorKind("x".repeat(300), detectSeedServer, { allowUsername: true }), null);
  // a throwing inferer leaves the field missing
  const r = coerceToolInput({ v: "a" }, { enumFields: { k: ["a"] }, infer: { k: { from: "v", infer: () => { throw new Error("x"); } } } });
  assertEquals(r.records, []);
});

Deno.test("/health: checks.input_kind_inference is wired and passes", async () => {
  const st = inputKindInferenceSelfTest(detectSeedServer);
  assertEquals(st.ok, true, st.detail);
  assertEquals(st.switch, "INPUT_COERCION_DISABLED=false");
  const health = await Deno.readTextFile(new URL("../../functions/osint-agent/health-handler.ts", import.meta.url));
  assert(health.includes("r.checks.input_kind_inference = inputKindInferenceSelfTest(detectSeedServer);"));
});
