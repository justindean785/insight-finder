import { describe, expect, it } from "vitest";
import { describeRepair } from "@/lib/pivot-repair-copy";
import { isInfraDomain } from "@/lib/intel";
import { targetShapeProblems } from "@/lib/pivot-target-shape";

describe("describeRepair", () => {
  it("explains a sentence-valued target in plain language, without parser wording", () => {
    const problems = targetShapeProblems(
      "name",
      "Run a WHOIS deep dive on the registrant and compare every historical record for the domain today",
    );
    expect(problems.some((p) => /sentence/.test(p))).toBe(true); // the diagnostic still exists…
    const copy = describeRepair(problems);
    expect(copy).toMatch(/sentence/);
    expect(copy).toMatch(/Nothing was run/);
    expect(copy).not.toMatch(/\d+ words/); // …but the headline is not the raw diagnostic
  });
  it("covers boilerplate and generic shape failures", () => {
    expect(describeRepair(["target is report boilerplate"])).toMatch(/not a search target/);
    expect(describeRepair(["target is not a domain name"])).toMatch(/not in a form that can be searched/);
  });
});

describe("shared nameserver / parking infrastructure is not a subject pivot", () => {
  it.each(["helios.dns-parking.com", "aster.dns-parking.com", "ns1.dns-parking.com", "dns-parking.com", "https://ns.registrar-servers.com/x"])(
    "%s is shared infrastructure",
    (v) => expect(isInfraDomain(v)).toBe(true),
  );
  it("does not swallow an unrelated domain that merely contains the text", () => {
    expect(isInfraDomain("my-dns-parking.com.example.org")).toBe(false);
    expect(isInfraDomain("example-hostinger.com")).toBe(false);
    expect(isInfraDomain("osintintel.com")).toBe(false);
  });
});
