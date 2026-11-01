import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { fetchAllPages } from "@/lib/fetch-all-pages";
import {
  OBSERVATION_WINDOW_DAYS,
  summarizeToolObservations,
  type ObservationRow,
  type ObservationSummary,
} from "@/lib/tool-observation-classes";

/** Rows per request, kept under PostgREST's default 1,000-row response cap. */
export const OBSERVATION_PAGE_SIZE = 500;
/**
 * Most tool-call rows read. The owner account logged ~4,800 live calls in 30 days (2026-11-01),
 * so this is well past the window today; if it is ever reached the panel says its figures cover
 * only the newest rows instead of labelling a partial read as "30 days".
 */
export const OBSERVATION_ROW_LIMIT = 20_000;

// `tool_usage_log.outcome` is live in the table but missing from the generated `Database` type
// (src/integrations/supabase/types.ts is generated), so a typed `.select()` of it would not
// compile. Same cast as `useThreadToolHealth` and `SourcesTab`, kept structural so `any` stays out.
interface LooseResult<T> { data: T[] | null; error: { message: string } | null }
interface LooseQuery<T> extends PromiseLike<LooseResult<T>> {
  select(columns: string): LooseQuery<T>;
  eq(column: string, value: string | boolean): LooseQuery<T>;
  gte(column: string, value: string): LooseQuery<T>;
  order(column: string, opts?: { ascending?: boolean }): LooseQuery<T>;
  range(from: number, to: number): LooseQuery<T>;
}
const toolLog = () =>
  (supabase as unknown as { from(t: string): unknown }).from("tool_usage_log") as LooseQuery<ObservationRow>;

export interface ToolObservationsState {
  loading: boolean;
  /** set when a page failed; the panel then says so rather than showing an empty, healthy-looking list */
  error: string | null;
  summary: ObservationSummary;
  /** the read stopped at OBSERVATION_ROW_LIMIT, so older calls in the window are missing */
  truncated: boolean;
}

const EMPTY_SUMMARY: ObservationSummary = {
  tools: [],
  totals: { tools: 0, attempts: 0, failed: 0, classes: { transport: 0, credential_plan: 0, rate_limited: 0, input_rejected: 0, other: 0 } },
};

export function useToolObservations(userId: string | undefined): ToolObservationsState {
  const [state, setState] = useState<ToolObservationsState>({ loading: true, error: null, summary: EMPTY_SUMMARY, truncated: false });

  useEffect(() => {
    if (!userId) return;
    let alive = true;
    (async () => {
      try {
        const now = Date.now();
        const cutoffIso = new Date(now - OBSERVATION_WINDOW_DAYS * 86_400_000).toISOString();
        const read = await fetchAllPages<ObservationRow>(
          (from, to) =>
            toolLog()
              .select("tool_name,outcome,cached,status_code,error_msg,thread_id,created_at")
              .eq("user_id", userId)
              .eq("cached", false)
              .gte("created_at", cutoffIso)
              // `id` breaks ties so rows with the same timestamp cannot be skipped or repeated across pages.
              .order("created_at", { ascending: false })
              .order("id", { ascending: false })
              .range(from, to),
          { pageSize: OBSERVATION_PAGE_SIZE, maxRows: OBSERVATION_ROW_LIMIT },
        );
        if (!alive) return;
        if (read.error) {
          setState({ loading: false, error: read.error, summary: EMPTY_SUMMARY, truncated: false });
          return;
        }
        setState({ loading: false, error: null, summary: summarizeToolObservations(read.rows, now), truncated: read.truncated });
      } catch (e) {
        // A read that THROWS (network drop, a client fault) must end the loading state with a visible
        // error. Left uncaught it is an unhandled rejection and the panel reads "Reading…" forever.
        if (!alive) return;
        setState({ loading: false, error: e instanceof Error ? e.message : "The read failed.", summary: EMPTY_SUMMARY, truncated: false });
      }
    })();
    return () => { alive = false; };
  }, [userId]);

  return state;
}
