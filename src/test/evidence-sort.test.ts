import { describe, expect, it } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { compareEvidence, matchesQuery, EVIDENCE_SORT_LABEL } from "@/lib/evidence-sort";
import { assessArtifacts } from "@/lib/agent-assessment";

/**
 * Case desk R4: the Evidence ledger's search and sort are pure and deterministic.
 */
const SEED = "j.harker@northgate-logistics.com";
const art = (over: Partial<Artifact> & { id: string; kind: string; value: string }): Artifact => ({
  confidence: 60, source: "exa_search", created_at: "2026-10-20T09:51:00Z", metadata: {}, ...over,
});
const seed = art({ id: "seed", kind: "email", value: SEED, confidence: 88, created_at: "2026-10-20T09:50:00Z" });
const linked = art({ id: "prof", kind: "social_profile", value: "https://social.example/jharker_ops", confidence: 72, metadata: { email: SEED, handle: "jharker_ops" }, created_at: "2026-10-20T09:52:00Z" });
const loose = art({ id: "phone", kind: "phone", value: "+1 415 555 0142", confidence: 95, source: "indicia_person", metadata: { reason_not_confirmed: "single broker record" }, created_at: "2026-10-20T09:53:00Z" });
const fp = art({ id: "fp", kind: "email", value: "info@northgate-logistics.com", confidence: 99, metadata: { false_positive: true }, created_at: "2026-10-20T09:54:00Z" });

describe("matchesQuery", () => {
  it("matches value, kind, source and recorded reasons, case-insensitively, every term", () => {
    expect(matchesQuery(loose, "415")).toBe(true);
    expect(matchesQuery(loose, "PHONE")).toBe(true);
    expect(matchesQuery(loose, "indicia")).toBe(true);
    expect(matchesQuery(loose, "broker record")).toBe(true);
    expect(matchesQuery(loose, "broker harker")).toBe(false);
    expect(matchesQuery(seed, "")).toBe(true);
    expect(matchesQuery(seed, "   ")).toBe(true);
  });

  it("never matches on a score", () => {
    expect(matchesQuery(loose, "95")).toBe(false);
  });
});

describe("compareEvidence", () => {
  const report = assessArtifacts([seed, linked, loose, fp], SEED);

  it("linkage: the seed first, linked rows next, unresolved rows last, ties by support", () => {
    const order = [loose, linked, seed, fp].sort(compareEvidence("linkage", report)).map((a) => a.id);
    expect(order[0]).toBe("seed");
    expect(order[1]).toBe("prof");
    // Both unresolved: the real 95 outranks a flagged false positive, whatever its stored score.
    expect(order.slice(2)).toEqual(["phone", "fp"]);
  });

  it("confidence: finding support descending, a false positive sinks below every real score", () => {
    expect([fp, seed, loose].sort(compareEvidence("confidence", report)).map((a) => a.id)).toEqual(["phone", "seed", "fp"]);
  });

  it("newest and name are what they say", () => {
    expect([seed, loose, linked].sort(compareEvidence("newest", report)).map((a) => a.id)).toEqual(["phone", "prof", "seed"]);
    expect([loose, seed, fp].sort(compareEvidence("name", report)).map((a) => a.id)).toEqual(["phone", "fp", "seed"]);
  });

  it("is deterministic: equal keys fall back to the id", () => {
    const a = art({ id: "a", kind: "email", value: "x@e.test", confidence: 50 });
    const b = art({ id: "b", kind: "email", value: "x@e.test", confidence: 50 });
    expect([b, a].sort(compareEvidence("confidence", null)).map((x) => x.id)).toEqual(["a", "b"]);
    expect([b, a].sort(compareEvidence("linkage", null)).map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("every mode has a menu label", () => {
    expect(Object.keys(EVIDENCE_SORT_LABEL).sort()).toEqual(["confidence", "linkage", "name", "newest", "strength"]);
  });
});
