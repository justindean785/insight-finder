import { assertEquals } from "https://deno.land/std@0.224.0/testing/asserts.ts";
import {
  DAILY_CAP_MICRO_USD,
  evaluateCreditGate,
  evaluateDailyCapGate,
  reasonToAbortForCredits,
} from "./credits.ts";

// ---- evaluateCreditGate (pre-run gate) -----------------------------------------

Deno.test("evaluateCreditGate: unlimited row is always exempt+allowed", () => {
  const r = evaluateCreditGate({ unlimited: true, balance_micro_usd: 0, blocked: true }, false, 20000);
  assertEquals(r.allow, true);
  assertEquals(r.exempt, true);
});

Deno.test("evaluateCreditGate: admin role is always exempt+allowed even with a blocked/empty row", () => {
  const r = evaluateCreditGate({ unlimited: false, balance_micro_usd: 0, blocked: true }, true, 20000);
  assertEquals(r.allow, true);
  assertEquals(r.exempt, true);
});

Deno.test("evaluateCreditGate: null row (missing) denies a non-exempt user", () => {
  const r = evaluateCreditGate(null, false, 20000);
  assertEquals(r.allow, false);
  assertEquals(r.code, "INSUFFICIENT_CREDITS");
});

Deno.test("evaluateCreditGate: blocked row denies with the paused-account detail", () => {
  const r = evaluateCreditGate({ balance_micro_usd: 500000, blocked: true }, false, 20000);
  assertEquals(r.allow, false);
  assertEquals(r.detail, "Your account is paused. Contact us to restore access.");
});

Deno.test("evaluateCreditGate: balance below reserve denies with the top-up detail", () => {
  const r = evaluateCreditGate({ balance_micro_usd: 19999, blocked: false }, false, 20000);
  assertEquals(r.allow, false);
  assertEquals(r.detail, "You've used your beta credit allowance — contact us to top up.");
});

Deno.test("evaluateCreditGate: balance exactly at reserve allows (boundary)", () => {
  const r = evaluateCreditGate({ balance_micro_usd: 20000, blocked: false }, false, 20000);
  assertEquals(r.allow, true);
  assertEquals(r.exempt, false);
});

Deno.test("evaluateCreditGate: balance above reserve allows", () => {
  const r = evaluateCreditGate({ balance_micro_usd: 500000, blocked: false }, false, 20000);
  assertEquals(r.allow, true);
});

// ---- evaluateDailyCapGate (F04) -------------------------------------------------

Deno.test("evaluateDailyCapGate: null row allows (treated as no spend yet)", () => {
  const r = evaluateDailyCapGate(null);
  assertEquals(r.allow, true);
});

Deno.test("evaluateDailyCapGate: unlimited row always allows regardless of daily_spent", () => {
  const r = evaluateDailyCapGate({ unlimited: true, daily_spent: 999_999_999 });
  assertEquals(r.allow, true);
});

Deno.test("evaluateDailyCapGate: daily_spent below the cap allows", () => {
  const r = evaluateDailyCapGate({ daily_spent: DAILY_CAP_MICRO_USD - 1 });
  assertEquals(r.allow, true);
});

Deno.test("evaluateDailyCapGate: daily_spent exactly at the cap denies (boundary)", () => {
  const r = evaluateDailyCapGate({ daily_spent: DAILY_CAP_MICRO_USD });
  assertEquals(r.allow, false);
  assertEquals(r.code, "DAILY_CAP_REACHED");
});

Deno.test("evaluateDailyCapGate: daily_spent above the cap denies", () => {
  const r = evaluateDailyCapGate({ daily_spent: DAILY_CAP_MICRO_USD + 1 });
  assertEquals(r.allow, false);
});

Deno.test("evaluateDailyCapGate: honors a custom cap override", () => {
  const r = evaluateDailyCapGate({ daily_spent: 50_000 }, 40_000);
  assertEquals(r.allow, false);
});

// ---- reasonToAbortForCredits (F02 mid-run hard-stop) -----------------------------

Deno.test("reasonToAbortForCredits: null/undefined debit result never aborts", () => {
  assertEquals(reasonToAbortForCredits(null), null);
  assertEquals(reasonToAbortForCredits(undefined), null);
});

Deno.test("reasonToAbortForCredits: ok:true never aborts", () => {
  assertEquals(reasonToAbortForCredits({ ok: true }), null);
});

Deno.test("reasonToAbortForCredits: ok:undefined (malformed RPC row) never aborts", () => {
  assertEquals(reasonToAbortForCredits({}), null);
});

Deno.test("reasonToAbortForCredits: ok:false with a reason aborts with that reason", () => {
  assertEquals(reasonToAbortForCredits({ ok: false, reason: "insufficient_balance" }), "insufficient_balance");
  assertEquals(reasonToAbortForCredits({ ok: false, reason: "daily_cap" }), "daily_cap");
  assertEquals(reasonToAbortForCredits({ ok: false, reason: "blocked" }), "blocked");
});

Deno.test("reasonToAbortForCredits: ok:false with no reason falls back to 'exhausted'", () => {
  assertEquals(reasonToAbortForCredits({ ok: false }), "exhausted");
});
