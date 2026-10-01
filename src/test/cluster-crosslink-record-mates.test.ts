import { describe, it, expect } from "vitest";
import { buildIdentityClusters, phoneMergeKey } from "@/lib/intel";
import type { Artifact } from "@/hooks/useThreadArtifacts";

/**
 * Regression fixture from production thread d72fa44a (seed `lildee808`,
 * 2026-09-20). The engine split ONE person into fifteen singleton clusters
 * because (1) phone keys were the raw string, so `8087838763` in a breach row
 * never met `+18087838763` the artifact; (2) the breach extractors write the
 * owner's other handles as `usernames[]` / `associated_username`, which the
 * cross-link union did not read. Values below are shaped like the real rows but
 * are not the real selectors.
 */
function mk(p: { id: string; kind: string; value: string; metadata?: Record<string, unknown>; source?: string }): Artifact {
  return {
    id: p.id,
    kind: p.kind,
    value: p.value,
    confidence: 60,
    source: p.source ?? "serus_darkweb_scan",
    created_at: "2026-09-20T11:54:35Z",
    metadata: p.metadata ?? null,
  };
}

const ids = (c: { artifacts: Artifact[] }) => new Set(c.artifacts.map((a) => a.id));

describe("phoneMergeKey", () => {
  it("lands bare digits, E.164 and punctuated forms on one key", () => {
    expect(phoneMergeKey("8087838763")).toBe("phone:8087838763");
    expect(phoneMergeKey("+18087838763")).toBe("phone:8087838763");
    expect(phoneMergeKey("(808) 783-8763")).toBe("phone:8087838763");
    expect(phoneMergeKey("1-808-783-8763")).toBe("phone:8087838763");
  });
  it("does not strip a leading 1 from a non-NANP length, and rejects short strings", () => {
    expect(phoneMergeKey("+4420712345678")).toBe("phone:4420712345678");
    expect(phoneMergeKey("12345")).toBeNull();
    expect(phoneMergeKey("no digits")).toBeNull();
  });
});

describe("buildIdentityClusters — record-mates from breach extractors", () => {
  it("a breach row's bare-digit phones[] merge with the E.164 phone artifacts", () => {
    const email = mk({ id: "e", kind: "email", value: "cnnamongirl90@example.com" });
    const serus = mk({
      id: "s", kind: "breach_exposure",
      value: "cnnamongirl90@example.com - 24 breaches",
      metadata: { email: "cnnamongirl90@example.com", phones: ["8087838763", "8086527289"] },
    });
    const p1 = mk({ id: "p1", kind: "phone", value: "+18087838763", metadata: { area_code: "808 Hawaii" } });
    const p2 = mk({ id: "p2", kind: "phone", value: "+18086527289", metadata: { area_code: "808 Hawaii" } });

    const { clusters } = buildIdentityClusters([email, serus, p1, p2], "lildee808");
    const c = clusters.find((x) => ids(x).has("e"));
    expect(c).toBeTruthy();
    expect(ids(c!)).toEqual(new Set(["e", "s", "p1", "p2"]));
  });

  it("associated_username on a breach row joins the handle seed to its record-mate email", () => {
    const seed = mk({ id: "seed", kind: "username", value: "lildee808", source: "user_seed" });
    const mfp = mk({
      id: "mfp", kind: "breach_exposure",
      value: "LilDee808 - MyFitnessPal breach - email: cnnamongirl90@example.com",
      metadata: { associated_username: "LilDee808", associated_email: "cnnamongirl90@example.com" },
      source: "leakcheck_lookup",
    });
    const email = mk({ id: "e", kind: "email", value: "cnnamongirl90@example.com" });

    const { clusters } = buildIdentityClusters([seed, mfp, email], "lildee808");
    const c = clusters.find((x) => ids(x).has("seed"));
    expect(c).toBeTruthy();
    expect(ids(c!)).toEqual(new Set(["seed", "mfp", "e"]));
  });

  it("usernames[] on a breach row is read like the singular key", () => {
    const seed = mk({ id: "seed", kind: "username", value: "lildee808", source: "user_seed" });
    const serus = mk({
      id: "s", kind: "breach_exposure", value: "cnnamongirl90@example.com - 24 breaches",
      metadata: { email: "cnnamongirl90@example.com", usernames: ["Cnnamongirl90", "VitaminD8", "LilDee808"] },
    });
    const { clusters } = buildIdentityClusters([seed, serus], "lildee808");
    expect(ids(clusters.find((x) => ids(x).has("seed"))!)).toEqual(new Set(["seed", "s"]));
  });

  it("current_address on a name row joins the standalone address artifact", () => {
    const name = mk({
      id: "n", kind: "name", value: "Desiree M. Example",
      metadata: { current_address: "2514 S Example St Unit 15 Honolulu HI 96826" },
      source: "indicia_person",
    });
    const addr = mk({ id: "a", kind: "address", value: "2514 S Example St Unit 15 Honolulu HI 96826", source: "indicia_person" });
    const { clusters } = buildIdentityClusters([name, addr], "lildee808");
    expect(ids(clusters.find((x) => ids(x).has("n"))!)).toEqual(new Set(["n", "a"]));
  });

  it("names, cities and zips are still never merge keys", () => {
    // Two rows that share only a person name and a city must stay apart.
    const a = mk({ id: "a", kind: "name", value: "Desiree Example", metadata: { cities: ["Kapaa"], zips: ["96746"] } });
    const b = mk({ id: "b", kind: "breach_exposure", value: "other@example.com - 3 breaches", metadata: { names: ["Desiree Example"], cities: ["Kapaa"], zips: ["96746"] } });
    const { clusters } = buildIdentityClusters([a, b], "lildee808");
    const together = clusters.find((x) => ids(x).has("a") && ids(x).has("b"));
    expect(together).toBeFalsy();
  });

  it("two people sharing no selector stay apart even when both carry phones[]", () => {
    const one = mk({ id: "1", kind: "email", value: "one@example.com", metadata: { phones: ["8087838763"] } });
    const two = mk({ id: "2", kind: "email", value: "two@example.net", metadata: { phones: ["2125551234"] } });
    const { clusters } = buildIdentityClusters([one, two], "lildee808");
    expect(clusters.find((x) => ids(x).has("1") && ids(x).has("2"))).toBeFalsy();
  });
});

describe("buildIdentityClusters — queried_selector as a record-mate key", () => {
  it("rows auto-persisted from one lookup on a durable selector union with that selector's row", () => {
    const email = mk({ id: "e", kind: "email", value: "cnnamongirl90@example.com" });
    const b1 = mk({ id: "b1", kind: "breach_exposure", value: "Breach exposure: cnnamongirl90@example.com (oathnet_db)", metadata: { queried_selector: "cnnamongirl90@example.com" }, source: "oathnet_lookup" });
    const b2 = mk({ id: "b2", kind: "breach_exposure", value: "Breach exposure: cnnamongirl90@example.com (leakcheck)", metadata: { queried_selector: "cnnamongirl90@example.com" }, source: "leakcheck_lookup" });
    const { clusters } = buildIdentityClusters([email, b1, b2], "lildee808");
    expect(ids(clusters.find((x) => ids(x).has("e"))!)).toEqual(new Set(["e", "b1", "b2"]));
  });

  it("a name-shaped queried_selector (whitespace) never unions anything", () => {
    const a = mk({ id: "a", kind: "email", value: "one@example.com", metadata: { queried_selector: "Desiree Example" }, source: "indicia_person" });
    const b = mk({ id: "b", kind: "phone", value: "+18085550000", metadata: { queried_selector: "Desiree Example" }, source: "indicia_person" });
    const { clusters } = buildIdentityClusters([a, b], "lildee808");
    expect(clusters.find((x) => ids(x).has("a") && ids(x).has("b"))).toBeFalsy();
  });
});
