import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { applyEvidenceCaps } from "./confidence.ts";

// #17 — a name sourced only from news is a LEAD, not a confirmation.
Deno.test("#17: name + news only → cap 55 (not 80)", () => {
  const r = applyEvidenceCaps({ rawConfidence: 90, sources: ["reuters"], kind: "name" });
  assertEquals(r.cap, 55);
});

Deno.test("#17: name+news reason states lead-not-confirmation", () => {
  const r = applyEvidenceCaps({ rawConfidence: 90, sources: ["reuters"], kind: "name" });
  assertEquals(r.reason_for_confidence, "single source class: news (name-from-news treated as lead, not confirmation)");
});

Deno.test("#17: NON-name + news → cap 65", () => {
  const r = applyEvidenceCaps({ rawConfidence: 90, sources: ["herald article"], kind: "address" });
  assertEquals(r.cap, 65);
});

Deno.test("#17: name + news + court_record → court_record (90) still wins", () => {
  const r = applyEvidenceCaps({ rawConfidence: 99, sources: ["pacer_docket", "nytimes_article"], kind: "name" });
  // court_record(90) is the driving class; cross-class boost may apply, but news downgrade must NOT pull it to 55.
  assertEquals(r.cap >= 90, true);
});

Deno.test("#17: non-name (no kind) + news keeps prior behavior (not downgraded to 55)", () => {
  const r = applyEvidenceCaps({ rawConfidence: 90, sources: ["reuters"] });
  // No kind supplied → non-name path → 65, never 55.
  assertEquals(r.cap, 65);
});
