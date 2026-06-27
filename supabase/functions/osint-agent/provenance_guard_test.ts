// Provenance guard (#131 follow-up) — tests for the minimal "option A" guard
// against LLM-fabricated source citations.
//
// Root cause: an artifact's `source` is a free-text string the orchestrator LLM
// writes; nothing validated it. In a live case 9 PII artifacts were attributed to
// `menstoppingviolence.org` — a DV nonprofit that is NOT a wired tool and hosts no
// such data: a fabricated citation that still polluted the case graph, the export,
// and the tamper-evident chain-of-custody log.
//
// Two guards are covered here:
//   PART 1 — isLlmAssertedDomainSource() conservative detection helper.
//   PART 2 — the runtime record path (a) stamps metadata.provenance and
//            (b) keeps the fabricated domain out of the chain-of-custody
//            _tool_name/_source, while a normal tool-slug source is unaffected.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isLlmAssertedDomainSource,
  LLM_ASSERTED_PROVENANCE,
} from "./source-classification.ts";
import { buildTools, type ToolContext } from "./tool-registry.ts";

// ── PART 1: detection helper ────────────────────────────────────────────────

Deno.test("guard: a fabricated bare domain is flagged", () => {
  assert(isLlmAssertedDomainSource("menstoppingviolence.org"));
});

Deno.test("guard: a real tool slug is NOT flagged", () => {
  assert(!isLlmAssertedDomainSource("minimax_web_search"));
  assert(!isLlmAssertedDomainSource("oathnet_lookup"));
});

Deno.test("guard: a compound of recognized tool slugs is NOT flagged", () => {
  assert(!isLlmAssertedDomainSource("breach_check+oathnet"));
  assert(!isLlmAssertedDomainSource("breach_check+leakcheck+oathnet_lookup"));
});

Deno.test("guard: a known people-search provider label is NOT flagged", () => {
  // whitepages/spokeo/zoominfo etc. are real data sources the classifier maps to
  // a real class — leave them.
  assert(!isLlmAssertedDomainSource("whitepages"));
  assert(!isLlmAssertedDomainSource("spokeo"));
  assert(!isLlmAssertedDomainSource("zoominfo"));
});

Deno.test("guard: a recognized provider written as a bare domain is NOT flagged", () => {
  // classifySource maps these to a real (non-unknown) class via its regexes.
  assert(!isLlmAssertedDomainSource("realtor.com"));
  assert(!isLlmAssertedDomainSource("apollo.io"));
  assert(!isLlmAssertedDomainSource("archive.org"));
});

Deno.test("guard: a dotted tool slug in TOOL_CLASS is NOT flagged", () => {
  // usphonesearch.net / nomorobo.com are wired phone-lookup providers.
  assert(!isLlmAssertedDomainSource("usphonesearch.net"));
  assert(!isLlmAssertedDomainSource("nomorobo.com"));
});

Deno.test("guard: the seed domain is NOT flagged when supplied as recognized", () => {
  // spprop.com is the SEED domain and IS fetched by whois/dns, so the record path
  // whitelists it via triageState.seedDomain. The full fetched-domain ledger that
  // would confirm this positively (rather than via a passed allowlist) is #131.
  assert(!isLlmAssertedDomainSource("spprop.com", ["spprop.com"]));
  // Reasoning note: without that recognition context a bare unrecognized domain is
  // indistinguishable from a fabricated one at the string level, so the pure helper
  // would trip — which is exactly why the seed domain is passed in at record time.
  assert(isLlmAssertedDomainSource("spprop.com"));
});

Deno.test("guard: a fabricated domain mixed with a real tool still trips", () => {
  // One unrecognized bare-domain component is enough — only "every component
  // recognized" is exempt.
  assert(isLlmAssertedDomainSource("oathnet_lookup+menstoppingviolence.org"));
});

Deno.test("guard: empty / non-domain free text is NOT flagged", () => {
  assert(!isLlmAssertedDomainSource(""));
  assert(!isLlmAssertedDomainSource(null));
  assert(!isLlmAssertedDomainSource("Multiple sources"));
  assert(!isLlmAssertedDomainSource("Investigation"));
});

// ── PART 2: runtime record path (record_artifacts) ──────────────────────────

interface MockSupabase {
  supabase: unknown;
  evidenceCalls: Array<Record<string, unknown>>;
  insertedArtifacts: Array<Record<string, unknown>>;
}

function makeMockSupabase(): MockSupabase {
  const evidenceCalls: Array<Record<string, unknown>> = [];
  const insertedArtifacts: Array<Record<string, unknown>> = [];
  // A thenable query builder: every chain method returns itself and awaiting it
  // resolves to an empty result set (no peers, no memory hits).
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
    rpc(name: string, args: Record<string, unknown>) {
      if (name === "append_evidence") evidenceCalls.push(args);
      return Promise.resolve({ data: [{ id: "ev1", seq: 1, chain_hash: "h" }], error: null });
    },
  };
  return { supabase, evidenceCalls, insertedArtifacts };
}

function ctxWith(supabase: unknown): ToolContext {
  return {
    supabase,
    supabaseAdmin: supabase,
    userId: "prov-test-user",
    threadId: "prov-test-thread",
    archiveEnabled: false,
    detectedSeedType: "email",
    messages: [],
    manualOverrideSelector: null,
  } as unknown as ToolContext;
}

async function recordOne(source: string, mock: MockSupabase) {
  const { tools } = buildTools(ctxWith(mock.supabase));
  // deno-lint-ignore no-explicit-any
  await (tools as any).record_artifacts.execute(
    { artifacts: [{ kind: "email", value: "victim@example.com", source }] },
    {},
  );
}

Deno.test("record path: a fabricated-domain source is flagged AND kept out of chain-of-custody", async () => {
  const mock = makeMockSupabase();
  await recordOne("menstoppingviolence.org", mock);

  assertEquals(mock.insertedArtifacts.length, 1);
  const meta = mock.insertedArtifacts[0].metadata as Record<string, unknown>;
  assertEquals(meta.provenance, LLM_ASSERTED_PROVENANCE);
  assertEquals(meta.provenance_verified, false);

  // The chain-of-custody row must NOT carry the fabricated domain as the
  // authoritative tool/source — only the provenance label.
  assertEquals(mock.evidenceCalls.length, 1);
  const ev = mock.evidenceCalls[0];
  assertEquals(ev._tool_name, LLM_ASSERTED_PROVENANCE);
  assertEquals(ev._source, LLM_ASSERTED_PROVENANCE);
  assert(ev._tool_name !== "menstoppingviolence.org");
  // Value/kind stay intact — only provenance representation changed.
  assertEquals(ev._value, mock.insertedArtifacts[0].value);
  assertEquals(ev._kind, "email");
});

Deno.test("record path: a normal tool-slug source is unaffected", async () => {
  const mock = makeMockSupabase();
  await recordOne("oathnet_lookup", mock);

  assertEquals(mock.insertedArtifacts.length, 1);
  const meta = mock.insertedArtifacts[0].metadata as Record<string, unknown>;
  assertEquals(meta.provenance, undefined);
  assertEquals(meta.provenance_verified, undefined);

  assertEquals(mock.evidenceCalls.length, 1);
  const ev = mock.evidenceCalls[0];
  assertEquals(ev._tool_name, "oathnet_lookup");
  assertEquals(ev._source, "oathnet_lookup");
});
