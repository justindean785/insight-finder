// A lookup that found NOTHING is coverage, not a candidate. The @port162 scan (2026-10-29, production) listed two
// model-authored `breach_exposure` rows — breach_check "0 hits" and oathnet_stealer_search "0 hits, 0 breaches,
// 0 pastes" — as Connections "unlinked candidates". `isNegativeResultArtifact` wants NUMERIC counters, so it missed
// both; the result strings themselves say zero. Quarantine is disclosure, not deletion: the rows stay in the graph,
// they just stop being offered (and counted) as leads.
import { describe, expect, it } from "vitest";
import { buildEntityGraph } from "@/lib/entity-graph";
import { connectionsView, isCleanCheck } from "@/lib/workbench-connections";
import type { Artifact } from "@/hooks/useThreadArtifacts";

const A = (o: Partial<Artifact>): Artifact => ({
  id: "a", kind: "email", value: "x@y.com", confidence: 50, source: "t",
  created_at: "2026-06-01T00:00:00Z", metadata: null, ...o,
});

// The two production shapes (§4.4 of the 2026-10-29 handoff): strings, not numbers.
const breachZero = A({
  id: "bc", kind: "breach_exposure", source: "breach_check", confidence: 60,
  value: "NO BREACH HITS", metadata: { breach_check_result: "0 hits" },
});
const stealerZero = A({
  id: "st", kind: "breach_exposure", source: "oathnet_stealer_search", confidence: 60,
  value: "NO STEALER LOG HITS", metadata: { serus_darkweb_result: "0 hits, 0 breaches, 0 pastes" },
});

describe("isCleanCheck", () => {
  it("reads both production zero-hit rows as clean checks", () => {
    expect(isCleanCheck(breachZero)).toBe(true);
    expect(isCleanCheck(stealerZero)).toBe(true);
  });

  it("a null-result VALUE is a clean check even without metadata", () => {
    expect(isCleanCheck(A({ kind: "breach_exposure", source: "breach_check", value: "port162 - no breach hits" }))).toBe(true);
  });

  it("numeric zero counters (the existing negative-result predicate) still count", () => {
    expect(isCleanCheck(A({ kind: "breach_exposure", source: "leakcheck", value: "port162@x.com", metadata: { found: 0 } }))).toBe(true);
  });

  it("a failed or refused lookup is NOT a clean check — it established nothing (Codex P2 on #895)", () => {
    for (const status of ["blocked", "restricted", "denied", "error"]) {
      expect(isCleanCheck(A({ kind: "breach_exposure", source: "leakcheck", value: "port162@x.com", metadata: { lookup_status: status } })), status).toBe(false);
    }
    for (const http_status of [401, 403, 429, 503]) {
      expect(isCleanCheck(A({ kind: "breach_exposure", source: "leakcheck", value: "port162@x.com", metadata: { http_status, found: 0 } })), String(http_status)).toBe(false);
    }
    // Even with a zero-reading value or result string, a failed status wins.
    expect(isCleanCheck(A({ kind: "breach_exposure", source: "breach_check", value: "NO BREACH HITS", metadata: { lookup_status: "error", breach_check_result: "0 hits" } }))).toBe(false);
    // `not_found` is a completed lookup that found nothing.
    expect(isCleanCheck(A({ kind: "breach_exposure", source: "leakcheck", value: "port162@x.com", metadata: { lookup_status: "not_found" } }))).toBe(true);
  });

  it("a real hit is never a clean check", () => {
    expect(isCleanCheck(A({ kind: "breach_exposure", source: "breach_check", value: "Canva (2019)", metadata: { breach_check_result: "3 hits" } }))).toBe(false);
    expect(isCleanCheck(A({ kind: "breach_exposure", source: "breach_check", value: "Canva breach found; no records of password exposure" }))).toBe(false);
  });

  it("one zero result beside one positive result is NOT clean", () => {
    expect(isCleanCheck(A({
      kind: "breach_exposure", source: "breach_check", value: "port162",
      metadata: { breach_check_result: "0 hits", serus_darkweb_result: "2 breaches" },
    }))).toBe(false);
  });

  it("result strings on a non-lookup kind do not make it clean (a profile is a lead)", () => {
    expect(isCleanCheck(A({ kind: "username", value: "port162", metadata: { breach_check_result: "0 hits" } }))).toBe(false);
  });
});

describe("connectionsView — clean checks are coverage, not candidates", () => {
  const lead = A({ id: "lead", kind: "username", value: "port162_alt", source: "username_sweep", confidence: 55 });
  const view = connectionsView(buildEntityGraph([breachZero, stealerZero, lead], "port162", "username"));

  it("removes clean checks from the isolated list and its count", () => {
    expect(view.isolated.map((n) => n.id)).toEqual(["lead"]);
    expect(view.isolatedLeads).toBe(1);
  });

  it("counts them separately", () => {
    expect(view.cleanChecks).toBe(2);
  });

  it("is zero when the case has none", () => {
    expect(connectionsView(buildEntityGraph([lead], "port162", "username")).cleanChecks).toBe(0);
  });
});
