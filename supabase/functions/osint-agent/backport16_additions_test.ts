// Gate for the THREE new integrity behaviors backported from mirror #16 that the
// #56 contract suite (audit_fixes_test.ts) does NOT exercise:
//   1. government/official public-record classes may legitimately exceed the
//      infra-safe 85 ownership ceiling,
//   2. status is DERIVED from evidence — a model-asserted verified/confirmed can
//      never coexist with an open confirmation gap,
//   3. collision/unrelated-entity exclusion fires (hard-capped, status=excluded).
// New behaviors → their own mechanical gate. (audit_fixes_test.ts is untouched.)
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifySource } from "./artifact_types.ts";
import {
  applyEvidenceCaps,
  isUnrelatedEntity,
  EXCLUDED_COLLISION_CONFIDENCE,
  coerceCoherentStatus,
  deriveStatus,
} from "./confidence.ts";

// ── 1. Government / official public records exceed the 85 ownership ceiling ──
Deno.test("#16: government public-record class legitimately exceeds the 85 infra ceiling", () => {
  assertEquals(classifySource("county assessor parcel record"), "government_property_record");
  const gov = applyEvidenceCaps({ rawConfidence: 95, sources: ["county assessor parcel record"] });
  assert(gov.cap >= 90, `government cap should be >= 90, got ${gov.cap}`);
  assert(gov.confidence > 85, `government confidence should exceed the 85 infra ceiling, got ${gov.confidence}`);
  // Contrast: infra-only (whois) still cannot exceed 85 (it caps at 75 here).
  const infra = applyEvidenceCaps({ rawConfidence: 95, sources: ["whois_lookup"] });
  assert(infra.confidence <= 85, `infra-only must stay <= 85, got ${infra.confidence}`);
});

Deno.test("#16: business registry/license map to trusted government classes", () => {
  assertEquals(classifySource("California Secretary of State business entity search"), "government_business_registry");
  assertEquals(classifySource("county business license"), "government_business_license");
});

// ── 2. Derived status overrides a contradictory model-asserted status ──
Deno.test("#16: coerceCoherentStatus downgrades verified/confirmed when a confirmation gap is open", () => {
  assertEquals(coerceCoherentStatus("verified", "needs second independent class of evidence"), "needs_corroboration");
  assertEquals(coerceCoherentStatus("confirmed", "no independent identity/ownership source"), "needs_corroboration");
  // control: no open reason → status is preserved.
  assertEquals(coerceCoherentStatus("verified", null), "verified");
});

Deno.test("#16: deriveStatus never returns verified/confirmed while a reason_not_confirmed is open", () => {
  // model asked for "verified" but there's an open gap → must NOT be verified/confirmed.
  const s = deriveStatus({
    requested: "verified",
    reasonNotConfirmed: "needs second independent class of evidence",
    sourceClasses: ["breach"],
  });
  assert(s !== "verified" && s !== "confirmed", `expected a downgraded status, got ${s}`);
  assertEquals(s, "observed");
  // control: ≥2 independent classes + no open gap → confirmed is legitimately granted.
  assertEquals(
    deriveStatus({ requested: "confirmed", reasonNotConfirmed: null, sourceClasses: ["court_record", "news"] }),
    "confirmed",
  );
});

// ── 3. Collision / unrelated-entity exclusion fires ──
Deno.test("#16: isUnrelatedEntity detects collisions and exclusion is hard-capped", () => {
  assertEquals(isUnrelatedEntity({ note: "unrelated individual, namesake" }), true);
  assertEquals(isUnrelatedEntity({ different_person: true }), true);
  assertEquals(isUnrelatedEntity({ note: "this is our subject" }), false); // control
  assertEquals(EXCLUDED_COLLISION_CONFIDENCE, 15); // hard cap so a collision can't roll into the case score
});

Deno.test("#16: deriveStatus(unrelated) forces 'excluded' even with otherwise strong evidence", () => {
  const s = deriveStatus({
    requested: "verified",
    reasonNotConfirmed: null,
    sourceClasses: ["court_record", "news"],
    unrelated: true,
  });
  assertEquals(s, "excluded");
});
