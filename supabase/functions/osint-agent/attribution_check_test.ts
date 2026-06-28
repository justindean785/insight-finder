import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  checkEmailAttribution,
  localPartMatchesSubject,
  type SubjectProfile,
} from "./attribution-check.ts";

const NANOS: SubjectProfile = {
  name: "Chris Nanos",
  nameVariants: ["Christopher", "C. Nanos"],
  gender: "M",
  city: "Tucson",
};

// ── MANDATORY RETRO TEST (#15): the charn@comcast.net misattribution ──
Deno.test("retro: charn@comcast.net is flagged (local-part ≠ chris/christopher)", () => {
  const findings = checkEmailAttribution(NANOS, [
    { value: "charn@comcast.net", metadata: { possible_owner: "CHRIS NANOS", gender: "F" } },
  ]);
  assertEquals(findings.length, 1);
  // Owner "CHRIS NANOS" tokens DO overlap subject, but local-part 'charn' fails
  // AND gender is F vs subject M → must surface as suspect, not silently attributed.
  assertEquals(findings[0].verdict, "attribution_suspect");
});

Deno.test("localPartMatchesSubject: 'charn' does NOT match Chris Nanos", () => {
  assertEquals(localPartMatchesSubject("charn", NANOS), false);
});

Deno.test("localPartMatchesSubject: 'cnanos' (initial+surname) matches", () => {
  assertEquals(localPartMatchesSubject("cnanos", NANOS), true);
});

Deno.test("localPartMatchesSubject: 'christopher.nanos' matches", () => {
  assertEquals(localPartMatchesSubject("christopher.nanos", NANOS), true);
});

Deno.test("checkEmailAttribution: matching email is not flagged", () => {
  const findings = checkEmailAttribution(NANOS, [
    { value: "cnanos@pima.gov", metadata: { possible_owner: "Chris Nanos" } },
  ]);
  assertEquals(findings.length, 0);
});

Deno.test("checkEmailAttribution: unknown owner + no match → unverified", () => {
  const findings = checkEmailAttribution(NANOS, [
    { value: "xyz123@gmail.com", metadata: {} },
  ]);
  assertEquals(findings[0].verdict, "attribution_unverified");
});

Deno.test("checkEmailAttribution: gender mismatch alone flags suspect", () => {
  const findings = checkEmailAttribution(NANOS, [
    { value: "cnanos@example.com", metadata: { gender: "F" } },
  ]);
  assertEquals(findings[0].verdict, "attribution_suspect");
});
