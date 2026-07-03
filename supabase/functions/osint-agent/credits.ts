/**
 * credits.ts — Pure, unit-testable credit-gate logic for the per-user beta
 * ledger (user_credits / debit_user_credits, see
 * supabase/migrations/20260629_user_credits.sql).
 * Extracted from index.ts's inline pre-run gate + mid-run debit callback so
 * the exempt/blocked/below-reserve/daily-cap/fail-open branches are directly
 * testable (audit finding F29) and the mid-run hard-stop (F02) and daily-cap
 * gate on new runs (F04) share one source of truth with the pre-run gate.
 */

// Must match debit_user_credits' `_daily_cap_micro_usd` default
// (supabase/migrations/20260629_user_credits.sql:81, $1.00/day). Duplicated
// here only for the read-only pre-run comparison — the DB is authoritative
// for actually enforcing the cap on a real debit.
export const DAILY_CAP_MICRO_USD = 1_000_000;

export interface CreditRow {
  balance_micro_usd?: number;
  unlimited?: boolean;
  blocked?: boolean;
}

export interface CreditGateResult {
  allow: boolean;
  exempt: boolean;
  code?: "INSUFFICIENT_CREDITS";
  detail?: string;
}

/**
 * Pre-run gate: may this user start a run at all? OWNER/ADMIN are always
 * exempt (unlimited, never blocked/reserved). A missing row, a blocked
 * account, or a balance under the reserve all deny — this function is pure
 * (no DB access), so the caller decides fail-open-on-exception separately
 * (see index.ts's surrounding try/catch: bookkeeping errors fail OPEN, a
 * genuinely fetched blocked/low-balance row does not).
 */
export function evaluateCreditGate(
  creditRow: CreditRow | null,
  isAdmin: boolean,
  reserveMicroUsd: number,
): CreditGateResult {
  const exempt = !!creditRow?.unlimited || isAdmin;
  if (exempt) return { allow: true, exempt: true };

  const balance = Number(creditRow?.balance_micro_usd ?? 0);
  const blocked = !!creditRow?.blocked;
  if (!creditRow || blocked || balance < reserveMicroUsd) {
    return {
      allow: false,
      exempt: false,
      code: "INSUFFICIENT_CREDITS",
      detail: blocked
        ? "Your account is paused. Contact us to restore access."
        : "You've used your beta credit allowance — contact us to top up.",
    };
  }
  return { allow: true, exempt: false };
}

export interface DailyCapRow {
  daily_spent?: number;
  unlimited?: boolean;
}

export interface DailyCapGateResult {
  allow: boolean;
  code?: "DAILY_CAP_REACHED";
  detail?: string;
}

/**
 * Daily-cap gate (F04): even a user with balance left should not be able to
 * start a fresh run once today's spend has already hit the daily backstop —
 * debit_user_credits only refuses the LEDGER WRITE, it does not on its own
 * stop a new run from being admitted at the per-run reserve. Callers should
 * source `dailyCapRow.daily_spent` from a rollover-aware read (e.g. calling
 * debit_user_credits with amount=0, which self-corrects daily_spent_micro_usd
 * across the UTC day boundary) rather than a raw SELECT, so a day-boundary
 * rollover a raw SELECT hasn't observed yet can't cause a false deny.
 */
export function evaluateDailyCapGate(
  dailyCapRow: DailyCapRow | null,
  dailyCapMicroUsd: number = DAILY_CAP_MICRO_USD,
): DailyCapGateResult {
  if (!dailyCapRow || dailyCapRow.unlimited) return { allow: true };
  const dailySpent = Number(dailyCapRow.daily_spent ?? 0);
  if (dailySpent >= dailyCapMicroUsd) {
    return {
      allow: false,
      code: "DAILY_CAP_REACHED",
      detail: "You've hit today's spending cap — it resets at midnight UTC, or contact us to raise it.",
    };
  }
  return { allow: true };
}

export interface DebitResult {
  ok?: boolean;
  reason?: string;
}

/**
 * Mid-run hard-stop (F02): the debit RPC is fire-and-forget for latency, but
 * its result must not be silently discarded. When a debit comes back
 * `ok:false` (insufficient_balance / daily_cap / blocked), the run must abort
 * at the next step boundary instead of continuing to fire paid tool calls
 * against a ledger that just refused to record them. Returns the reason to
 * abort for (non-null means "stop"), or null to keep running.
 */
export function reasonToAbortForCredits(debitResult: DebitResult | null | undefined): string | null {
  if (!debitResult) return null;
  if (debitResult.ok === false) return debitResult.reason ?? "exhausted";
  return null;
}
