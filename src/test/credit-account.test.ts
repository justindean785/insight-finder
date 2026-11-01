import { describe, it, expect } from "vitest";
import { describeCreditAccount } from "@/lib/credit-account";

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0); // 2026-11-01 12:00Z
const at = (iso: string) => iso;

describe("describeCreditAccount", () => {
  it("reports an unlimited account as never debited, whatever the balance column says", () => {
    const a = describeCreditAccount({ unlimited: true, blocked: false, balance_micro_usd: 0, spent_micro_usd: 0, daily_spent_micro_usd: 0 });
    expect(a.kind).toBe("unlimited");
  });

  it("reports a beta account with its balance, lifetime spend and today's spend in dollars", () => {
    const a = describeCreditAccount(
      { unlimited: false, blocked: false, balance_micro_usd: 312_450, spent_micro_usd: 187_550, daily_spent_micro_usd: 41_200, daily_window_start: at("2026-11-01T03:10:00Z") },
      NOW,
    );
    expect(a).toEqual({ kind: "beta", balanceUsd: 0.31245, spentUsd: 0.18755, todayUsd: 0.0412, depleted: false });
  });

  it("marks a zero balance as depleted", () => {
    const a = describeCreditAccount({ unlimited: false, blocked: false, balance_micro_usd: 0, spent_micro_usd: 500_000, daily_spent_micro_usd: 0 });
    expect(a).toMatchObject({ kind: "beta", depleted: true });
  });

  it("marks a blocked account as blocked", () => {
    const a = describeCreditAccount({ unlimited: false, blocked: true, balance_micro_usd: 100_000, spent_micro_usd: 0, daily_spent_micro_usd: 0 });
    expect(a.kind).toBe("blocked");
  });

  it("reports unavailable when the row is missing, instead of showing a $0 balance", () => {
    expect(describeCreditAccount(null).kind).toBe("unavailable");
    expect(describeCreditAccount(undefined).kind).toBe("unavailable");
  });

  it("reports unavailable when the balance column is absent from the row", () => {
    expect(describeCreditAccount({ unlimited: false, blocked: false } as never).kind).toBe("unavailable");
  });

  // The ledger zeroes `daily_spent_micro_usd` lazily, inside debit_user_credits, when
  // daily_window_start < date_trunc('day', now()). A beta user who has not run anything today
  // therefore still has yesterday's total in the column; showing it as "today" is wrong.
  it("shows today's spend as zero when the daily window started before today (UTC)", () => {
    const a = describeCreditAccount(
      { unlimited: false, blocked: false, balance_micro_usd: 300_000, spent_micro_usd: 200_000, daily_spent_micro_usd: 41_200, daily_window_start: at("2026-10-31T22:40:00Z") },
      NOW,
    );
    expect(a).toMatchObject({ kind: "beta", todayUsd: 0, spentUsd: 0.2 });
  });

  it("keeps today's spend when the window started earlier today, including exactly at 00:00:00Z", () => {
    const row = { unlimited: false, blocked: false, balance_micro_usd: 300_000, spent_micro_usd: 200_000, daily_spent_micro_usd: 41_200 };
    expect(describeCreditAccount({ ...row, daily_window_start: at("2026-11-01T00:00:00Z") }, NOW)).toMatchObject({ todayUsd: 0.0412 });
    expect(describeCreditAccount({ ...row, daily_window_start: at("2026-11-01T11:59:59Z") }, NOW)).toMatchObject({ todayUsd: 0.0412 });
  });

  it("cannot tell today's spend when the window start is missing or unreadable, and says so with null", () => {
    const row = { unlimited: false, blocked: false, balance_micro_usd: 300_000, spent_micro_usd: 200_000, daily_spent_micro_usd: 41_200 };
    expect(describeCreditAccount({ ...row, daily_window_start: null }, NOW)).toMatchObject({ kind: "beta", todayUsd: null });
    expect(describeCreditAccount({ ...row, daily_window_start: "not-a-date" }, NOW)).toMatchObject({ kind: "beta", todayUsd: null });
  });
});
