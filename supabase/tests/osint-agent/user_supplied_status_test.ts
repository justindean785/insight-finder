// user_supplied_status_test.ts — E2 option (c): pasted is not checked.
// Production 2026-10-09, thread 7a2968e1: two legal_record rows sourced
// "user_supplied (unicourt.com docket)" were stored verified / 90 with no analyst review.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { applyRecordingSourcePolicy, resolveRecordingStatus } from "../../functions/osint-agent/recording-source-policy.ts";
import {
  guardUserSuppliedStatus,
  isUserSuppliedOnly,
  USER_SUPPLIED_REASON,
  userSuppliedStatusSelfTest,
} from "../../functions/osint-agent/lib/user-supplied-status.ts";

const KILL = "USER_SUPPLIED_STATUS_CEILING_DISABLED";
const derive = (source: string, kind = "legal_record") => {
  const r = applyRecordingSourcePolicy({ rawConfidence: 95, source, kind, metadata: null });
  return { cap: r.effective, status: resolveRecordingStatus(r.effective, null) };
};

Deno.test("REPRODUCTION: the engine itself derives verified/90 for the pasted docket", () => {
  const { cap, status } = derive("user_supplied (unicourt.com docket)");
  assertEquals(status.status, "verified");
  assertEquals(cap.cap, 90);
});

Deno.test("user-supplied-only rows lose verified/confirmed but KEEP their confidence", () => {
  const { cap, status } = derive("user_supplied (unicourt.com docket)");
  const g = guardUserSuppliedStatus(status, "user_supplied (unicourt.com docket)", null);
  assertEquals(g.status, "observed");
  assertEquals(g.reasonNotConfirmed, USER_SUPPLIED_REASON);
  assertEquals(g.userSuppliedUnreviewed, true);
  assertEquals(cap.cap, 90, "option (c): the score the analyst expects is not touched");
});

Deno.test("never raises: a status that was already low is not promoted", () => {
  const g = guardUserSuppliedStatus({ status: "needs_review", reasonNotConfirmed: "x" }, "user_supplied", null);
  assertEquals(g.status, "needs_review");
  assertEquals(g.reasonNotConfirmed, "x");
});

Deno.test("an existing reason_not_confirmed is preserved, not overwritten", () => {
  const g = guardUserSuppliedStatus({ status: "verified", reasonNotConfirmed: "keep me" }, "user-provided pivot", null);
  assertEquals(g.reasonNotConfirmed, "keep me");
});

Deno.test("rows with a non-user source are left to normal derivation", () => {
  const v = { status: "verified" as const, reasonNotConfirmed: null };
  assertEquals(guardUserSuppliedStatus(v, "exa_search (nytimes.com/x)", null).status, "verified");
  assertEquals(
    guardUserSuppliedStatus(v, "user_supplied (unicourt.com docket) + exa_search (nytimes.com/x)", null).status,
    "verified",
  );
  // a non-user entry in metadata.sources also makes it mixed
  assert(!isUserSuppliedOnly("user_supplied", { sources: ["exa_search (x.com)"] }));
  assert(isUserSuppliedOnly("user_supplied", { sources: ["user-provided pivot"] }));
});

Deno.test("empty / non-matching sources never trigger", () => {
  assert(!isUserSuppliedOnly(undefined, null));
  assert(!isUserSuppliedOnly("", null));
  assert(!isUserSuppliedOnly("user_suppliedfoo.example", null));
});

Deno.test("kill switch restores legacy behaviour", () => {
  Deno.env.set(KILL, "true");
  try {
    const g = guardUserSuppliedStatus({ status: "verified", reasonNotConfirmed: null }, "user_supplied (unicourt.com docket)", null);
    assertEquals(g.status, "verified");
    assertEquals(g.userSuppliedUnreviewed, false);
    assertEquals(userSuppliedStatusSelfTest().detail, "LEGACY via USER_SUPPLIED_STATUS_CEILING_DISABLED");
  } finally {
    Deno.env.delete(KILL);
  }
});

Deno.test("health self-test passes with the rule on", () => {
  assert(userSuppliedStatusSelfTest().ok);
});

Deno.test("wiring: BOTH record tools apply the guard before status is used (source-level)", async () => {
  const src = await Deno.readTextFile(new URL("../../functions/osint-agent/tool-registry.ts", import.meta.url));
  assertEquals((src.match(/guardUserSuppliedStatus\(/g) ?? []).length, 2);
  assertEquals((src.match(/user_supplied_unreviewed: true/g) ?? []).length, 2, "flag stamped on both paths");
  assert(!/const ordinaryStatus = resolveRecordingStatus\(/.test(src), "no unguarded status derivation left");
  const h = await Deno.readTextFile(new URL("../../functions/osint-agent/health-handler.ts", import.meta.url));
  assert(h.includes("userSuppliedStatusSelfTest()"));
});
