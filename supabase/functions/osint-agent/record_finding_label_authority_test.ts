/**
 * record_finding_label_authority_test.ts — #477
 *
 * `record_finding` computes `confidence` with full server authority
 * (`computeAxes` over a server-derived independent-source count) and then
 * persists the MODEL'S `label` beside it with none, echoing it back as
 * `applied_label` as though the server had ratified it.
 *
 * Measured in production (8,788 artifacts / 167 threads): `record_finding` has
 * executed 13 times. TEN of those persisted `label: "CONFIRMED"` on a
 * server-computed confidence between 15 and 78 — every one below the >=80
 * confirmation bar, mean 43.3. For contrast the number itself is exact: 0 of
 * 8,788 rows carry a confidence above their own `confidence_cap_applied`.
 *
 * These tests DRIVE THE REAL TOOL — buildTools(...).tools.record_finding.execute()
 * — and assert on the row actually handed to the database and on the value
 * actually returned to the model. They must never be rewritten to re-describe
 * the derivation inline: record_finding_corroboration_test.ts does exactly that
 * for F06 and therefore cannot catch a regression in the shipped call path.
 *
 * Authority reused, not invented: `deriveStatus` + `coerceCoherentStatus`
 * (confidence.ts), the same pair auto-record-integrity.ts already applies to
 * every auto-recorded artifact. No new numeric ladder is introduced, and
 * confidence / caps / axes / source classification are left untouched.
 */
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@^1";
import { buildTools, type ToolContext } from "./tool-registry.ts";

type Row = { confidence: number; metadata: Record<string, unknown> };

type FindingResult = {
  ok: boolean;
  id: string | null;
  confidence_axes: { case: number };
  applied_label: string;
  model_label: string;
};
type ExecutableTool = { execute: (input: Record<string, unknown>) => Promise<FindingResult> };

function harness(threadRows: unknown[] = []) {
  const captured: { row?: Row } = {};
  const supabase = {
    from(_table: string) {
      return {
        select(_cols: string) {
          return { eq: (_k: string, _v: string) => Promise.resolve({ data: threadRows, error: null }) };
        },
        insert(rows: unknown) {
          captured.row = (Array.isArray(rows) ? rows[0] : rows) as Row;
          return {
            select: (_c: string) => ({
              maybeSingle: () => Promise.resolve({ data: { id: "artifact-1" }, error: null }),
            }),
          };
        },
      };
    },
  };
  const ctx = {
    supabase, supabaseAdmin: supabase, userId: "u1", threadId: "t1",
    archiveEnabled: false, detectedSeedType: "email", messages: [],
    manualOverrideSelector: null,
  } as unknown as ToolContext;
  const tool = (buildTools(ctx).tools as unknown as Record<string, ExecutableTool>).record_finding;
  return { captured, tool };
}

/** A deliberately weak finding: one ai_summary-class source corroborates nothing. */
function weakInput(label: string) {
  return {
    conclusion: "Subject operates the handle in question",
    supporting_sources: ["exa_search"],
    supporting_artifact_values: [],
    drivers: ["single discovery-tool hit"],
    identity_evidence_strength: 20,
    relationship_evidence_strength: 20,
    corroboration_count: 5, // model over-claim; disarmed since F06
    label,
  };
}

Deno.test("#477: a model-claimed CONFIRMED is not persisted as authority on a weak score", async () => {
  const { captured, tool } = harness();
  const out = await tool.execute(weakInput("CONFIRMED"));
  const row = captured.row!;
  // Guard against a vacuous pass: the server score must genuinely be under the bar.
  assert(row.confidence < 80, `expected a sub-80 server score, got ${row.confidence}`);
  assertNotEquals(row.metadata.label, "CONFIRMED");
  assertNotEquals(out.applied_label, "CONFIRMED");
});

Deno.test("#477: the server derives an authoritative status field", async () => {
  const { captured, tool } = harness();
  await tool.execute(weakInput("CONFIRMED"));
  const status = captured.row!.metadata.status;
  assert(typeof status === "string" && status.length > 0, "expected a server-derived metadata.status");
  assertNotEquals(status, "confirmed");
  assertNotEquals(status, "verified");
});

Deno.test("#477: applied_label reports server authority, never the model's own pick", async () => {
  const { captured, tool } = harness();
  const out = await tool.execute(weakInput("CONFIRMED"));
  assertEquals(out.applied_label, captured.row!.metadata.status);
});

Deno.test("#477: the model's pick is preserved for disclosure, not deleted", async () => {
  const { captured, tool } = harness();
  await tool.execute(weakInput("CONFIRMED"));
  assertEquals(captured.row!.metadata.model_label, "CONFIRMED");
});

Deno.test("#477: free text cannot reach an authority field", async () => {
  // Production carries 68 rows whose `label` is free text — record-company names
  // such as "Mozzy Records" and "One RPM" — because the model read "label" in its
  // ordinary English sense. Such a value must be preserved as disclosure and must
  // never become a status/tier.
  const { captured, tool } = harness();
  const out = await tool.execute(weakInput("Mozzy Records"));
  const md = captured.row!.metadata;
  assertEquals(md.model_label, "Mozzy Records");
  assertNotEquals(md.status, "Mozzy Records");
  assertNotEquals(out.applied_label, "Mozzy Records");
  assertNotEquals(md.label, "Mozzy Records");
});

Deno.test("#477: the server-computed confidence is left untouched by this change", async () => {
  // Scope guard. #477 must not alter caps, axes, or source classification —
  // the persisted number stays exactly axes.case.
  const { captured, tool } = harness();
  const out = await tool.execute(weakInput("CONFIRMED"));
  assertEquals(captured.row!.confidence, out.confidence_axes.case);
});

Deno.test("#477: metadata.label is not written on findings, so isMetaArtifact stays unaffected", async () => {
  // useThreadArtifacts.ts:63 treats metadata.label as the META-KIND marker
  // (triage_decision / cluster_decision) and excludes those rows from every
  // artifact count. Findings must not compete for that key.
  const { captured, tool } = harness();
  await tool.execute(weakInput("CONFIRMED"));
  assertEquals(captured.row!.metadata.label, undefined);
});


// ---------------------------------------------------------------------------
// H1 / H2 — the two merge blockers raised in review on 517f01c. The seven tests
// above pass both before and after those fixes, because they assert only
// `!== "confirmed"` / `!== "verified"` on a single weak, single-source input.
// The derivation that authority FLOWS THROUGH was still wrong. These drive it.
// ---------------------------------------------------------------------------

/** Three genuinely distinct source classes: breach + ai_summary + court_record. */
function multiClassInput(extra: Record<string, unknown> = {}) {
  return {
    conclusion: "Subject is the named party in the filing",
    supporting_sources: ["breach_check", "gemini_deep_dork", "court_record_search"],
    supporting_artifact_values: [],
    drivers: ["breach record", "court filing"],
    identity_evidence_strength: 70,
    relationship_evidence_strength: 70,
    corroboration_count: 3,
    label: "CONFIRMED",
    ...extra,
  };
}

Deno.test("#486 H1: distinct source classes survive into the cap derivation", async () => {
  const { captured, tool } = harness();
  await tool.execute(multiClassInput());
  const classes = captured.row!.metadata.source_category as string[];
  // The defect: `supporting_sources.join(",")` was wrapped as ONE label, and
  // BREACH_SLUG_RE matches a breach slug anywhere in the string (its boundary
  // class includes ","), so all three classes collapsed to exactly [breach].
  assert(Array.isArray(classes), `expected an array of classes, got ${JSON.stringify(classes)}`);
  assertNotEquals(
    JSON.stringify(classes),
    JSON.stringify(["breach"]),
    "three distinct source classes collapsed to [breach] — the join(\",\") defect",
  );
  for (const expected of ["breach", "ai_summary", "court_record"]) {
    assert(classes.includes(expected), `missing class ${expected} in ${JSON.stringify(classes)}`);
  }
});

Deno.test("#486 H1: reason_not_confirmed does not claim a second class is missing when three back it", async () => {
  const { captured, tool } = harness();
  await tool.execute(multiClassInput());
  // This is the integrity consequence, and the #477 shape one field over: the
  // collapsed count made the server persist a FALSE authoritative statement.
  // Measured in review: 11 of 13 live rows would carry this string over 2-5
  // real independent classes.
  assertNotEquals(
    captured.row!.metadata.reason_not_confirmed,
    "needs second independent class of evidence",
    "server asserted a missing second class over three independent classes",
  );
});

Deno.test("#486 H1: the recorded cap reflects the array path, not the collapsed single class", async () => {
  const { captured, tool } = harness();
  await tool.execute(multiClassInput());
  const cap = captured.row!.metadata.confidence_cap_applied as number;
  // Collapsed-to-[breach] pinned the cap at the breach class cap of 60. The
  // array path measures the real mix. Asserting ">60" rather than a literal
  // keeps this from re-describing CLASS_CAP arithmetic inline.
  assert(typeof cap === "number", `expected a numeric cap, got ${JSON.stringify(cap)}`);
  assert(cap > 60, `cap ${cap} is still pinned at the collapsed single-class ceiling`);
});

Deno.test("#486 H2: model prose asserting NO contradiction cannot make a row contradicted", async () => {
  const { captured, tool } = harness(); // no thread rows => server detects none
  await tool.execute(multiClassInput({
    contradictions: ["None — all sources agree on Sacramento location and identity"],
  }));
  // deriveStatus tests only `Array.isArray(x) && x.length > 0`, so this text —
  // which asserts the OPPOSITE of a contradiction — set status to
  // "contradicted". Three live production rows carry prose of this form.
  assertNotEquals(
    captured.row!.metadata.status,
    "contradicted",
    "model prose fabricated a contradiction the server never detected",
  );
});

Deno.test("#486 H2: the model cannot suppress a server-detected contradiction", async () => {
  // Two genuinely incompatible locations => a real `location_conflict`.
  const rows = [
    { kind: "name", value: "Subject A", source: "court_record_search", metadata: { based: "Sacramento, CA" }, created_at: "2026-01-01T00:00:00Z" },
    { kind: "name", value: "Subject A", source: "gemini_deep_dork", metadata: { based: "Miami, FL" }, created_at: "2026-01-02T00:00:00Z" },
  ];
  const { captured, tool } = harness(rows);
  await tool.execute(multiClassInput({ contradictions: [] }));

  // Guard against a vacuous pass: prove the server really did detect one.
  const persisted = captured.row!.metadata.contradictions as unknown[];
  assert(
    Array.isArray(persisted) && persisted.length > 0,
    "vacuous: the server detected no contradiction, so suppression cannot be tested",
  );
  // The defect: `i.contradictions ?? contras` let the model's empty array win,
  // discarding the server's own finding and persisting `observed`.
  assertEquals(
    captured.row!.metadata.status,
    "contradicted",
    "an empty model array suppressed a server-detected contradiction",
  );
});

Deno.test("#486 H2: the model's contradiction claim is preserved as disclosure, not discarded", async () => {
  const { captured, tool } = harness();
  const claim = ["None — all sources agree on Sacramento location and identity"];
  await tool.execute(multiClassInput({ contradictions: claim }));
  // Removing authority must never mean removing the record. Same shape as
  // model_label, and as quarantine: disclosure, not deletion.
  assertEquals(captured.row!.metadata.model_contradictions, claim);
});

Deno.test("#486 M4: the persisted confidence is still axes.case, uncapped", async () => {
  const { captured, tool } = harness();
  const out = await tool.execute(multiClassInput());
  // The scope guard from the original PR, restated against the new cap field:
  // recording the cap is DISCLOSURE. It must not silently start clamping the
  // stored number — that would be a different change with a different blast
  // radius (#481 owns the display layer).
  assertEquals(captured.row!.confidence, out.confidence_axes.case);
});
