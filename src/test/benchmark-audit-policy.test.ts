// Tests for the post-deploy benchmark audit policy.
//
// These drive the shipped functions with production-shaped rows. The central
// case is the one the hand-run audit got wrong on 2026-08-17: Indicia showed 14
// failures all aborting at 18.0-18.3s — the exact signature of the timeout #469
// had just raised to 30s — which reads as a live regression. Every one predated
// the deploy and no indicia call had happened since. The policy must return
// "unexercised", and must never let that be rounded up to "fixed".
import { describe, it, expect } from "vitest";
import { META_ARTIFACT_KINDS } from "@/hooks/useThreadArtifacts";
import {
  META_KINDS,
  exerciseStatus,
  classifyFailure,
  reconcileArtifacts,
  isQueuedPlaceholder,
  auditDisclosure,
  authorityDistribution,
  summarizeLedger,
  reportAcrossDeploy,
  countErrorSignatures,
  REAL_CONFIDENCE_CEILING,
  type ArtifactRow,
  type ToolCallRow,
} from "../../scripts/benchmark-audit-policy";

const art = (over: Partial<ArtifactRow> = {}): ArtifactRow => ({
  kind: "email",
  value: "a@b.c",
  confidence: 50,
  source: "some_tool",
  metadata: {},
  ...over,
});

const call = (over: Partial<ToolCallRow> = {}): ToolCallRow => ({
  tool_name: "indicia_person",
  outcome: "failed",
  duration_ms: 18_100,
  error_msg: "indicia person timed out",
  created_at: "2026-08-16T04:18:23Z",
  ...over,
});

const DEPLOY = "2026-08-17T07:25:31Z";

describe("the meta-kind list cannot drift from the frontend filter", () => {
  it("matches META_ARTIFACT_KINDS exactly", () => {
    // Two sources of truth that must agree. The hook imports the supabase
    // client so a node script cannot import it; this test is the seam.
    expect([...META_KINDS].sort()).toEqual([...META_ARTIFACT_KINDS].sort());
  });
});

describe("exerciseStatus refuses to read silence as success", () => {
  it("THE INDICIA CASE: aborts that all predate the deploy do not grade the fix", () => {
    const calls = Array.from({ length: 14 }, (_, i) =>
      call({ created_at: `2026-08-1${i < 7 ? 5 : 6}T04:18:${10 + i}Z` }),
    );
    const report = reportAcrossDeploy(calls, {
      deployedAt: DEPLOY,
      ourCapMs: 18_000, // the OLD cap those calls died at
      totalEventsAfter: 82, // there WAS traffic, just no indicia
    });

    expect(report.before).toHaveLength(14);
    expect(report.after).toHaveLength(0);
    // Every pre-deploy failure is correctly attributed to our own abort...
    expect(report.causesBefore.our_timeout).toBe(14);
    // ...and yet the fix is NOT graded, because nothing ran it.
    expect(report.verdict.status).toBe("unexercised");
    expect(report.verdict.provesFix).toBe(false);
  });

  it("a path that actually ran is exercised and can prove the fix", () => {
    const v = exerciseStatus({ deployedAt: DEPLOY, totalEventsAfter: 82, relevantEventsAfter: 3 });
    expect(v.status).toBe("exercised");
    expect(v.provesFix).toBe(true);
  });

  it("no traffic at all is unexercised, not passing", () => {
    const v = exerciseStatus({ deployedAt: DEPLOY, totalEventsAfter: 0, relevantEventsAfter: 0 });
    expect(v.status).toBe("unexercised");
    expect(v.provesFix).toBe(false);
    expect(v.reason).toMatch(/silence, not evidence/);
  });

  it("a rare path unseen in a small sample is inconclusive, not unexercised", () => {
    // classifySource errors fired twice in ~1300 calls. 82 calls of traffic
    // predicts 0.13 occurrences, so absence proves nothing either way.
    const v = exerciseStatus({
      deployedAt: DEPLOY,
      totalEventsAfter: 82,
      relevantEventsAfter: 0,
      priorRatePerEvent: 2 / 1300,
    });
    expect(v.status).toBe("inconclusive");
    expect(v.provesFix).toBe(false);
  });

  it("a common path that never fired despite traffic IS unexercised", () => {
    const v = exerciseStatus({
      deployedAt: DEPLOY,
      totalEventsAfter: 82,
      relevantEventsAfter: 0,
      priorRatePerEvent: 0.5, // would predict ~41 occurrences
    });
    expect(v.status).toBe("unexercised");
  });
});

describe("classifyFailure separates our abort from the provider's", () => {
  it("a death at our own budget is our_timeout", () => {
    expect(classifyFailure({ errorMsg: "indicia person timed out", durationMs: 18_100, ourCapMs: 18_000 }))
      .toBe("our_timeout");
  });

  it("the same message well inside our budget is the provider's", () => {
    // With the cap raised to 30s, an 18s death is no longer self-inflicted.
    expect(classifyFailure({ errorMsg: "indicia person timed out", durationMs: 18_100, ourCapMs: 30_000 }))
      .toBe("provider_timeout");
  });

  it("distinguishes mutex skips, internal caps and finalize skips from failures", () => {
    expect(classifyFailure({ errorMsg: "provider 'indicia' already has a call in flight" }))
      .toBe("serialization_mutex_skip");
    expect(classifyFailure({ errorMsg: "internal paid-call cap reached (12 this run)" }))
      .toBe("internal_cap");
    expect(classifyFailure({ errorMsg: "finalize window open; live lookup skipped" }))
      .toBe("finalize_window_skip");
    expect(classifyFailure({ errorMsg: "429 too many requests", statusCode: 429 })).toBe("quota");
  });

  it("a clean call has no cause", () => {
    expect(classifyFailure({ errorMsg: "", durationMs: 5_232 })).toBe("none");
  });
});

describe("G1 — real court language survives, tool placeholders do not", () => {
  const tools = ["dork_harvest", "indicia_person", "jina_reader_scrape"];

  it("keeps a docket string containing (pending appeal)", () => {
    expect(isQueuedPlaceholder("Docket 2021_cv_01188 (pending appeal) — Anne Arundel", tools)).toBe(false);
    expect(isQueuedPlaceholder("Asylum application (pending decision) ref uscis_2024_88231", tools)).toBe(false);
  });

  it("discards a placeholder that names a real tool", () => {
    expect(isQueuedPlaceholder("dork_harvest (queued)", tools)).toBe(true);
  });

  it("FAILS CLOSED with no tool vocabulary — no vocabulary, no discard", () => {
    expect(isQueuedPlaceholder("dork_harvest (queued)", [])).toBe(false);
  });
});

describe("reconcileArtifacts walks persisted count down to real observations", () => {
  it("subtracts bookkeeping, duplicates and interchangeable nulls only", () => {
    const rows: ArtifactRow[] = [
      art({ kind: "email", value: "a@b.c" }),
      art({ kind: "email", value: "A@B.C" }), // exact duplicate (case-folded)
      art({ kind: "name", value: "Jordan Vale" }),
      art({ kind: "cluster_decision", value: "Deterministic clustering: 111 subjects, 7 merges", confidence: 100 }),
      art({ kind: "triage_decision", value: "triage" }),
      // two BARE nulls from the same tool — interchangeable, collapse one
      art({ kind: "breach_exposure", value: "no records", source: "leakcheck" }),
      art({ kind: "breach_exposure", value: "not found", source: "leakcheck" }),
      // a null carrying real substance — distinct, must NOT collapse
      art({ kind: "breach_exposure", value: "no records for 1988 DOB variant", source: "leakcheck" }),
    ];
    const r = reconcileArtifacts(rows, ["dork_harvest"]);

    expect(r.total).toBe(8);
    expect(r.metaBookkeeping).toBe(2);
    expect(r.exactDuplicates).toBe(1);
    expect(r.duplicateEquivalentNulls).toBe(1);
    expect(r.distinctSubstantive).toBe(4);
    expect(r.pctReal).toBe(50);
  });

  it("an empty set reports 0% rather than dividing by zero", () => {
    expect(reconcileArtifacts([]).pctReal).toBe(0);
  });
});

describe("G2 — hygiene must disclose, not silently mutate", () => {
  it("flags a stripped row that did not retain the original", () => {
    const rows = [
      art({
        value: "BREAKING: POLICE SUSPECT IN CUSTODY",
        metadata: { status_assertion_stripped: true }, // no value_before_hygiene
      }),
    ];
    const a = auditDisclosure(rows);
    expect(a.strippedRows).toHaveLength(1);
    expect(a.invariantViolations).toHaveLength(1);
  });

  it("accepts a stripped row that retained the original", () => {
    const rows = [
      art({
        value: "BREAKING: POLICE SUSPECT IN CUSTODY",
        metadata: {
          status_assertion_stripped: true,
          value_before_hygiene: "BREAKING: POLICE CONFIRMED SUSPECT IN CUSTODY",
        },
      }),
    ];
    const a = auditDisclosure(rows);
    expect(a.invariantViolations).toHaveLength(0);
    expect(a.strippedRows[0].before).toContain("CONFIRMED");
  });
});

describe("authorityDistribution surfaces anything above the real ceiling", () => {
  it("flags a confidence-100 row as impossible for a genuine observation", () => {
    const rows = [
      art({ confidence: 60 }),
      art({ kind: "cluster_decision", confidence: 100 }),
      art({ confidence: null }),
    ];
    const d = authorityDistribution(rows);
    expect(REAL_CONFIDENCE_CEILING).toBe(75);
    expect(d.aboveRealCeiling).toHaveLength(1);
    expect(d.aboveRealCeiling[0].kind).toBe("cluster_decision");
    expect(d.confidence["(null)"]).toBe(1);
  });

  it("counts quarantined rows without deleting them", () => {
    const rows = [
      art({ metadata: { subject_unlinked: true, subject_unlinked_reason: "name-only echo" } }),
      art({ kind: "excluded_collision" }),
      art(),
    ];
    const d = authorityDistribution(rows);
    expect(d.quarantined).toBe(1);
    expect(d.collisions).toBe(1);
  });
});

describe("ledger summary and error signatures", () => {
  it("computes an ok rate over outcomes", () => {
    const s = summarizeLedger([
      call({ outcome: "ok" }),
      call({ outcome: "ok" }),
      call({ outcome: "failed" }),
      call({ outcome: "empty" }),
    ]);
    expect(s.total).toBe(4);
    expect(s.byOutcome.ok).toBe(2);
    expect(s.okRate).toBe(50);
  });

  it("counts the two known error signatures", () => {
    const c = countErrorSignatures([
      call({ error_msg: "toolOrSource.toLowerCase is not a function" }),
      call({ error_msg: '"failed to parse logic tree ((subject.eq.11349 ne prescott st' }),
      call({ error_msg: "indicia person timed out" }),
    ]);
    expect(c.classifySource_type).toBe(1);
    expect(c.postgrest_logic_tree).toBe(1);
  });
});
