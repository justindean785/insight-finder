// geoseer_test.ts — geolocatability gate + payload normalization.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { assessGeolocatability, normalizeGeoseer } from "../../functions/osint-agent/tools/geoseer_core.ts";
import { TOOL_COSTS_MICRO_USD } from "../../functions/osint-agent/costs.ts";
import { PROVIDER_REQUIREMENTS } from "../../functions/osint-agent/capabilities.ts";
import { toolTimeoutMs } from "../../functions/osint-agent/cache.ts";
const GEOSEER_HTTP_TIMEOUT_MS = 50_000; // mirrors tools/geoseer.ts

Deno.test("gate: outdoor scenery is geolocatable", () => {
  const v = assessGeolocatability("man standing on a snowy mountain trail with pine forest and a wooden signpost");
  assertEquals(v.geolocatable, true);
});

Deno.test("gate: street/storefront imagery is geolocatable", () => {
  assertEquals(assessGeolocatability("woman in front of a storefront on a busy city street with signage").geolocatable, true);
});

Deno.test("gate: indoor selfie is skipped", () => {
  assertEquals(assessGeolocatability("selfie of a man sitting in a bedroom with a plain wall behind him").geolocatable, false);
});

Deno.test("gate: blockers beat geo words", () => {
  // mentions trees but is still an indoor mirror selfie → no capture-location signal
  assertEquals(assessGeolocatability("mirror selfie indoors, trees visible through a window").geolocatable, false);
});

Deno.test("gate: screenshots, logos and documents are skipped", () => {
  for (const s of ["screenshot of a chat log conversation", "company logo on a white background", "scanned document page of a court filing"]) {
    assertEquals(assessGeolocatability(s).geolocatable, false, s);
  }
});

Deno.test("gate: missing or featureless scene is skipped", () => {
  assertEquals(assessGeolocatability(undefined).geolocatable, false);
  assertEquals(assessGeolocatability("a person").geolocatable, false);
});

Deno.test("normalize: trims to 3 candidates and exposes pct confidence", () => {
  const out = normalizeGeoseer({
    status: "success",
    processing_time: "7.4s",
    API_Requests_remaining: 196,
    locations: [
      { latitude: 48.86, longitude: 2.29, address: "Paris, France", confidence: 0.95, reasoning: "Eiffel Tower" },
      { latitude: 1, longitude: 2, confidence: 0.5 },
      { latitude: 3, longitude: 4, confidence: 0.2 },
      { latitude: 5, longitude: 6, confidence: 0.1 },
      { address: "no coords" },
    ],
  });
  const locs = out.locations as Array<Record<string, unknown>>;
  assertEquals(locs.length, 3);
  assertEquals(locs[0].provider_confidence_pct, 95);
  assertEquals(out.requests_remaining, 196);
});

Deno.test("wiring: cost, key gate, and wrapper timeout above own fetch budget", () => {
  assertEquals(typeof TOOL_COSTS_MICRO_USD.geoseer_geolocate, "number");
  assertEquals(PROVIDER_REQUIREMENTS.geoseer_geolocate?.requiresKey, "GEOSEER_API_KEY");
  assertEquals(toolTimeoutMs("geoseer_geolocate") > GEOSEER_HTTP_TIMEOUT_MS, true);
});

/* ── the gate must match WORDS, not substrings ──────────────────────────────── */

Deno.test("gate: a term inside a larger word must not block a real landmark", () => {
  // The first implementation used raw `includes()`, so "icon" matched "Iconic" and
  // the gate refused exactly the images with the strongest location signal. These
  // are pinned by value because the failure is silent — a skipped paid call looks
  // identical to a tool that simply found nothing.
  for (const s of [
    "Iconic landmark: the Eiffel Tower at dusk, Paris skyline behind",
    "An iconic mountain vista with a glacier and hiking trail",
  ]) {
    assertEquals(assessGeolocatability(s).geolocatable, true, s);
  }
});

Deno.test("gate: a term inside a larger word must not authorise a paid call", () => {
  // "sea" inside "seats" and "park" inside "Sparkling" both passed the gate, which
  // spends a GeoSeer credit on a car interior and an indoor object — the two things
  // this gate exists to prevent.
  for (const s of [
    "Leather seats and a dashboard, sunroof closed",
    "Sparkling water glass on a table",
  ]) {
    assertEquals(assessGeolocatability(s).geolocatable, false, s);
  }
});

Deno.test("gate: ordinary inflections still match", () => {
  // A bare \b…\b would fix the above but lose these, which is the same silent
  // refusal in a new place. The suffix allowance keeps them.
  for (const s of [
    "Rocky shoreline with breaking waves at sunset",   // shore -> shoreline
    "Skiing down a groomed piste below the summit",    // ski   -> skiing
    "Mountainside chalets above the treeline",         // mountain -> mountainside
  ]) {
    assertEquals(assessGeolocatability(s).geolocatable, true, s);
  }
});

Deno.test("wiring: /health counts GeoSeer, so a deploy that ships it is detectable", () => {
  // health-handler.ts's tool count is the ONE deploy signal that does not depend on
  // build-info.ts being restamped. GeoSeer was added to the mirror and deployed
  // without touching either file, so `build: 2d47656` and `16/19` both stayed frozen
  // and it was impossible to tell from outside whether the tool was live. Its own
  // comment already required this ("Any tool added with a new key belongs here") —
  // this test makes the requirement enforceable rather than advisory.
  const src = Deno.readTextFileSync(new URL("../../functions/osint-agent/health-handler.ts", import.meta.url));
  assertEquals(/geoseer:\s*has\(env\.GEOSEER_API_KEY\)/.test(src), true);
  assertEquals(/GEOSEER_API_KEY\?:\s*string\s*\|\s*null/.test(src), true);
  assertEquals(/GEOSEER_API_KEY:\s*Deno\.env\.get\("GEOSEER_API_KEY"\)/.test(src), true);
});