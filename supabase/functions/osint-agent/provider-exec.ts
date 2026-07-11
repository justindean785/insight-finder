// provider-exec.ts — the SHARED provider-execution primitive (PR #305 review,
// finding #1 / #4).
//
// One implementation of "run a paid provider call with the operational controls,"
// consumed by BOTH:
//   • the streamText tool wrapper (cache.ts) — via `writeToolUsage` (the billing +
//     tool_usage_log telemetry primitive it used to inline), and
//   • the pre-stream anchor intake — via `executeProvider`, which runs a provider
//     call BEFORE streamText WITHOUT bypassing controls: circuit-breaker gate +
//     provider suppression, cache lookup/write, timeout + AbortSignal, outcome/error
//     classification, cost/charge, credit debit (no charge on failure/suppressed/
//     cached), and a truthful tool_usage_log row under the real operation name.
//
// It deliberately does NOT own the wrapper-only concerns (the multi-layer LRU,
// selector-reuse replay, runtime-policy/EV gating, per-run model tool-call budget)
// — those model the reasoning loop and stay in cache.ts.

import { creditsCharged } from "./billing.ts";
import { classifyToolOutcome } from "./tool-outcome.ts";
import { costForTool } from "./costs.ts";
import * as circuit from "./circuit.ts";
import { hashInput, normalizeForHash } from "./safety.ts";

type DbLike = {
  from: (t: string) => {
    insert: (row: unknown) => PromiseLike<{ error: { message?: string } | null }>;
    upsert: (row: unknown, opts?: unknown) => PromiseLike<{ error: { message?: string } | null }>;
    select: (cols: string) => {
      eq: (c: string, v: unknown) => {
        eq: (c: string, v: unknown) => {
          eq: (c: string, v: unknown) => {
            eq: (c: string, v: unknown) => {
              limit: (n: number) => PromiseLike<{ data: unknown[] | null; error: unknown }>;
            };
            limit: (n: number) => PromiseLike<{ data: unknown[] | null; error: unknown }>;
          };
        };
      };
    };
  };
};

export interface UsageCtx {
  userId: string;
  threadId: string;
  onCost?: (microUsd: number) => void;
  adminDb: DbLike;
}

/**
 * The SHARED billing + telemetry write. One tool_usage_log row per call, with the
 * exact two-number accounting the wrapper uses: `cost_micro_usd` (attributed list
 * price; paid non-cached incl. failures) and `charged_micro_usd` (ACTUAL credits —
 * success-only, 0 on cache/free/failure). `charged>0` debits credits via onCost.
 * cache.ts delegates its `logUsage` here so there is ONE implementation.
 */
export async function writeToolUsage(
  name: string,
  baseCost: number,
  ctx: UsageCtx,
  f: {
    cached: boolean;
    ok: boolean;
    durationMs: number;
    errorMsg?: string | null;
    statusCode?: number | null;
    freeCall?: boolean;
    inputJson?: Record<string, unknown> | null;
  },
): Promise<{ charged: number; outcome: string; okStored: boolean }> {
  const outcome = f.ok ? "ok" : classifyToolOutcome(f.errorMsg ?? null, f.statusCode ?? null);
  const okStored = outcome !== "failed";
  const cost = (f.cached || f.freeCall) ? 0 : baseCost;
  const charged = creditsCharged({ ok: f.ok, cached: f.cached, free: !!f.freeCall, baseCost });
  if (charged > 0) ctx.onCost?.(charged);
  const row: Record<string, unknown> = {
    user_id: ctx.userId,
    thread_id: ctx.threadId,
    tool_name: name,
    cost_micro_usd: cost,
    charged_micro_usd: charged,
    cached: f.cached,
    ok: okStored,
    outcome,
    duration_ms: f.durationMs,
    error_msg: outcome === "ok" ? null : (f.errorMsg ?? null),
    status_code: outcome === "ok" ? null : (f.statusCode ?? null),
    input_json: f.inputJson ?? null,
  };
  try {
    let { error } = await ctx.adminDb.from("tool_usage_log").insert(row);
    if (error && /outcome/i.test(error.message ?? "")) {
      const { outcome: _omit, ...legacy } = row;
      ({ error } = await ctx.adminDb.from("tool_usage_log").insert(legacy));
    }
    if (error) console.warn(`[tool_usage_log] insert failed for ${name}: ${error.message}`);
  } catch (e) {
    console.warn(`[tool_usage_log] insert threw for ${name}:`, e);
  }
  return { charged, outcome, okStored };
}

// ---- minimal result classification (provider results are simple {ok,data}/{error})
function resultOk(result: unknown): boolean {
  if (!result || typeof result !== "object") return true;
  const r = result as Record<string, unknown>;
  if (r.skipped === true) return true; // intentional no-op, not a failure
  if (typeof r.ok === "boolean") return r.ok;
  if (typeof r.error === "string" && r.error.length > 0) return false;
  return true;
}
function resultFree(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const r = result as Record<string, unknown>;
  if (r.skipped === true) return true;
  if (typeof r.error === "string") {
    const e = r.error.toLowerCase();
    return e.includes("disabled") || e.includes("not configured") || e.includes("degraded") || e.includes("gated");
  }
  return false;
}
function resultError(result: unknown): { errorMsg: string | null; statusCode: number | null } {
  if (!result || typeof result !== "object") return { errorMsg: null, statusCode: null };
  const r = result as Record<string, unknown>;
  const raw = typeof r.error === "string" ? r.error : typeof r.message === "string" ? (r.message as string) : null;
  const status = typeof r.status === "number" ? r.status : typeof r.status_code === "number" ? (r.status_code as number) : null;
  return { errorMsg: raw ? raw.slice(0, 500) : status ? `upstream returned HTTP ${status}` : "tool returned no usable result", statusCode: status };
}

async function runWithTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T | { ok: false; error: string; _tool_timeout: true }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fn(ctrl.signal);
  } catch (e) {
    if (ctrl.signal.aborted) return { ok: false, error: `exceeded ${ms}ms timeout`, _tool_timeout: true };
    return { ok: false, error: String(e) } as { ok: false; error: string; _tool_timeout: true };
  } finally {
    clearTimeout(timer);
  }
}

export interface ProviderExecOpts {
  /** Truthful operation name — the tool_usage_log name, circuit key, and cost key.
   *  Use a dedicated anchor operation (e.g. "anchor_profile_read"), NOT a wrapped
   *  tool that did not run. */
  operation: string;
  provider?: string;
  selectorType: string;
  selectorValue: string;
  purpose?: string;
  /** Normalized request identity for cache key + input_json. */
  cacheInput: unknown;
  timeoutMs?: number;
  baseCost?: number;
  cache?: boolean;   // default true
  circuit?: boolean; // default true
}

export interface ProviderExecResult<T> {
  result: T | null;
  ok: boolean;
  cached: boolean;
  skipped: boolean;
  charged: number;
  reason?: string;
}

/**
 * Run one provider call with the full control set, for pre-stream callers that
 * don't have the AI-SDK tool loop. Returns the (possibly cached) result plus the
 * accounting outcome. Never throws.
 */
export async function executeProvider<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ctx: UsageCtx,
  opts: ProviderExecOpts,
): Promise<ProviderExecResult<T>> {
  const name = opts.operation;
  const baseCost = opts.baseCost ?? costForTool(name);
  const purpose = opts.purpose ?? "anchor";
  const selector = circuit.normalizeSelector(opts.selectorType, opts.selectorValue);
  const useCache = opts.cache !== false;
  const useCircuit = opts.circuit !== false;
  const t0 = Date.now();

  // 1. Circuit-breaker + provider-suppression gate.
  if (useCircuit) {
    const d = circuit.shouldRun(ctx.threadId, name, selector, purpose, {});
    if (!d.allow) {
      await writeToolUsage(name, baseCost, ctx, { cached: false, ok: false, durationMs: 0, errorMsg: d.reason ?? "circuit open", freeCall: true, inputJson: null });
      return { result: null, ok: false, cached: false, skipped: true, charged: 0, reason: d.reason };
    }
  }

  // 2. Cache lookup (exact request identity).
  let inputHash = "";
  if (useCache) {
    try {
      inputHash = await hashInput(normalizeForHash(opts.cacheInput));
      const { data } = await ctx.adminDb
        .from("tool_call_cache")
        .select("output_json, expires_at")
        .eq("user_id", ctx.userId)
        .eq("tool_name", name)
        .eq("input_hash", inputHash)
        .eq("stale", false)
        .limit(1);
      const hit = Array.isArray(data) && data.length ? (data[0] as { output_json?: unknown; expires_at?: string | null }) : null;
      const fresh = hit && (hit.expires_at == null || new Date(hit.expires_at).getTime() > Date.now());
      if (fresh) {
        await writeToolUsage(name, baseCost, ctx, { cached: true, ok: true, durationMs: Date.now() - t0, inputJson: { input: opts.cacheInput } });
        return { result: (hit!.output_json ?? null) as T, ok: true, cached: true, skipped: false, charged: 0 };
      }
    } catch (e) {
      console.warn(`[provider-exec] cache lookup failed for ${name}:`, (e as Error).message);
    }
  }

  // 3. Run with timeout + AbortSignal.
  const result = (await runWithTimeout(fn, opts.timeoutMs ?? 15_000)) as T;
  const ok = resultOk(result);
  const { errorMsg, statusCode } = ok ? { errorMsg: null, statusCode: null } : resultError(result);

  // 4. Circuit record (drives breaker + provider suppression state).
  if (useCircuit) {
    try {
      circuit.recordResult(ctx.threadId, name, selector, purpose, { status: circuit.classifyResult(result, null), artifactCount: 0 });
    } catch { /* best-effort */ }
  }

  // 5. Cache write-back on success.
  if (useCache && ok && inputHash) {
    try {
      await ctx.adminDb.from("tool_call_cache").upsert({
        user_id: ctx.userId,
        investigation_id: ctx.threadId,
        tool_name: name,
        input_hash: inputHash,
        input_json: { input: opts.cacheInput },
        output_json: result ?? {},
        selector_type: opts.selectorType,
        selector_normalized: selector,
      }, { onConflict: "user_id,tool_name,input_hash" });
    } catch (e) {
      console.warn(`[provider-exec] cache write failed for ${name}:`, (e as Error).message);
    }
  }

  // 6. Telemetry + billing (shared with the wrapper).
  const { charged } = await writeToolUsage(name, baseCost, ctx, {
    cached: false, ok, durationMs: Date.now() - t0, errorMsg, statusCode, freeCall: resultFree(result), inputJson: { input: opts.cacheInput },
  });

  return { result, ok, cached: false, skipped: false, charged };
}
