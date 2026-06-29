import { describe, it, expect } from "vitest";
import { serializeReport, type ReportInput } from "@/lib/audit/report-serializer";
import { hashSourceNode } from "@/lib/audit/report-hash";

const fixture: ReportInput = {
  seed: { value: "morgan.reed@example.com", type: "email" },
  clusters: [
    {
      name: "Cluster A — Adrien Broner",
      declaredTier: "High",
      cells: [
        { claim: "Full Name", value: "ADRIEN BRONER", source: "MyDriveSure breach", confidence: 80 },
        { claim: "Address", value: "2480 Scully St", source: "MyDriveSure breach", confidence: 55 },
        { claim: "Email link", value: "morgan.reed@example", source: "MyDriveSure + Scribd mirror", confidence: 60 },
      ],
    },
  ],
  hypotheses: [
    { id: "H1", label: "Single owner — Broner", evidence: "Breach + mirror", confidence: 55, distinguishingEvidence: "Primary source" },
  ],
  sources: [
    { id: "S1", type: "breach", origin: "MyDriveSure-2019", url: "https://leakcheck.io/x", retrievedAt: "2026-06-07T18:00:00Z", confidence: 80 },
    { id: "S2", type: "scribd", origin: "MyDriveSure-2019", url: "https://scribd.com/doc/x", retrievedAt: "2026-06-07T18:02:00Z", confidence: 60 },
  ],
  confidenceFindings: [],
  independenceFindings: [],
  cost: 0.0594,
  caseId: "CASE-TEST",
  analyst: "JD",
  generatedAt: "2026-06-07T18:30:00Z",
};

const render = (over: Partial<ReportInput> = {}) => serializeReport({ ...fixture, ...over }, hashSourceNode);

describe("serializeReport", () => {
  it("produces markdown with all required sections", async () => {
    const md = await render();
    expect(md).toContain("# OSINT Investigation Report");
    expect(md).toContain("## 1. Seed");
    expect(md).toContain("## 2. Identity Clusters");
    expect(md).toContain("## 3. Competing Hypotheses");
    expect(md).toContain("## 4. Source Independence");
    expect(md).toContain("## 5. Audit Summary");
    expect(md).toContain("## 6. Chain of Custody");
  });

  it("includes the seed value", async () => {
    expect(await render()).toContain("`morgan.reed@example.com`");
  });

  it("flags declared/effective tier drift", async () => {
    expect(await render()).toMatch(/Declared:.*High.*Effective:.*Medium/);
  });

  it("shows declared vs effective source counts", async () => {
    expect(await render()).toMatch(/Declared:\*\*\s2.*Effective:\*\*\s1/);
  });

  it("hashes every source with SHA-256 in custody block", async () => {
    const md = await render();
    const matches = md.match(/`[a-f0-9]{64}`/g);
    expect(matches?.length).toBeGreaterThanOrEqual(2);
  });

  it("escapes pipe characters in cell content", async () => {
    const md = await render({
      clusters: [
        {
          name: "X",
          declaredTier: "Medium",
          cells: [{ claim: "a|b", value: "v|v", source: "s|s", confidence: 50 }],
        },
      ],
    });
    expect(md).toContain("a\\|b");
    expect(md).toContain("v\\|v");
    expect(md).toContain("s\\|s");
  });

  it("is deterministic for the same input", async () => {
    expect(await render()).toBe(await render());
  });

  it("report fingerprint is invariant to source ordering", async () => {
    const fpOf = (md: string) => md.match(/Report fingerprint: `([0-9A-F]{12})`/)?.[1];
    const a = await render();
    const b = await render({ sources: [...fixture.sources].reverse() });
    expect(fpOf(a)).toBeDefined();
    expect(fpOf(a)).toBe(fpOf(b));
  });
});
