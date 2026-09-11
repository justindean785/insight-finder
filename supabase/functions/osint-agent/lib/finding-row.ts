/**
 * lib/finding-row.ts — the ONE scorer behind every persisted `kind='finding'` row.
 *
 * WHY THIS MODULE EXISTS. `record_finding` is the model-facing tool; finding
 * SYNTHESIS derives the same rows deterministically from already-persisted
 * artifacts when the model never calls it (measured 2026-08-28: 13 findings in
 * the product's lifetime, 6 of 181 threads, last one 11 days ago). Two writers
 * of the same row shape is exactly how a scoring path silently drifts, so the
 * scoring and row construction live here ONCE and both writers call it.
 *
 * ⚠️ THE BODY BELOW IS record_finding's SCORING CHAIN, MOVED VERBATIM — not
 * reimplemented, not "cleaned up". Every comment in it is load-bearing incident
 * history (audit F06's independence derivation, #477's label-vs-status authority
 * split, the joined-source cap collapse, the deriveStatus contradiction
 * asymmetry). It was extracted by slicing the exact source lines rather than by
 * retyping, and `finding_row_equivalence_test.ts` pins that both writers produce
 * an identical row for identical input. Do not edit the arithmetic here to suit
 * a caller; add a parameter instead.
 *
 * SCOPE: this module computes and SHAPES a row. It performs no I/O — the caller
 * supplies the thread's artifact rows and performs the insert — which is what
 * makes it testable without a database and what keeps synthesis out of the
 * finalize window.
 */
import { detectContradictions, artifactsForFinding, isExplicitContradiction } from "../contradictions.ts";
import { classifySourceWithOrigin, countIndependentClasses } from "../source-classification.ts";
import { computeAxes, sourceConfidence } from "../confidence.ts";
import { applyRecordingSourcePolicy, resolveRecordingStatus } from "../recording-source-policy.ts";

/** The subset of `record_finding`'s validated input the scorer reads. */
export interface FindingScoringInput {
  conclusion: string;
  cluster_label?: string;
  supporting_sources: string[];
  supporting_artifact_values?: string[];
  drivers: string[];
  reducers?: string[];
  contradictions?: string[];
  unresolved?: string[];
  next_pivots?: string[];
  identity_evidence_strength: number;
  relationship_evidence_strength: number;
  label: string;
}

type ContraRows = Parameters<typeof detectContradictions>[0];

/**
 * Build the exact `artifacts` row a finding persists as.
 *
 * `contraRows` is the thread's artifact set (kind,value,source,metadata,created_at),
 * already fetched by the caller. Passing null degrades to the same empty-array
 * default the tool path has always used.
 */
export interface BuiltFinding {
  /** The exact `artifacts` row to insert. */
  row: Record<string, unknown>;
  /** The uncapped axes, echoed to the model by the tool path. */
  axes: ReturnType<typeof computeAxes>;
  /** The SERVER-applied status. Never the model's requested label. */
  status: string;
}

export function buildFindingRow(
  i: FindingScoringInput,
  ctx: { threadId: string; userId: string; contraRows: ContraRows | null },
): BuiltFinding {
  const { threadId, userId, contraRows } = ctx;
  // Scope the contradiction / advisory penalty to the artifacts that
  // actually belong to THIS finding's identity candidate — its cited
  // artifacts plus their cluster(s) — so a finding for one candidate is not
  // docked for an UNRELATED candidate's location conflict / thin_name /
  // over_broad_username sitting elsewhere in the same multi-hypothesis
  // thread. When the finding cites nothing resolvable we can't attribute a
  // cluster, so fall back to the thread-wide set (conservative: keep the
  // penalty rather than inflate confidence).
  const allRows = (contraRows ?? []) as Parameters<typeof detectContradictions>[0];
  const scopedRows = artifactsForFinding(allRows, i.supporting_artifact_values ?? []);
  const contras = detectContradictions(scopedRows.length > 0 ? scopedRows : allRows);
  // Audit F06: i.corroboration_count was a raw model-supplied integer with no
  // independence check — a single ai_summary-class source claiming
  // corroboration_count:5 inflated the artifact axis to 100. Derive the real
  // count server-side from the independent SOURCE CLASSES actually backing
  // this finding (same taxonomy the frontend's independentSourceClassCount in
  // src/lib/intel.ts uses), so the boost can never exceed what
  // supporting_sources genuinely proves.
  // `classifySourceWithOrigin` (not `classifySource`) so the count dedups by
  // ORIGIN where one is known: the same hostname reached through two different
  // tools, or on two of its own pages, is one source and must not corroborate
  // itself. Sources with no URL-bearing qualifier carry originId:null and are
  // counted by class exactly as before.
  const corroborationCount = countIndependentClasses(
    i.supporting_sources.map(classifySourceWithOrigin),
  );
  const axes = computeAxes({
    sources: i.supporting_sources,
    corroborationCount,
    contradictions: contras,
    identityEvidenceStrength: i.identity_evidence_strength,
    relationshipEvidenceStrength: i.relationship_evidence_strength,
  });
  // #477: the confidence above is derived with full server authority, but the
  // model's `label` was persisted beside it with none and echoed back as
  // `applied_label` as though the server had ratified it. Measured in
  // production: of the 13 times record_finding has run, TEN persisted
  // label:"CONFIRMED" on a server score between 15 and 78 — every one below
  // the >=80 bar. Free text reached the same field too ("Mozzy Records"),
  // because the model read "label" in its ordinary English sense.
  //
  // Authority is REUSED, never re-invented: resolveRecordingStatus wraps
  // deriveStatus + coerceCoherentStatus and is already the status resolver on
  // every other recording path (tool-registry :4662/:5021, tools/recording
  // :78/:319). record_finding was the one that skipped it.
  //
  // `requested` is deliberately left null by passing no `status` key — the
  // model may not ask for a status. Contradictions ARE passed, because they
  // can only make the verdict more conservative.
  // The cap MUST be derived from the source ARRAY, never from a joined
  // string. `applyRecordingSourcePolicy` takes a singular top-level source
  // and wraps it via `singularSurfaceSources` as ONE label, and
  // `classifySource` then classifies that whole label as a single token.
  // Because BREACH_SLUG_RE matches a breach slug anywhere in the string
  // (its boundary class includes ","), "breach_check,gemini_deep_dork,
  // court_record_search" resolved wholly to `breach`: 3 classes -> 1,
  // independent 2 -> 1, cap 95 -> 60. The collapse is not breach-specific —
  // "court_record_search,gemini_deep_dork" collapsed to [court_record],
  // silently dropping ai_summary.
  //
  // That matters because `reason_not_confirmed` is DERIVED from the
  // collapsed count and persisted as server authority: it wrote "needs
  // second independent class of evidence" onto rows already carrying 2-5
  // independent classes — a false authoritative statement in the very field
  // added to stop false authoritative statements.
  //
  // Fixed by passing the LIST through the channel policy's `sources`
  // surface, NOT by reaching past it for the array-form cap entry.
  // `recording_source_policy_runtime_test.ts` ("production edge modules
  // cannot bypass the recording source policy") allows low-level cap symbols
  // only in confidence.ts and recording-source-policy.ts, so calling
  // applyEvidenceCaps* from here fails that invariant — correctly: the cap
  // engine stays the single implementation of evidence policy. The surface
  // here is genuinely a list, which is exactly what `sources` is for. This
  // matches the line above that already classifies correctly via
  // `supporting_sources.map(classifySourceWithOrigin)`.
  const findingCap = applyRecordingSourcePolicy({
    rawConfidence: axes.case,
    sources: i.supporting_sources,
    kind: "finding",
    metadata: null,
  }).effective;
  // Status derives from SERVER-DETECTED contradictions only. Passing the
  // model's array through `??` opened authority in both directions, because
  // deriveStatus tests only `Array.isArray(x) && x.length > 0`:
  //   - suppression: the model sends `[]`, the server's own `contras` are
  //     discarded, and a row the server would call `contradicted` persists
  //     as `observed`;
  //   - fabrication: the model sends ["None — all sources agree ..."], length
  //     is 1, and the row persists as `contradicted` on text that asserts
  //     the opposite. Three live rows carry prose of exactly that form.
  // So the earlier claim that contradictions "can only make the verdict more
  // conservative" does not hold in either direction.
  // Only EXPLICIT conflicts carry status authority. detectContradictions also
  // returns advisory single-artifact heuristics (thin_name,
  // common_handle_collision, over_broad_username, cdn_shared_infra,
  // stale_breach) which omit `field` by design, and deriveStatus tests only
  // `length > 0` — so mapping the whole set in marked a finding
  // `contradicted` on a RISK signal rather than a conflict. `thin_name`
  // alone fires on any single-token name in the thread, so one such
  // artifact would have contradicted every finding in it. That is the same
  // false-authority shape as #477, a third field over.
  //
  // The advisory signals keep their ordinary confidence penalty: `contras`
  // is passed WHOLE to computeAxes above, and that is deliberately
  // unchanged. Penalty yes, verdict no.
  const explicitContras = contras.filter(isExplicitContradiction);
  const serverContradictions = explicitContras.map((c) => `${c.kind}: ${c.detail}`);
  const advisorySignals = contras
    .filter((c) => !isExplicitContradiction(c))
    .map((c) => `${c.kind}: ${c.detail}`);
  const { status: findingStatus, reasonNotConfirmed: findingReason } =
    resolveRecordingStatus(findingCap, { contradictions: serverContradictions });
  const row = {
    thread_id: threadId,
    user_id: userId,
    kind: "finding",
    value: i.conclusion.slice(0, 500),
    confidence: axes.case,
    source: i.supporting_sources.join(","),
    metadata: {
      // Server authority. Note the key is `status`, not `label`:
      // useThreadArtifacts.ts:63 reads metadata.label as the META-KIND marker
      // (triage_decision / cluster_decision) to exclude rows from every
      // artifact count, so findings must not compete for that key.
      status: findingStatus,
      reason_not_confirmed: findingReason,
      // The model's own pick, kept for disclosure and never read as authority.
      model_label: i.label,
      cluster_label: i.cluster_label,
      drivers: i.drivers,
      reducers: i.reducers ?? [],
      // Server-detected, and the exact list the status above was derived
      // from. The model's own array is preserved beside it as disclosure
      // (same pattern as model_label) and is never read as authority.
      contradictions: serverContradictions,
      // Recorded, never authoritative — disclosure, not deletion. Keeping
      // these out of `contradictions` honors the documented contract on
      // ContradictionFinding.field: only explicit conflicts are eligible to
      // be structured there.
      advisory_signals: advisorySignals,
      model_contradictions: i.contradictions ?? null,
      unresolved: i.unresolved ?? [],
      next_pivots: i.next_pivots ?? [],
      supporting_sources: i.supporting_sources,
      supporting_artifact_values: i.supporting_artifact_values ?? [],
      confidence_axes: axes,
      // M4 disclosure: the status above is derived from a CAPPED result,
      // but the row persists `confidence: axes.case` uncapped, so without
      // these two fields a stored status cannot be reconciled with the
      // derivation that produced it. Production carries
      // confidence_cap_applied on 8,301 rows and on ZERO finding rows,
      // which is why findings sat outside #481's display invariant. The
      // persisted `confidence` is deliberately NOT changed here.
      // Key is `source_category`, matching all five other recording
      // writers (:4690, :5038, auto-record-integrity.ts:65,
      // tools/recording.ts:84/:325). `source_classes` would be dead data:
      // every consumer — intel.ts:334, evidence-status.ts:140,
      // report-badges.ts:62, audit/from-artifacts.ts:35, AnalysisTab.tsx:134
      // — keys on `source_category`. Writing it also fixes the SAME collapse
      // on the read side: absent this key, artifactSourceClasses falls back
      // to splitting the joined `source` string and finding rows resolve to
      // ONE class on the frontend too.
      confidence_cap_applied: findingCap.cap,
      source_category: findingCap.source_classes,
      source_reliability: sourceConfidence(i.supporting_sources),
    },
  };
  return { row, axes, status: findingStatus };
}
