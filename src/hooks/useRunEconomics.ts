import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { fetchAllPages } from "@/lib/fetch-all-pages";
import {
  dailySpendUsd,
  sumTokens,
  summarizeRuns,
  type InvocationRow,
  type RunEconomics,
  type RunTokens,
  type StepTokenRow,
} from "@/lib/run-economics";

/** How far back the tab looks. The summary windows (14 / 30 days) are inside it. */
export const RUN_WINDOW_DAYS = 30;
/** Rows per request. Kept under PostgREST's default 1,000-row response cap. */
export const RUN_PAGE_SIZE = 500;
/**
 * Most runs read. At the ~12 runs a day measured on 2026-11-01 (355 in 30 days) this is far
 * past the window; if it is ever reached the tab says its figures cover only the newest
 * RUN_ROW_LIMIT runs, instead of labelling a partial read as "30 days".
 */
export const RUN_ROW_LIMIT = 3000;
/** Runs listed on screen; token totals are fetched for these only. */
export const RECENT_RUN_LIMIT = 12;

// `orchestrator_invocations` / `orchestrator_step_metrics` are not in the generated
// `Database` type yet (src/integrations/supabase/types.ts is generated), so `.from()` would
// not type-check. This structural type covers exactly the calls below and keeps `any` out.
// Both tables have owner-scoped SELECT policies, so the explicit `user_id` filter is
// belt-and-braces, not the access control.
interface LooseResult<T> { data: T[] | null; error: { message: string } | null }
interface LooseQuery<T> extends PromiseLike<LooseResult<T>> {
  select(columns: string): LooseQuery<T>;
  eq(column: string, value: string): LooseQuery<T>;
  in(column: string, values: string[]): LooseQuery<T>;
  range(from: number, to: number): LooseQuery<T>;
  gte(column: string, value: string): LooseQuery<T>;
  order(column: string, opts?: { ascending?: boolean }): LooseQuery<T>;
  limit(n: number): LooseQuery<T>;
}
const looseFrom = <T,>(table: string) =>
  (supabase as unknown as { from(t: string): unknown }).from(table) as LooseQuery<T>;

const INVOCATION_COLUMNS =
  "id,thread_id,started_at,duration_ms,step_count,tool_call_count,stop_reason,credits_micro_usd,model_id,persist_ms,salvage_ms,salvage_outcome,unfinished_steps";

export interface RunEconomicsState {
  loading: boolean;
  /** set when the run read failed; the tab then says so instead of showing zeros */
  error: string | null;
  /** runs in the 30-day window, newest first */
  recent: InvocationRow[];
  tokens: Map<string, RunTokens>;
  summary: RunEconomics;
  /** recorded cost per day, last 14 days, oldest first */
  daily: number[];
  /** the invocation read hit RUN_ROW_LIMIT, so older runs in the window are missing */
  truncated: boolean;
}

const EMPTY: RunEconomicsState = {
  loading: true,
  error: null,
  recent: [],
  tokens: new Map(),
  summary: summarizeRuns([], Date.now()),
  daily: new Array<number>(14).fill(0),
  truncated: false,
};

export function useRunEconomics(userId: string | undefined): RunEconomicsState {
  const [state, setState] = useState<RunEconomicsState>(EMPTY);

  useEffect(() => {
    if (!userId) return;
    let alive = true;
    (async () => {
      const now = Date.now();
      const cutoffMs = now - RUN_WINDOW_DAYS * 86_400_000;
      const cutoffIso = new Date(cutoffMs).toISOString();
      const read = await fetchAllPages<InvocationRow>(
        (from, to) =>
          looseFrom<InvocationRow>("orchestrator_invocations")
            .select(INVOCATION_COLUMNS)
            .eq("user_id", userId)
            .gte("started_at", cutoffIso)
            // `id` breaks ties so two runs with the same timestamp cannot be skipped or repeated across pages.
            .order("started_at", { ascending: false })
            .order("id", { ascending: false })
            .range(from, to),
        { pageSize: RUN_PAGE_SIZE, maxRows: RUN_ROW_LIMIT },
      );
      if (!alive) return;
      if (read.error) {
        setState({ ...EMPTY, loading: false, error: read.error });
        return;
      }
      const data = read.rows;
      // The window is enforced here too, not only in the query: it is what the summary
      // figures promise, whatever the server returned.
      const rows = data
        .filter((r) => new Date(r.started_at).getTime() >= cutoffMs)
        .sort((a, b) => b.started_at.localeCompare(a.started_at));
      const recent = rows.slice(0, RECENT_RUN_LIMIT);

      let tokens = new Map<string, RunTokens>();
      if (recent.length > 0) {
        const steps = await looseFrom<StepTokenRow>("orchestrator_step_metrics")
          .select("invocation_id,input_tokens,output_tokens")
          .eq("user_id", userId)
          .in("invocation_id", recent.map((r) => r.id))
          .limit(2000);
        if (!alive) return;
        // A failed token read leaves tokens blank ("—"); it never blocks the cost figures.
        if (!steps.error && steps.data) tokens = sumTokens(steps.data);
      }

      setState({
        loading: false,
        error: null,
        recent,
        tokens,
        summary: summarizeRuns(rows, now),
        daily: dailySpendUsd(rows, 14, now),
        truncated: read.truncated,
      });
    })();
    return () => { alive = false; };
  }, [userId]);

  return state;
}
