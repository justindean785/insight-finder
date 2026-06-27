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
import { DEFAULT_TOOL_TTL_MS, NO_CACHE_TOOLS, redactSensitiveToolInput, TOOL_TTL_MS } from "./validation.ts";
import { creditsCharged } from "./billing.ts";
import * as circuit from "./circuit.ts";
import {
  analyzeWeakLead,
  currentStage,
  ensureCycle,
  finishCall,
  notePlanCall,
  noteRejectedCall,
  scoreExpectedValue,
  startCall,
  type SelectorEvidenceSignal,
  type ToolCostTier,
} from "./runtime-policy.ts";

const SELECTOR_SIGNAL_CACHE = new Map<string, SelectorEvidenceSignal>();

function detectSelectorType(input: Record<string, unknown>): string {
  const hinted = String(input.kind ?? input.selector_type ?? "").trim().toLowerCase();
  if (hinted) return hinted;
  if (typeof input.email === "string") return "email";
  if (typeof input.username === "string" || typeof input.handle === "string") return "username";
  if (typeof input.domain === "string") return "domain";
  if (typeof input.phone === "string") return "phone";
  if (typeof input.ip === "string") return "ip";
  if (typeof input.url === "string") return "url";
  if (typeof input.name === "string") return "name";
  if (typeof input.value === "string") return "value";
  return "value";
}

function detectSelectorValue(input: Record<string, unknown>): string {
  const raw = input.value ?? input.email ?? input.username ?? input.handle ?? input.domain ?? input.ip ?? input.phone ?? input.url ?? input.name ?? input.seed ?? "";
  return typeof raw === "string" ? raw : String(raw ?? "");
}

const SELECTOR_INPUT_KEYS = new Set([
  "value",
  "email",
  "username",
  "handle",
  "domain",
  "ip",
  "phone",
  "url",
  "name",
  "seed",
  "kind",
  "selector_type",
  "force",
  "manual_override",
  "manualOverride",
]);

function normalizedParams(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([key]) => !SELECTOR_INPUT_KEYS.has(key)),
  );
}

function costTierForTool(baseCost: number): ToolCostTier {
  if (baseCost <= 0) return "free";
  if (baseCost <= 1_500) return "low";
  return "expensive";
}

function attachRuntimeMeta(
  output: unknown,
  meta: Record<string, unknown>,
) {
  if (output && typeof output === "object" && !Array.isArray(output)) {
    return { ...(output as Record<string, unknown>), _runtime: meta };
  }
  return { value: output, _runtime: meta };
}

async function loadSelectorEvidence(
  userDb: ReturnType<typeof createClient>,
  threadId: string,
  selectorType: string,
  normalizedSelector: string,
): Promise<SelectorEvidenceSignal> {
  const key = `${threadId}:${selectorType}:${normalizedSelector}`;
  const cached = SELECTOR_SIGNAL_CACHE.get(key);
  if (cached) return cached;
  const empty: SelectorEvidenceSignal = {
    selector: normalizedSelector,
    selectorType,
    confidence: null,
    sourceCount: 0,
    sourceNames: [],
    artifactKinds: [],
    statuses: [],
    relatedProfile: false,
    aiSummaryOnly: false,
    usernameCollision: false,
    noHit: false,
    emptyProfile: false,
    sameNameWithoutOverlap: false,
    displayNameOnly: false,
  };
  if (!normalizedSelector) return empty;
  try {
    const likelyKinds = selectorType === "username"
      ? ["username", "social", "related_profile"]
      : selectorType === "name"
        ? ["name", "identity", "related_profile"]
        : [selectorType];
    const { data } = await userDb
      .from("artifacts")
      .select("kind,value,confidence,source,metadata")
      .eq("thread_id", threadId)
      .in("kind", likelyKinds)
      .limit(100);
    const rows = ((data ?? []) as Array<{
      kind?: string | null;
      value?: string | null;
      confidence?: number | null;
      source?: string | null;
      metadata?: Record<string, unknown> | null;
    }>).filter((row) =>
      circuit.normalizeSelector(row.kind ?? selectorType, row.value ?? "") === normalizedSelector
    );
    if (rows.length === 0) return empty;
    const sourceNames = new Set<string>();
    const artifactKinds = new Set<string>();
    const statuses = new Set<string>();
    let confidence: number | null = null;
    let relatedProfile = false;
    let aiSummaryOnly = false;
    let usernameCollision = false;
    let noHit = false;
    let emptyProfile = false;
    let sameNameWithoutOverlap = false;
    let displayNameOnly = false;
    for (const row of rows) {
      if (row.source) sourceNames.add(String(row.source));
      if (row.kind) artifactKinds.add(String(row.kind));
      if (typeof row.confidence === "number") confidence = confidence == null ? row.confidence : Math.max(confidence, row.confidence);
      const meta = row.metadata ?? {};
      const status = typeof meta.status === "string" ? meta.status : null;
      if (status) statuses.add(status);
      const reason = `${meta.reason ?? ""} ${meta.reason_not_confirmed ?? ""} ${meta.next_verification_step ?? ""}`.toLowerCase();
      relatedProfile ||= row.kind === "related_profile" || meta.related_profile === true;
      aiSummaryOnly ||= String(meta.source_category ?? "").toLowerCase().includes("ai_summary") || reason.includes("ai summary");
      usernameCollision ||= reason.includes("collision") || reason.includes("different handle") || reason.includes("same-name collision");
      noHit ||= reason.includes("0 hit") || reason.includes("zero hit") || reason.includes("no hit");
      emptyProfile ||= reason.includes("private profile") || reason.includes("empty profile") || reason.includes("no content");
      sameNameWithoutOverlap ||= reason.includes("same-name") || reason.includes("out-of-area");
      displayNameOnly ||= reason.includes("display name") || meta.display_name_only === true;
    }
    const signal: SelectorEvidenceSignal = {
      selector: normalizedSelector,
      selectorType,
      confidence,
      sourceCount: sourceNames.size,
      sourceNames: [...sourceNames],
      artifactKinds: [...artifactKinds],
      statuses: [...statuses],
      relatedProfile,
      aiSummaryOnly,
      usernameCollision,
      noHit,
      emptyProfile,
      sameNameWithoutOverlap,
      displayNameOnly,
    };
    SELECTOR_SIGNAL_CACHE.set(key, signal);
    return signal;
  } catch {
    return empty;
  }
}

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
    manualOverrideSelector?: string | null;
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
      inputJson: Record<string, unknown> | null = null,
    ) => {
      // Two distinct numbers, intentionally logged separately:
      //  • cost_micro_usd   — ATTRIBUTED list price. Logged for every paid,
      //    non-cached call (incl. failures) so the export can separate charged
      //    vs. avoided spend. A failed call still carries its list price here.
      //  • charged_micro_usd — ACTUAL credits consumed. Success-only: cache
      //    hits, free stubs, and any failure bill 0. This is the user-facing
      //    "what did this run cost me" number; cost_micro_usd is NOT.
      // Keeping them separate is what stops a failed-call list price from being
      // misread as a real charge (the tool_usage_log accounting ambiguity).
      const cost = (cached || freeCall) ? 0 : baseCost;
      const charged = creditsCharged({ ok, cached, free: freeCall, baseCost });
      if (charged > 0) ctx.onCost?.(charged);
      try {
        const { error } = await adminDb.from("tool_usage_log").insert({
          user_id: ctx.userId,
          thread_id: ctx.investigationId,
          tool_name: name,
          cost_micro_usd: cost,
          charged_micro_usd: charged,
          cached,
          ok,
          duration_ms: durationMs,
          error_msg: ok ? null : errorMsg,
          status_code: ok ? null : statusCode,
          input_json: inputJson,
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
              return tagSkipState(tagTier(scrub(out), tier, model));
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
    const ttl = TOOL_TTL_MS[name] ?? DEFAULT_TOOL_TTL_MS;

    wrapped[name] = {
      ...t,
      execute: async (input: unknown, opts: unknown) => {
        const t0 = Date.now();
        // ---- Circuit breaker + dedup gate ----
        const inp = (input ?? {}) as Record<string, unknown>;
        const selectorType = detectSelectorType(inp);
        const selectorValue = detectSelectorValue(inp);
        const sel = circuit.normalizeSelector(selectorType, selectorValue);
        const purpose = String(inp.purpose ?? "default");
        const force = inp.force === true;
        const overrideSelector = ctx.manualOverrideSelector
          ? circuit.normalizeSelector(selectorType, ctx.manualOverrideSelector)
          : "";
        const manualOverride = overrideSelector.length > 0 && overrideSelector === sel;
        // Redact sensitive inputs (e.g. HIBP password / full SHA-1) BEFORE this
        // value can reach tool_usage_log.input_json or tool_call_cache.input_json.
        const inputJson = redactSensitiveToolInput(name, normalizeForHash(input)) as unknown as Record<string, unknown>;
        const params = normalizedParams(inp);
        const signal = await loadSelectorEvidence(ctx.supabase, ctx.investigationId, selectorType, sel);
        const weakLead = analyzeWeakLead(signal);
        const expectedValue = scoreExpectedValue({
          selectorConfidence: signal.confidence,
          sourceIndependenceBonus: signal.sourceCount >= 2 ? 18 : 0,
          corroborationPotential: ["email", "phone", "domain", "username"].includes(selectorType) ? 12 : 6,
          freshnessNeed: name === "wayback_snapshots" || name === "archive_url" ? 10 : 0,
          // First call on a zero-evidence seed: any data is high-value. Without
          // this bonus, all paid breach/identity tools score 37-49 against
          // thresholds of 50-70 and get EV-blocked before a single artifact
          // lands — deadlocking the investigation on a fresh seed.
          freshSeedBonus: signal.confidence === null && signal.sourceCount === 0 ? 35 : 0,
          costPenalty: costTierForTool(baseCost) === "expensive" ? 20 : costTierForTool(baseCost) === "low" ? 8 : 0,
          duplicatePenalty: selectorType === "value" ? 8 : 0,
          priorFailurePenalty: circuit.snapshot(ctx.investigationId).find((entry) => entry.tool === name)?.consecutive ?? 0,
          collisionPenalty: signal.usernameCollision || signal.sameNameWithoutOverlap ? 20 : 0,
          weakLeadPenalty: weakLead.weak ? 22 : 0,
          repeatedToolPenalty: circuit.isPremiumTool(name) ? 6 : 0,
        });
        const runtimeMetaBase = {
          selector: sel,
          selector_type: selectorType,
          purpose,
          expected_value: expectedValue,
          manual_override: manualOverride,
          weak_lead: weakLead.weak,
          weak_lead_reasons: weakLead.reasons,
        };
        let hash: string | null = null;
        let paramsHash: string | null = null;
        try {
          paramsHash = await hashInput(params);
          hash = await hashInput({
            selector_type: selectorType,
            selector: sel,
            tool: name,
            params,
          });
        } catch {
          // Unhashable inputs can still run live, but are never cached.
        }
        const key = hash ? `${ctx.investigationId}:${name}:${hash}` : null;
        const now = Date.now();
        const fresh = (createdAt: number, expiresAt?: string | null) => {
          if (expiresAt) return now < new Date(expiresAt).getTime();
          return ttl == null || (now - createdAt) < ttl;
        };
        const cycle = ensureCycle(ctx.investigationId);
        const cacheRuntime = {
          ...runtimeMetaBase,
          stage: currentStage(ctx.investigationId),
          cycle_id: cycle.cycle_id,
        };

        // Cache lookup happens before live-call policy. Replays are transparent,
        // free, and do not consume provider budgets or count as corroboration.
        if (key) {
          const mem = TOOL_CACHE_LRU.get(key);
          if (mem && fresh(mem.createdAt)) {
            await logUsage(true, true, Date.now() - t0, null, null, false, {
              input: inputJson,
              runtime: { ...cacheRuntime, cache_layer: "thread", stale_cache: false, source_created_at: new Date(mem.createdAt).toISOString() },
            });
            return attachRuntimeMeta(markCached(mem.output, new Date(mem.createdAt).toISOString(), "thread"), {
              ...cacheRuntime,
              cache_layer: "thread",
              stale_cache: false,
              source_created_at: new Date(mem.createdAt).toISOString(),
              corroboration_eligible: false,
            });
          }
        }

        let staleRecord: {
          created_at: string;
          output_json: unknown;
          expires_at?: string | null;
          source_created_at?: string | null;
        } | null = null;
        if (hash) {
          try {
            const { data } = await adminDb
              .from("tool_call_cache")
              .select("output_json, created_at, expires_at, source_created_at")
              .eq("user_id", ctx.userId)
              .eq("tool_name", name)
              .eq("input_hash", hash)
              .order("created_at", { ascending: false })
              .maybeSingle();
            if (data) {
              const row = data as {
                created_at: string;
                output_json: unknown;
                expires_at?: string | null;
                source_created_at?: string | null;
              };
              const createdAt = new Date(row.created_at).getTime();
              if (fresh(createdAt, row.expires_at)) {
                const output = row.output_json;
                if (key) TOOL_CACHE_LRU.set(key, { output, createdAt });
                await logUsage(true, true, Date.now() - t0, null, null, false, {
                  input: inputJson,
                  runtime: { ...cacheRuntime, cache_layer: "user", stale_cache: false, source_created_at: row.source_created_at ?? row.created_at },
                });
                return attachRuntimeMeta(markCached(output, row.source_created_at ?? row.created_at, "user"), {
                  ...cacheRuntime,
                  cache_layer: "user",
                  stale_cache: false,
                  source_created_at: row.source_created_at ?? row.created_at,
                  corroboration_eligible: false,
                });
              }
              staleRecord = row;
              await adminDb
                .from("tool_call_cache")
                .update({ stale: true })
                .eq("user_id", ctx.userId)
                .eq("tool_name", name)
                .eq("input_hash", hash);
            }
          } catch (error) {
            console.warn(`[tool_call_cache] lookup failed for ${name}:`, error);
          }
        }

        const decision = circuit.shouldRun(ctx.investigationId, name, sel, purpose, { force });
        if (!decision.allow) {
          noteRejectedCall(ctx.investigationId, {
            tool_name: name,
            selector: sel,
            selector_type: selectorType,
            expected_value: expectedValue,
            reason: decision.reason,
            cost_tier: costTierForTool(baseCost),
            weak_lead: weakLead.weak,
            stale_cache: !!staleRecord,
            manual_override: manualOverride,
          });
          await logUsage(false, false, Date.now() - t0, decision.reason, null, true, {
            input: inputJson,
            runtime: { ...runtimeMetaBase, rejection_reason: decision.reason, rejection_source: "circuit" },
          });
          return attachRuntimeMeta({ ok: false, skipped: true, error: decision.reason, _breaker: true }, {
            ...runtimeMetaBase,
            rejection_reason: decision.reason,
            stage: "TRIAGE",
            cache_layer: "miss",
            stale_cache: !!staleRecord,
          });
        }
        const familyKey = `${name}::${selectorType}::${sel}`;
        const runtimeDecision = startCall({
          threadId: ctx.investigationId,
          toolName: name,
          selector: sel,
          selectorType,
          costTier: costTierForTool(baseCost),
          expectedValue,
          familyKey,
          weakLead,
          staleCache: !!staleRecord,
          manualOverride,
          force,
        });
        if (!runtimeDecision.allow) {
          noteRejectedCall(ctx.investigationId, {
            tool_name: name,
            selector: sel,
            selector_type: selectorType,
            expected_value: expectedValue,
            reason: runtimeDecision.reason,
            cost_tier: costTierForTool(baseCost),
            weak_lead: weakLead.weak,
            stale_cache: !!staleRecord,
            manual_override: manualOverride,
          });
          await logUsage(false, false, Date.now() - t0, runtimeDecision.reason, null, true, {
            input: inputJson,
            runtime: { ...runtimeMetaBase, rejection_reason: runtimeDecision.reason, rejection_source: "runtime", stage: runtimeDecision.stage, cycle_id: runtimeDecision.cycleId },
          });
          return attachRuntimeMeta({ ok: false, skipped: true, error: runtimeDecision.reason, _policy: true }, {
            ...runtimeMetaBase,
            rejection_reason: runtimeDecision.reason,
            stage: runtimeDecision.stage,
            cycle_id: runtimeDecision.cycleId,
            cache_layer: "miss",
            stale_cache: !!staleRecord,
          });
        }
        if (runtimeDecision.waitMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, runtimeDecision.waitMs));
        }
        notePlanCall(ctx.investigationId, {
          tool_name: name,
          selector: sel,
          selector_type: selectorType,
          params_preview: inputJson,
          expected_value: expectedValue,
          cost_tier: costTierForTool(baseCost),
          reason: weakLead.weak
            ? `manual override or corroborated retry despite weak lead: ${weakLead.reasons.join("; ")}`
            : "highest-value eligible pivot for this cycle",
          stop_condition: "stop if no corroborating evidence, duplicate selector, or provider suppression appears",
          cache_status: staleRecord ? "stale" : "miss",
        });

        // 3) live
        let ok = true;
        let result: unknown;
        let errInfo: { errorMsg: string | null; statusCode: number | null } = { errorMsg: null, statusCode: null };
        try {
          result = attachRuntimeMeta(tagSkipState(tagTier(scrub(await originalExecute(input, opts)), tier, model)), {
            ...runtimeMetaBase,
            stage: runtimeDecision.stage,
            cycle_id: runtimeDecision.cycleId,
            cache_layer: "miss",
            stale_cache: !!staleRecord,
            stale_source_created_at: staleRecord?.source_created_at ?? staleRecord?.created_at ?? null,
          });
          ok = deriveOk(result);
          if (!ok) errInfo = extractToolError(result);
          circuit.recordResult(ctx.investigationId, name, sel, purpose, {
            status: circuit.classifyResult(result, null),
            artifactCount: 0,
          });
        } catch (e) {
          ok = false;
          const msg = redactSecrets(String((e as Error)?.message ?? e)).slice(0, 500);
          finishCall(ctx.investigationId, name);
          logUsage(false, false, Date.now() - t0, msg, null, false, {
            input: inputJson,
            runtime: { ...runtimeMetaBase, stage: runtimeDecision.stage, cycle_id: runtimeDecision.cycleId, cache_layer: "miss", stale_cache: !!staleRecord },
          });
          circuit.recordResult(ctx.investigationId, name, sel, purpose, {
            status: circuit.classifyResult(null, e),
            artifactCount: 0,
          });
          throw e;
        }
        const createdAtIso = new Date().toISOString();
        // Only cache successful results — caching a failure would poison
        // subsequent calls with the same input.
        if (ok && hash && key) {
          TOOL_CACHE_LRU.set(key, { output: result, createdAt: Date.now() });
          try {
            const { error: cacheWriteError } = await adminDb.from("tool_call_cache").upsert(
              {
                user_id: ctx.userId,
                investigation_id: ctx.investigationId,
                tool_name: name,
                input_hash: hash,
                input_json: inputJson,
                output_json: result as unknown as Record<string, unknown>,
                selector_normalized: sel || null,
                selector_type: selectorType || null,
                params_hash: paramsHash,
                created_at: createdAtIso,
                source_created_at: createdAtIso,
                expires_at: ttl == null ? null : new Date(Date.now() + ttl).toISOString(),
                stale: false,
              },
              { onConflict: "user_id,tool_name,input_hash" },
            );
            if (cacheWriteError) {
              console.warn(`[tool_call_cache] write failed for ${name}: ${cacheWriteError.message}`);
            }
          } catch (error) {
            console.warn(`[tool_call_cache] write threw for ${name}:`, error);
          }
        }
        finishCall(ctx.investigationId, name);
        logUsage(false, ok, Date.now() - t0, errInfo.errorMsg, errInfo.statusCode, isFreeCall(result), {
          input: inputJson,
          runtime: {
            ...runtimeMetaBase,
            stage: runtimeDecision.stage,
            cycle_id: runtimeDecision.cycleId,
            cache_layer: "miss",
            stale_cache: !!staleRecord,
            source_created_at: createdAtIso,
          },
        });
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

// ---- Skip-state tagging --------------------------------------------------------
// The UI tool-status taxonomy (src/lib/tool-run.ts → deriveToolStatus) renders a
// call as "skipped" when output.skipped === true. Most self-skips already set it
// (skipStub → guard/dedup, dead-host, intelbase gate, bosint timeout) or carry
// reason text the UI regexes match (circuit/5xx/disabled → degraded; budget/quota
// → gated). The one class that does NOT is a missing-key bail: a bare
// { error: "X_API_KEY not configured" } with no flag, matching no regex — so the
// Tools tab mis-renders it. Tag exactly that case so it reads as Skipped.
// Additive only: deriveOk already treats an error/skip as not-ok and isFreeCall
// already treats "not configured" as a free (unbilled) call, so ok / billing /
// caching are unchanged.
export function tagSkipState(output: unknown): unknown {
  if (!output || typeof output !== "object") return output;
  const o = output as Record<string, unknown>;
  if (o.ok === true) return output;
  if (o.skipped === true || o.gated === true || o.degraded === true || o.partial === true) return output;
  const text = [o.error, o.note, o.reason, o.detail]
    .filter((v): v is string => typeof v === "string")
    .join(" ");
  if (/not configured/i.test(text)) o.skipped = true;
  return output;
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
export function markCached(output: unknown, cachedAt: string, layer: "thread" | "user") {
  if (output && typeof output === "object" && !Array.isArray(output)) {
    return { ...(output as Record<string, unknown>), _cached: true, _cached_at: cachedAt, _cache_layer: layer };
  }
  return { value: output, _cached: true, _cached_at: cachedAt, _cache_layer: layer };
}
