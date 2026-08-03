import { describe, it, expect } from "vitest";
import { detectSeed, extractDisplaySeed } from "@/lib/seed";
import { buildReportMarkdown } from "@/lib/intel";
import type { Artifact } from "@/hooks/useThreadArtifacts";

const art = (over: Partial<Artifact> = {}): Artifact => ({
  id: "1",
  kind: "email",
  value: "a@b.com",
  confidence: 60,
  source: "whois",
  created_at: "2026-08-01T00:00:00.000Z",
  metadata: null,
  ...over,
});

// ---------------------------------------------------------------------------
// Contract 12 — the production-shaped Ronny.doe fixture.
//
// This is NOT another unit test of detectSeed(). It reproduces the LIVE SHAPE:
// a thread whose persisted `seed_type` was written by the edge function's
// `detectSeedServer` (validation.ts:247), which still classifies any dotted
// token as a domain — while the frontend classifier now reads the same token as
// an ambiguous handle.
//
// Invariant: the report must EXPOSE that disagreement conservatively. It must
// not silently rewrite history and present "username" as established, and it
// must not blindly repeat "domain" as established either.
//
// SCOPE: Contract 1 is FRONTEND-CLOSED / BACKEND-BLOCKED, not closed end to end.
// The deployed `validation.ts:247` is untouched by this PR, so the investigation
// is still ROUTED as a domain. That is precisely why the report has to say so
// rather than quietly disagree with the routing that produced its own evidence.
// ---------------------------------------------------------------------------

/** The live thread shape: value as submitted, type as the backend persisted it. */
const PRODUCTION_SHAPE = {
  seed_value: "Ronny.doe",
  seed_type: "domain", // written by detectSeedServer, NOT by the frontend
};

const productionArtifacts: Artifact[] = [
  art({ id: "u1", kind: "username", value: "ronnydoe", confidence: 58, source: "breach_lookup" }),
  art({ id: "e1", kind: "email", value: "r.doe@example.com", confidence: 62, source: "breach_lookup" }),
];

const buildProductionReport = () =>
  buildReportMarkdown({
    seedValue: PRODUCTION_SHAPE.seed_value,
    seedType: PRODUCTION_SHAPE.seed_type,
    artifacts: productionArtifacts,
  });

describe("Contract 12 — the two classifiers genuinely disagree on this token", () => {
  it("the frontend reads Ronny.doe as an ambiguous handle, not a domain", () => {
    const d = detectSeed(PRODUCTION_SHAPE.seed_value);
    expect(d).not.toBeNull();
    expect(d!.kind).toBe("username");
    expect(d!.ambiguous).toBe(true);
  });

  it("the persisted backend type is something else entirely", () => {
    // Guard: if these ever agree, every assertion below would pass vacuously.
    expect(PRODUCTION_SHAPE.seed_type).not.toBe(detectSeed(PRODUCTION_SHAPE.seed_value)!.kind);
  });

  it("the display seed records the disagreement rather than discarding one side", () => {
    const d = extractDisplaySeed(PRODUCTION_SHAPE.seed_value, PRODUCTION_SHAPE.seed_type);
    expect(d.kind).toBe("username");
    expect(d.ambiguous).toBe(true);
    expect(d.typeDisagreement).toBe(true);
    expect(d.persistedKind).toBe("domain");
  });
});

describe("Contract 12 — the report exposes the disagreement conservatively", () => {
  it("surfaces the recorded backend type and marks it as disagreeing", () => {
    const md = buildProductionReport();
    expect(md).toContain("**Recorded type (backend):** domain");
    expect(md).toMatch(/DISAGREES/);
  });

  it("does not present 'username' as an established fact", () => {
    const md = buildProductionReport();
    // The ambiguity note must still be there — the handle reading is the
    // least-assertive one, not a settled one.
    expect(md).toMatch(/ambiguous — a dotted token with an unrecognised suffix/);
    expect(md).toMatch(/it is NOT established as a domain/);
    expect(md).toMatch(/does not adopt either reading as settled/i);
  });

  it("does not blindly repeat 'domain' as an established fact either", () => {
    const md = buildProductionReport();
    const typeLine = md.split("\n").find((l) => l.startsWith("- **Type:**")) ?? "";
    expect(typeLine).not.toMatch(/^- \*\*Type:\*\* domain/);
  });

  it("tells the reader the run was routed on the recorded type", () => {
    // Without this the analyst cannot reconcile a handle-shaped report with
    // domain-shaped tooling in the Activity Log.
    expect(buildProductionReport()).toMatch(/routed using the recorded type/i);
  });

  it("warns before type-derived pivots are treated as established", () => {
    expect(buildProductionReport()).toMatch(/Resolve the selector type before relying on type-specific tooling/i);
  });
});

// ---------------------------------------------------------------------------
// Controls. Without these the suite would pass by always printing a
// disagreement, which would be the same failure wearing the opposite sign.
// ---------------------------------------------------------------------------

describe("Contract 12 — controls", () => {
  it("a genuine domain still renders as a domain, with no disagreement", () => {
    const d = extractDisplaySeed("zenbusiness.com", "domain");
    expect(d.kind).toBe("domain");
    expect(d.ambiguous).toBeUndefined();
    expect(d.typeDisagreement).toBeUndefined();

    const md = buildReportMarkdown({
      seedValue: "zenbusiness.com",
      seedType: "domain",
      artifacts: productionArtifacts,
    });
    expect(md).toContain("- **Type:** domain");
    expect(md).not.toMatch(/DISAGREES/);
    expect(md).not.toMatch(/Recorded type \(backend\)/);
  });

  it("an agreeing email seed produces no disagreement line", () => {
    const md = buildReportMarkdown({
      seedValue: "casey.rivera@example.com",
      seedType: "email",
      artifacts: productionArtifacts,
    });
    expect(md).not.toMatch(/DISAGREES/);
  });

  it("an unclassified persisted type is not treated as a competing claim", () => {
    // `other` is the pipeline's "unknown", not a rival classification. Reporting
    // it as a disagreement would cry wolf on ordinary threads.
    const d = extractDisplaySeed("Ronny.doe", "other");
    expect(d.typeDisagreement).toBeUndefined();
    expect(d.ambiguous).toBe(true);
  });

  it("a missing persisted type produces no disagreement", () => {
    expect(extractDisplaySeed("Ronny.doe", null).typeDisagreement).toBeUndefined();
  });

  it("an ambiguous token with an AGREEING persisted type stays ambiguous but silent", () => {
    // The backend already agreed it is a handle; there is nothing to reconcile,
    // but the token itself is still not settled.
    const d = extractDisplaySeed("Ronny.doe", "username");
    expect(d.typeDisagreement).toBeUndefined();
    expect(d.ambiguous).toBe(true);
  });
});
