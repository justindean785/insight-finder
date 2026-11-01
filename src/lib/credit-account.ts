/**
 * credit-account.ts — what the Credits tab says about the account itself.
 *
 * `user_credits` (supabase/migrations/20260629_user_credits.sql): owner and admin accounts
 * are `unlimited` and are NEVER debited, so for them a balance means nothing and "credit
 * usage" can only be read from the per-run meter. Beta accounts carry a micro-USD balance.
 * A missing row or a missing balance is "unavailable", never a $0 balance: reading absence
 * as zero is how the harness once rendered "Out of beta credits" for a healthy account.
 *
 * "TODAY" IS NOT THE RAW COLUMN. The ledger zeroes `daily_spent_micro_usd` lazily, inside
 * `debit_user_credits`, when `daily_window_start < date_trunc('day', now())`. Until that
 * user's next debit the column still holds a previous day's total, so it is only "today's"
 * spend if the window started today (UTC, the database's day). Before that, today is $0; with
 * no readable window start we cannot say, so today is `null` and the screen shows an em dash.
 */

export interface CreditRow {
  unlimited?: boolean | null;
  blocked?: boolean | null;
  balance_micro_usd?: number | null;
  spent_micro_usd?: number | null;
  daily_spent_micro_usd?: number | null;
  daily_window_start?: string | null;
}

export type CreditAccount =
  | { kind: "unlimited" }
  | { kind: "blocked" }
  | { kind: "unavailable" }
  | { kind: "beta"; balanceUsd: number; spentUsd: number; todayUsd: number | null; depleted: boolean };

const MICRO = 1_000_000;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Spend inside the ledger's current UTC day, or null when the window start cannot be read. */
function todaysSpendMicro(row: CreditRow, nowMs: number): number | null {
  if (!row.daily_window_start) return null;
  const start = new Date(row.daily_window_start).getTime();
  if (!Number.isFinite(start)) return null;
  const dayStart = Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate());
  if (start < dayStart) return 0; // the ledger has not rolled this window over yet
  return isNum(row.daily_spent_micro_usd) ? row.daily_spent_micro_usd : 0;
}

export function describeCreditAccount(row: CreditRow | null | undefined, nowMs: number = Date.now()): CreditAccount {
  if (!row) return { kind: "unavailable" };
  if (row.unlimited === true) return { kind: "unlimited" };
  if (row.blocked === true) return { kind: "blocked" };
  if (!isNum(row.balance_micro_usd)) return { kind: "unavailable" };
  return {
    kind: "beta",
    balanceUsd: row.balance_micro_usd / MICRO,
    spentUsd: (isNum(row.spent_micro_usd) ? row.spent_micro_usd : 0) / MICRO,
    todayUsd: (() => { const m = todaysSpendMicro(row, nowMs); return m === null ? null : m / MICRO; })(),
    depleted: row.balance_micro_usd <= 0,
  };
}
