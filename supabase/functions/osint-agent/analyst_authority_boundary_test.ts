// analyst_authority_boundary_test.ts — A1 driving tests.
//
// REPRODUCED 2026-10-13 on main 32f5ddb: record_artifacts and its record_artifact shim persisted a
// model-written `metadata.reviewed`, `linkage_confirmed`, `review_state`, `analyst_confirmed`
// verbatim, and the frontend ladder then rendered a single-source breach email as
// "Analyst-confirmed" (label ATTESTED, status verified). These tests drive the REAL tools through
// the same stub harness as recording_source_policy_runtime_test.ts. Synthetic values only.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildTools, type ToolContext } from "./tool-registry.ts";
import { ANALYST_AUTHORITY_DISCLOSURE_KEY, RESERVED_ANALYST_AUTHORITY_KEYS } from "./lib/analyst-authority-keys.ts";

type Row = Record<string, unknown>;

function makeRuntime() {
  const inserted: Row[] = [];
  const builder: Record<string, unknown> = {
    then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
  };
  for (const m of ["select", "eq", "neq", "or", "order", "limit", "is", "in", "not", "range", "contains", "ilike", "gte", "lte", "update"]) {
    builder[m] = () => builder;
  }
  builder.maybeSingle = () => Promise.resolve({ data: null, error: null });
  const supabase = {
    from(_t: string) {
      return {
        insert(rows: Row | Row[]) {
          inserted.push(...(Array.isArray(rows) ? rows : [rows]));
          return Promise.resolve({ error: null });
        },
        select: () => builder,
        update: () => builder,
      };
    },
    rpc() {
      return Promise.resolve({ data: [{ id: "evidence", seq: 1, chain_hash: "hash" }], error: null });
    },
  };
  const ctx = {
    supabase,
    supabaseAdmin: supabase,
    userId: "authority-user",
    threadId: "authority-thread",
    archiveEnabled: false,
    detectedSeedType: "email",
    messages: [],
    manualOverrideSelector: null,
  } as unknown as ToolContext;
  return { inserted, tools: buildTools(ctx).tools };
}

const exec = (tools: unknown, name: string) =>
  (tools as Record<string, { execute: (i: unknown, o: unknown) => Promise<unknown> }>)[name].execute;

/** Every reserved key, with values chosen so a leak would be unmistakable. */
const IMPERSONATION: Row = {
  reviewed: true,
  linkage_confirmed: true,
  linkage_confirmed_at: "2099-01-01T00:00:00.000Z",
  false_positive: true,
  review_state: "confirmed",
  analyst_confirmed: true,
  analyst_review: "key",
  attested: true,
  human_verified: true,
};

const SERVER_AUTHORITY_FIELDS = ["status", "source_category", "confidence_cap_applied", "reason_for_confidence", "reason_not_confirmed"];

const breachEmail = (metadata?: Row) => ({
  kind: "email",
  value: "synthetic.person@example.com",
  confidence: 90,
  source: "oathnet_lookup",
  ...(metadata ? { metadata } : {}),
});

function without(meta: Row, drop: Iterable<string>): Row {
  const d = new Set(drop);
  return Object.fromEntries(Object.entries(meta).filter(([k]) => !d.has(k)));
}

Deno.test("record_artifacts: a model cannot persist the analyst's keys (reproduction of the 2026-10-13 finding)", async () => {
  const rt = makeRuntime();
  await exec(rt.tools, "record_artifacts")({ artifacts: [breachEmail(IMPERSONATION)] }, {});
  assertEquals(rt.inserted.length, 1);
  const meta = rt.inserted[0].metadata as Row;
  for (const k of RESERVED_ANALYST_AUTHORITY_KEYS) assert(!(k in meta), `${k} must not be persisted`);
  assertEquals(meta[ANALYST_AUTHORITY_DISCLOSURE_KEY], [...RESERVED_ANALYST_AUTHORITY_KEYS].sort());
  assert(!JSON.stringify(meta).includes("2099-01-01"), "the model's value for linkage_confirmed_at must not be stored");
});

Deno.test("record_artifact (shim): same boundary, same disclosure", async () => {
  const rt = makeRuntime();
  await exec(rt.tools, "record_artifact")(breachEmail(IMPERSONATION), {});
  assertEquals(rt.inserted.length, 1);
  const meta = rt.inserted[0].metadata as Row;
  for (const k of RESERVED_ANALYST_AUTHORITY_KEYS) assert(!(k in meta), `${k} must not be persisted`);
  assertEquals(meta[ANALYST_AUTHORITY_DISCLOSURE_KEY], [...RESERVED_ANALYST_AUTHORITY_KEYS].sort());
});

Deno.test("DIFFERENTIAL: the strip changes nothing about confidence, source, kind, value or the server's derived fields", async () => {
  const withKeys = makeRuntime();
  const control = makeRuntime();
  await exec(withKeys.tools, "record_artifacts")({ artifacts: [breachEmail({ ...IMPERSONATION, note: "n", cluster_id: "c1" })] }, {});
  await exec(control.tools, "record_artifacts")({ artifacts: [breachEmail({ note: "n", cluster_id: "c1" })] }, {});
  const a = withKeys.inserted[0];
  const b = control.inserted[0];
  for (const f of ["kind", "value", "confidence", "source", "thread_id", "user_id"]) assertEquals(a[f], b[f], `${f} must be identical`);
  const am = a.metadata as Row;
  const bm = b.metadata as Row;
  for (const f of SERVER_AUTHORITY_FIELDS) assertEquals(am[f], bm[f], `metadata.${f} must be identical`);
  // The ONLY difference between the two stored metadata objects is the disclosure key.
  assertEquals(without(am, [ANALYST_AUTHORITY_DISCLOSURE_KEY]), bm);
  // And the breach caps still apply to the breach row — nothing about the strip lifts or lowers them.
  assertEquals(a.confidence, 60);
  assertEquals(am.source_category, ["breach"]);
  assertEquals(am.status, "observed");
});

Deno.test("BREACH VALUE REVEAL IS UNTOUCHED: the stored value is byte-identical, with no masking or redaction marker", async () => {
  const rt = makeRuntime();
  const value = "synthetic.person@example.com";
  await exec(rt.tools, "record_artifacts")({ artifacts: [{ ...breachEmail(IMPERSONATION), value }] }, {});
  const row = rt.inserted[0];
  assertEquals(row.value, value);
  const meta = row.metadata as Row;
  for (const k of Object.keys(meta)) {
    assert(!/mask|redact|hidden|truncat/i.test(k), `no masking-style metadata may appear (found ${k})`);
  }
});

Deno.test("legitimate model metadata is preserved exactly, and a clean call gets NO disclosure key", async () => {
  const rt = makeRuntime();
  const legit: Row = {
    cluster_id: "c1",
    sources: ["oathnet_lookup"],
    note: "free text",
    contradictions: ["a"],
    next_verification_step: "ask",
    username: "synthetic_user",
    custom_flag: true,
    possible_minor: false,
  };
  await exec(rt.tools, "record_artifacts")({ artifacts: [breachEmail(legit)] }, {});
  const meta = rt.inserted[0].metadata as Row;
  assert(!(ANALYST_AUTHORITY_DISCLOSURE_KEY in meta));
  for (const k of ["cluster_id", "sources", "note", "contradictions", "next_verification_step", "username", "custom_flag"]) {
    assertEquals(meta[k], legit[k], `${k} must be preserved`);
  }
});

Deno.test("case and whitespace variants are stripped on the live path too", async () => {
  const rt = makeRuntime();
  await exec(rt.tools, "record_artifacts")({ artifacts: [breachEmail({ Reviewed: true, " LINKAGE_CONFIRMED ": true })] }, {});
  const meta = rt.inserted[0].metadata as Row;
  assert(!("Reviewed" in meta) && !(" LINKAGE_CONFIRMED " in meta));
  assertEquals(meta[ANALYST_AUTHORITY_DISCLOSURE_KEY], ["linkage_confirmed", "reviewed"]);
});

Deno.test("a spoofed disclosure key is replaced by the true record, never stored as written", async () => {
  const rt = makeRuntime();
  await exec(rt.tools, "record_artifacts")({ artifacts: [breachEmail({ [ANALYST_AUTHORITY_DISCLOSURE_KEY]: [] })] }, {});
  const meta = rt.inserted[0].metadata as Row;
  assertEquals(meta[ANALYST_AUTHORITY_DISCLOSURE_KEY], [ANALYST_AUTHORITY_DISCLOSURE_KEY]);
});

Deno.test("a mixed batch strips per row, discloses per row, and tells the model (told, not hidden)", async () => {
  const rt = makeRuntime();
  const result = await exec(rt.tools, "record_artifacts")({
    artifacts: [
      { ...breachEmail({ reviewed: true, false_positive: true }), value: "synthetic.one@example.com" },
      { ...breachEmail({ note: "clean" }), value: "synthetic.two@example.com" },
    ],
  }, {}) as Row;
  assertEquals(rt.inserted.length, 2);
  const byValue = Object.fromEntries(rt.inserted.map((r) => [String(r.value), r.metadata as Row]));
  assertEquals(byValue["synthetic.one@example.com"][ANALYST_AUTHORITY_DISCLOSURE_KEY], ["false_positive", "reviewed"]);
  assert(!(ANALYST_AUTHORITY_DISCLOSURE_KEY in byValue["synthetic.two@example.com"]));
  assertEquals(result.analyst_authority_stripped, ["false_positive", "reviewed"]);
  assert(typeof result.analyst_authority_note === "string" && result.analyst_authority_note.length > 0);
});

Deno.test("a call with nothing reserved carries no strip notice in its result", async () => {
  const rt = makeRuntime();
  const result = await exec(rt.tools, "record_artifacts")({ artifacts: [breachEmail({ note: "clean" })] }, {}) as Row;
  assert(!("analyst_authority_stripped" in result));
  assert(!("analyst_authority_note" in result));
});

Deno.test("the shim tells the model too", async () => {
  const rt = makeRuntime();
  const result = await exec(rt.tools, "record_artifact")(breachEmail({ reviewed: true }), {}) as Row;
  assertEquals(result.analyst_authority_stripped, ["reviewed"]);
});

Deno.test("an impersonation attempt is logged by KEY NAME only — never by value", async () => {
  const rt = makeRuntime();
  const logged: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
  try {
    await exec(rt.tools, "record_artifacts")({ artifacts: [breachEmail({ reviewed: "VALUE-MUST-NOT-LOG" })] }, {});
  } finally {
    console.warn = orig;
  }
  const line = logged.find((l) => l.includes("analyst_authority_stripped"));
  assert(line, "a structured analyst_authority_stripped event must be emitted");
  const evt = JSON.parse(line!) as Row;
  assertEquals(evt.event, "analyst_authority_stripped");
  assertEquals(evt.keys, ["reviewed"]);
  assertEquals(evt.thread_id, "authority-thread");
  assert(!line!.includes("VALUE-MUST-NOT-LOG"));
});

Deno.test("kill switch ANALYST_AUTHORITY_STRIP_DISABLED restores legacy pass-through on both tools", async () => {
  Deno.env.set("ANALYST_AUTHORITY_STRIP_DISABLED", "true");
  try {
    const batch = makeRuntime();
    await exec(batch.tools, "record_artifacts")({ artifacts: [breachEmail({ reviewed: true })] }, {});
    assertEquals((batch.inserted[0].metadata as Row).reviewed, true);
    assert(!(ANALYST_AUTHORITY_DISCLOSURE_KEY in (batch.inserted[0].metadata as Row)));
    const shim = makeRuntime();
    await exec(shim.tools, "record_artifact")(breachEmail({ reviewed: true }), {});
    assertEquals((shim.inserted[0].metadata as Row).reviewed, true);
  } finally {
    Deno.env.delete("ANALYST_AUTHORITY_STRIP_DISABLED");
  }
});

Deno.test("the strip also covers metadata that reaches the row through the memory-context path", async () => {
  const rt = makeRuntime();
  await exec(rt.tools, "record_artifacts")({
    artifacts: [{ ...breachEmail({ reviewed: true }), source: "memory_recall (prior investigation)" }],
  }, {});
  const meta = rt.inserted[0].metadata as Row;
  assert(!("reviewed" in meta));
  assertEquals(meta.context_from_memory, true);
});

Deno.test("wiring (source-level): both model entry points strip BEFORE the metadata is used, and /health reports the rule", async () => {
  const src = await Deno.readTextFile(new URL("./tool-registry.ts", import.meta.url));
  assertEquals((src.match(/stripAnalystAuthorityKeys\(/g) ?? []).length, 2, "exactly the two model-metadata entry points");
  const batchStart = src.indexOf("record_artifacts: tool({");
  const shimStart = src.indexOf("record_artifact: tool({");
  assert(batchStart > 0 && shimStart > batchStart);
  const batchBody = src.slice(batchStart, shimStart);
  const stripAt = batchBody.indexOf("stripAnalystAuthorityKeys(");
  assert(stripAt > 0, "the batch tool must strip");
  assert(stripAt < batchBody.indexOf("collapseRecordArtifactsBatch("), "strip before the batch collapse can merge metadata");
  assert(stripAt < batchBody.indexOf("applyMemoryContext("), "strip before any other use of the metadata");
  const shimBody = src.slice(shimStart, shimStart + 4000);
  const shimStrip = shimBody.indexOf("stripAnalystAuthorityKeys(");
  assert(shimStrip > 0, "the shim must strip");
  assert(shimStrip < shimBody.indexOf("applyMemoryContext("), "shim strips before any other use");
  const h = await Deno.readTextFile(new URL("./health-handler.ts", import.meta.url));
  assert(h.includes("analystAuthorityBoundarySelfTest()"));
  assert(h.includes("checks.analyst_authority_boundary"));
});
