import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  indicia_email, indicia_phone, indicia_person,
  indicia_address, indicia_web_dbs, indicia_hudsonrock,
  extractIndiciaRecords, inferHudsonRockType, WEB_DB_SERVICES,
} from "./tools/indicia.ts";
import { buildTools, type ToolContext } from "./tool-registry.ts";
import { classifyToolOutcome } from "./tool-outcome.ts";
import { classifySource } from "./source-classification.ts";
import { applyEvidenceCapsLegacyOccurrenceBaseline } from "./confidence.ts";

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

// SPLIT 2026-07-26 — by what each endpoint actually queries, not by vendor.
// person|address|phone are people-search/broker lookups; email|web_dbs|hudsonrock
// hit real breach/stealer corpora. Both classes carry the SAME cap and NEVER_HIGH
// ceiling (pinned below), so this is a labelling fix with no weight change.
const INDICIA_BROKER_TOOLS = ["indicia_person", "indicia_address", "indicia_phone"];
const INDICIA_BREACH_TOOLS = ["indicia_email", "indicia_web_dbs", "indicia_hudsonrock"];

Deno.test("indicia: broker endpoints classify as data_broker, breach endpoints as breach", () => {
  // WHY THIS SPLIT EXISTS: classing an address/person lookup as `breach` made the
  // UI render "Breach/exposure" for every person a broker returns for an address.
  // On a live case that put eleven uninvolved people — including a bank-fraud
  // investigator, in a bank-fraud case — under a false breach-disclosure claim.
  for (const n of INDICIA_BROKER_TOOLS) {
    assertEquals(classifySource(n), "data_broker", `${n} is a people-search lookup, not breach data`);
  }
  for (const n of INDICIA_BREACH_TOOLS) {
    assertEquals(classifySource(n), "breach", `${n} queries breach corpora`);
  }
  assertEquals(classifySource("pdl_person_enrich"), "data_broker", "PDL is a person aggregator");
});

Deno.test("indicia: the data_broker split did NOT weaken any cap (integrity contract)", () => {
  // The rename must be weight-neutral. If someone ever loosens data_broker's cap
  // or drops it from NEVER_HIGH, this fails — a relabel must never become a
  // promotion.
  for (const n of [...INDICIA_BROKER_TOOLS, ...INDICIA_BREACH_TOOLS, "pdl_person_enrich"]) {
    const broker = applyEvidenceCapsLegacyOccurrenceBaseline({ rawConfidence: 95, sources: [n] });
    assert(broker.confidence <= 65, `${n}: ${broker.confidence} must stay ≤65 after the split`);
    assert(!!broker.reason_not_confirmed, `${n}: reason_not_confirmed must still be set`);
  }
  // Byte-for-byte parity between the two classes on the same raw input.
  const asBroker = applyEvidenceCapsLegacyOccurrenceBaseline({ rawConfidence: 95, sources: ["indicia_address"] });
  const asBreach = applyEvidenceCapsLegacyOccurrenceBaseline({ rawConfidence: 95, sources: ["indicia_web_dbs"] });
  assertEquals(asBroker.confidence, asBreach.confidence, "data_broker and breach must cap identically");
});

Deno.test("indicia: a single hit can NEVER reach Confirmed (capped ≤65, not-confirmed reason set)", () => {
  for (const n of INDICIA_TOOLS) {
    const r = applyEvidenceCapsLegacyOccurrenceBaseline({ rawConfidence: 95, sources: [n] });
    assert(r.confidence <= 65, `${n}: confidence ${r.confidence} must be ≤65`);
    assert(r.confidence < 90, `${n}: a single hit must stay below the Confirmed threshold`);
    assert(!!r.reason_not_confirmed, `${n}: reason_not_confirmed must be set`);
    // Either lead-tier class is acceptable here; the split is asserted above. What
    // this test guards is the CEILING, which must hold for both.
    assert(
      r.source_classes.includes("breach") || r.source_classes.includes("data_broker"),
      `${n}: must be classed breach or data_broker (lead tier)`,
    );
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

// ---- Provider input contracts (backported from the deployed build) -----------
// Four endpoints reject a request the model can easily construct: a formatted
// phone, a missing zip, an omitted `services`, an omitted hudsonrock `type`. Each
// was a 400 spent for nothing. Every test below fails against the preceding commit.

Deno.test("indicia_phone: a formatted or E.164 selector is normalized to 10 NANP digits", async () => {
  for (const [input, expected] of [
    ["+1 (212) 555-0123", "2125550123"],
    ["1-212-555-0123", "2125550123"],
    ["212.555.0123", "2125550123"],
    ["2125550123", "2125550123"],
  ] as const) {
    let sentBody: Record<string, unknown> | null = null;
    await withStubbedFetch((_url, init) => {
      sentBody = JSON.parse(String((init as RequestInit)?.body ?? "{}")) as Record<string, unknown>;
      return jsonResponse(200, { success: true, data: { web: [{ name: "Jane" }] } });
    }, async () => {
      await exec(indicia_phone, { query: input });
    });
    assertEquals((sentBody as unknown as Record<string, unknown>).query, expected, `for input ${input}`);
  }
});

Deno.test("indicia_phone: an unusable selector is SKIPPED, never a measured empty", async () => {
  // A call we declined to make is not a measurement. Recording it as `empty`
  // would assert the provider was asked and had no record — the same
  // absence-assertion error this codebase has already corrected three times.
  const r = await exec(indicia_phone, { query: "not-a-phone-at-all" });
  assertEquals(classifyToolOutcome(r.error as string, null), "skipped");
});

Deno.test("indicia_phone: the gate reports a digit COUNT and never echoes the selector", async () => {
  // A tool's `error` string is lifted into tool_usage_log.error_msg, so echoing
  // the selector would write an analyst-supplied phone number into telemetry.
  const r = await exec(indicia_phone, { query: "+44 20 7946 0958" });
  const err = String(r.error);
  assertEquals(err.includes("7946"), false, "selector leaked into the error string");
  assertEquals(err.includes("0958"), false, "selector leaked into the error string");
  assert(err.includes("got 12"), `expected a digit count, got: ${err}`);
});

Deno.test("indicia_phone: an unusable selector never reaches the provider", async () => {
  let called = false;
  await withStubbedFetch(() => {
    called = true;
    return jsonResponse(200, { success: true, data: {} });
  }, async () => {
    await exec(indicia_phone, { query: "12345" });
  });
  assertEquals(called, false, "a gated selector must not spend a provider call");
});

Deno.test("indicia_address: zip is REQUIRED by the schema (an omitted zip is a hard 400)", () => {
  const schema = (indicia_address as unknown as { inputSchema: { shape: Record<string, { isOptional(): boolean }> } }).inputSchema;
  assertEquals(schema.shape.zip.isOptional(), false, "zip must be required");
  assertEquals(schema.shape.city.isOptional(), true, "city stays optional");
});

Deno.test("indicia_web_dbs: an omitted services list defaults to the full closed set", async () => {
  let sentBody: Record<string, unknown> | null = null;
  await withStubbedFetch((_url, init) => {
    sentBody = JSON.parse(String((init as RequestInit)?.body ?? "{}")) as Record<string, unknown>;
    return jsonResponse(200, { success: true, data: { web: [] } });
  }, async () => {
    await exec(indicia_web_dbs, { query: "jane@example.com" });
  });
  assertEquals((sentBody as unknown as Record<string, unknown>).services, [...WEB_DB_SERVICES]);
});

Deno.test("indicia_web_dbs: an explicit empty array still resolves to the full set", async () => {
  // `services: []` satisfies a zod .default() while still 400ing at the provider,
  // which is why the resolution lives in execute() and not only in the schema.
  let sentBody: Record<string, unknown> | null = null;
  await withStubbedFetch((_url, init) => {
    sentBody = JSON.parse(String((init as RequestInit)?.body ?? "{}")) as Record<string, unknown>;
    return jsonResponse(200, { success: true, data: { web: [] } });
  }, async () => {
    await exec(indicia_web_dbs, { query: "jane@example.com", services: [] });
  });
  assertEquals((sentBody as unknown as Record<string, unknown>).services, [...WEB_DB_SERVICES]);
});

Deno.test("indicia_web_dbs: a service outside the closed set is dropped, not forwarded", async () => {
  let sentBody: Record<string, unknown> | null = null;
  await withStubbedFetch((_url, init) => {
    sentBody = JSON.parse(String((init as RequestInit)?.body ?? "{}")) as Record<string, unknown>;
    return jsonResponse(200, { success: true, data: { web: [] } });
  }, async () => {
    await exec(indicia_web_dbs, { query: "jane@example.com", services: ["LeakCheck", "not-a-service"] });
  });
  assertEquals((sentBody as unknown as Record<string, unknown>).services, ["leakcheck"]);
});

Deno.test("indicia_hudsonrock: an omitted type is inferred from the selector shape", () => {
  assertEquals(inferHudsonRockType("jane@example.com"), "email");
  assertEquals(inferHudsonRockType("example.com"), "domain");
  assertEquals(inferHudsonRockType("192.0.2.1"), "ip");
  assertEquals(inferHudsonRockType("jdean785"), "username");
  // "password" is never inferred — it is not derivable from shape, and guessing it
  // would send a selector to a credential-search endpoint it was not meant for.
  for (const q of ["jane@example.com", "example.com", "192.0.2.1", "jdean785", "hunter2"]) {
    assert(inferHudsonRockType(q) !== "password", `inferred password for ${q}`);
  }
});

Deno.test("indicia_hudsonrock: an unrecognized explicit type falls back to inference", async () => {
  let sentBody: Record<string, unknown> | null = null;
  await withStubbedFetch((_url, init) => {
    sentBody = JSON.parse(String((init as RequestInit)?.body ?? "{}")) as Record<string, unknown>;
    return jsonResponse(200, { success: true, data: { web: [] } });
  }, async () => {
    await exec(indicia_hudsonrock, { query: "jane@example.com", type: "handle" });
  });
  assertEquals((sentBody as unknown as Record<string, unknown>).type, "email");
});

Deno.test("indicia_hudsonrock: a valid explicit type is honoured over inference", async () => {
  let sentBody: Record<string, unknown> | null = null;
  await withStubbedFetch((_url, init) => {
    sentBody = JSON.parse(String((init as RequestInit)?.body ?? "{}")) as Record<string, unknown>;
    return jsonResponse(200, { success: true, data: { web: [] } });
  }, async () => {
    await exec(indicia_hudsonrock, { query: "hunter2", type: "PASSWORD" });
  });
  assertEquals((sentBody as unknown as Record<string, unknown>).type, "password");
});
