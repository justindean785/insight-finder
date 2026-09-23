// record-name-quarantine — the write-path linkage gate for MODEL-AUTHORED rows.
//
// Canonical case: a username-seed production case (2026-09-23), SANITIZED —
// every handle, person and organisation is fictional. The seed was a
// username; a name-only breach lookup quarantined "Jordan Vale"; the model then
// recorded a chamber-of-commerce CEO, a Senate aide and a civic directory profile for that
// SAME name through record_artifacts, all at full subject authority.
//
// PART 1 pins the pure rule. PART 2 DRIVES the shipped record_artifacts path
// with a mock DB, so the wiring is exercised rather than re-described.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  inheritedNameQuarantine,
  quarantinedPersonNames,
  recordNameQuarantineEnabled,
} from "./lib/record-name-quarantine.ts";
import { buildTools, type ToolContext } from "./tool-registry.ts";

const QUARANTINED_ECHO = {
  kind: "name",
  value: "Jordan Vale",
  metadata: { subject_unlinked: true, subject_unlinked_reason: "echo of a name-only query" },
};

// ── PART 1: pure rule ───────────────────────────────────────────────────────

Deno.test("record-name-quarantine: a row naming a quarantined person inherits the quarantine", () => {
  const names = quarantinedPersonNames([QUARANTINED_ECHO]);
  for (const v of [
    "Jordan Vale - Midvale Chamber CEO",
    "Jordan R. Vale - legislative staff directory record",
    "Civic directory profile - Jordan Vale - Advocate (2025)",
  ]) {
    const got = inheritedNameQuarantine(v, names, "quietfalcon77");
    assert(got, v);
    assertEquals(got!.subject_unlinked, true);
    assertEquals(got!.unproven_linkage_parent, "name:jordan vale");
    assert(String(got!.subject_unlinked_reason).includes("echo of a name-only query"));
  }
});

Deno.test("record-name-quarantine: unrelated rows and partial-name rows are untouched", () => {
  const names = quarantinedPersonNames([QUARANTINED_ECHO]);
  assertEquals(inheritedNameQuarantine("https://x.com/quietfalcon77", names, "quietfalcon77"), null);
  // Surname-only and first-name-only mentions are NOT the quarantined name.
  assertEquals(inheritedNameQuarantine("Casey Vale", names, "quietfalcon77"), null);
  assertEquals(inheritedNameQuarantine("Jordan Blake", names, "quietfalcon77"), null);
});

Deno.test("record-name-quarantine: a name the SEED links is exempt (name-seeded investigation)", () => {
  const names = quarantinedPersonNames([QUARANTINED_ECHO]);
  assertEquals(inheritedNameQuarantine("Jordan Vale - Midvale Chamber CEO", names, "Jordan Vale"), null);
});

Deno.test("record-name-quarantine: a RELEASED or non-person or single-token parent taints nothing", () => {
  assertEquals(quarantinedPersonNames([{ ...QUARANTINED_ECHO, metadata: { subject_unlinked: true, linkage_confirmed: true } }]).length, 0);
  assertEquals(quarantinedPersonNames([{ ...QUARANTINED_ECHO, kind: "breach_exposure" }]).length, 0);
  assertEquals(quarantinedPersonNames([{ ...QUARANTINED_ECHO, value: "Jordan" }]).length, 0);
  assertEquals(quarantinedPersonNames([{ ...QUARANTINED_ECHO, metadata: { subject_unlinked: "true" } }]).length, 0);
});

Deno.test("record-name-quarantine: kill switch is ON by default and read at call time", () => {
  assert(recordNameQuarantineEnabled(() => undefined));
  assert(!recordNameQuarantineEnabled(() => "true"));
  assert(recordNameQuarantineEnabled(() => "false"));
});

// ── PART 2: the shipped record_artifacts path ───────────────────────────────

function makeMock(threadRows: Array<Record<string, unknown>>) {
  const inserted: Array<Record<string, unknown>> = [];
  const evidence: Array<Record<string, unknown>> = [];
  const supabase = {
    from(_table: string) {
      // Only the name-quarantine read filters `.in("kind", …)`; every other read
      // (dedup, peers, memory) sees an empty thread, exactly as in provenance_guard_test.
      let personRead = false;
      const builder: Record<string, unknown> = {
        then: (res: (v: unknown) => unknown) =>
          Promise.resolve(
            personRead
              ? { data: threadRows, count: threadRows.length, error: null }
              : { data: [], count: 0, error: null },
          ).then(res),
      };
      for (const m of ["select", "eq", "or", "order", "limit", "is", "update", "range", "not", "gte", "lte", "ilike", "neq"]) {
        builder[m] = () => builder;
      }
      builder.in = (col: string) => {
        if (col === "kind") personRead = true;
        return builder;
      };
      return {
        insert(rows: unknown) {
          if (Array.isArray(rows)) inserted.push(...(rows as Record<string, unknown>[]));
          else inserted.push(rows as Record<string, unknown>);
          return Promise.resolve({ error: null });
        },
        select: (...a: unknown[]) => (builder.select as (...x: unknown[]) => unknown)(...a),
        update: () => builder,
      };
    },
    rpc(name: string, args: Record<string, unknown>) {
      if (name === "append_evidence") evidence.push(args);
      return Promise.resolve({ data: [{ id: "ev1", seq: 1, chain_hash: "h" }], error: null });
    },
  };
  return { supabase, inserted, evidence };
}

async function record(threadRows: Array<Record<string, unknown>>, value: string, kind = "name") {
  const mock = makeMock(threadRows);
  const ctx = {
    supabase: mock.supabase,
    supabaseAdmin: mock.supabase,
    userId: "rnq-user",
    threadId: "rnq-thread",
    archiveEnabled: false,
    detectedSeedType: "username",
    messages: [],
    manualOverrideSelector: null,
  } as unknown as ToolContext;
  const { tools } = buildTools(ctx);
  const out = await (tools as Record<string, { execute: (i: unknown, o: unknown) => Promise<unknown> }>)
    .record_artifacts.execute(
      { artifacts: [{ kind, value, source: "minimax_web_search", confidence: 85 }] },
      {},
    ) as Record<string, unknown>;
  const row = mock.inserted.find((r) => r.value === value);
  return { out, meta: (row?.metadata ?? {}) as Record<string, unknown>, row };
}

Deno.test("record_artifacts: the Midvale Chamber CEO row is written WITH the inherited quarantine", async () => {
  const { out, meta, row } = await record([QUARANTINED_ECHO], "Jordan Vale - Midvale Chamber CEO");
  assert(row, "row must still be written — quarantine is disclosure, not deletion");
  assertEquals(meta.subject_unlinked, true);
  assertEquals(meta.unproven_linkage_parent, "name:jordan vale");
  assertEquals(out.name_quarantined, 1);
});

Deno.test("record_artifacts: the model cannot pre-release its own tainted row", async () => {
  const mock = makeMock([QUARANTINED_ECHO]);
  const ctx = {
    supabase: mock.supabase, supabaseAdmin: mock.supabase, userId: "u", threadId: "t",
    archiveEnabled: false, detectedSeedType: "username", messages: [], manualOverrideSelector: null,
  } as unknown as ToolContext;
  const { tools } = buildTools(ctx);
  await (tools as Record<string, { execute: (i: unknown, o: unknown) => Promise<unknown> }>).record_artifacts.execute(
    { artifacts: [{ kind: "name", value: "Jordan Vale - Midvale Chamber CEO", source: "minimax_web_search", metadata: { linkage_confirmed: true } }] },
    {},
  );
  const meta = (mock.inserted[0]?.metadata ?? {}) as Record<string, unknown>;
  assertEquals(meta.subject_unlinked, true);
  assertEquals(meta.linkage_confirmed, undefined);
});

Deno.test("record_artifacts: control — with no quarantined name on the thread, the row keeps authority", async () => {
  const { out, meta, row } = await record([], "Jordan Vale - Midvale Chamber CEO");
  assert(row);
  assertEquals(meta.subject_unlinked, undefined);
  assertEquals(out.name_quarantined, undefined);
});

Deno.test("record_artifacts: kill switch RECORD_NAME_QUARANTINE_DISABLED restores the old write", async () => {
  Deno.env.set("RECORD_NAME_QUARANTINE_DISABLED", "true");
  try {
    const { meta } = await record([QUARANTINED_ECHO], "Jordan Vale - Midvale Chamber CEO");
    assertEquals(meta.subject_unlinked, undefined);
  } finally {
    Deno.env.delete("RECORD_NAME_QUARANTINE_DISABLED");
  }
});

// ── Codex review on #621: the three bypasses ─────────────────────────────────

function toolsFor(threadRows: Array<Record<string, unknown>>, extra: Partial<ToolContext> = {}) {
  const mock = makeMock(threadRows);
  const ctx = {
    supabase: mock.supabase, supabaseAdmin: mock.supabase, userId: "u", threadId: "t",
    archiveEnabled: false, detectedSeedType: "username", messages: [], manualOverrideSelector: null,
    ...extra,
  } as unknown as ToolContext;
  const built = buildTools(ctx);
  const tools = built.tools as Record<string, { execute: (i: unknown, o: unknown) => Promise<unknown> }>;
  return { mock, tools, built };
}

Deno.test("record_artifact (singular shim): the same value is quarantined — no bypass by tool spelling", async () => {
  const { mock, tools } = toolsFor([QUARANTINED_ECHO]);
  const out = await tools.record_artifact.execute(
    { kind: "name", value: "Jordan Vale - Midvale Chamber CEO", source: "minimax_web_search", confidence: 85 },
    {},
  ) as Record<string, unknown>;
  const meta = (mock.inserted[0]?.metadata ?? {}) as Record<string, unknown>;
  assertEquals(meta.subject_unlinked, true);
  assertEquals(out.name_quarantined, 1);
  // The chain-of-custody append carries the SAME post-quarantine metadata.
  await new Promise((r) => setTimeout(r, 0));
  const ev = mock.evidence.find((e) => e._value === "Jordan Vale - Midvale Chamber CEO");
  assert(ev, "append_evidence must be called for the recorded row");
  assertEquals((ev!._metadata as Record<string, unknown>).subject_unlinked, true);
});

Deno.test("record_artifacts: a quarantine extracted THIS request binds before its auto-persist insert lands", async () => {
  // The DB has no quarantined row yet (the detached insert has not landed).
  const { mock, tools, built } = toolsFor([]);
  built.noteQuarantinedFindings([
    { kind: "name", value: "Jordan Vale", context: { subject_unlinked: true, subject_unlinked_reason: "echo of a name-only query" } },
    { kind: "email", value: "unrelated@example.com", context: {} },
  ]);
  await tools.record_artifacts.execute(
    { artifacts: [{ kind: "name", value: "Jordan Vale - Midvale Chamber CEO", source: "minimax_web_search" }] },
    {},
  );
  const meta = (mock.inserted[0]?.metadata ?? {}) as Record<string, unknown>;
  assertEquals(meta.subject_unlinked, true);
});

Deno.test("record_artifacts: the REQUEST's person seed exempts its own name (not only triage_seed state)", async () => {
  const { mock, tools } = toolsFor([QUARANTINED_ECHO], { getSubjectSeedName: () => "jordan vale" });
  await tools.record_artifacts.execute(
    { artifacts: [{ kind: "name", value: "Jordan Vale - Midvale Chamber CEO", source: "minimax_web_search" }] },
    {},
  );
  const meta = (mock.inserted[0]?.metadata ?? {}) as Record<string, unknown>;
  assertEquals(meta.subject_unlinked, undefined);
});

Deno.test("index.ts wiring: quarantines are noted SYNCHRONOUSLY before the detached auto-persist, and the person seed is passed", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const noted = src.indexOf("noteQuarantinedFindings(stepFindings)");
  const detached = src.indexOf("const autoPersistTask = (async () =>");
  assert(noted > 0, "onStepFinish must call noteQuarantinedFindings(stepFindings)");
  assert(detached > noted, "the note must precede the detached auto-persist task");
  assert(src.includes("getSubjectSeedName: () => subjectSeedName"), "buildTools must receive the request's person seed");
});
