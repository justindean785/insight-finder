// seed-without-attachments.test.ts: a case started with typed text plus an
// upload stores the composer's "Attached files:" block in threads.seed_value
// (first 200 characters). Engines that match rows against the seed compared
// against that whole string, so nothing was ever "the seed" and the Overview
// read 0 supported findings. Seen in production 2026-11-10.
import { describe, expect, it } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { seedWithoutAttachments } from "@/lib/attachments";
import { assessArtifacts } from "@/lib/agent-assessment";
import { buildEntityGraph } from "@/lib/entity-graph";

const email = "jane.roe@example.com";
const stored = `${email}\n\nAttached files:\n- [export.pdf](https://example.supabase.co/storage/v1/object/sign/attachments/aaaaaaaa-bbbb/export.pdf?token=${"x".repeat(120)}) (application/pdf, 11 MB)`.slice(0, 200);
const uploadOnly = "Attached files:\n- [export.pdf](https://example.supabase.co/storage/v1/object/sign/x";

const row = (id: string, kind: string, value: string, confidence: number, source: string, metadata: Record<string, unknown>) =>
  ({ id, thread_id: "t", kind, value, confidence, source, created_at: "2026-01-01T00:00:00Z", metadata }) as unknown as Artifact;

const rows = [
  row("a1", "email", email, 60, "hunter_verify", { source_category: "independent_public" }),
  row("a2", "breach_exposure", `${email} exposed in ExampleCorp 2019`, 55, "oathnet_lookup", { queried_selector: email, source_category: "breach" }),
  row("a3", "phone", "+15550104477", 50, "oathnet_lookup", { source_category: "breach" }),
];

describe("seedWithoutAttachments", () => {
  it("the fixture is the cut shape the edge stores", () => {
    expect(stored).toHaveLength(200);
    expect(stored).toContain("Attached files:");
  });

  it("returns the typed selector and leaves every other seed alone", () => {
    expect(seedWithoutAttachments(stored)).toBe(email);
    expect(seedWithoutAttachments(email)).toBe(email);
    expect(seedWithoutAttachments(uploadOnly)).toBe(uploadOnly);
    expect(seedWithoutAttachments(null)).toBeNull();
  });
});

describe("engines read the typed seed, not the attachment block", () => {
  it("the assessment finds the seed row and counts what links to it", () => {
    const clean = assessArtifacts(rows, email, {});
    const fromStored = assessArtifacts(rows, stored, {});
    expect(clean.seedClusterId).not.toBeNull();
    expect(clean.counts.supported).toBeGreaterThan(0);
    expect(fromStored.seedClusterId).toBe(clean.seedClusterId);
    expect(fromStored.counts).toEqual(clean.counts);
  });

  it("the graph ties the seed's own record to the seed", () => {
    const clean = buildEntityGraph(rows, email, "email", {});
    const fromStored = buildEntityGraph(rows, stored, "email", {});
    expect(clean.stats.seedRecordCount).toBe(1);
    expect(fromStored.stats.seedRecordCount).toBe(1);
    expect(fromStored.edges.map((e) => e.id).sort()).toEqual(clean.edges.map((e) => e.id).sort());
  });

  it("an upload-only seed still links nothing to itself", () => {
    const g = buildEntityGraph(rows, uploadOnly, "other", {});
    expect(g.stats.seedRecordCount).toBe(0);
    expect(assessArtifacts(rows, uploadOnly, {}).seedClusterId).toBeNull();
  });
});
