// breach_exposure needs a breach-class tool that RAN in the case, and a non-zero result.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  breachExposureGuardDisabled,
  breachExposureGuardSelfTest,
  checkBreachExposureRow,
  isBreachCapableTool,
  isZeroHitBreachRow,
  loadRanBreachTools,
} from "../../../functions/osint-agent/lib/breach-exposure-guard.ts";
import { extractFindings } from "../../../functions/osint-agent/auto-persist-findings.ts";

const ran = new Set(["breach_check", "serus_darkweb_scan", "oathnet_stealer_search"]);
const check = (value: string, sourceLabels: string[], metadata: Record<string, unknown> = {}, r = ran) =>
  checkBreachExposureRow({ value, sourceLabels, metadata, ranTools: r });

Deno.test("legitimate breach rows pass — compound and annotated source labels", () => {
  assert(check("dizosint (breach_check: 1 hit, IPs …)", ["breach_check (stolen.tax/OsintCat/Snusbase)"]).ok);
  assert(check("katiecaraotta@yahoo.com — 19 breaches", ["rapidapi_breach_search / leakcheck_lookup / serus_darkweb_scan"]).ok);
});

Deno.test("Caraotta: a Lemon8 post read by socialfetch cannot be breach_exposure", () => {
  const v = check("Lemon8 post #2: 'Stylish Winter and Baddie Outfits'", ["socialfetch_web_read"]);
  assertEquals(v.ok, false);
  assertEquals(!v.ok && v.code, "no_breach_source_ran");
});

Deno.test("adversarial: a social post that CLAIMS a leak, with a breach-sounding label, still fails", () => {
  const v = check("Instagram post: 'my password leaked in a breach'", ["socialfetch_web_read (leaked breach dump)"]);
  assertEquals(v.ok, false);
});

Deno.test("naming a breach tool that never ran in this case is not enough", () => {
  const v = check("x exposure", ["leakcheck_lookup"]);
  assertEquals(!v.ok && v.code, "no_breach_source_ran");
  assertEquals(check("x exposure", ["leakcheck_lookup"], {}, new Set(["leakcheck_lookup"])).ok, true);
});

Deno.test("the model's source_category never satisfies the guard", () => {
  const v = check("Lemon8 post", ["socialfetch_web_read"], { source_category: ["breach"] });
  assertEquals(v.ok, false);
});

Deno.test("dizosint: zero-hit results are not exposures", () => {
  for (const [value, meta] of [
    ["dizosint - serus_darkweb_scan: 0 breaches, 0 pastes (clean)", { total_breaches: 0, total_pastes: 0 }],
    ["Breach exposure: 99.161.169.172 (clean)", {}],
    ["foo@example.com — 0 hits", {}],
  ] as const) {
    const v = check(value, ["serus_darkweb_scan"], meta as Record<string, unknown>);
    assertEquals(!v.ok && v.code, "zero_hit_result", value);
  }
  assertEquals(isZeroHitBreachRow("10 breaches across 4 corpora", {}), false);
  assertEquals(isZeroHitBreachRow("Neopets breach 2013", { total_breaches: 1 }), false);
});

Deno.test("port162 (2026-10-29): 'no breach hits' / 'no stealer log hits' wordings are zero-hit results", () => {
  for (const [value, src] of [
    ["NO BREACH HITS", "breach_check"],
    ["port162 - no breach hits", "breach_check"],
    ["NO STEALER LOG HITS", "oathnet_stealer_search"],
    ["port162 — No stealer hits", "oathnet_stealer_search"],
    ["no stealer logs hit", "oathnet_stealer_search"],
  ] as const) {
    const v = check(value, [src]);
    assertEquals(!v.ok && v.code, "zero_hit_result", value);
  }
  // Positive stealer/breach hit counts are not caught by the new wording.
  assertEquals(isZeroHitBreachRow("Neopets breach — stealer log hits: 3", {}), false);
  assertEquals(isZeroHitBreachRow("3 stealer log hits for port162", {}), false);
});

Deno.test("/health detail names the no-breach/stealer-hits shape (proof key for this build)", () => {
  const d = breachExposureGuardSelfTest().detail;
  assert(/no breach\/stealer hits/.test(d), d);
});

Deno.test("isBreachCapableTool uses server classification of the slug", () => {
  assertEquals(isBreachCapableTool("breach_check"), true);
  assertEquals(isBreachCapableTool("opsis_search"), true);
  assertEquals(isBreachCapableTool("socialfetch_web_read"), false);
  assertEquals(isBreachCapableTool("minimax_web_search"), false);
});

Deno.test("loadRanBreachTools keeps only breach-capable tools and fails open on a read error", async () => {
  const rows = [{ tool_name: "breach_check" }, { tool_name: "socialfetch_web_read" }, { tool_name: "OATHNET_LOOKUP" }];
  const ok = {
    from: () => ({ select: () => ({ eq: () => ({ in: () => ({ limit: () => Promise.resolve({ data: rows, error: null }) }) }) }) }),
  };
  assertEquals([...(await loadRanBreachTools(ok, "t"))!].sort(), ["breach_check", "oathnet_lookup"]);
  const bad = {
    from: () => ({ select: () => ({ eq: () => ({ in: () => ({ limit: () => Promise.resolve({ data: null, error: new Error("x") }) }) }) }) }),
  };
  assertEquals(await loadRanBreachTools(bad, "t"), null);
});

Deno.test("auto-extraction: an HIBP-shaped payload yields breach_exposure only from a breach-capable tool", () => {
  const out = { ok: true, breaches: [{ Name: "Adobe" }, { Name: "LinkedIn" }] };
  const input = { email: "subject@example.com" };
  const fromBreach = extractFindings("breach_check", out, input).filter((f) => f.kind === "breach_exposure");
  assertEquals(fromBreach.length, 1, "control: the breach tool still yields its exposure");
  const fromSocial = extractFindings("socialfetch_web_read", out, input).filter((f) => f.kind === "breach_exposure");
  assertEquals(fromSocial.length, 0);
});

Deno.test("kill switch parses only an explicit true; /health self-test passes", () => {
  assertEquals(breachExposureGuardDisabled(() => "true"), true);
  assertEquals(breachExposureGuardDisabled(() => "yes"), false);
  assertEquals(breachExposureGuardSelfTest().ok, true);
});
