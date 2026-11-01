/**
 * credit-account.ts — what the Credits tab says about the account itself.
 *
 * `user_credits` (supabase/migrations/20260629_user_credits.sql): owner and admin accounts
 * are `unlimited` and are NEVER debited, so for them a balance means nothing and "credit
 * usage" can only be read from the per-run meter. Beta accounts carry a micro-USD balance.
 * A missing row or a missing balance is "unavailable", never a $0 balance: reading absence
 * as zero is how the harness once rendered "Out of beta credits" for a healthy account.
 */

export interface CreditRow {
  unlimited?: boolean | null;
  blocked?: boolean | null;
  balance_micro_usd?: number | null;
  spent_micro_usd?: number | null;
  daily_spent_micro_usd?: number | null;
}

export type CreditAccount =
  | { kind: "unlimited" }
  | { kind: "blocked" }
  | { kind: "unavailable" }
  | { kind: "beta"; balanceUsd: number; spentUsd: number; todayUsd: number; depleted: boolean };

const MICRO = 1_000_000;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function describeCreditAccount(row: CreditRow | null | undefined): CreditAccount {
  if (!row) return { kind: "unavailable" };
  if (row.unlimited === true) return { kind: "unlimited" };
  if (row.blocked === true) return { kind: "blocked" };
  if (!isNum(row.balance_micro_usd)) return { kind: "unavailable" };
  return {
    kind: "beta",
    balanceUsd: row.balance_micro_usd / MICRO,
    spentUsd: (isNum(row.spent_micro_usd) ? row.spent_micro_usd : 0) / MICRO,
    todayUsd: (isNum(row.daily_spent_micro_usd) ? row.daily_spent_micro_usd : 0) / MICRO,
    depleted: row.balance_micro_usd <= 0,
  };
}
