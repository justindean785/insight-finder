import { describe, it, expect } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { computePivots } from "@/lib/pivot-engine";
import { isClusterIneligible, isCollisionArtifact } from "@/lib/report-hygiene";
import { isQuarantined } from "@/lib/quarantine";
import type { RecommendedPivot } from "@/lib/recommended-pivots";

/**
 * The PIVOT authority boundary for the COLLISION family.
 *
 * BACKGROUND — the third leak on a seam that has been closed twice
 * ---------------------------------------------------------------
 * `subject_unlinked` has had its write boundary closed (#433), its pivot
 * boundary closed (#436) and its promote boundary closed (#448). Those all bind
 * on `isQuarantined` — `subject_unlinked === true && linkage_confirmed !== true`.
 *
 * The COLLISION family is a different set of signals with the same meaning:
 * `kind === "excluded_collision"`, `metadata.status === "excluded"`,
 * `excluded_collision`, `collision`, `possible_collision`. `isCollisionArtifact`
 * owns them, and `isClusterIneligible` — the predicate applied at all five
 * `buildIdentityClusters` call sites, in the graph, in the report and in the
 * confidence dimensions — is `isCollisionArtifact(a) || isQuarantined(a.metadata)`.
 *
 * The pivot gate never got the second half. `quarantineSets` classifies with
 * `isQuarantined` alone, so a `possible_collision` row is excluded from the
 * clusters, the graph, the report and every confidence axis — and is still
 * offered as a one-click pivot.
 *
 * Measured on the harness case (42 artifacts, 2026-08-31):
 *
 *     a12b  j.harker@harker-legal.example
 *       isCollisionArtifact  true      isClusterIneligible  true
 *       evidenceStatus       "verified"
 *       adjustedConfidence   93            <- the HIGHEST number in the case
 *       computePivots        #1, HIGH, score 1412
 *
 * A row the engine has already decided is a different person was the top
 * recommended action and the strongest-looking number on the board. That is an
 * accuracy defect and a paid-call defect at the same time: pivoting on it steers
 * the next run, and every tool it seeds is billed.
 *
 * THE CONTRACT these tests pin
 * ----------------------------
 *   Pivot eligibility is `isClusterIneligible` — the SAME predicate the other
 *   authority surfaces use. Not a copy of it, not a third parallel predicate.
 *   A cluster-ineligible artifact may not rank as a recommended pivot, may not
 *   hold HIGH or MEDIUM priority, and may not seed a paid tool call.
 *
 *   Authority, not evidence. The row stays persisted, stays on the Evidence
 *   board, keeps its reason, and stays exportable. Only its authority to drive
 *   work is withheld.
 *
 *   NOT over-blocking. `quarantineSets` is deliberately per-row and type-aware:
 *   a selector is inert only while EVERY row carrying it is ineligible. One
 *   independent, subject-linked observation of the same value restores it.
 */

let seq = 0;
function art(partial: Partial<Artifact> & { kind: string; value: string }): Artifact {
  seq += 1;
  return {
    id: partial.id ?? `c${seq}`,
    kind: partial.kind,
    value: partial.value,
    confidence: partial.confidence ?? 65,
    source: partial.source ?? "tool",
    created_at: partial.created_at ?? `2026-03-01T00:00:${String(seq).padStart(2, "0")}Z`,
    metadata: partial.metadata ?? {},
  };
}

/** The a12b shape: a second person who matches the queried name and nothing else. */
const POSSIBLE_COLLISION = {
  possible_collision: true,
  reason_not_confirmed:
    "a second James Harker — attorney, Sacramento — matches the queried name but nothing else in the case",
};

/** The pipeline's definitive "not the subject" stamp. */
const STATUS_EXCLUDED = { status: "excluded" };

/** The quarantine stamp, for the cross-family test. */
const QUARANTINED = {
  subject_unlinked: true,
  subject_unlinked_reason:
    "harvested from a name-only query — same-name collision axis; linkage to the subject is unproven",
};

function reportPivot(
  over: Partial<RecommendedPivot> & { value: string; type: RecommendedPivot["type"] },
): RecommendedPivot {
  return {
    label: over.label ?? `Investigate ${over.value}`,
    actionLabel: over.actionLabel ?? "Review lead",
    detail: over.detail ?? over.value,
    reason: over.reason ?? "analyst recommendation",
    priority: over.priority ?? "medium",
    prompt: over.prompt ?? `Run pivot on ${over.value}`,
    value: over.value,
    type: over.type,
  };
}

const NONE = new Set<string>();
const run = (artifacts: Artifact[], reportPivots: RecommendedPivot[] = []) =>
  computePivots({
    artifacts,
    seedValue: "j.harker@northgate-logistics.com",
    reportPivots,
    skipSet: NONE,
  });

// ---------------------------------------------------------------------------
// (1) The different-person case
// ---------------------------------------------------------------------------
describe("computePivots — a collision row is never an actionable pivot", () => {
  it("drops the possible_collision namesake that currently ranks #1 HIGH", () => {
    const artifacts = [
      art({
        kind: "email",
        value: "j.harker@harker-legal.example",
        confidence: 88,
        source: "hunter_verify",
        metadata: { ...POSSIBLE_COLLISION, sources: ["hunter_verify", "exa_search"] },
      }),
      art({ kind: "username", value: "harker.logistics", confidence: 81, source: "socialfetch" }),
    ];
    const out = run(artifacts);

    expect(out.find((p) => p.value === "j.harker@harker-legal.example")).toBeUndefined();
    // The eligible neighbour is untouched — the gate is narrow, not a blanket.
    expect(out.find((p) => p.value === "harker.logistics")).toBeDefined();
  });

  it("drops it through the REPORT-recommended route as well", () => {
    // Report-origin candidates enter computePivots by a different path than
    // artifact-derived ones. Closing only the artifact path leaves the model
    // able to re-offer the same selector by writing it into "Recommended pivots".
    const artifacts = [
      art({ kind: "email", value: "j.harker@harker-legal.example", metadata: POSSIBLE_COLLISION }),
    ];
    const out = run(artifacts, [
      reportPivot({ value: "j.harker@harker-legal.example", type: "email" }),
    ]);
    expect(out).toHaveLength(0);
  });

  it("never gives a collision row HIGH or MEDIUM priority — it gives it no card at all", () => {
    const artifacts = [
      art({ kind: "email", value: "namesake@example.com", confidence: 95, metadata: POSSIBLE_COLLISION }),
      art({ kind: "phone", value: "+1 415 555 0142", confidence: 40, metadata: STATUS_EXCLUDED }),
      art({ kind: "domain", value: "excluded.example", confidence: 90, metadata: { excluded_collision: true } }),
      art({ kind: "username", value: "flagged_collision", confidence: 88, metadata: { collision: true } }),
    ];
    const out = run(artifacts);
    expect(out).toHaveLength(0);
    expect(out.filter((p) => p.priority === "high" || p.priority === "medium")).toHaveLength(0);
  });

  it("drops a row whose KIND is excluded_collision, not only its metadata", () => {
    // isCollisionArtifact reads `kind` as well as `metadata`, so the gate must be
    // handed the whole row, never just `metadata`.
    const artifacts = [art({ kind: "excluded_collision", value: "wrong.person@example.com" })];
    expect(run(artifacts)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (2) The explicitly excluded residents
// ---------------------------------------------------------------------------
describe("computePivots — explicitly excluded residents are not leads", () => {
  // The Sample Ave shape. A reverse-address lookup returned the address's
  // co-residents; the case then recorded that the subject is not among them:
  //
  //   "CONTRADICTION: 1110 Sample Ave is NOT linked to James Harker. The
  //    reverse-address lookup returned 31 records and the actual residents are
  //    the Keith and Plascencia families — Harker appears in none of them."
  //
  // Today all four rank MEDIUM and each would spend a paid call on a person the
  // case has already ruled out.
  //
  // The exclusion must be carried STRUCTURALLY. Intent is never inferred from
  // prose in this project — a future-intent regex was implemented and removed
  // because it matched a legitimate closing line and fabricated a report. So
  // these tests bind on `status: "excluded"`, the pipeline's own stamp, and the
  // gap in the WRITER (co-residents are not stamped today) is tracked separately
  // as backend work; the frontend must honour the stamp the moment it exists.
  const RESIDENTS = [
    "m.keith@mail.example",
    "a.keith@mail.example",
    "r.plascencia@mail.example",
    "t.plascencia@mail.example",
  ];

  it("offers no pivot for any of the four excluded resident selectors", () => {
    const artifacts = RESIDENTS.map((value) =>
      art({
        kind: "email",
        value,
        confidence: 50,
        source: "indicia_address",
        metadata: {
          ...STATUS_EXCLUDED,
          source_class: "data_broker",
          reason_not_confirmed:
            "co-resident of 1110 Sample Ave; the case records that the subject is not among the residents",
        },
      }),
    );
    const out = run(artifacts);
    for (const value of RESIDENTS) {
      expect(out.find((p) => p.value === value), `${value} must not be a pivot`).toBeUndefined();
    }
    expect(out).toHaveLength(0);
  });

  it("keeps them out even when the model recommends them in the report", () => {
    const artifacts = RESIDENTS.map((value) =>
      art({ kind: "email", value, source: "indicia_address", metadata: STATUS_EXCLUDED }),
    );
    const out = run(
      artifacts,
      RESIDENTS.map((value) => reportPivot({ value, type: "email", priority: "medium" })),
    );
    expect(out).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (3) The over-suppression guard
// ---------------------------------------------------------------------------
describe("computePivots — eligible selectors stay pivotable", () => {
  it("keeps an ordinary corroborated selector", () => {
    const artifacts = [
      art({
        kind: "phone",
        value: "+1 415 555 0142",
        confidence: 55,
        source: "indicia_footprint",
        metadata: { sources: ["indicia_footprint"], source_class: "data_broker" },
      }),
    ];
    const out = run(artifacts);
    expect(out.find((p) => p.value === "+1 415 555 0142")).toBeDefined();
  });

  it("keeps a selector RELEASED by an explicit analyst linkage decision", () => {
    // #448's escape hatch. `linkage_confirmed` clears quarantine, and the
    // collision gate must not silently re-block what the analyst adjudicated.
    const artifacts = [
      art({
        kind: "username",
        value: "harker.logistics",
        confidence: 81,
        metadata: { ...QUARANTINED, linkage_confirmed: true },
      }),
    ];
    expect(run(artifacts).find((p) => p.value === "harker.logistics")).toBeDefined();
  });

  it("does not block a value that ALSO has an independent, eligible observation", () => {
    // Per-row provenance, not per-string blocking. The same phone arrived twice:
    // once on the collision axis and once from a provider that matched on the
    // subject's own email. Blocking the string would discard the good row.
    const artifacts = [
      art({ kind: "phone", value: "+1 415 555 0177", metadata: POSSIBLE_COLLISION }),
      art({ kind: "phone", value: "+1 415 555 0177", source: "hunter_verify", metadata: {} }),
    ];
    expect(run(artifacts).find((p) => p.value === "+1 415 555 0177")).toBeDefined();
  });

  it("does not let a NAME row restore authority to a same-normalizing username", () => {
    // normalizeTarget collapses non-alphanumerics, so username "jordan.vale" and
    // name "Jordan Vale" both become "jordan vale". The keyspace is type-aware
    // precisely so an ordinary name cannot un-block a quarantined handle.
    const artifacts = [
      art({ kind: "username", value: "jordan.vale", metadata: POSSIBLE_COLLISION }),
      art({ kind: "name", value: "Jordan Vale", metadata: {} }),
    ];
    expect(run(artifacts).find((p) => p.value === "jordan.vale")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (4) Quarantine stays visible as evidence
// ---------------------------------------------------------------------------
describe("the collision gate is authority, not deletion", () => {
  it("a quarantined row is still an artifact — the gate withholds pivots, not existence", () => {
    const quarantined = art({ kind: "email", value: "stranger@example.com", metadata: QUARANTINED });
    const collision = art({ kind: "email", value: "namesake@example.com", metadata: POSSIBLE_COLLISION });

    // Both are cluster-ineligible …
    expect(isClusterIneligible(quarantined)).toBe(true);
    expect(isClusterIneligible(collision)).toBe(true);
    // … by two DIFFERENT halves of the predicate, which is the whole point:
    // the pivot gate has to consult both, not just the quarantine half.
    expect(isQuarantined(quarantined.metadata)).toBe(true);
    expect(isCollisionArtifact(quarantined)).toBe(false);
    expect(isQuarantined(collision.metadata)).toBe(false);
    expect(isCollisionArtifact(collision)).toBe(true);

    // … and neither yields a pivot, while both remain ordinary artifact rows.
    expect(run([quarantined, collision])).toHaveLength(0);
    expect(quarantined.value).toBe("stranger@example.com");
    expect(collision.metadata?.reason_not_confirmed).toBeTruthy();
  });

  it("pivot eligibility is exactly isClusterIneligible — no third predicate", () => {
    // A guard against the failure mode this seam keeps producing: someone adds a
    // fourth signal to isCollisionArtifact and the pivot gate silently does not
    // learn about it. Drive the engine with every signal the shared predicate
    // recognises and assert the engine agrees with it, row by row.
    const rows: Array<[string, Artifact]> = [
      ["possible_collision", art({ kind: "email", value: "a@example.com", metadata: { possible_collision: true } })],
      ["collision", art({ kind: "email", value: "b@example.com", metadata: { collision: true } })],
      ["excluded_collision", art({ kind: "email", value: "c@example.com", metadata: { excluded_collision: true } })],
      ["status:excluded", art({ kind: "email", value: "d@example.com", metadata: { status: "excluded" } })],
      ["kind:excluded_collision", art({ kind: "excluded_collision", value: "e@example.com" })],
      ["subject_unlinked", art({ kind: "email", value: "f@example.com", metadata: QUARANTINED })],
      ["eligible", art({ kind: "email", value: "g@example.com", metadata: {} })],
    ];

    for (const [label, row] of rows) {
      const offered = run([row]).some((p) => p.value === row.value);
      expect(offered, `${label}: pivot offered must be the inverse of isClusterIneligible`)
        .toBe(!isClusterIneligible(row));
    }
  });
});
