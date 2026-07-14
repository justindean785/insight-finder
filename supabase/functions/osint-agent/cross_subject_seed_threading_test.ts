// cross_subject_seed_threading_test.ts — Finding #7: the cross-subject contact-
// laundering guard (isCrossSubjectContactLaundering, output-integrity.ts) must
// fire through the REAL caller (record_artifacts in tool-registry.ts), not just
// as a pure-function unit test — the original defect was that direct unit tests
// of the guard passed while the actual caller supplied an empty seed, because it
// read triageState.seed (populated ONLY by the optional triage_seed tool) instead
// of the investigation's real seed. record_artifacts now sources the seed from
// ctx.detectedSeedValue (the original request context — auth.ts's SetupContext
// field, threaded through ToolContext), independent of triage_seed.
//
// Every test below deliberately NEVER calls triage_seed, and covers every
// accepted investigation seed type (username, name, phone, URL, domain, IP) to
// prove the guard is reachable for all of them, not just email/username.
import { assert, assertEquals } from "jsr:@std/assert@^1";
import { buildTools, type ToolContext } from "./tool-registry.ts";
import * as circuit from "./circuit.ts";

interface MockSupabase {
  supabase: unknown;
  insertedArtifacts: Array<Record<string, unknown>>;
}

function makeMockSupabase(): MockSupabase {
  const insertedArtifacts: Array<Record<string, unknown>> = [];
  const builder: Record<string, unknown> = {
    then: (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res),
  };
  for (const m of ["select", "eq", "or", "order", "limit", "is", "update"]) {
    builder[m] = () => builder;
  }
  const supabase = {
    from(_table: string) {
      return {
        insert(rows: unknown) {
          if (Array.isArray(rows)) insertedArtifacts.push(...(rows as Record<string, unknown>[]));
          else insertedArtifacts.push(rows as Record<string, unknown>);
          return Promise.resolve({ error: null });
        },
        select: () => builder,
        update: () => builder,
      };
    },
    rpc(name: string, _args: Record<string, unknown>) {
      if (name === "append_evidence") return Promise.resolve({ data: [{ id: "ev1", seq: 1, chain_hash: "h" }], error: null });
      return Promise.resolve({ data: [], error: null });
    },
  };
  return { supabase, insertedArtifacts };
}

// Builds a ToolContext with a real detectedSeedValue/detectedSeedType, and
// CRITICALLY never touches triage_seed — proving the guard doesn't depend on it.
function ctxWithSeed(supabase: unknown, seedType: string, seedValue: string): ToolContext {
  const threadId = `cst-thread-${seedType}`;
  circuit.clearThread(threadId);
  return {
    supabase,
    supabaseAdmin: supabase,
    userId: "cst-test-user",
    threadId,
    archiveEnabled: false,
    detectedSeedType: seedType,
    detectedSeedValue: seedValue,
    messages: [],
    manualOverrideSelector: null,
  } as unknown as ToolContext;
}

// The laundering shape from the live case: a third-party account's own phone/geo
// gets asserted as a lead ABOUT the seed subject with no explicit link. The seed
// here is a HANDLE-shaped identity token — for seed types where the raw seed
// isn't itself a handle (name/phone/url/domain/ip), sourceProfileHandle's own
// "barlozblendz"-vs-seed comparison still correctly proceeds past the empty-seed
// short-circuit (the bug), because detectedSeedValue is non-empty; the guard's
// full logic (tiesToSeed / EXPLICIT_LINK_RE) still governs the actual verdict.
async function recordLaunderedContact(ctx: ToolContext, seedHandleNote: string) {
  const { tools } = buildTools(ctx);
  await (tools as Record<string, { execute: (i: unknown, o: unknown) => Promise<unknown> }>).record_artifacts.execute(
    {
      artifacts: [{
        kind: "weak_lead",
        value: "530 area code Sacramento/Yuba City",
        source: "barlozblendz Instagram bio",
        // sourceProfileHandle() (output-integrity.ts) reads source/source_profile/
        // handle from the METADATA object, not the artifact's top-level `source` —
        // it must be duplicated inside metadata for isCrossSubjectContactLaundering
        // to find it (matches output_integrity_test.ts's proven-working shape).
        metadata: {
          source: "barlozblendz Instagram bio",
          note: `${seedHandleNote} appeared in search results near this geographic area`,
        },
      }],
    },
    {},
  );
}

// note MUST literally contain foldHandle(value) (lowercase, no URL parsing —
// foldHandle only strips a leading @ and trailing dots) so isCrossSubjectContact
// Laundering's `noteText.includes(seed)` tiesToSeed check actually matches; a
// mismatch here would be a bug in the TEST, not in the guard.
const SEED_TYPES: Array<{ type: string; value: string; note: string }> = [
  { type: "username", value: "pjsmakka", note: "pjsmakka" },
  { type: "name", value: "John Smith", note: "John Smith" },
  { type: "phone", value: "+15305551234", note: "+15305551234" },
  { type: "url", value: "https://www.instagram.com/pjsmakka/", note: "https://www.instagram.com/pjsmakka/" },
  { type: "domain", value: "example-corp.com", note: "example-corp.com" },
  { type: "ip", value: "203.0.113.42", note: "203.0.113.42" },
];

for (const seed of SEED_TYPES) {
  Deno.test(`finding #7: cross-subject guard reaches its verdict for seed type "${seed.type}" WITHOUT triage_seed ever running`, async () => {
    const mock = makeMockSupabase();
    const ctx = ctxWithSeed(mock.supabase, seed.type, seed.value);
    await recordLaunderedContact(ctx, seed.note);

    assertEquals(mock.insertedArtifacts.length, 1);
    const meta = mock.insertedArtifacts[0].metadata as Record<string, unknown>;
    // The guard actually EVALUATED (didn't short-circuit on an empty seed) — it
    // reached a real verdict. For the "note names the seed's own identity token"
    // shape used here, that verdict is exclusion (cross_subject_contact=true).
    // The pre-fix bug made every one of these calls silently skip the guard
    // (isCrossSubjectContactLaundering always returned false immediately because
    // triageState.seed was "" — no triage_seed call, ever, for any seed type).
    assert(
      meta.cross_subject_contact === true || meta.excluded_reason === "cross_subject_contact_not_linked",
      `expected the guard to fire for seed type "${seed.type}", got metadata: ${JSON.stringify(meta)}`,
    );
    circuit.clearThread(ctx.threadId);
  });
}

Deno.test("finding #7: a legitimate, explicitly-linked contact is NOT excluded (the guard isn't just a blanket suppressor)", async () => {
  const mock = makeMockSupabase();
  const ctx = ctxWithSeed(mock.supabase, "username", "pjsmakka");
  const { tools } = buildTools(ctx);
  await (tools as Record<string, { execute: (i: unknown, o: unknown) => Promise<unknown> }>).record_artifacts.execute(
    {
      artifacts: [{
        kind: "weak_lead",
        value: "530 area code",
        source: "barlozblendz Instagram bio",
        metadata: {
          source: "barlozblendz Instagram bio",
          note: "pjsmakka tagged barlozblendz in a shared post — explicit link",
        },
      }],
    },
    {},
  );
  assertEquals(mock.insertedArtifacts.length, 1);
  const meta = mock.insertedArtifacts[0].metadata as Record<string, unknown>;
  assert(!meta.cross_subject_contact, "an explicitly-linked contact must NOT be excluded as laundered");
  circuit.clearThread(ctx.threadId);
});

Deno.test("finding #7: missing seed context (no detectedSeedValue, no triage_seed) fails closed to the guard's original safe behavior, never a false negative that IS actually reachable when a seed exists", async () => {
  const mock = makeMockSupabase();
  const ctx = ctxWithSeed(mock.supabase, "unknown", "");
  (ctx as { detectedSeedValue?: string | null }).detectedSeedValue = null;
  const { tools } = buildTools(ctx);
  await (tools as Record<string, { execute: (i: unknown, o: unknown) => Promise<unknown> }>).record_artifacts.execute(
    {
      artifacts: [{
        kind: "weak_lead",
        value: "530 area code",
        source: "barlozblendz Instagram bio",
        metadata: {
          source: "barlozblendz Instagram bio",
          note: "some subject appeared in search results near this geographic area",
        },
      }],
    },
    {},
  );
  assertEquals(mock.insertedArtifacts.length, 1);
  // With genuinely no seed anywhere, the guard cannot compare — this is the one
  // case where it legitimately can't fire (nothing to compare against), unlike
  // the pre-fix bug where THIS was the behavior for every real investigation.
  const meta = mock.insertedArtifacts[0].metadata as Record<string, unknown>;
  assert(!meta.cross_subject_contact, "with no seed at all, there is nothing to launder against — expected, not a regression");
  circuit.clearThread(ctx.threadId);
});
