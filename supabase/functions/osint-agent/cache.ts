/**
 * cache.ts — Central tool-cache wrapper, tier tagging, auto-evidence, and cache marking.
 * Extracted from index.ts (lines 834–1185).
 * All 77 tools flow through wrapToolsWithCache().
 */

import { createClient } from "npm:@supabase/supabase-js@2";
import type { Tool } from "npm:ai@6";
import { hashInput, normalizeForHash, sanitizeToolOutput, TOOL_CACHE_LRU } from "./safety.ts";
import { tierForTool, modelForTool, type Tier } from "./models.ts";
import { costForTool } from "./costs.ts";
import { NO_CACHE_TOOLS, TOOL_TTL_MS } from "./validation.ts";
import { creditsCharged } from "./billing.ts";
import * as circuit from "./circuit.ts";

// ---- Central tool cache wrapper ------------------------------------------------
// Wraps every tool with a three-layer cache (memory → db → live), cost tracking,
// telemetry logging, and optional auto-evidence mirroring. All 77 tools flow
// through this function.
export function wrapToolsWithCache(
  toolsObj: Record<string, Tool>,
  ctx: {
    investigationId: string;
    userId: string;
    supabase: ReturnType<typeof createClient>;
    supabaseAdmin?: ReturnType<typeof createClient>;
    onCost?: (microUsd: number) => void;
  },
) {
  const wrapped: Record<string, Tool> = {};
  const adminDb = ctx.supabaseAdmin ?? ctx.supabase;
  // Derive a real success flag from a tool's return value. A tool can return
  // without throwing yet still represent a failure (HTTP non-2xx wrapped into
  // { ok:false }, an `error` field, or a stub). The wrapper must NOT log such
  // calls as ok=true — otherwise tool_usage_log lies about reality.
  const deriveOk = (result: unknown): boolean => {
    if (!result || typeof result !== "object") return true;
    const r = result as Record<string, unknown>;
    if (typeof r.ok === "boolean") return r.ok;
    if (typeof r.error === "string" && r.error.length > 0) return false;
    if (r.skipped === true) return false;
    return true;
  };
  // Detect calls that didn't actually consume provider quota / credits so we
  // don't bill for them: disabled stubs (firecrawl_*), gated tools (intelbase
  // when unhealthy), and tools that bailed because their API key isn't set.
  const isFreeCall = (result: unknown): boolean => {
    if (!result || typeof result !== "object") return false;
    const r = result as Record<string, unknown>;
    if (r.skipped === true) return true;
    if (typeof r.error === "string") {
      const e = r.error.toLowerCase();
      if (e.includes("disabled")) return true;
      if (e.includes("not configured")) return true;
      if (e.includes("degraded")) return true;
    }
    return false;
  };
  // Strip anything that looks like an API credential before it lands in
  // tool_usage_log.error_msg or edge logs. Covers Bearer tokens, OpenAI-style
  // sk- keys, and Google AIza keys.
  const redactSecrets = (input: string): string =>
    input
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
      .replace(/sk-[A-Za-z0-9._-]+/g, "sk-[REDACTED]")
      .replace(/AIza[A-Za-z0-9_-]+/g, "AIza[REDACTED]");
  // Pull a human-readable error message + status code out of a tool result
  // so failed calls leave a durable trace in tool_usage_log.
  const extractToolError = (
    result: unknown,
  ): { errorMsg: string | null; statusCode: number | null } => {
    if (!result || typeof result !== "object") return { errorMsg: null, statusCode: null };
    const r = result as Record<string, unknown>;
    const rawError =
      typeof r.error === "string"
        ? r.error
        : typeof r.message === "string"
          ? (r.message as string)
          : null;
    // extractToolError is only called for non-ok results, so a missing error
    // string is a SILENT failure — it shows up in the timeline as a reasonless
    // red "failed". Derive a concrete fallback so every failure is explained.
    const fallback = ((): string | null => {
      if (rawError) return null;
      if (typeof r.reason === "string" && r.reason) return r.reason;
      if (r.skipped === true) return "skipped — no usable result";
      if (typeof r.status === "number") return `upstream returned HTTP ${r.status}`;
      if (typeof r.status_code === "number") return `upstream returned HTTP ${r.status_code}`;
      return "tool returned no usable result";
    })();
    const errorMsg = rawError ? redactSecrets(rawError).slice(0, 500) : fallback;
    const statusCode =
      typeof r.status === "number"
        ? (r.status as number)
        : typeof r.status_code === "number"
          ? (r.status_code as number)
          : null;
    return { errorMsg, statusCode };
  };
  for (const [name, t] of Object.entries(toolsObj)) {
    const tier = tierForTool(name);
    const model = modelForTool(name);
    const baseCost = costForTool(name);
    const scrub = (o: unknown) => (NO_SANITIZE_TOOLS.has(name) ? o : sanitizeToolOutput(o));
    const logUsage = async (
      cached: boolean,
      ok: boolean,
      durationMs: number,
      errorMsg: string | null = null,
      statusCode: number | null = null,
      freeCall: boolean = false,
    ) => {
      // Attributed (list) price of this call — logged for every paid, non-cached
      // call so the export can separate charged vs avoided. The actual credit
      // charge is success-only: failed/timed-out/dup-key calls bill nothing.
      const cost = (cached || freeCall) ? 0 : baseCost;
      const charged = creditsCharged({ ok, cached, free: freeCall, baseCost });
      if (charged > 0) ctx.onCost?.(charged);
      try {
        const { error } = await adminDb.from("tool_usage_log").insert({
          user_id: ctx.userId,
          thread_id: ctx.investigationId,
          tool_name: name,
          cost_micro_usd: cost,
          cached,
          ok,
          duration_ms: durationMs,
          error_msg: ok ? null : errorMsg,
          status_code: ok ? null : statusCode,
        });
        if (error) console.warn(`[tool_usage_log] insert failed for ${name}: ${error.message}`);
      } catch (e) {
        console.warn(`[tool_usage_log] insert threw for ${name}:`, e);
      }
    };
    if (NO_CACHE_TOOLS.has(name) || typeof t?.execute !== "function") {
      // Still wrap so we can tag the output with tier/model badges.
      if (typeof t?.execute === "function") {
        const orig = t.execute.bind(t);
        wrapped[name] = {
          ...t,
          execute: async (input: unknown, opts: unknown) => {
            const t0 = Date.now();
            let ok = true;
            let out: unknown;
            let errInfo: { errorMsg: string | null; statusCode: number | null } = { errorMsg: null, statusCode: null };
            try {
              out = await orig(input, opts);
              ok = deriveOk(out);
              if (!ok) errInfo = extractToolError(out);
              return tagTier(scrub(out), tier, model);
            } catch (e) {
              ok = false;
              errInfo = { errorMsg: redactSecrets(String((e as Error)?.message ?? e)).slice(0, 500), statusCode: null };
              throw e;
            }
            finally { logUsage(false, ok, Date.now() - t0, errInfo.errorMsg, errInfo.statusCode, isFreeCall(out)); }
          },
        };
      } else {
        wrapped[name] = t;
      }
      continue;
    }
    const originalExecute = t.execute.bind(t);
    const ttl = TOOL_TTL_MS[name] ?? null;

    wrapped[name] = {
      ...t,
      execute: async (input: unknown, opts: unknown) => {
        const t0 = Date.now();
        // ---- Circuit breaker + dedup gate ----
        const inp = (input ?? {}) as Record<string, unknown>;
        const sel = circuit.normalizeSelector(
          String(inp.kind ?? ""),
          inp.value ?? inp.email ?? inp.username ?? inp.domain ?? inp.ip ?? inp.phone ?? inp.url ?? "",
        );
        const purpose = String(inp.purpose ?? "default");
        const force = inp.force === true;
        const decision = circuit.shouldRun(ctx.investigationId, name, sel, purpose, { force });
        if (!decision.allow) {
          await logUsage(false, false, Date.now() - t0, decision.reason, null, true);
          return { ok: false, skipped: true, error: decision.reason, _breaker: true };
        }
        let hash: string;
        try { hash = await hashInput(input); }
        catch {
          let ok = true;
          let out: unknown;
          let errInfo: { errorMsg: string | null; statusCode: number | null } = { errorMsg: null, statusCode: null };
          try {
            out = tagTier(scrub(await originalExecute(input, opts)), tier, model);
            ok = deriveOk(out);
            if (!ok) errInfo = extractToolError(out);
            return out;
          } catch (e) {
            ok = false;
            errInfo = { errorMsg: redactSecrets(String((e as Error)?.message ?? e)).slice(0, 500), statusCode: null };
            throw e;
          }
          finally { logUsage(false, ok, Date.now() - t0, errInfo.errorMsg, errInfo.statusCode, isFreeCall(out)); }
        }
        const key = `${ctx.investigationId}:${name}:${hash}`;
        const now = Date.now();
        const fresh = (createdAt: number) => ttl == null || (now - createdAt) < ttl;

        // 1) in-memory
        const mem = TOOL_CACHE_LRU.get(key);
        if (mem && fresh(mem.createdAt)) {
          logUsage(true, true, Date.now() - t0);
          return markCached(mem.output, new Date(mem.createdAt).toISOString(), "memory");
        }

        // 2) database
        try {
          const { data } = await ctx.supabase
            .from("tool_call_cache")
            .select("output_json, created_at")
            .eq("investigation_id", ctx.investigationId)
            .eq("tool_name", name)
            .eq("input_hash", hash)
            .maybeSingle();
          if (data) {
            const row = data as { created_at: string; output_json: unknown };
            const createdAt = new Date(row.created_at).getTime();
            if (fresh(createdAt)) {
              const output = row.output_json;
              TOOL_CACHE_LRU.set(key, { output, createdAt });
              logUsage(true, true, Date.now() - t0);
              return markCached(output, row.created_at, "db");
            }
          }
        } catch { /* fall through to live call */ }

        // 3) live
        let ok = true;
        let result: unknown;
        let errInfo: { errorMsg: string | null; statusCode: number | null } = { errorMsg: null, statusCode: null };
        try {
          result = tagTier(scrub(await originalExecute(input, opts)), tier, model);
          ok = deriveOk(result);
          if (!ok) errInfo = extractToolError(result);
          circuit.recordResult(ctx.investigationId, name, sel, purpose, {
            status: circuit.classifyResult(result, null),
            artifactCount: 0,
          });
        } catch (e) {
          ok = false;
          const msg = redactSecrets(String((e as Error)?.message ?? e)).slice(0, 500);
          logUsage(false, false, Date.now() - t0, msg, null);
          circuit.recordResult(ctx.investigationId, name, sel, purpose, {
            status: circuit.classifyResult(null, e),
            artifactCount: 0,
          });
          throw e;
        }
        const createdAtIso = new Date().toISOString();
        // Only cache successful results — caching a failure would poison
        // subsequent calls with the same input.
        if (ok) {
          TOOL_CACHE_LRU.set(key, { output: result, createdAt: Date.now() });
          try {
            await ctx.supabase.from("tool_call_cache").upsert(
              {
                investigation_id: ctx.investigationId,
                tool_name: name,
                input_hash: hash,
                input_json: normalizeForHash(input) as unknown as Record<string, unknown>,
                output_json: result as unknown as Record<string, unknown>,
                created_at: createdAtIso,
              },
              { onConflict: "investigation_id,tool_name,input_hash" },
            );
          } catch { /* best-effort */ }
        }
        logUsage(false, ok, Date.now() - t0, errInfo.errorMsg, errInfo.statusCode, isFreeCall(result));
        if (AUTO_EVIDENCE_TOOLS.has(name)) {
          // Fire-and-forget: never let auto-evidence block the tool result.
          autoAppendToolEvidence(ctx.supabase, ctx, name, input, result).catch(() => {});
        }
        return result;
      },
    };
  }
  return wrapped;
}

// ---- Tier / model badge tagging ------------------------------------------------
// Tag a tool result with the model tier that produced it so the timeline can
// render a "fast" / "smart" badge. Non-object results get wrapped.
export function tagTier(output: unknown, tier: Tier, model: string) {
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const o = output as Record<string, unknown>;
    // Don't overwrite a more specific tier already set by the tool itself.
    return { ...o, _tier: o._tier ?? tier, _model: o._model ?? model };
  }
  return { value: output, _tier: tier, _model: model };
}

// ---- No-sanitize tools ---------------------------------------------------------
// Tools whose outputs are already small/safe and should NOT be passed through
// sanitizeToolOutput (it would just waste cycles or strip legitimate fields
// that look like sensitive keys — e.g. our own `record_artifact` payloads).
export const NO_SANITIZE_TOOLS = new Set<string>([
  "list_tools",
  "record_artifact",
  "record_artifacts",
  "record_evidence",
  "memory_recall",
  "memory_save",
  "jina_reader_scrape",
]);

// ---- Auto-evidence tools -------------------------------------------------------
// Tools whose results should be auto-mirrored into the chain-of-custody log
// so investigators always have a tamper-evident record of breach/leak/footprint
// queries — even when the agent forgets to call record_evidence.
export const AUTO_EVIDENCE_TOOLS = new Set<string>([
  "breach_check",
  "leakcheck_lookup",
  "stolentax_footprint",
  "intelbase_email_lookup",
  "oathnet_lookup",
  "deepfind_reverse_email",
  "deepfind_profile_analyzer",
  "hunter_combined",
  "username_sweep",
  "jina_reader_scrape",
]);

// ---- Evidence seed extraction --------------------------------------------------
export function extractEvidenceSeed(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  for (const k of ["email", "value", "seed", "username", "phone", "domain", "ip", "query", "target"]) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 200);
  }
  return "";
}

// ---- Hit counting --------------------------------------------------------------
function countHits(output: unknown): number {
  if (!output || typeof output !== "object") return 0;
  const o = output as Record<string, unknown>;
  for (const k of ["total", "count", "hit_count", "found"]) {
    const v = o[k];
    if (typeof v === "number" && v > 0) return v;
  }
  for (const k of ["hits", "results", "breaches", "sources", "accounts"]) {
    const v = o[k];
    if (Array.isArray(v)) return v.length;
  }
  return 0;
}

// ---- Auto-evidence appender ----------------------------------------------------
async function autoAppendToolEvidence(
  userDb: ReturnType<typeof createClient>,
  ctx: { investigationId: string; userId: string },
  toolName: string,
  input: unknown,
  output: unknown,
) {
  try {
    const seed = extractEvidenceSeed(input);
    if (!seed) return;
    const hits = countHits(output);
    // soft = procedural record of the query (incl. confirmed-clean zero-hit runs)
    const snapshot = JSON.stringify({ input, summary: { hits } }).slice(0, 1500);
    await userDb.rpc("append_evidence", {
      _thread_id: ctx.investigationId,
      _artifact_id: null,
      _tool_name: toolName,
      _source: toolName,
      _source_url: null,
      _classification: "soft",
      _confidence: null,
      _kind: "tool_query",
      _value: seed,
      _content_snapshot: snapshot,
      _metadata: { tool: toolName, hits, auto: true },
    });
  } catch (e) {
    console.warn(`[auto_evidence] ${toolName} failed:`, (e as Error).message);
  }
}

// ---- Cache marker --------------------------------------------------------------
export function markCached(output: unknown, cachedAt: string, layer: "memory" | "db") {
  if (output && typeof output === "object" && !Array.isArray(output)) {
    return { ...(output as Record<string, unknown>), _cached: true, _cached_at: cachedAt, _cache_layer: layer };
  }
  return { value: output, _cached: true, _cached_at: cachedAt, _cache_layer: layer };
}
