import { describe, expect, it } from "vitest";
import { countCustodyCovered, type CoverageArtifact, type CoverageEvidence } from "@/lib/custody-coverage";

const art = (id: string, thread_id: string, kind: string, value: string | null): CoverageArtifact =>
  ({ id, thread_id, kind, value });
const ev = (thread_id: string | null, kind: string | null, value: string | null, artifact_id: string | null = null): CoverageEvidence =>
  ({ artifact_id, thread_id, kind, value });

describe("countCustodyCovered", () => {
  it("matches evidence to artifacts by thread, kind and value when artifact_id is NULL (the production shape)", () => {
    const artifacts = [
      art("a1", "t1", "email", "j@example.com"),
      art("a2", "t1", "domain", "example.com"),
      art("a3", "t1", "phone", "+15550100"),
    ];
    const evidence = [ev("t1", "email", "j@example.com"), ev("t1", "domain", "example.com")];
    expect(countCustodyCovered(artifacts, evidence)).toBe(2);
  });

  it("does not collapse every NULL artifact_id into a single covered item", () => {
    // The old metric: new Set(evidence.map(r => r.artifact_id)).size === 1 for any number of rows.
    const artifacts = Array.from({ length: 5 }, (_, i) => art(`a${i}`, "t1", "username", `user${i}`));
    const evidence = artifacts.map((a) => ev("t1", "username", a.value));
    expect(countCustodyCovered(artifacts, evidence)).toBe(5);
  });

  it("never matches across threads", () => {
    expect(countCustodyCovered([art("a1", "t1", "email", "x@y.z")], [ev("t2", "email", "x@y.z")])).toBe(0);
  });

  it("requires the kind to agree, so a username does not cover a name with the same text", () => {
    expect(countCustodyCovered([art("a1", "t1", "name", "jordan vale")], [ev("t1", "username", "jordan vale")])).toBe(0);
  });

  it("ignores case and surrounding whitespace in kind and value", () => {
    expect(countCustodyCovered([art("a1", "t1", "Email", " J@Example.com ")], [ev("t1", "email", "j@example.com")])).toBe(1);
  });

  it("honours a non-null artifact_id even when the triple differs", () => {
    expect(countCustodyCovered([art("a1", "t1", "email", "x@y.z")], [ev("t9", "other", "zzz", "a1")])).toBe(1);
  });

  it("counts each artifact once however many evidence rows it has", () => {
    const evidence = [ev("t1", "email", "x@y.z"), ev("t1", "email", "x@y.z"), ev(null, null, null, "a1")];
    expect(countCustodyCovered([art("a1", "t1", "email", "x@y.z")], evidence)).toBe(1);
  });

  it("does not let empty values match each other", () => {
    expect(countCustodyCovered([art("a1", "t1", "note", null)], [ev("t1", "note", "")])).toBe(0);
  });
});
