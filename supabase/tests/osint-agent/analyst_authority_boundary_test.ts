// analyst_authority_boundary_test.ts — A1 driving tests.
//
// REPRODUCED 2026-10-13 on main 32f5ddb: record_artifacts and its record_artifact shim persisted a
// model-written `metadata.reviewed`, `linkage_confirmed`, `review_state`, `analyst_confirmed`
// verbatim, and the frontend ladder then rendered a single-source breach email as
// "Analyst-confirmed" (label ATTESTED, status verified). These tests drive the REAL tools through
// the same stub harness as recording_source_policy_runtime_test.ts. Synthetic values only.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildTools, type ToolContext } from "../../functions/osint-agent/tool-registry.ts";
import { ANALYST_AUTHORITY_DISCLOSURE_KEY, RESERVED_ANALYST_AUTHORITY_KEYS } from "../../functions/osint-agent/lib/analyst-authority-keys.ts";

type Row = Record<string, unknown>;

/**
 * `ranBreachTools`: breach-class tools the case "ran". Main's breach-exposure guard rejects a
 * `breach_exposure` row unless one did (read from tool_usage_log), so the cases that record
 * breach prose rows must say so; every other case keeps the empty default.
 */
function makeRuntime(ranBreachTools: string[] = []) {
  const inserted: Row[] = [];
  const rpcCalls: Array<{ fn: string; args: Row }> = [];
  const builder: Record<string, unknown> = {
    then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
  };
  const ranBuilder: Record<string, unknown> = {
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve({ data: ranBreachTools.map((tool_name) => ({ tool_name })), error: null }).then(resolve),
  };
  for (const m of ["select", "eq", "in", "limit"]) ranBuilder[m] = () => ranBuilder;
  for (const m of ["select", "eq", "neq", "or", "order", "limit", "is", "in", "not", "range", "contains", "ilike", "gte", "lte", "update"]) {
    builder[m] = () => builder;
  }
  builder.maybeSingle = () => Promise.resolve({ data: null, error: null });
  const supabase = {
    from(t: string) {
      return {
        insert(rows: Row | Row[]) {
          inserted.push(...(Array.isArray(rows) ? rows : [rows]));
          return Promise.resolve({ error: null });
        },
        select: () => (t === "tool_usage_log" ? ranBuilder : builder),
        update: () => builder,
      };
    },
    rpc(fn: string, args: Row) {
      rpcCalls.push({ fn, args });
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
  return { inserted, rpcCalls, tools: buildTools(ctx).tools };
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
  user_provided: true,
  analyst_provided: true,
};

const custodyRow = (metadata?: Row) => ({
  classification: "hard" as const,
  kind: "email",
  value: "synthetic.person@example.com",
  source: "oathnet_lookup",
  confidence: 90,
  ...(metadata ? { metadata } : {}),
});

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

Deno.test("a reserved key on a LATER batch item is stripped too (not just the first)", async () => {
  const rt = makeRuntime();
  const result = await exec(rt.tools, "record_artifacts")({
    artifacts: [
      { ...breachEmail({ note: "a" }), value: "synthetic.a@example.com" },
      { ...breachEmail({ note: "b" }), value: "synthetic.b@example.com" },
      { ...breachEmail({ reviewed: true, note: "c" }), value: "synthetic.c@example.com" },
      { ...breachEmail({ false_positive: true, linkage_confirmed: true }), value: "synthetic.d@example.com" },
    ],
  }, {}) as Row;
  assertEquals(rt.inserted.length, 4);
  const byValue = Object.fromEntries(rt.inserted.map((r) => [String(r.value), r.metadata as Row]));
  assert(!(ANALYST_AUTHORITY_DISCLOSURE_KEY in byValue["synthetic.a@example.com"]));
  assert(!(ANALYST_AUTHORITY_DISCLOSURE_KEY in byValue["synthetic.b@example.com"]));
  assertEquals(byValue["synthetic.c@example.com"][ANALYST_AUTHORITY_DISCLOSURE_KEY], ["reviewed"]);
  assertEquals(byValue["synthetic.d@example.com"][ANALYST_AUTHORITY_DISCLOSURE_KEY], ["false_positive", "linkage_confirmed"]);
  for (const m of Object.values(byValue)) {
    for (const k of RESERVED_ANALYST_AUTHORITY_KEYS) assert(!(k in m), `${k} must not be persisted on any item`);
  }
  assertEquals(result.analyst_authority_stripped, ["false_positive", "linkage_confirmed", "reviewed"]);
});

Deno.test("a reserved key on the NON-BEST item of a collapsed breach batch is still stripped and still disclosed", async () => {
  // Two duplicate breach prose rows for one selector collapse into the higher-confidence one
  // (G6). The reserved key rides on the LOWER-confidence row, which the collapse would drop
  // silently if the strip ran after it — the result would then never mention the attempt.
  const rt = makeRuntime(["serus_darkweb_scan"]);
  const selector = "synthetic.person@example.com";
  const result = await exec(rt.tools, "record_artifacts")({
    artifacts: [
      {
        kind: "breach_exposure",
        value: `${selector} — Serus darkweb scan: 10 breaches, 0 pastes. Breaches: Alpha, Beta`,
        source: "serus_darkweb_scan",
        confidence: 60,
      },
      {
        kind: "breach_exposure",
        value: `${selector} — Serus 10 breaches: Alpha (2023-09-20), Beta (2024-05-28)`,
        source: "serus_darkweb_scan",
        confidence: 50,
        metadata: { reviewed: true },
      },
    ],
  }, {}) as Row;
  assertEquals(rt.inserted.length, 1, "the pair collapses to one row");
  const meta = rt.inserted[0].metadata as Row;
  assertEquals(meta.breach_exposure_collapsed, true);
  assert(!("reviewed" in meta));
  assertEquals(result.analyst_authority_stripped, ["reviewed"]);
});

Deno.test("a model cannot self-dismiss, but keeps every legitimate way to LOWER a row", async () => {
  const rt = makeRuntime();
  await exec(rt.tools, "record_artifacts")({
    artifacts: [breachEmail({ false_positive: true, conflict: true, collision: true, subject_unlinked: true, contradictions: ["c"] })],
  }, {});
  const meta = rt.inserted[0].metadata as Row;
  assert(!("false_positive" in meta), "a dismissal is the analyst's, not the model's");
  assertEquals(meta.conflict, true);
  assertEquals(meta.collision, true);
  assertEquals(meta.subject_unlinked, true);
  assertEquals(meta.contradictions, ["c"]);
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
    const custody = makeRuntime();
    await exec(custody.tools, "record_evidence")(custodyRow({ reviewed: true }), {});
    assertEquals((custody.rpcCalls[0].args._metadata as Row).reviewed, true);
  } finally {
    Deno.env.delete("ANALYST_AUTHORITY_STRIP_DISABLED");
  }
});

Deno.test("record_evidence: the custody log cannot carry the analyst's keys either (defense in depth, #827 review finding 4)", async () => {
  const rt = makeRuntime();
  const result = await exec(rt.tools, "record_evidence")(custodyRow({ ...IMPERSONATION, note: "kept" }), {}) as Row;
  assertEquals(rt.rpcCalls.length, 1);
  assertEquals(rt.rpcCalls[0].fn, "append_evidence");
  const args = rt.rpcCalls[0].args;
  const meta = args._metadata as Row;
  for (const k of RESERVED_ANALYST_AUTHORITY_KEYS) assert(!(k in meta), `${k} must not reach evidence_log._metadata`);
  assertEquals(meta[ANALYST_AUTHORITY_DISCLOSURE_KEY], [...RESERVED_ANALYST_AUTHORITY_KEYS].sort());
  assertEquals(meta.note, "kept");
  // The content snapshot is the metadata's JSON. A forged key must not survive there AS A KEY, and its value never
  // does; the key NAMES do appear once, as values inside the disclosure array — that is the audit record.
  const snapshot = String(args._content_snapshot);
  for (const k of RESERVED_ANALYST_AUTHORITY_KEYS) assert(!snapshot.includes(`"${k}":`), `${k} must not reach the content snapshot as a key`);
  assert(snapshot.includes(`"${ANALYST_AUTHORITY_DISCLOSURE_KEY}":`), "the disclosure is part of the snapshot");
  assert(!snapshot.includes("2099-01-01"));
  // Nothing else about the row changes.
  assertEquals(args._kind, "email");
  assertEquals(args._value, "synthetic.person@example.com");
  assertEquals(args._source, "oathnet_lookup");
  assertEquals(args._confidence, 90);
  assertEquals(args._classification, "hard");
  // Told, not hidden.
  assertEquals(result.ok, true);
  assertEquals(result.analyst_authority_stripped, [...RESERVED_ANALYST_AUTHORITY_KEYS].sort());
  assert(typeof result.analyst_authority_note === "string");
});

Deno.test("record_evidence: notes still land, a clean call gets no disclosure, and the impersonation is logged by name only", async () => {
  const clean = makeRuntime();
  const cleanResult = await exec(clean.tools, "record_evidence")({ ...custodyRow({ note: "x" }), notes: "collected" }, {}) as Row;
  const cleanMeta = clean.rpcCalls[0].args._metadata as Row;
  assertEquals(cleanMeta, { note: "x", notes: "collected" });
  assert(!("analyst_authority_stripped" in cleanResult));
  assert(!("analyst_authority_note" in cleanResult));

  const rt = makeRuntime();
  const logged: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
  try {
    await exec(rt.tools, "record_evidence")({ ...custodyRow({ user_provided: "VALUE-MUST-NOT-LOG" }), notes: "n" }, {});
  } finally {
    console.warn = orig;
  }
  const line = logged.find((l) => l.includes("analyst_authority_stripped"));
  assert(line, "a structured analyst_authority_stripped event must be emitted");
  const evt = JSON.parse(line!) as Row;
  assertEquals(evt.tool, "record_evidence");
  assertEquals(evt.keys, ["user_provided"]);
  assertEquals(evt.thread_id, "authority-thread");
  assert(!line!.includes("VALUE-MUST-NOT-LOG"));
  // `notes` is a schema field, not model metadata: it is never mistaken for a reserved key.
  assertEquals((rt.rpcCalls[0].args._metadata as Row).notes, "n");
});

Deno.test("the name-conflict anchor cannot be chosen by the model on the live artifact path", async () => {
  const rt = makeRuntime();
  const result = await exec(rt.tools, "record_artifacts")({
    artifacts: [{ kind: "name", value: "Synthetic Person", confidence: 60, source: "exa_search (example.com)", metadata: { user_provided: true, analyst_provided: true } }],
  }, {}) as Row;
  assertEquals(rt.inserted.length, 1);
  const meta = rt.inserted[0].metadata as Row;
  assert(!("user_provided" in meta));
  assert(!("analyst_provided" in meta));
  assertEquals(meta[ANALYST_AUTHORITY_DISCLOSURE_KEY], ["analyst_provided", "user_provided"]);
  assertEquals(result.analyst_authority_stripped, ["analyst_provided", "user_provided"]);
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

Deno.test("wiring (source-level): all three model entry points strip BEFORE the metadata is used, and /health reports the rule", async () => {
  const src = await Deno.readTextFile(new URL("../../functions/osint-agent/tool-registry.ts", import.meta.url));
  assertEquals((src.match(/stripAnalystAuthorityKeys\(/g) ?? []).length, 3, "exactly the three model-metadata entry points");
  const batchStart = src.indexOf("record_artifacts: tool({");
  const shimStart = src.indexOf("record_artifact: tool({");
  assert(batchStart > 0 && shimStart > batchStart);
  const batchBody = src.slice(batchStart, shimStart);
  const stripAt = batchBody.indexOf("stripAnalystAuthorityKeys(");
  assert(stripAt > 0, "the batch tool must strip");
  assert(stripAt < batchBody.indexOf("collapseRecordArtifactsBatch("), "strip before the batch collapse can merge metadata");
  assert(stripAt < batchBody.indexOf("applyMemoryContext("), "strip before any other use of the metadata");
  const shimEnd = src.indexOf("record_evidence: tool({", shimStart);
  assert(shimEnd > shimStart, "the shim body ends where the next tool begins");
  const shimBody = src.slice(shimStart, shimEnd);
  const shimStrip = shimBody.indexOf("stripAnalystAuthorityKeys(");
  assert(shimStrip > 0, "the shim must strip");
  assert(shimStrip < shimBody.indexOf("applyMemoryContext("), "shim strips before any other use");
  const evidenceStart = shimEnd;
  const evidenceEnd = src.indexOf("serus_darkweb_scan = serus_darkweb_scan;", evidenceStart);
  assert(evidenceEnd > evidenceStart, "record_evidence body ends before the late-injected tools");
  const evidenceBody = src.slice(evidenceStart, evidenceEnd);
  const evidenceStrip = evidenceBody.indexOf("stripAnalystAuthorityKeys(");
  assert(evidenceStrip > 0, "record_evidence must strip");
  assert(evidenceStrip < evidenceBody.indexOf('supabase.rpc("append_evidence"'), "record_evidence strips before the custody RPC");
  assert(evidenceStrip < evidenceBody.indexOf("_content_snapshot"), "record_evidence strips before the content snapshot is built");
  const h = await Deno.readTextFile(new URL("../../functions/osint-agent/health-handler.ts", import.meta.url));
  assert(h.includes("analystAuthorityBoundarySelfTest()"));
  assert(h.includes("checks.analyst_authority_boundary"));
});
