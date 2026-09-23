// record-name-quarantine — the write-path linkage gate for MODEL-AUTHORED rows.
//
// Canonical case: speedrvce (thread ba53080a, 2026-09-23). The seed was a
// username; a name-only breach lookup quarantined "Ahmad Thomas"; the model then
// recorded a Silicon Valley CEO, a Senate aide and a CalMatters profile for that
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
  value: "Ahmad Thomas",
  metadata: { subject_unlinked: true, subject_unlinked_reason: "echo of a name-only query" },
};

// ── PART 1: pure rule ───────────────────────────────────────────────────────

Deno.test("record-name-quarantine: a row naming a quarantined person inherits the quarantine", () => {
  const names = quarantinedPersonNames([QUARANTINED_ECHO]);
  for (const v of [
    "Ahmad Thomas - SVLG CEO",
    "Ahmad R. Thomas - LegiStorm congressional staff record",
    "CalMatters Digital Democracy profile - Ahmad Thomas - Advocate (2025)",
  ]) {
    const got = inheritedNameQuarantine(v, names, "speedrvce");
    assert(got, v);
    assertEquals(got!.subject_unlinked, true);
    assertEquals(got!.unproven_linkage_parent, "name:ahmad thomas");
    assert(String(got!.subject_unlinked_reason).includes("echo of a name-only query"));
  }
});

Deno.test("record-name-quarantine: unrelated rows and partial-name rows are untouched", () => {
  const names = quarantinedPersonNames([QUARANTINED_ECHO]);
  assertEquals(inheritedNameQuarantine("https://x.com/speedrvce", names, "speedrvce"), null);
  // Surname-only and first-name-only mentions are NOT the quarantined name.
  assertEquals(inheritedNameQuarantine("Haley Thomas", names, "speedrvce"), null);
  assertEquals(inheritedNameQuarantine("Ahmad Jamal", names, "speedrvce"), null);
});

Deno.test("record-name-quarantine: a name the SEED links is exempt (name-seeded investigation)", () => {
  const names = quarantinedPersonNames([QUARANTINED_ECHO]);
  assertEquals(inheritedNameQuarantine("Ahmad Thomas - SVLG CEO", names, "Ahmad Thomas"), null);
});

Deno.test("record-name-quarantine: a RELEASED or non-person or single-token parent taints nothing", () => {
  assertEquals(quarantinedPersonNames([{ ...QUARANTINED_ECHO, metadata: { subject_unlinked: true, linkage_confirmed: true } }]).length, 0);
  assertEquals(quarantinedPersonNames([{ ...QUARANTINED_ECHO, kind: "breach_exposure" }]).length, 0);
  assertEquals(quarantinedPersonNames([{ ...QUARANTINED_ECHO, value: "Ahmad" }]).length, 0);
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
    rpc() {
      return Promise.resolve({ data: [{ id: "ev1", seq: 1, chain_hash: "h" }], error: null });
    },
  };
  return { supabase, inserted };
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

Deno.test("record_artifacts: the SVLG CEO row is written WITH the inherited quarantine", async () => {
  const { out, meta, row } = await record([QUARANTINED_ECHO], "Ahmad Thomas - SVLG CEO");
  assert(row, "row must still be written — quarantine is disclosure, not deletion");
  assertEquals(meta.subject_unlinked, true);
  assertEquals(meta.unproven_linkage_parent, "name:ahmad thomas");
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
    { artifacts: [{ kind: "name", value: "Ahmad Thomas - SVLG CEO", source: "minimax_web_search", metadata: { linkage_confirmed: true } }] },
    {},
  );
  const meta = (mock.inserted[0]?.metadata ?? {}) as Record<string, unknown>;
  assertEquals(meta.subject_unlinked, true);
  assertEquals(meta.linkage_confirmed, undefined);
});

Deno.test("record_artifacts: control — with no quarantined name on the thread, the row keeps authority", async () => {
  const { out, meta, row } = await record([], "Ahmad Thomas - SVLG CEO");
  assert(row);
  assertEquals(meta.subject_unlinked, undefined);
  assertEquals(out.name_quarantined, undefined);
});

Deno.test("record_artifacts: kill switch RECORD_NAME_QUARANTINE_DISABLED restores the old write", async () => {
  Deno.env.set("RECORD_NAME_QUARANTINE_DISABLED", "true");
  try {
    const { meta } = await record([QUARANTINED_ECHO], "Ahmad Thomas - SVLG CEO");
    assertEquals(meta.subject_unlinked, undefined);
  } finally {
    Deno.env.delete("RECORD_NAME_QUARANTINE_DISABLED");
  }
});
