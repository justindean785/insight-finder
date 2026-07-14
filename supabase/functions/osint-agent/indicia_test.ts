import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  indicia_email, indicia_phone, indicia_person,
  indicia_address, indicia_web_dbs, indicia_hudsonrock,
  extractIndiciaRecords, isBarePhoneSelector, normalizeBarePhone,
} from "./tools/indicia.ts";
import { buildTools, type ToolContext } from "./tool-registry.ts";
import { classifyToolOutcome } from "./tool-outcome.ts";
import { classifySource } from "./source-classification.ts";
import { applyEvidenceCaps } from "./confidence.ts";

// Indicia (api.indicia.app) wiring + integrity contract.
//   - 6 endpoints ONLY; facial/geolocation/gmail/username are hard-excluded.
//   - outcome contract: records→ok, empty 200→empty, 402/429→skipped, else→failed.
//   - broker/lead tier: a single hit can never reach Confirmed.

function stubCtx(): ToolContext {
  return {
    supabase: {}, supabaseAdmin: {},
    userId: "t", threadId: "t", archiveEnabled: false,
    detectedSeedType: "email", messages: [], manualOverrideSelector: null,
  } as unknown as ToolContext;
}

const INDICIA_TOOLS = [
  "indicia_email", "indicia_phone", "indicia_person",
  "indicia_address", "indicia_web_dbs", "indicia_hudsonrock",
];
// HARD POLICY: these must never exist as tools anywhere.
const FORBIDDEN = [
  "indicia_facial", "indicia_geolocation", "indicia_gmail", "indicia_username",
];

Deno.test("indicia: exactly the 6 approved tools are registered; face/geo/gmail/username absent", () => {
  const key = Deno.env.get("INDICIA_API_KEY");
  Deno.env.set("INDICIA_API_KEY", "test-key"); // ensure not gated out of the registry build
  try {
    const { tools } = buildTools(stubCtx());
    for (const n of INDICIA_TOOLS) assert(n in tools, `${n} must be registered`);
    for (const f of FORBIDDEN) assert(!(f in tools), `${f} must NOT exist (hard policy)`);
    // No stray indicia_* tool beyond the approved six.
    const strays = Object.keys(tools).filter((n) => n.startsWith("indicia_") && !INDICIA_TOOLS.includes(n));
    assertEquals(strays, [], `unexpected indicia tools: ${strays.join(", ")}`);
  } finally {
    if (key === undefined) Deno.env.delete("INDICIA_API_KEY"); else Deno.env.set("INDICIA_API_KEY", key);
  }
});

Deno.test("indicia: source class is 'breach' for all six (lead tier)", () => {
  for (const n of INDICIA_TOOLS) {
    assertEquals(classifySource(n), "breach", `${n} must classify as breach`);
  }
});

Deno.test("indicia: a single hit can NEVER reach Confirmed (capped ≤65, not-confirmed reason set)", () => {
  for (const n of INDICIA_TOOLS) {
    const r = applyEvidenceCaps({ rawConfidence: 95, sources: [n] });
    assert(r.confidence <= 65, `${n}: confidence ${r.confidence} must be ≤65`);
    assert(r.confidence < 90, `${n}: a single hit must stay below the Confirmed threshold`);
    assert(!!r.reason_not_confirmed, `${n}: reason_not_confirmed must be set`);
    assert(r.source_classes.includes("breach"), `${n}: classed breach`);
  }
});

Deno.test("indicia: extractIndiciaRecords is defensive across keys, not hardcoded to 'web'", () => {
  // Live-verified shape (email → data.web[]).
  assertEquals(extractIndiciaRecords({ web: [{ a: 1 }, { b: 2 }] }).length, 2);
  // A different endpoint may nest under a different key — must still be found.
  assertEquals(extractIndiciaRecords({ snusbase: [{ a: 1 }] }).length, 1);
  // Multiple corpora union together.
  assertEquals(extractIndiciaRecords({ web: [{ a: 1 }], leakcheck: [{ b: 2 }] }).length, 2);
  // Valid negatives: empty arrays / absent data → no records (→ outcome=empty).
  assertEquals(extractIndiciaRecords({ web: [] }).length, 0);
  assertEquals(extractIndiciaRecords({}).length, 0);
  assertEquals(extractIndiciaRecords(null).length, 0);
  // A single record object under a key (no arrays) is still counted.
  assert(extractIndiciaRecords({ person: { name: "x" } }).length >= 1);
});

Deno.test("indicia: metadata-only no-hit echoes read as EMPTY, not a bogus record", () => {
  // The integrity bug (Fix #2): {found:0} / {count:0} / {found:false} are how the
  // API signals a valid NEGATIVE. A bare number/boolean field must NOT count as a
  // record, or a no-hit is misreported as an ok:true one-record hit.
  assertEquals(extractIndiciaRecords({ found: 0 }).length, 0);
  assertEquals(extractIndiciaRecords({ count: 0 }).length, 0);
  assertEquals(extractIndiciaRecords({ found: false }).length, 0);
  assertEquals(extractIndiciaRecords({ found: 0, count: 0 }).length, 0);
  // Truthy scalars are ALSO metadata (exists:true is not a record payload).
  assertEquals(extractIndiciaRecords({ found: 1, exists: true }).length, 0);
  // Empty nested containers are not substance either.
  assertEquals(extractIndiciaRecords({ web: [], meta: {} }).length, 0);
  // But a real string/object payload alongside metadata IS a record.
  assert(extractIndiciaRecords({ found: 1, name: "Jane Doe" }).length >= 1);
  assert(extractIndiciaRecords({ profile: { handle: "x" }, count: 1 }).length >= 1);
});

// ---- Outcome contract via a stubbed fetch -----------------------------------
// Replaces globalThis.fetch so execute() runs without network; asserts the
// returned object maps to the correct outcome through the REAL classifier.
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
}

async function withStubbedFetch(
  handler: (url: string, init?: RequestInit) => Response,
  fn: () => Promise<void>,
) {
  const origFetch = globalThis.fetch;
  const origKey = Deno.env.get("INDICIA_API_KEY");
  Deno.env.set("INDICIA_API_KEY", "test-key");
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(String(url), init))) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = origFetch;
    if (origKey === undefined) Deno.env.delete("INDICIA_API_KEY"); else Deno.env.set("INDICIA_API_KEY", origKey);
  }
}

// The execute() closures live on the tool objects.
type ExecTool = { execute: (input: unknown, opts: unknown) => Promise<Record<string, unknown>> };
const exec = (t: unknown, input: unknown): Promise<Record<string, unknown>> =>
  (t as ExecTool).execute(input, {});

Deno.test("indicia outcome: success:true + records → ok", async () => {
  await withStubbedFetch(() => jsonResponse(200, { success: true, data: { web: [{ name: "Jane" }] } }), async () => {
    const r = await exec(indicia_email, { query: "jane@example.com" });
    assertEquals(r.ok, true);
    assertEquals(r.count, 1);
    // deriveOk sees ok:true → outcome ok
    assertEquals(classifyToolOutcome(r.error ?? null, r.status ?? null), "ok");
  });
});

Deno.test("indicia outcome: success:true + 0 records → empty (valid negative, NOT failed)", async () => {
  await withStubbedFetch(() => jsonResponse(200, { success: true, data: { web: [] } }), async () => {
    const r = await exec(indicia_phone, { query: "+15555550100" });
    assertEquals(r.ok, false);
    assertEquals(r.empty, true);
    assertEquals(classifyToolOutcome(r.error, r.status), "empty");
  });
});

Deno.test("indicia outcome: 402/429 (credit/rate) → skipped (balance dry ≠ vendor failure)", async () => {
  for (const status of [402, 429]) {
    await withStubbedFetch(() => jsonResponse(status, { error: "insufficient credits" }), async () => {
      const r = await exec(indicia_web_dbs, { query: "jane@example.com" });
      assertEquals(r.ok, false);
      // No skipped:true flag (would flip to ok); the "provider suppressed" phrasing
      // drives outcome=skipped through the classifier.
      assertEquals(classifyToolOutcome(r.error, r.status), "skipped");
    });
  }
});

Deno.test("indicia outcome: HTTP 500 → failed", async () => {
  await withStubbedFetch(() => jsonResponse(500, { error: "server error" }), async () => {
    const r = await exec(indicia_person, { name: "Jane Doe", state: "CA" });
    assertEquals(r.ok, false);
    assertEquals(classifyToolOutcome(r.error, r.status), "failed");
  });
});

Deno.test("indicia outcome: 200 with success:false → failed (status alone doesn't decide)", async () => {
  await withStubbedFetch(() => jsonResponse(200, { success: false, message: "bad query" }), async () => {
    const r = await exec(indicia_hudsonrock, { query: "jane@example.com" });
    assertEquals(r.ok, false);
    assertEquals(classifyToolOutcome(r.error, r.status), "failed");
  });
});

// #248 cherry-pick: broker/public-record name seeds ("LAST, FIRST MIDDLE[, ST]")
// must be reordered to natural "First … Last" before the person API call, and a
// trailing state code lifted into the state field.
Deno.test("indicia_person: reorders LAST, FIRST[, ST] before the API call", async () => {
  let sentBody: Record<string, unknown> | null = null;
  await withStubbedFetch((_url, init) => {
    sentBody = JSON.parse(String((init as RequestInit)?.body ?? "{}")) as Record<string, unknown>;
    return jsonResponse(200, { success: true, data: { web: [{ name: "Jarrett Riley Morris" }] } });
  }, async () => {
    const r = await exec(indicia_person, { name: "MORRIS, JARRETT RILEY, CA" });
    assertEquals(r.ok, true);
  });
  assert(sentBody !== null, "expected a request body to be sent");
  assertEquals((sentBody as Record<string, unknown>).name, "JARRETT RILEY MORRIS");
  // Parsed trailing ", CA" fills the empty state field.
  assertEquals((sentBody as Record<string, unknown>).state, "CA");
});

Deno.test("indicia_person: explicit state wins over a parsed suffix", async () => {
  let sentBody: Record<string, unknown> | null = null;
  await withStubbedFetch((_url, init) => {
    sentBody = JSON.parse(String((init as RequestInit)?.body ?? "{}")) as Record<string, unknown>;
    return jsonResponse(200, { success: true, data: { web: [{ name: "John Smith" }] } });
  }, async () => {
    await exec(indicia_person, { name: "SMITH, JOHN TX", state: "NY" });
  });
  assertEquals((sentBody as Record<string, unknown>).name, "JOHN SMITH");
  assertEquals((sentBody as Record<string, unknown>).state, "NY");
});

// Live audit (thread 0ba426f5…): indicia_web_dbs 400'd on a bare 10-digit phone
// ("2133788694") because the endpoint requires E.164. indicia_phone/web_dbs must
// normalize a bare-phone-shaped selector before it reaches the request body.
Deno.test("isBarePhoneSelector: matches bare/separated 10-11 digit phones, not email/username", () => {
  assert(isBarePhoneSelector("2133788694"));
  assert(isBarePhoneSelector("12133788694"));
  assert(isBarePhoneSelector("+12133788694"));
  assert(isBarePhoneSelector("(213) 378-8694"));
  assert(isBarePhoneSelector("213-378-8694"));
  assert(!isBarePhoneSelector("jane@example.com"));
  assert(!isBarePhoneSelector("stevenm3532"));
  assert(!isBarePhoneSelector("123")); // too short — not a phone
});

Deno.test("normalizeBarePhone: bare 10-digit → +1-prefixed E.164; already-formatted passes through", () => {
  assertEquals(normalizeBarePhone("2133788694"), "+12133788694");
  assertEquals(normalizeBarePhone("12133788694"), "+12133788694");
  assertEquals(normalizeBarePhone("+12133788694"), "+12133788694");
  // Non-US-shaped input is passed through unchanged rather than guessed at.
  assertEquals(normalizeBarePhone("+442071234567"), "+442071234567");
});

Deno.test("indicia_phone: bare 10-digit query is normalized to E.164 in the request body", async () => {
  let sentBody: Record<string, unknown> | null = null;
  await withStubbedFetch((_url, init) => {
    sentBody = JSON.parse(String((init as RequestInit)?.body ?? "{}")) as Record<string, unknown>;
    return jsonResponse(200, { success: true, data: { web: [{ name: "Jane" }] } });
  }, async () => {
    const r = await exec(indicia_phone, { query: "2133788694" });
    assertEquals(r.ok, true);
  });
  assertEquals((sentBody as Record<string, unknown>).query, "+12133788694");
});

Deno.test("indicia_web_dbs: bare-phone query is normalized; email/username selectors pass through untouched", async () => {
  let sentBody: Record<string, unknown> | null = null;
  await withStubbedFetch((_url, init) => {
    sentBody = JSON.parse(String((init as RequestInit)?.body ?? "{}")) as Record<string, unknown>;
    return jsonResponse(200, { success: true, data: { web: [{ name: "Jane" }] } });
  }, async () => {
    await exec(indicia_web_dbs, { query: "2133788694" });
  });
  assertEquals((sentBody as Record<string, unknown>).query, "+12133788694");

  sentBody = null;
  await withStubbedFetch((_url, init) => {
    sentBody = JSON.parse(String((init as RequestInit)?.body ?? "{}")) as Record<string, unknown>;
    return jsonResponse(200, { success: true, data: { web: [{ name: "Jane" }] } });
  }, async () => {
    await exec(indicia_web_dbs, { query: "eireannach_99@yahoo.com" });
  });
  assertEquals((sentBody as Record<string, unknown>).query, "eireannach_99@yahoo.com");

  sentBody = null;
  await withStubbedFetch((_url, init) => {
    sentBody = JSON.parse(String((init as RequestInit)?.body ?? "{}")) as Record<string, unknown>;
    return jsonResponse(200, { success: true, data: { web: [{ name: "Jane" }] } });
  }, async () => {
    await exec(indicia_web_dbs, { query: "stevenm3532" });
  });
  assertEquals((sentBody as Record<string, unknown>).query, "stevenm3532");
});
