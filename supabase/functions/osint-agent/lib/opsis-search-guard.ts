// lib/opsis-search-guard.ts — a paid Opsis search is only started when it can be read.
//
// MEASURED (thread 0ea52455, 2026-10-21..23, build aae1152): 11 paid opsis_search calls
// ($3.30, half the case's whole cost), 4 read by opsis_results, 7 never read ($2.10 paid for
// nothing). The finalize-side collect phase (orchestrator-finalize.ts, 2026-10-19) was live
// and could not help: its own comment says that at the WALL-CLOCK finalize trigger a collect
// step is never affordable, and 12 of the 16 runs ended `finalize_forced`.
//
// THE RULE. The fix is on the SEARCH side, before a credit is spent — never more work inside
// the finalize window (CLAUDE.md: that path owns this project's worst incidents):
//   1. at most MAX_UNCOLLECTED_OPSIS_RUNS runs may be un-collected per thread; a further
//      opsis_search is refused, uncharged, and told to read the pending runs first (free);
//   2. a new search is refused, uncharged, when the run cannot read it before the report:
//      the search's own wait + the collect step + the completion sequence the finalize path
//      already budgets for (requiredCompletionMs, no correlate) must fit in what remains.
// A refused search is NOT lost: the pending run ids and the selector are replayed in the next
// turn's history (pendingOpsisRuns reads them), and reading a run is free, so the model can
// start the search at the top of its next turn with the whole budget ahead of it.
//
// What this deliberately does NOT do: it never blocks opsis_results (reading is free and is
// the thing we want), never touches the finalize path, never changes what a search returns.
//
// Kill switch, read at call time: OPSIS_SEARCH_GUARD_DISABLED=true restores the legacy
// behaviour (every search admitted) on the running build with no deploy.

import { OPSIS_POLL_DEADLINE_MS } from "./opsis.ts";
import { OPSIS_COLLECT_BUDGET_MS, requiredCompletionMs, type OpsisPendingRun } from "../orchestrator-finalize.ts";

export type { OpsisPendingRun };

/** The constant head of every refusal's error text. tool-outcome.ts SKIP_RE names it, so the
 *  tool_usage_log row is `skipped`, never `failed`: a refusal must not count against Opsis's health. */
export const OPSIS_GUARD_SKIP_PREFIX = "opsis search guard:";

/** Un-collected runs a thread may hold before a further paid search is refused. */
export const MAX_UNCOLLECTED_OPSIS_RUNS = 2;

/** Wall-clock one opsis_search occupies: its internal poll deadline plus request slack. */
export const OPSIS_SEARCH_WALL_MS = OPSIS_POLL_DEADLINE_MS + 5_000;

/**
 * Run time that must remain for a search started NOW to be read before the report:
 * the search itself, then the collect step, then the completion sequence (planning turn,
 * closing synthesis, safety margin — the finalize path's own numbers, with no correlate).
 * Under the current constants: 30s + 30s + 80s = 140s of a 180s budget, so a collectable
 * search starts within the first ~40s of a run. That is strict on purpose: a search that
 * cannot be read this run costs a credit for nothing, and the next turn can start it free
 * of this constraint.
 */
export function opsisSearchNeededMs(): number {
  return OPSIS_SEARCH_WALL_MS + OPSIS_COLLECT_BUDGET_MS + requiredCompletionMs({ correlateBudgetMs: 0 });
}

type EnvGet = (k: string) => string | undefined;

function readEnvSafe(k: string): string | undefined {
  try {
    return (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get(k);
  } catch {
    return undefined;
  }
}

export function opsisSearchGuardDisabled(env: EnvGet = readEnvSafe): boolean {
  return (env("OPSIS_SEARCH_GUARD_DISABLED") ?? "").trim().toLowerCase() === "true";
}

export type OpsisSearchRefusal = "pending_same_selector" | "uncollected_cap" | "deadline";

export type OpsisSearchDecision =
  | { allow: true }
  | {
    allow: false;
    reason: OpsisSearchRefusal;
    uncollected: number;
    remaining_ms: number | null;
    needed_ms: number;
    note: string;
    /** For pending_same_selector: the run the model should read instead. */
    pending_run?: OpsisPendingRun;
  };

export const OPSIS_GUARD_NOTE_SAME_SELECTOR =
  "This selector already has an Opsis run that has not been read — from this turn or an earlier one. " +
  "Read it with opsis_results { run_id, kind, value } (free) instead of paying for a second search.";
export const OPSIS_GUARD_NOTE_CAP =
  "Opsis runs from this thread are still un-collected. Read each one with opsis_results (free) before starting another paid opsis_search; " +
  "a search whose results are never read costs a credit for nothing.";
export const OPSIS_GUARD_NOTE_DEADLINE =
  "Not enough run time remains to read a new Opsis search before the report, so it was not started and no credit was spent. " +
  "Start it at the beginning of your next turn, when the whole time budget is ahead of it; any run already started can still be read with opsis_results (free).";

/**
 * Pure decision. `remainingMs` is the run's remaining wall-clock. A NON-FINITE reading FAILS
 * CLOSED (refused), matching the finalize path's rule that an unreadable bound is treated as
 * exhausted — a paid call must never be admitted on an instrument that cannot be read. `null`
 * means NO clock is wired (a caller outside the orchestrator); then only the cap applies — the
 * wiring test pins that index.ts always supplies the clock.
 */
export function decideOpsisSearch(input: {
  uncollected: number;
  remainingMs: number | null;
  /** An un-read run for the SAME selector (kind + value), if any: a repeat is never a new search. */
  sameSelectorRun?: OpsisPendingRun | null;
  enabled?: boolean;
  maxUncollected?: number;
  neededMs?: number;
}): OpsisSearchDecision {
  if (input.enabled === false) return { allow: true };
  const max = input.maxUncollected ?? MAX_UNCOLLECTED_OPSIS_RUNS;
  const needed = input.neededMs ?? opsisSearchNeededMs();
  const uncollected = Number.isFinite(input.uncollected) ? Math.max(0, Math.floor(input.uncollected)) : 0;
  const remaining = typeof input.remainingMs === "number" && Number.isFinite(input.remainingMs) ? Math.round(input.remainingMs) : null;
  if (input.sameSelectorRun && input.sameSelectorRun.run_id) {
    return {
      allow: false,
      reason: "pending_same_selector",
      uncollected,
      remaining_ms: remaining,
      needed_ms: needed,
      note: OPSIS_GUARD_NOTE_SAME_SELECTOR,
      pending_run: { ...input.sameSelectorRun },
    };
  }
  if (uncollected >= max) {
    return {
      allow: false,
      reason: "uncollected_cap",
      uncollected,
      remaining_ms: typeof input.remainingMs === "number" && Number.isFinite(input.remainingMs) ? Math.round(input.remainingMs) : null,
      needed_ms: needed,
      note: OPSIS_GUARD_NOTE_CAP,
    };
  }
  if (input.remainingMs !== null && (!Number.isFinite(input.remainingMs) || input.remainingMs < needed)) {
    return {
      allow: false,
      reason: "deadline",
      uncollected,
      remaining_ms: Number.isFinite(input.remainingMs) ? Math.round(input.remainingMs) : null,
      needed_ms: needed,
      note: OPSIS_GUARD_NOTE_DEADLINE,
    };
  }
  return { allow: true };
}

/** The pending run whose selector equals this search's (case- and whitespace-insensitive), if any. */
export function findPendingForSelector(pending: readonly OpsisPendingRun[], kind: unknown, value: unknown): OpsisPendingRun | null {
  const k = String(kind ?? "").trim().toLowerCase();
  const v = String(value ?? "").trim().toLowerCase();
  if (!k || !v) return null;
  for (const r of pending) {
    if (String(r.kind ?? "").trim().toLowerCase() === k && String(r.value ?? "").trim().toLowerCase() === v) return r;
  }
  return null;
}

// ---- Per-thread registry of runs started but not yet read ----------------------------
// The replayed history tells the next STEP about earlier steps' runs (index.ts hands the
// wrapper `pendingOpsisRuns(stepMessages)`), but a parallel fan-out inside ONE step starts
// several searches before any of them is in the history. This registry sees those. The two
// sources are unioned by run id, so a run counts once wherever it was seen.

/** Bounded like circuit.ts: an isolate serves a handful of threads, never thousands. */
export const MAX_TRACKED_OPSIS_THREADS = 256;
const THREADS = new Map<string, Map<string, OpsisPendingRun>>();

function threadSet(threadId: string): Map<string, OpsisPendingRun> {
  const existing = THREADS.get(threadId);
  if (existing) {
    THREADS.delete(threadId);
    THREADS.set(threadId, existing);
    return existing;
  }
  const s = new Map<string, OpsisPendingRun>();
  THREADS.set(threadId, s);
  while (THREADS.size > MAX_TRACKED_OPSIS_THREADS) {
    const oldest = THREADS.keys().next().value;
    if (oldest === undefined || oldest === threadId) break;
    THREADS.delete(oldest);
  }
  return s;
}

function bodyOf(result: unknown): Record<string, unknown> | null {
  const r = result as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return null;
  // The wrapper may hand the SDK envelope `{type, value}`; an Opsis body carries its own
  // string `value` (the selector), so only a nested OBJECT value is the envelope.
  return (typeof r.value === "object" && r.value !== null && !("run_id" in r)) ? r.value as Record<string, unknown> : r;
}

function runIdOf(result: unknown): string {
  const body = bodyOf(result);
  return body && typeof body.run_id === "string" ? body.run_id.trim() : "";
}

/** After a live opsis_search: a PARTIAL ok result is a run that still needs reading. The
 *  selector is taken from the result body (Opsis echoes kind and value), falling back to the input. */
export function noteOpsisSearchOutcome(threadId: string, result: unknown, input?: { kind?: unknown; value?: unknown }): void {
  const runId = runIdOf(result);
  if (!runId) return;
  const body = bodyOf(result)!;
  if (body.ok === true && body.partial === true) {
    threadSet(threadId).set(runId, {
      run_id: runId,
      kind: String(typeof body.kind === "string" ? body.kind : input?.kind ?? ""),
      value: String(typeof body.value === "string" ? body.value : input?.value ?? ""),
    });
  } else threadSet(threadId).delete(runId); // complete / failed: nothing left to read
}

/** After any opsis_results read: the run has been read, whatever it returned. */
export function noteOpsisResultsOutcome(threadId: string, result: unknown, requestedRunId?: unknown): void {
  const runId = runIdOf(result) || (typeof requestedRunId === "string" ? requestedRunId.trim() : "");
  if (!runId) return;
  const s = THREADS.get(threadId);
  if (s) s.delete(runId);
}

/** Union of the registry and the runs replayed from history, by run id, sorted by run id. */
export function uncollectedOpsisRuns(threadId: string, replayed: readonly OpsisPendingRun[] = []): OpsisPendingRun[] {
  const byId = new Map<string, OpsisPendingRun>();
  for (const r of replayed) {
    const id = typeof r?.run_id === "string" ? r.run_id.trim() : "";
    if (id) byId.set(id, { run_id: id, kind: String(r.kind ?? ""), value: String(r.value ?? "") });
  }
  for (const [id, r] of THREADS.get(threadId) ?? []) if (!byId.has(id)) byId.set(id, r);
  return [...byId.values()].sort((a, b) => a.run_id < b.run_id ? -1 : a.run_id > b.run_id ? 1 : 0);
}

export function clearOpsisGuardThread(threadId: string): void {
  THREADS.delete(threadId);
}

/** /health → checks.opsis_search_guard. Pure; PRESENCE proves the build, ok proves the rule. */
export function opsisSearchGuardSelfTest(): { ok: boolean; detail: string } {
  if (opsisSearchGuardDisabled()) return { ok: true, detail: "LEGACY via OPSIS_SEARCH_GUARD_DISABLED" };
  const needed = opsisSearchNeededMs();
  const cap = decideOpsisSearch({ uncollected: MAX_UNCOLLECTED_OPSIS_RUNS, remainingMs: needed * 2 });
  const late = decideOpsisSearch({ uncollected: 0, remainingMs: needed - 1 });
  const bad = decideOpsisSearch({ uncollected: 0, remainingMs: Number.NaN });
  const fine = decideOpsisSearch({ uncollected: MAX_UNCOLLECTED_OPSIS_RUNS - 1, remainingMs: needed });
  const off = decideOpsisSearch({ uncollected: 99, remainingMs: 0, enabled: false });
  const probe = `__opsis_guard_probe_${Date.now()}`;
  noteOpsisSearchOutcome(probe, { ok: true, partial: true, run_id: "r1", kind: "username", value: "one" });
  noteOpsisSearchOutcome(probe, { ok: true, partial: true, run_id: "r2", kind: "email", value: "Two@Example.test" });
  noteOpsisResultsOutcome(probe, { ok: true, run_id: "r1" });
  const registry = uncollectedOpsisRuns(probe, [{ run_id: "r3", kind: "username", value: "three" }]);
  const same = findPendingForSelector(registry, "EMAIL", " two@example.test ");
  const repeat = decideOpsisSearch({ uncollected: 1, remainingMs: needed * 2, sameSelectorRun: same });
  clearOpsisGuardThread(probe);
  const ok = !cap.allow && cap.reason === "uncollected_cap" &&
    !late.allow && late.reason === "deadline" &&
    !bad.allow && bad.reason === "deadline" &&
    fine.allow && off.allow &&
    registry.length === 2 && registry[0].run_id === "r2" && registry[1].run_id === "r3" &&
    same?.run_id === "r2" && !repeat.allow && repeat.reason === "pending_same_selector";
  return ok
    ? {
      ok: true,
      detail: `search-side guard: a repeat of an un-read run is read not re-bought, max ${MAX_UNCOLLECTED_OPSIS_RUNS} un-collected runs per thread, a new search needs ${Math.round(needed / 1000)}s of run time to be read before the report; refusals are free, logged skipped, never a provider failure`,
    }
    : { ok: false, detail: "opsis search guard misbehaving" };
}
