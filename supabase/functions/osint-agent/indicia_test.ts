import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  indicia_email, indicia_phone, indicia_person,
  indicia_address, indicia_web_dbs, indicia_hudsonrock,
  extractIndiciaRecords,
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

Deno.test("indicia_person: parseStructuredName reorders LAST, FIRST[, ST] before API call", async () => {
  await withStubbedFetch((_url, init) => {
    const body = JSON.parse(String((init as RequestInit)?.body ?? "{}")) as Record<string, unknown>;
    assertEquals(body.name, "JARRETT RILEY MORRIS");
    assertEquals(body.state, "CA");
    return jsonResponse(200, { success: true, data: { web: [{ name: "Jarrett Morris" }] } });
  }, async () => {
    const r = await exec(indicia_person, { name: "MORRIS, JARRETT RILEY, CA" });
    assertEquals(r.ok, true);
    assertEquals(r.count, 1);
  });
});

Deno.test("indicia_person: explicit state param wins over parsed suffix", async () => {
  await withStubbedFetch((_url, init) => {
    const body = JSON.parse(String((init as RequestInit)?.body ?? "{}")) as Record<string, unknown>;
    assertEquals(body.name, "JANE DOE");
    assertEquals(body.state, "NY");
    return jsonResponse(200, { success: true, data: { web: [] } });
  }, async () => {
    const r = await exec(indicia_person, { name: "DOE, JANE, CA", state: "NY" });
    assertEquals(r.empty, true);
    assertEquals(classifyToolOutcome(r.error, r.status), "empty");
  });
});

Deno.test("indicia_person: natural-order name passes through unchanged", async () => {
  await withStubbedFetch((_url, init) => {
    const body = JSON.parse(String((init as RequestInit)?.body ?? "{}")) as Record<string, unknown>;
    assertEquals(body.name, "Jane Doe");
    return jsonResponse(200, { success: true, data: { web: [{ a: 1 }] } });
  }, async () => {
    const r = await exec(indicia_person, { name: "Jane Doe", state: "CA" });
    assertEquals(r.ok, true);
  });
});
