/**
 * case-metrics.ts — per-case artifact / tool-call counts for the cases list.
 *
 * WHY THIS EXISTS. CasesPage used to fetch every artifact row and every
 * tool_usage_log row for the user (`.select("thread_id").eq("user_id", …)
 * .limit(10000)`) and tally them in the browser. Measured on live production
 * 2026-08-06, that account held 11,610 artifacts and 17,783 tool rows, so
 * 1,610 and 7,783 rows (44%) fell outside the window and every thread owning
 * them rendered "0 artifacts · 0 tool calls" while holding real evidence.
 *
 * Neither query had an ORDER BY, so which rows survived was planner-dependent —
 * it under-reported by an arbitrary subset, not a predictable tail. The live
 * tell was a case showing "0 artifacts · 1 tool calls" against an actual 23/61.
 *
 * Counting happens in Postgres now (get_case_metrics, migration 20260806),
 * so the numbers are exact at any volume and the page transfers one row per
 * case instead of ~30,000 rows.
 */
export type CaseMetrics = { artifacts: number; toolCalls: number };

type MetricsRow = {
  thread_id: string;
  artifacts: number | string | null;
  tool_calls: number | string | null;
};

/** Minimal shape of the Supabase client this needs — keeps the module testable. */
export interface CaseMetricsClient {
  rpc(fn: string, args?: Record<string, unknown>): Promise<{
    data: unknown;
    error: { message?: string } | null;
  }>;
}

export async function loadCaseMetrics(
  client: CaseMetricsClient,
): Promise<Map<string, CaseMetrics>> {
  const { data, error } = await client.rpc("get_case_metrics");
  // A failed aggregate must NOT read as "every case is empty" — that is the
  // exact misreport this module exists to remove. Let the caller surface it.
  if (error) throw new Error(error.message ?? "get_case_metrics failed");

  const m = new Map<string, CaseMetrics>();
  for (const row of (data ?? []) as MetricsRow[]) {
    if (!row?.thread_id) continue;
    m.set(row.thread_id, {
      artifacts: Number(row.artifacts ?? 0),
      toolCalls: Number(row.tool_calls ?? 0),
    });
  }
  return m;
}
