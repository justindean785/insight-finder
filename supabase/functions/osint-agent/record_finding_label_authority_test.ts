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

function harness() {
  const captured: { row?: Row } = {};
  const supabase = {
    from(_table: string) {
      return {
        select(_cols: string) {
          return { eq: (_k: string, _v: string) => Promise.resolve({ data: [], error: null }) };
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
