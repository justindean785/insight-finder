import { describe, it, expect } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { artifactsToSources, classifySourceType, originOf } from "@/lib/audit/from-artifacts";
import { computeEffectiveSourceCount, checkIndependence } from "@/lib/audit/source-independence";

let n = 0;
function art(p: Partial<Artifact>): Artifact {
  n += 1;
  return {
    id: p.id ?? `a${n}`,
    kind: p.kind ?? "email",
    value: p.value ?? "x@example.com",
    confidence: p.confidence ?? 50,
    source: p.source ?? "tool",
    created_at: p.created_at ?? "2026-06-29T00:00:00Z",
    metadata: p.metadata ?? {},
  } as Artifact;
}

const eff = (arts: Artifact[]) => computeEffectiveSourceCount(artifactsToSources(arts));

describe("audit adapter — honest source collapsing", () => {
  it("collapses many fields from ONE breach corpus to a single source", () => {
    const arts = [
      art({ kind: "breach_exposure", metadata: { breach_source: "Collection#1" } }),
      art({ kind: "credential_exposure", metadata: { breach_source: "Collection#1" } }),
      art({ kind: "email", metadata: { source_category: "breach", breach_source: "Collection#1" } }),
    ];
    expect(eff(arts)).toBe(1);
  });

  it("keeps DIFFERENT breach corpora as distinct sources", () => {
    const arts = [
      art({ kind: "breach_exposure", metadata: { breach_source: "Collection#1" } }),
      art({ kind: "breach_exposure", metadata: { breach_source: "Zynga-2019" } }),
    ];
    expect(eff(arts)).toBe(2);
  });

  it("collapses repeat hits from the SAME provider to one source", () => {
    const arts = [
      art({ source: "minimax_web_search", value: "r1" }),
      art({ source: "minimax_web_search", value: "r2" }),
      art({ source: "minimax_web_search", value: "r3" }),
    ];
    expect(eff(arts)).toBe(1);
  });

  it("keeps distinct providers distinct", () => {
    const arts = [
      art({ source: "minimax_web_search" }),
      art({ source: "github_user" }),
      art({ source: "oathnet_lookup" }),
    ];
    expect(eff(arts)).toBe(3);
  });

  it("effective count is <= raw artifact count and reflects real independence", () => {
    const arts = [
      art({ kind: "breach_exposure", metadata: { breach_source: "BigLeak" } }),
      art({ kind: "credential_exposure", metadata: { breach_source: "BigLeak" } }),
      art({ source: "github_user" }),
      art({ source: "github_user" }),
      art({ source: "whois_lookup" }),
    ];
    // BigLeak(1) + github(1) + whois(1) = 3
    expect(eff(arts)).toBe(3);
    expect(eff(arts)).toBeLessThan(arts.length);
  });

  it("classifies and labels origin as expected", () => {
    expect(classifySourceType(art({ kind: "breach_exposure" }))).toBe("breach");
    expect(classifySourceType(art({ source: "github_user", metadata: {} }))).toBe("github");
    expect(originOf(art({ kind: "breach_exposure", metadata: { breach_source: "X" } }))).toBe("breach:x");
    expect(originOf(art({ source: "Hunter" }))).toBe("src:hunter");
  });

  it("flags declared-vs-effective when sources collapse", () => {
    const arts = [
      art({ kind: "breach_exposure", metadata: { breach_source: "OneLeak" } }),
      art({ kind: "breach_exposure", metadata: { breach_source: "OneLeak" } }),
    ];
    const findings = checkIndependence(artifactsToSources(arts));
    expect(findings.some((f) => f.effectiveCount < f.declaredCount)).toBe(true);
  });
});
