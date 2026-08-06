// auto_persist_evidence_log_test.ts — the auto-persist backstop must put what it
// rescues on the chain of custody.
//
// THE DEFECT (production 2026-08-06): auto-persist-findings.ts wrote
// `public.artifacts` and contained no reference to `evidence_log` at all. Every
// finding it rescued therefore existed with no chain entry. On thread f9056822 the
// model called record_artifacts ZERO times across 28 tool calls, so the backstop
// wrote everything — and the run closed with 4 artifacts behind 2 chain entries and
// a report reading "0 model-reviewed, 4 unreviewed". Across the last 8 production
// threads, 6 held more artifacts than chain entries, inverting the documented
// invariant that the chain is the LARGER count.
//
// THE INTEGRITY LINE these tests defend: entering the ledger must make a
// machine-extracted row AUDITABLE, never VERIFIED. record_artifacts derives
// classification from confidence (>= 85 → "hard"); an auto-recorded row must be
// "soft" unconditionally, or a high-confidence extraction would sit in the
// tamper-evident log indistinguishable from a model-reviewed finding.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  appendAutoEvidence,
  AUTO_EVIDENCE_CLASSIFICATION,
  AUTO_EVIDENCE_MAX_RETRIES,
  persistAutoFindings,
} from "./auto-persist-findings.ts";

type RpcCall = { fn: string; args: Record<string, unknown> };

/** Records every append_evidence call; `fail` lets a test script the RPC's errors. */
function fakeClient(opts?: { fail?: Array<{ message: string } | null>; noRpc?: boolean }) {
  const calls: RpcCall[] = [];
  const inserted: Array<Record<string, unknown>> = [];
  let n = 0;
  const client: Record<string, unknown> = {
    from: () => ({
      insert: (rows: Array<Record<string, unknown>>) => {
        inserted.push(...rows);
        return Promise.resolve({ error: null });
      },
    }),
  };
  if (!opts?.noRpc) {
    client.rpc = (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      const scripted = opts?.fail?.[n++];
      return Promise.resolve({ error: scripted ?? null });
    };
  }
  return { client, calls, inserted };
}

function autoRow(over?: Record<string, unknown>) {
  return {
    kind: "email",
    value: "found@example.com",
    confidence: 30,
    source: "oathnet_lookup",
    metadata: { auto_recorded: true, auto_persist_source: "tool_return_extractor" },
    ...over,
  };
}

const ctxFor = (client: unknown) => ({
  supabase: client as never,
  threadId: "11111111-1111-1111-1111-111111111111",
  userId: "22222222-2222-2222-2222-222222222222",
  seen: new Set<string>(),
});

Deno.test("every rescued artifact gets exactly one chain entry", async () => {
  const { client, calls } = fakeClient();
  const rows = [autoRow(), autoRow({ kind: "phone", value: "+15550000000" })];

  const appended = await appendAutoEvidence(ctxFor(client), rows);

  assertEquals(appended, 2);
  assertEquals(calls.length, 2, "one append_evidence per row — no batching, no skipping");
  assert(calls.every((c) => c.fn === "append_evidence"), "must go through the chain RPC");
  assertEquals(calls[0].args._kind, "email");
  assertEquals(calls[1].args._value, "+15550000000");
});

// ── The integrity line ───────────────────────────────────────────────────────
Deno.test("auto-recorded rows enter the ledger as SOFT, whatever their confidence", async () => {
  const { client, calls } = fakeClient();
  // 95 would be "hard" under record_artifacts' confidence-derived rule.
  await appendAutoEvidence(ctxFor(client), [autoRow({ confidence: 95 })]);

  assertEquals(
    calls[0].args._classification,
    AUTO_EVIDENCE_CLASSIFICATION,
    "a machine-extracted row must never be laundered into hard evidence",
  );
  assertEquals(AUTO_EVIDENCE_CLASSIFICATION, "soft");
});

Deno.test("the ledger row stays distinguishable as machine-extracted", async () => {
  const { client, calls } = fakeClient();
  await appendAutoEvidence(ctxFor(client), [autoRow()]);

  const meta = calls[0].args._metadata as Record<string, unknown>;
  assertEquals(meta.auto_recorded, true, "provenance must survive into the chain entry");
  assertEquals(meta.auto_persist_source, "tool_return_extractor");
});

Deno.test("the artifact's own confidence is carried, not inflated", async () => {
  const { client, calls } = fakeClient();
  await appendAutoEvidence(ctxFor(client), [autoRow({ confidence: 30 })]);
  assertEquals(calls[0].args._confidence, 30);
});

// ── Race handling: appends are serial, and a lost seq race is retried ────────
//
// `append_evidence` computes seq as MAX(seq)+1 with no lock, so this module — now a
// SECOND concurrent writer alongside record_artifacts — can lose the race. A
// UNIQUE(thread_id, seq) index makes that a failed INSERT rather than a forked
// chain, so the correct response is to retry, not to drop the evidence.
Deno.test("a lost seq race is retried, not dropped", async () => {
  const { client, calls } = fakeClient({
    fail: [{ message: 'duplicate key value violates unique constraint "evidence_log_thread_id_seq_key"' }, null],
  });

  const appended = await appendAutoEvidence(ctxFor(client), [autoRow()]);

  assertEquals(appended, 1, "the row must still reach the chain after the race");
  assertEquals(calls.length, 2, "exactly one retry was needed");
});

Deno.test("retries are bounded — a persistent race gives up instead of spinning", async () => {
  const fail = Array.from({ length: 10 }, () => ({ message: "duplicate key value violates unique constraint" }));
  const { client, calls } = fakeClient({ fail });

  const appended = await appendAutoEvidence(ctxFor(client), [autoRow()]);

  assertEquals(appended, 0);
  assertEquals(calls.length, AUTO_EVIDENCE_MAX_RETRIES + 1, "bounded by AUTO_EVIDENCE_MAX_RETRIES");
});

Deno.test("a non-race error is NOT retried", async () => {
  const { client, calls } = fakeClient({ fail: [{ message: "must be authenticated" }] });

  const appended = await appendAutoEvidence(ctxFor(client), [autoRow()]);

  assertEquals(appended, 0);
  assertEquals(calls.length, 1, "retrying an auth failure would just burn the backstop's budget");
});

Deno.test("appends are SERIAL — append_evidence reads MAX(seq) and cannot be parallelised", async () => {
  const order: string[] = [];
  let inFlight = 0;
  const client = {
    from: () => ({ insert: () => Promise.resolve({ error: null }) }),
    rpc: async (_fn: string, args: Record<string, unknown>) => {
      inFlight++;
      assertEquals(inFlight, 1, "two appends were in flight at once — they would collide on seq");
      order.push(String(args._kind));
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return { error: null };
    },
  };

  await appendAutoEvidence(ctxFor(client), [autoRow({ kind: "a" }), autoRow({ kind: "b" }), autoRow({ kind: "c" })]);

  assertEquals(order, ["a", "b", "c"], "order must follow the row order");
});

// ── Never break the run ──────────────────────────────────────────────────────
Deno.test("a client with no rpc degrades quietly — artifacts still land", async () => {
  const { client } = fakeClient({ noRpc: true });
  const appended = await appendAutoEvidence(ctxFor(client), [autoRow()]);
  assertEquals(appended, 0, "no ledger entry, but no throw either");
});

Deno.test("a throwing rpc never propagates out of the detached backstop", async () => {
  const client = {
    from: () => ({ insert: () => Promise.resolve({ error: null }) }),
    rpc: () => { throw new Error("network down"); },
  };
  const appended = await appendAutoEvidence(ctxFor(client), [autoRow()]);
  assertEquals(appended, 0);
});

// ── Wiring: persistAutoFindings must actually call it ───────────────────────
Deno.test("persistAutoFindings appends the chain entries for what it inserts", async () => {
  const { client, calls } = fakeClient();
  const res = await persistAutoFindings(ctxFor(client), [
    { kind: "email", value: "hit@example.com", rawConfidence: 30, toolName: "oathnet_lookup" },
  ] as never);

  assertEquals(res.inserted, 1);
  assertEquals(res.evidence_appended, 1, "an inserted artifact without a chain entry is the bug being fixed");
  assertEquals(calls.length, 1);
});

Deno.test("a duplicate that was NOT inserted gets no second chain entry", async () => {
  const { client, calls } = fakeClient();
  const ctx = ctxFor(client);
  const finding = [{ kind: "email", value: "dupe@example.com", rawConfidence: 30, toolName: "oathnet_lookup" }];

  await persistAutoFindings(ctx, finding as never);
  const second = await persistAutoFindings(ctx, finding as never);

  assertEquals(second.inserted, 0);
  assertEquals(second.skipped_duplicates, 1);
  assertEquals(calls.length, 1, "one finding must never accumulate two chain rows");
});
