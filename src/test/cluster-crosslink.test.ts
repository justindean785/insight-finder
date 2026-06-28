import { describe, it, expect } from "vitest";
import { buildIdentityClusters } from "@/lib/intel";
import type { Artifact } from "@/hooks/useThreadArtifacts";

function mk(p: { id: string; kind: string; value: string; metadata?: Record<string, unknown> }): Artifact {
  return {
    id: p.id,
    kind: p.kind,
    value: p.value,
    confidence: 60,
    source: "oathnet_lookup",
    created_at: "2026-06-28T10:00:00Z",
    metadata: p.metadata ?? null,
  };
}

describe("buildIdentityClusters metadata cross-links (#21)", () => {
  it("merges email + phone rows when the email's metadata names that phone", () => {
    const email = mk({ id: "e1", kind: "email", value: "jc14beast@yahoo.com", metadata: { phone: "+19167356524", instagram_handle: "jc.tha.barber" } });
    const phone = mk({ id: "p1", kind: "phone", value: "+19167356524", metadata: { owner: "Jack Cordrey" } });
    const ig = mk({ id: "i1", kind: "account_id", value: "jc.tha.barber Instagram", metadata: { handle: "jc.tha.barber", full_name: "Jack Cordrey" } });

    const { clusters } = buildIdentityClusters([email, phone, ig], "jcthabarber");
    // the email (shared phone) + phone, and the email (shared handle) + IG, all
    // converge into a single cluster instead of three single-attribute ones.
    const merged = clusters.find(
      (c) =>
        c.artifacts.some((a) => a.id === "e1") &&
        c.artifacts.some((a) => a.id === "p1") &&
        c.artifacts.some((a) => a.id === "i1"),
    );
    expect(merged).toBeTruthy();
  });

  it("keeps two different people separate when they share no concrete selector", () => {
    // Jack Cordrey vs JC Hammons: same username seed, different email/phone/addr.
    const jackEmail = mk({ id: "a", kind: "email", value: "jc14beast@yahoo.com", metadata: { phone: "+19167356524" } });
    const hammonsEmail = mk({ id: "b", kind: "email", value: "jc_thabarber@hotmail.com", metadata: { address: "20366 Via Galileo Northridge CA 91326" } });
    const hammonsAddr = mk({ id: "c", kind: "address", value: "20366 Via Galileo Northridge CA 91326", metadata: { owner: "Jc Hammons" } });

    const { clusters } = buildIdentityClusters([jackEmail, hammonsEmail, hammonsAddr], "jcthabarber");
    // Hammons' email + address merge (shared address); Jack's email stays apart.
    const both = clusters.find(
      (c) => c.artifacts.some((x) => x.id === "a") && c.artifacts.some((x) => x.id === "b"),
    );
    expect(both).toBeFalsy();
    const hammons = clusters.find(
      (c) => c.artifacts.some((x) => x.id === "b") && c.artifacts.some((x) => x.id === "c"),
    );
    expect(hammons).toBeTruthy();
  });
});
