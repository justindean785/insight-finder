import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  extractBreachConcreteValues,
  groupBreachRecordsForArtifacts,
  groupContentKey,
  inferSeedSelector,
} from "./breach-autorecord.ts";
import { buildAutoRecordedRow } from "./auto-record-integrity.ts";
import { scrubArtifactRows } from "./safety.ts";

Deno.test("rapidapi_breach_search — flattens concrete_values with sensitive flag", () => {
  const output = {
    ok: true,
    source: "rapidapi.breach_search",
    data: {
      email: "steven@example.com",
      breaches_found: 1,
      concrete_values: [
        { breach: "MySpace", field: "Password", value: "siochain1", sensitive: true },
        { breach: "MySpace", field: "Username", value: "stevenm", sensitive: false },
      ],
      breaches: [],
    },
  };
  const recs = extractBreachConcreteValues("rapidapi_breach_search", output);
  assertEquals(recs.length, 2);
  assertEquals(recs[0], { selector: "steven@example.com", breach: "MySpace", field: "password", value: "siochain1", sensitive: true });
  assertEquals(recs[1].field, "username");
  assertEquals(recs[1].sensitive, false);
});

Deno.test("rapidapi_breach_search — empty concrete_values → no records", () => {
  const output = { ok: true, data: { email: "x@y", concrete_values: [], breaches: [] } };
  assertEquals(extractBreachConcreteValues("rapidapi_breach_search", output).length, 0);
});

Deno.test("serus_darkweb_scan — walks breaches[] reveal fields + extractedData", () => {
  const output = {
    ok: true,
    status: "success",
    breaches: [
      {
        breachAuthority: { name: "MySpace" },
        isMasked: false,
        password: "siochain1",
        full_name: "stevemurphy",
        first_name: "steve",
        last_name: "murphy",
      },
      {
        breachAuthority: { name: "Fling" },
        isMasked: false,
        dob: "1966-09-03",
        username: "Suck you till you cum",
      },
      {
        breachAuthority: { name: "StillMasked" },
        isMasked: true,
        password: "••••••",
      },
    ],
    extractedData: {
      emails: ["steven@example.com", "eireannach_99@yahoo.com"],
      usernames: ["stevenm3532"],
      phones: ["2133788694"],
      names: ["Steven Murphy"],
      cryptoAddresses: [],
    },
    classification: "sensitive_unmasked",
  };
  const recs = extractBreachConcreteValues("serus_darkweb_scan", output, "eireannach_99@yahoo.com");
  const pwd = recs.find((r) => r.field === "password");
  assert(pwd, "should surface MySpace password");
  assertEquals(pwd!.value, "siochain1");
  assertEquals(pwd!.sensitive, true);
  assertEquals(pwd!.breach, "MySpace");
  assertEquals(pwd!.selector, "eireannach_99@yahoo.com");

  const dob = recs.find((r) => r.field === "dob");
  assert(dob, "should surface Fling DOB");
  assertEquals(dob!.sensitive, true);

  // isMasked:true breach must contribute NOTHING.
  assert(!recs.some((r) => r.breach === "StillMasked"), "masked breach must not appear");

  // extractedData flattens.
  assert(recs.some((r) => r.field === "email" && r.value === "steven@example.com"));
  assert(recs.some((r) => r.field === "username" && r.value === "stevenm3532"));
  assert(recs.some((r) => r.field === "phone" && r.value === "2133788694"));
});

Deno.test("serus_darkweb_scan — bullet-masked values are dropped", () => {
  const output = {
    breaches: [
      { breachAuthority: { name: "X" }, isMasked: false, password: "••••••", full_name: "real name" },
    ],
    extractedData: {},
  };
  const recs = extractBreachConcreteValues("serus_darkweb_scan", output, "seed");
  assertEquals(recs.length, 1);
  assertEquals(recs[0].field, "full_name");
});

Deno.test("leakcheck_lookup — reaches into data.raw.result[] for row fields", () => {
  const output = {
    ok: true,
    source: "leakcheck.v2",
    data: {
      success: true,
      found: 2,
      quota: 100,
      sources: ["MySpace", "Evite"],
      raw: {
        success: true,
        found: 2,
        result: [
          {
            source: { name: "MySpace" },
            password: "siochain",
            username: "stevenm",
          },
          {
            source: { name: "Evite" },
            full_name: "stevemurphy",
            first_name: "steve",
            last_name: "murphy",
            password: "siochain",
          },
        ],
      },
    },
  };
  const recs = extractBreachConcreteValues("leakcheck_lookup", output, "eireannach_99@yahoo.com");
  assert(recs.some((r) => r.breach === "MySpace" && r.field === "password" && r.value === "siochain"));
  assert(recs.some((r) => r.breach === "Evite" && r.field === "full_name" && r.value === "stevemurphy"));
});

Deno.test("oathnet_stealer_search — pivots per-item domain into breach name", () => {
  const output = {
    ok: true,
    items: [
      {
        log_id: "vic_1",
        domain: ["google.com"],
        username: "steven",
        email: "steven@example.com",
        password: "hunter2",
      },
      {
        log_id: "vic_2",
        domain: [],
        username: "steven2",
      },
    ],
  };
  const recs = extractBreachConcreteValues("oathnet_stealer_search", output, "steven@example.com");
  assert(recs.some((r) => r.breach === "stealer:google.com" && r.field === "password" && r.value === "hunter2"));
  assert(recs.some((r) => r.breach === "stealer:vic_2" && r.field === "username" && r.value === "steven2"));
});

Deno.test("unknown tool name returns empty", () => {
  assertEquals(extractBreachConcreteValues("hibp_lookup", { anything: true }).length, 0);
});

Deno.test("null / non-object output returns empty", () => {
  assertEquals(extractBreachConcreteValues("rapidapi_breach_search", null).length, 0);
  assertEquals(extractBreachConcreteValues("serus_darkweb_scan", "oops").length, 0);
});

Deno.test("groupBreachRecordsForArtifacts — one row per (selector, breach); dedupes within group", () => {
  const groups = groupBreachRecordsForArtifacts([
    { selector: "x@y", breach: "MySpace", field: "password", value: "abc", sensitive: true },
    { selector: "x@y", breach: "MySpace", field: "password", value: "abc", sensitive: true }, // dupe
    { selector: "x@y", breach: "MySpace", field: "username", value: "xy", sensitive: false },
    { selector: "x@y", breach: "Evite", field: "full_name", value: "steve", sensitive: false },
  ]);
  assertEquals(groups.length, 2);
  const ms = groups.find((g) => g.breach === "MySpace")!;
  assertEquals(ms.exposed_values.length, 2);
  assertEquals(ms.sensitive, true);
  const ev = groups.find((g) => g.breach === "Evite")!;
  assertEquals(ev.sensitive, false);
});

Deno.test("groupContentKey — stable regardless of insertion order", () => {
  const k1 = groupContentKey({
    selector: "x@y", breach: "MySpace", sensitive: true,
    exposed_values: [{ field: "password", value: "abc", sensitive: true }, { field: "username", value: "u", sensitive: false }],
  });
  const k2 = groupContentKey({
    selector: "x@y", breach: "MySpace", sensitive: true,
    exposed_values: [{ field: "username", value: "u", sensitive: false }, { field: "password", value: "abc", sensitive: true }],
  });
  assertEquals(k1, k2);
});

// ---- End-to-end pipeline glue (the exact sequence index.ts's onStepFinish runs:
// extract -> group -> dedup -> buildAutoRecordedRow -> scrubArtifactRows) --------

function buildRowsForStep(
  toolResults: Array<{ toolName: string; input: unknown; output: unknown }>,
  seenKeys: Set<string>,
): Record<string, unknown>[] {
  const records = toolResults.flatMap((tr) =>
    extractBreachConcreteValues(tr.toolName, tr.output, inferSeedSelector(tr.toolName, tr.input)),
  );
  const groups = groupBreachRecordsForArtifacts(records);
  const rows = groups
    .filter((g) => {
      const key = groupContentKey(g);
      if (seenKeys.has(key)) return false;
      seenKeys.add(key);
      return true;
    })
    .map((g) =>
      buildAutoRecordedRow({
        kind: "breach_exposure",
        value: g.breach
          ? `${g.selector ?? "unknown selector"} — ${g.breach} (unmasked)`
          : `${g.selector ?? "unknown selector"} — breach exposure (unmasked)`,
        source: "breach_reveal_autorecord",
        rawConfidence: 70,
        metadata: {
          selector: g.selector,
          breach: g.breach,
          exposed_values: g.exposed_values,
          reveal_source: "server_auto_record",
        },
      }),
    );
  return scrubArtifactRows(rows as unknown as Record<string, unknown>[]);
}

Deno.test("pipeline: a rapidapi_breach_search step produces a scrub-safe breach_exposure row with real values in metadata", () => {
  const seen = new Set<string>();
  const rows = buildRowsForStep(
    [{
      toolName: "rapidapi_breach_search",
      input: { email: "eireannach_99@yahoo.com" },
      output: {
        ok: true,
        data: {
          email: "eireannach_99@yahoo.com",
          concrete_values: [
            { breach: "MySpace", field: "Password", value: "siochain1", sensitive: true },
          ],
          breaches: [],
        },
      },
    }],
    seen,
  );
  assertEquals(rows.length, 1);
  const row = rows[0] as { kind: string; value: string; confidence: number; metadata: Record<string, unknown> };
  assertEquals(row.kind, "breach_exposure");
  assert(row.value.includes("MySpace"));
  // Evidence caps applied — a single breach source can never reach Confirmed.
  assert(row.confidence < 90, "single breach source must stay capped below Confirmed");
  const exposed = row.metadata.exposed_values as Array<{ field: string; value: string }>;
  assertEquals(exposed.length, 1);
  assertEquals(exposed[0].value, "siochain1");
  // auto_recorded flag proves this went through buildAutoRecordedRow, not the LLM shim.
  assertEquals(row.metadata.auto_recorded, true);
});

Deno.test("pipeline: the SAME hit across two steps (corroborating re-query) is NOT duplicated", () => {
  const seen = new Set<string>();
  const stepInput = [{
    toolName: "serus_darkweb_scan",
    input: { identifierType: "email", identifierValue: "eireannach_99@yahoo.com" },
    output: {
      breaches: [{ breachAuthority: { name: "MySpace" }, isMasked: false, password: "siochain1" }],
      extractedData: {},
    },
  }];
  const rowsStep1 = buildRowsForStep(stepInput, seen);
  const rowsStep2 = buildRowsForStep(stepInput, seen); // same tool re-fired next round
  assertEquals(rowsStep1.length, 1);
  assertEquals(rowsStep2.length, 0, "identical hit in a later step must be deduped, not re-inserted");
});

Deno.test("pipeline: a DIFFERENT breach for the same selector across steps produces a SECOND row (no under-merging)", () => {
  const seen = new Set<string>();
  const rowsStep1 = buildRowsForStep(
    [{
      toolName: "serus_darkweb_scan",
      input: { identifierType: "email", identifierValue: "eireannach_99@yahoo.com" },
      output: { breaches: [{ breachAuthority: { name: "MySpace" }, isMasked: false, password: "siochain1" }], extractedData: {} },
    }],
    seen,
  );
  const rowsStep2 = buildRowsForStep(
    [{
      toolName: "serus_darkweb_scan",
      input: { identifierType: "email", identifierValue: "eireannach_99@yahoo.com" },
      output: { breaches: [{ breachAuthority: { name: "Evite" }, isMasked: false, full_name: "stevemurphy" }], extractedData: {} },
    }],
    seen,
  );
  assertEquals(rowsStep1.length, 1);
  assertEquals(rowsStep2.length, 1);
  assert((rowsStep1[0] as { value: string }).value.includes("MySpace"));
  assert((rowsStep2[0] as { value: string }).value.includes("Evite"));
});

Deno.test("pipeline: masked-only output (no reveal) produces zero rows — never fabricates evidence", () => {
  const seen = new Set<string>();
  const rows = buildRowsForStep(
    [{
      toolName: "serus_darkweb_scan",
      input: { identifierType: "email", identifierValue: "x@y.com" },
      output: { breaches: [{ breachAuthority: { name: "SomeBreach" }, isMasked: true, password: "••••••" }], extractedData: {} },
    }],
    seen,
  );
  assertEquals(rows.length, 0);
});

Deno.test("inferSeedSelector — pulls the seed from each tool's canonical arg", () => {
  assertEquals(inferSeedSelector("rapidapi_breach_search", { email: "a@b" }), "a@b");
  assertEquals(inferSeedSelector("serus_darkweb_scan", { identifierType: "email", identifierValue: "a@b" }), "a@b");
  assertEquals(inferSeedSelector("leakcheck_lookup", { value: "handle", type: "username" }), "handle");
  assertEquals(inferSeedSelector("oathnet_stealer_search", { value: "seed" }), "seed");
  assertEquals(inferSeedSelector("hibp_lookup", { email: "a@b" }), null);
});
