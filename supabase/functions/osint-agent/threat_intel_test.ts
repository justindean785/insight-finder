// Tests for the dedicated `threat_intel` source class.
//
// Resolves source-classification.ts TODO(integrity): ransomware-victim / threat-intel
// exposure (ransomwarelive_lookup, the dead deepfind_ransomware_exposure) was mapped to
// "breach", giving organization-level threat data the same identity weight as a
// credential breach tied to the subject. A dedicated class with a conservative cap keeps
// threat-intel-only findings from ever reading as a verified identity claim.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifySource, countIndependentClasses } from "./source-classification.ts";
import { applyEvidenceCaps } from "./confidence.ts";

Deno.test("threat_intel does not count as independent identity corroboration", () => {
  // threat_intel alongside one official record must NOT read as 2 independent
  // corroborating classes (the org-ransomware signal is not about the person).
  assertEquals(countIndependentClasses(["threat_intel"]), 0);
  assertEquals(countIndependentClasses(["threat_intel", "court_record"]), 1);
});

Deno.test("ransomware/threat-intel tools classify as threat_intel, not breach", () => {
  assertEquals(classifySource("ransomwarelive_lookup"), "threat_intel");
  assertEquals(classifySource("deepfind_ransomware_exposure"), "threat_intel");
});

Deno.test("real breach/leak tools STILL classify as breach (no over-reach)", () => {
  for (const t of ["breach_check", "oathnet_lookup", "leakcheck_lookup", "serus_darkweb_scan"]) {
    assertEquals(classifySource(t), "breach", `${t} must stay breach`);
  }
});

Deno.test("threat_intel-only confidence is capped low (<= 50, < breach)", () => {
  const r = applyEvidenceCaps({ rawConfidence: 95, sources: ["ransomwarelive_lookup"] });
  assertEquals(r.source_classes, ["threat_intel"]);
  assert(r.cap <= 50, `threat_intel cap expected <= 50, got ${r.cap}`);
  assert(r.confidence <= 50, `threat_intel confidence expected <= 50, got ${r.confidence}`);
});

Deno.test("threat_intel is NEVER_HIGH — even mixed with breach it can't reach 90+", () => {
  const r = applyEvidenceCaps({
    rawConfidence: 99,
    sources: ["ransomwarelive_lookup", "breach_check"],
  });
  assert(r.source_classes.includes("threat_intel"));
  assert(r.source_classes.includes("breach"));
  assert(r.cap <= 65, `weak-only mix must stay <= 65, got ${r.cap}`);
  assert(r.confidence < 90, `threat_intel-only-mix must never confirm identity, got ${r.confidence}`);
  assert(r.reason_not_confirmed, "must carry a reason_not_confirmed");
});

Deno.test("threat_intel does not unlock the ownership/identity path on its own", () => {
  // Even alongside many infra perspectives, threat_intel is not a TRUSTED non-infra
  // class, so the finding cannot exceed the infra-safe ceiling.
  const r = applyEvidenceCaps({
    rawConfidence: 99,
    sources: ["ransomwarelive_lookup", "dns_records", "whois_lookup"],
  });
  assert(r.confidence <= 85, `no trusted identity source ⇒ <= 85, got ${r.confidence}`);
});
