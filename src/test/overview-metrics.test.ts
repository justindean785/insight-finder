import { describe, it, expect } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { tallyAuthority, authorityFor } from "@/lib/authority";
import { describeError, describeNamedError } from "@/lib/error-text";

/**
 * Overview metric semantics.
 *
 * The Overview is the one screen that summarises a case in numbers, which makes
 * it the one screen where a wrong number is worst: an analyst reads it INSTEAD
 * of the detail, so a misleading figure is not corrected downstream. Two
 * regressions have already been caught here in review and are pinned below.
 */

const NOW = new Date("2026-08-14T00:00:00Z").toISOString();
let seq = 0;
const art = (meta: Record<string, unknown> = {}, conf = 88): Artifact => {
  seq += 1;
  return {
    id: `ov-${seq}`, kind: "email", value: `r${seq}@example.com`,
    confidence: conf, source: "hunter_verify", created_at: NOW,
    metadata: { sources: ["hunter_verify", "exa_search"], corroborations: 2, ...meta },
  } as Artifact;
};

describe("Overview — the failed/degraded taxonomy must not be summed", () => {
  /**
   * REGRESSION (caught in review). The tile read "Tools failed: 4" on a case
   * whose Tools tab reported Failed 1 / Degraded 3, because the Overview added
   * them together under the word "failed".
   *
   * The two are not the same kind of event and ToolsTab documents why:
   *   failed    breakage. The lookup did not happen, so anything it would have
   *             found is missing from this case. Permanent until re-run.
   *   degraded  transient. Our own throttles and caps, upstream rate limits,
   *             denials, timeouts. The same call can succeed on a retry.
   *
   * Summing them overstates breakage AND destroys the distinction an analyst
   * uses to decide whether re-running is worth anything — which is the
   * suppressed-failure problem this codebase already fixed once, arriving from
   * the opposite direction.
   */
  const label = (failed: number, degraded: number) =>
    degraded > 0 ? `${failed}/${degraded}` : String(failed);

  it("reports failed and degraded as separate figures", () => {
    expect(label(1, 3)).toBe("1/3");
    expect(label(1, 3)).not.toBe("4");
  });

  it("shows a bare count only when there is nothing degraded to hide", () => {
    expect(label(2, 0)).toBe("2");
    expect(label(0, 0)).toBe("0");
  });

  it("never renders a sum whenever there is a degraded count to lose", () => {
    // d === 0 is excluded on purpose: with nothing degraded the bare count and
    // the sum are legitimately the same string, and asserting otherwise would
    // pin a falsehood.
    for (const [f, d] of [[0, 5], [3, 3], [1, 9], [2, 1]]) {
      expect(label(f, d)).not.toBe(String(f + d));
      expect(label(f, d)).toContain("/");
    }
  });
});

describe("Overview — authority tally agrees with the ledger", () => {
  it("counts each row exactly once, on the same projection the ledger renders", () => {
    const rows = [
      art(),                                                  // verified
      art({ subject_unlinked: true }),                         // quarantined
      art({ conflict: true }),                                 // conflict
      art({ false_positive: true }),                           // excluded
      art({ subject_unlinked: true, linkage_confirmed: true }), // released -> verified
    ];
    const t = tallyAuthority(rows);
    expect(Object.values(t).reduce((a, b) => a + b, 0)).toBe(rows.length);
    expect(t.quarantined).toBe(1);
    expect(t.conflict).toBe(1);
    expect(t.failed).toBe(1);
    expect(t.verified).toBe(2);
  });

  it("the tally and the per-row projection cannot disagree", () => {
    // The Overview's headline numbers and the ledger's rows must come from ONE
    // function. This header owns a documented incident (2026-08-06) where two
    // surfaces counted two different tables and disagreed by 48.
    const rows = [art(), art({ subject_unlinked: true }), art({ conflict: true })];
    const t = tallyAuthority(rows);
    for (const state of Object.keys(t) as (keyof typeof t)[]) {
      const byRow = rows.filter((a) => authorityFor(a).state === state).length;
      expect(byRow).toBe(t[state]);
    }
  });
});

describe("describeError — a failure must never render as [object Object]", () => {
  /**
   * REGRESSION (seen in production on the Brain > Analysis tab). The screen read
   * "Could not load analysis: [object Object]" because a Supabase
   * `PostgrestError` is a PLAIN OBJECT, so `e instanceof Error` was false and
   * the code fell through to `String(e)` — asserting that something broke while
   * withholding what, which is worse than not catching at all.
   */
  it("extracts message and code from a PostgrestError-shaped object", () => {
    const out = describeError({ message: "permission denied for table artifacts", code: "42501", details: null, hint: null });
    expect(out).toContain("permission denied for table artifacts");
    expect(out).toContain("42501");
  });

  it("surfaces PostgREST's own hint, the most actionable field it returns", () => {
    expect(describeError({ message: "boom", code: "PGRST200", hint: "Verify the relationship" }))
      .toContain("Verify the relationship");
  });

  it("never returns [object Object] for any input", () => {
    const inputs: unknown[] = [
      {}, { a: 1 }, [], null, undefined, 0, false, new Error("real"), "plain",
      Object.create(null), { message: "   " },
    ];
    for (const i of inputs) {
      const out = describeError(i);
      expect(out).not.toBe("[object Object]");
      expect(out.length).toBeGreaterThan(0);
    }
  });

  it("names which request failed, since Promise.all collapses four into one", () => {
    expect(describeNamedError("evidence_log", { message: "canceling statement due to statement timeout", code: "57014" }))
      .toMatch(/^evidence_log: canceling statement/);
  });

  it("prefers a real Error's message", () => {
    expect(describeError(new Error("stream closed"))).toBe("stream closed");
  });
});
