import { describe, it, expect } from "vitest";
import { describeCreditAccount } from "@/lib/credit-account";

describe("describeCreditAccount", () => {
  it("reports an unlimited account as never debited, whatever the balance column says", () => {
    const a = describeCreditAccount({ unlimited: true, blocked: false, balance_micro_usd: 0, spent_micro_usd: 0, daily_spent_micro_usd: 0 });
    expect(a.kind).toBe("unlimited");
  });

  it("reports a beta account with its balance, lifetime spend and today's spend in dollars", () => {
    const a = describeCreditAccount({ unlimited: false, blocked: false, balance_micro_usd: 312_450, spent_micro_usd: 187_550, daily_spent_micro_usd: 41_200 });
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
});
