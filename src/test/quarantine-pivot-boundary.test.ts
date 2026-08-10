import { describe, it, expect } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { computePivots } from "@/lib/pivot-engine";
import { buildReportMarkdown } from "@/lib/intel";
import type { RecommendedPivot } from "@/lib/recommended-pivots";

/**
 * The PIVOT authority boundary for `subject_unlinked`.
 *
 * BACKGROUND — why this file exists
 * ---------------------------------
 * The backend quarantines every row harvested from a name-only query: #433 made
 * the WRITE path honest (including the echo of the queried name, unless that
 * name is durably linked to the subject), and #434 bound the flag across the
 * edge function — `graph.ts` refuses to build a node from a quarantined row,
 * `recovery.ts` marks it excluded, and the collision detector skips it when
 * counting corroboration.
 *
 * All of that stopped at the network boundary. On `3cac170` the flag was read in
 * exactly one frontend place — the report's collision section (`intel.ts`, #431)
 * — so it DESCRIBED a collision while the pivot engine went on offering the
 * disputed selectors as ordinary "Run this pivot" cards. `subject_unlinked` was
 * a label, not an authority: an analyst could one-click a quarantined selector
 * and steer the whole next run onto a same-name stranger.
 *
 * THE CONTRACT these tests pin — identical to the backend module's:
 *   authority, not evidence. A quarantined row stays persisted, visible and
 *   auditable on the report. It may not become an actionable pivot from ANY
 *   frontend surface. Both surfaces (the chat "Next steps" rail and the Pivots
 *   tab) call `computePivots`, so binding it there covers both by construction.
 *
 * NOT over-blocking: a selector is inert only while EVERY artifact carrying it
 * is quarantined. One piece of independent, subject-linked evidence for the same
 * value restores it — the quarantine is a statement about provenance, and
 * provenance is per-row.
 */

let seq = 0;
function art(partial: Partial<Artifact> & { kind: string; value: string }): Artifact {
  seq += 1;
  return {
    id: partial.id ?? `q${seq}`,
    kind: partial.kind,
    value: partial.value,
    confidence: partial.confidence ?? 65,
    source: partial.source ?? "tool",
    created_at: partial.created_at ?? `2026-02-01T00:00:${String(seq).padStart(2, "0")}Z`,
    metadata: partial.metadata ?? {},
  };
}

/** The backend's exact quarantine stamp (auto-persist-findings.ts SUBJECT_UNLINKED_CTX). */
const QUARANTINED = {
  subject_unlinked: true,
  subject_unlinked_reason:
    "harvested from a name-only query — same-name collision axis; linkage to the subject is unproven",
};

/** The root-echo variant #433 added (UNLINKED_ECHO_CTX). */
const QUARANTINED_ECHO = {
  subject_unlinked: true,
  subject_unlinked_reason:
    "echo of a name-only query whose queried name is not itself linked to the subject — " +
    "same-name collision axis; the matching name does not prove this record is the subject's",
};

function reportPivot(over: Partial<RecommendedPivot> & { value: string; type: RecommendedPivot["type"] }): RecommendedPivot {
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
  computePivots({ artifacts, seedValue: "subject@example.com", reportPivots, skipSet: NONE });

describe("computePivots — a quarantined selector is never actionable", () => {
  it("drops an artifact-derived pivot whose source row is subject_unlinked", () => {
    // The leoseyes86 shape: a phone harvested from a name-only sweep. It is a
    // stranger's number under the failure case, and pivoting on it is what moved
    // the whole investigation onto a different person.
    const artifacts = [
      art({ kind: "phone", value: "+1 555 0100", metadata: QUARANTINED }),
      art({ kind: "email", value: "linked@example.com" }),
    ];
    const out = run(artifacts);
    expect(out.find((p) => p.value === "+1 555 0100")).toBeUndefined();
    // The un-quarantined lead is untouched — this filter is narrow.
    expect(out.find((p) => p.value === "linked@example.com")).toBeDefined();
  });

  it("drops the quarantined name ROOT, not merely its descendants", () => {
    // #433's UNLINKED_ECHO_CTX case. The trunk is the collision axis; if only the
    // children were filtered the run would still pivot onto the wrong person.
    const artifacts = [art({ kind: "name", value: "Jordan Vale", metadata: QUARANTINED_ECHO })];
    expect(run(artifacts).find((p) => p.value === "Jordan Vale")).toBeUndefined();
  });

  it("drops a REPORT-recommended pivot naming a quarantined selector", () => {
    // Report-origin candidates skip the metadata guard block entirely, so the
    // model writing a quarantined selector into "Recommended pivots" was a second,
    // independent way for it to become a one-click action.
    const artifacts = [art({ kind: "username", value: "vale_jordan", metadata: QUARANTINED })];
    const out = run(artifacts, [reportPivot({ value: "vale_jordan", type: "username" })]);
    expect(out.find((p) => p.value === "vale_jordan")).toBeUndefined();
  });

  it("blocks every frontend pivot surface at once (one shared engine, no leaks)", () => {
    // Both the chat rail (ChatWindow) and the Pivots tab call computePivots, so a
    // value quarantined here cannot reappear through the other surface. Assert on
    // the engine's whole output rather than a single card.
    const artifacts = [
      art({ kind: "phone", value: "+1 555 0199", metadata: QUARANTINED }),
      art({ kind: "email", value: "collision@example.com", metadata: QUARANTINED }),
    ];
    const out = run(artifacts, [
      reportPivot({ value: "+1 555 0199", type: "phone" }),
      reportPivot({ value: "collision@example.com", type: "email" }),
    ]);
    expect(out).toHaveLength(0);
  });
});

describe("computePivots — the quarantine does not over-block", () => {
  it("keeps a selector that ALSO has independent, subject-linked evidence", () => {
    // Same value, two rows: one from the name sweep (quarantined), one from a
    // selector-matched provider (linked). Provenance is per-row, so the linked
    // observation restores the selector's authority.
    const artifacts = [
      art({ kind: "email", value: "shared@example.com", metadata: QUARANTINED }),
      art({ kind: "email", value: "shared@example.com", source: "breach_check" }),
    ];
    expect(run(artifacts).find((p) => p.value === "shared@example.com")).toBeDefined();
  });

  it("leaves ordinary subject-linked pivots completely unchanged", () => {
    const artifacts = [
      art({ kind: "email", value: "lead@example.com" }),
      art({ kind: "username", value: "leadhandle" }),
      art({ kind: "phone", value: "+1 555 0123" }),
    ];
    const before = computePivots({
      artifacts, seedValue: "subject@example.com", reportPivots: [], skipSet: NONE,
    });
    expect(before.map((p) => p.value).sort()).toEqual(
      ["+1 555 0123", "lead@example.com", "leadhandle"],
    );
  });

  it("is strictly `=== true` — a legacy row keeps its authority", () => {
    // Mirrors lib/quarantine.ts on the edge: a string "true", a truthy number, or
    // absent metadata predate the gate and must not be silently disenfranchised.
    const artifacts = [
      art({ kind: "email", value: "stringflag@example.com", metadata: { subject_unlinked: "true" } }),
      art({ kind: "email", value: "numflag@example.com", metadata: { subject_unlinked: 1 } }),
      art({ kind: "email", value: "nometa@example.com", metadata: null }),
    ];
    const out = run(artifacts);
    expect(out.map((p) => p.value).sort()).toEqual(
      ["nometa@example.com", "numflag@example.com", "stringflag@example.com"],
    );
  });
});

describe("quarantined evidence stays visible — inert, not deleted", () => {
  it("still renders in the report's collision section with the backend's reason", () => {
    // The whole point of the contract: the analyst must be able to SEE the
    // disputed row and why it was disputed. Making it non-actionable must not
    // make it invisible.
    const quarantined = art({ kind: "phone", value: "+1 555 0100", metadata: QUARANTINED });
    const md = buildReportMarkdown({
      seedValue: "subject@example.com",
      seedType: "email",
      artifacts: [quarantined, art({ kind: "email", value: "linked@example.com" })],
    });
    expect(md).toContain("+1 555 0100");
    expect(md).toContain("same-name collision axis");
    // ...and it is simultaneously absent from the actionable pivot list.
    expect(run([quarantined]).find((p) => p.value === "+1 555 0100")).toBeUndefined();
  });
});
