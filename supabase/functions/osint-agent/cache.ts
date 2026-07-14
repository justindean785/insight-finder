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
import { classifyToolOutcome } from "./tool-outcome.ts";
import { writeToolUsage } from "./provider-exec.ts";
import * as circuit from "./circuit.ts";
import type { GuardState } from "./guard.ts";
import { shouldSkipForToolCap } from "./orchestrator-finalize.ts";
import {
  ALWAYS_ALLOW_TOOLS,
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

// ---- Per-tool hard timeout (Phase 2) ------------------------------------------
// A wall-clock cap around each LIVE tool execution so a single latency-bomb
// provider (audit: bosint_phone p95 60s, archive_url 49s, crtsh 121s, oathnet 68s,
// wayback 60s) can't hold the whole run hostage. On timeout we RESOLVE (never
// throw) with a schema-safe error result — same pairing guarantee as the catch
// paths — so the orchestrator step keeps a valid tool-call/result pair. The
// scorer's latency penalty does the gradual demotion; this cap is the hard
// backstop for the catastrophic tail. Recording tools (ALWAYS_ALLOW_TOOLS) are
// exempt — evidence writes must never be cut off.
export const DEFAULT_TOOL_TIMEOUT_MS = 12_000;
// Legit-slow tools whose p95 genuinely exceeds the default but still yield value.
// Everything else uses the default cap.
export const TOOL_TIMEOUT_OVERRIDE_MS: Record<string, number> = {
  // Phase B3 — cap the three chronic time sinks so a slow provider fails FAST with
  // a schema-safe timeout instead of holding a step open. All three forward the
  // per-tool AbortSignal into their fetch, so the cap truly cancels the in-flight
  // request (not just abandons the promise). gemini_deep_dork's p95 (~46s) exceeds
  // this cap by design: it becomes a fast-fail corroboration source, not a 30s tax.
  gemini_deep_dork: 12_000,        // was 30_000 — kill the per-run 30s timeout tail
  deepfind_reverse_email: 8_000,   // account-discovery corroboration — fail fast
  jina_reader_scrape: 8_000,       // single-page scrape — fail fast, try a lighter source
  dork_harvest: 25_000,     // wraps several web searches — p95 ~17s
  exa_search: 20_000,       // neural search + contents — p95 ~12s
  exa_find_similar: 20_000,
  exa_get_contents: 20_000,
  // archive.org (Cloudflare-fronted, chronically slow p95 ~60s) — raise past the
  // tools' own per-attempt fetch timeouts so a legit-slow archive resolves instead
  // of the 12s default cap orphaning an un-signalled request (2026-07-05 fix).
  wayback_cdx_search: 25_000,
  archive_url: 25_000,
  // Indicia broker lookups — person/address can be slow; own fetch timeout is 18s.
  indicia_email: 20_000,
  indicia_phone: 20_000,
  indicia_person: 20_000,
  indicia_address: 20_000,
  indicia_web_dbs: 20_000,
  indicia_hudsonrock: 20_000,
  // SocialFetch server-side web read (/v1/web/markdown) fetches + renders + converts
  // a full page (YouTube, etc.) upstream, which legitimately exceeds the 12s default.
  // 25s outer budget sits above the tool's own 22s per-attempt fetch timeout.
  socialfetch_web_read: 25_000,
  // Telemetry-backed overrides (live failing-tools panel 2026-07-08): these
  // chronically hit the 12s default and lose real coverage.
  // crt.sh certificate transparency is Cloudflare-fronted and slow (p95 » 12s).
  crtsh_lookup: 25_000,
  crtsh_subdomains: 25_000,
  // WHOIS registrar RDAP/port-43 chains can run long.
  whois_lookup: 20_000,
  // web.archive.org (peer of wayback_cdx_search / archive_url, which are already 25s).
  wayback_snapshots: 25_000,
  // Serus darkweb scan POLLS upstream until the scan finishes — POLL_INTERVAL_MS
  // (2.5s) × POLL_MAX_RETRIES (10) = ~25s by design (serus_core.ts), so a 12s cap
  // guaranteed a timeout on every non-trivial scan. 30s sits above the poll window.
  serus_darkweb_scan: 30_000,
  // minimax_correlate is the correlation engine — it sends the whole artifact batch
  // (up to 200 entries / 16k chars) to the smart-tier model for a 1500-token JSON
  // clustering+rescoring response. The 2026-07-08 pipeline audit caught it timing out
  // at 12,143ms on the 12s default, so correlation produced ZERO output and 73/73
  // artifacts stayed cluster_id:null (raised 12s -> 20s then). RECURRENCE 2026-07-09
  // (live fullyteamjody run): the call COMPLETED at 22,487ms but the 20s cap had already
  // binned it as a timeout — a finished correlation was thrown away. execute() doesn't
  // forward the wrapper signal, so the model call runs to completion regardless; the fix
  // is to let it finish. Its input is BOUNDED (16k chars / 1500 out tokens) so latency is
  // bounded — this is calibration, not open-ended bumping. 30s (= the serus precedent, the
  // highest existing cap) clears the observed 22.5s with headroom. We deliberately keep
  // MODELS.smart (not fast) — this is the misattribution/collision-detection step, where
  // quality outranks a few seconds.
  minimax_correlate: 30_000,
};
export function toolTimeoutMs(name: string): number {
  return TOOL_TIMEOUT_OVERRIDE_MS[name] ?? DEFAULT_TOOL_TIMEOUT_MS;
}

export interface ToolTimeoutResult {
  ok: false;
  error: string;
  _tool_error: true;
  _tool_timeout: true;
}

// Race a tool execution against a hard timeout. On timeout, RESOLVE (never
// reject/throw) with a schema-safe error result so the step keeps a valid pair;
// classifyToolOutcome buckets a "timeout" as `failed` (its documented behavior),
// and ok:false keeps the result out of the cache. A late resolution/rejection
// after the cap fired is swallowed (no unhandled rejection).
export function runWithToolTimeout<T>(
  name: string,
  factory: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<T | ToolTimeoutResult> {
  return new Promise<T | ToolTimeoutResult>((resolve, reject) => {
    let settled = false;
    // Own an AbortController so a timeout doesn't just ABANDON the promise while
    // the underlying (often paid) fetch keeps running to its own internal cap —
    // aborting it cancels the in-flight request and stops wasting cost/quota.
    // Tools that forward this signal into fetch/fetchRetry get real cancellation;
    // tools that ignore it degrade to the old abandon-the-promise behavior.
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ctrl.abort();
      resolve({
        ok: false,
        error: `${name} exceeded ${ms}ms tool timeout`,
        _tool_error: true,
        _tool_timeout: true,
      });
    }, ms);
    factory(ctrl.signal).then(
      (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } },
      // If the factory rejects AFTER we already resolved a timeout (e.g. the
      // AbortError from our own ctrl.abort()), swallow it — the timeout result
      // already went out.
      (e) => { if (settled) return; settled = true; clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Merge our per-tool timeout AbortSignal into the AI-SDK tool-execution options
 * so a tool's `execute(args, opts)` can read `opts.abortSignal` and forward it
 * to fetch. If the SDK already supplied its own abortSignal (top-level request
 * cancellation), combine both so EITHER firing aborts the call.
 */
export function withTimeoutSignal(opts: unknown, signal: AbortSignal): unknown {
  const existing = (opts as { abortSignal?: AbortSignal } | null | undefined)?.abortSignal;
  const merged = existing ? AbortSignal.any([existing, signal]) : signal;
  return { ...((opts as Record<string, unknown>) ?? {}), abortSignal: merged };
}

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

// Pure planner-annotation params: they explain WHY a tool was called but never
// change its RESULT. Excluded from the selector-reuse params hash so the SAME
// selector re-queried later in the SAME thread reuses the cached result even when
// the planner passes a different `purpose`/`reason`. Deliberately conservative —
// result-shaping params (kind/depth/limit/focus/…) are NOT here, so a different
// mode can never be served a wrong-mode cache hit.
const ANNOTATION_PARAM_KEYS = new Set(["purpose", "reason", "rationale", "note", "notes"]);

/** params minus pure annotation keys — feeds the thread-scoped selector-reuse
 * hash only; the cross-thread input_hash still uses the FULL params. Exported for
 * the selector-reuse regression test. */
export function semanticParams(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params).filter(([key]) => !ANNOTATION_PARAM_KEYS.has(key)),
  );
}

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
    // Per-run genuine-tool-call budget (MAX_TOOL_CALLS_PER_RUN). Owned by index.ts's
    // per-request closure and passed in so the wrapper can (a) increment on each
    // genuine live execution and (b) short-circuit new lookups once the cap is hit.
    // `capped` is surfaced by index.ts (finalize + telemetry). Optional so callers
    // that don't set it (tests, other entrypoints) are unaffected.
    toolCallBudget?: { genuine: number; capped: boolean };
    // Request-scoped guard state (finding #8) — the wrapper sets
    // guard.lastCorrelateOutcome from the FINAL minimax_correlate result. Optional
    // so existing tests that don't exercise minimax_correlate are unaffected; a
    // caller that does must supply the request's own requestState.guard, never a
    // shared/module-level instance.
    guard?: GuardState;
  },
) {
  const wrapped: Record<string, Tool> = {};
  const adminDb = ctx.supabaseAdmin ?? ctx.supabase;
  // Per-run tool_health cache (Phase 2): load the rolling reliability + latency
  // signal ONCE and reuse it across every wrapped tool call this run. Best-effort —
  // if the view is missing (deploy ordering) or the query fails, scoring simply
  // proceeds without the prior (no penalty), exactly as before this feature.
  interface ToolHealth { okPct: number | null; p95: number | null; sampleSize: number }
  let toolHealthPromise: Promise<Map<string, ToolHealth>> | null = null;
  const loadToolHealth = (): Promise<Map<string, ToolHealth>> => {
    if (!toolHealthPromise) {
      toolHealthPromise = (async () => {
        const map = new Map<string, ToolHealth>();
        try {
          const { data, error } = await adminDb
            .from("tool_health")
            .select("tool_name,ok_pct,p95_duration_ms,sample_size");
          // Supabase returns { data, error } WITHOUT throwing on a query-level
          // failure (missing view / permission denied), so surface it here — the
          // catch below only fires on network/thrown errors. Degradation is
          // unchanged (empty map → neutral scoring); this just makes the
          // "view missing" case observable instead of silent.
          if (error) {
            console.warn("[tool_health] load failed (scoring without prior):", error.message);
            return map;
          }
          for (const row of (data ?? []) as Array<Record<string, unknown>>) {
            const tn = typeof row.tool_name === "string" ? row.tool_name : null;
            if (!tn) continue;
            map.set(tn, {
              okPct: row.ok_pct == null ? null : Number(row.ok_pct),
              p95: row.p95_duration_ms == null ? null : Number(row.p95_duration_ms),
              sampleSize: Number(row.sample_size ?? 0),
            });
          }
        } catch (e) {
          console.warn("[tool_health] load failed (scoring without prior):", e);
        }
        return map;
      })();
    }
    return toolHealthPromise;
  };
  // Derive a real success flag from a tool's return value. A tool can return
  // without throwing yet still represent a failure (HTTP non-2xx wrapped into
  // { ok:false }, an `error` field, or a stub). The wrapper must NOT log such
  // calls as ok=true — otherwise tool_usage_log lies about reality.
  const deriveOk = (result: unknown): boolean => {
    if (!result || typeof result !== "object") return true;
    const r = result as Record<string, unknown>;
    // Intentional skips (missing required key, provider disabled in config, or an
    // explicit `skipped` flag) are NOT failures. Keep them out of the
    // tool_usage_log failure metric so the beta dashboard reflects real errors
    // instead of intentional no-ops. The UI still renders them as "skipped" via
    // tagSkipState / output.skipped. (Distinct from genuine 4xx/5xx/parse errors.)
    if (isIntentionalSkip(r)) return true;
    if (typeof r.ok === "boolean") return r.ok;
    if (typeof r.error === "string" && r.error.length > 0) return false;
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
      if (e.includes("gated")) return true;
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
    // Billing + telemetry now delegate to the SHARED primitive in provider-exec.ts
    // (PR #305 review #1) so the streamText tool wrapper and the pre-stream anchor
    // intake write tool_usage_log + debit credits through ONE implementation. The
    // two-number accounting (cost_micro_usd = attributed list price; charged_micro_usd
    // = actual success-only credits) and the outcome classification live there.
    // Returns the writeToolUsage promise so existing `await logUsage(...)` and
    // fire-and-forget call sites both keep working unchanged.
    const logUsage = (
      cached: boolean,
      ok: boolean,
      durationMs: number,
      errorMsg: string | null = null,
      statusCode: number | null = null,
      freeCall: boolean = false,
      inputJson: Record<string, unknown> | null = null,
    ) =>
      writeToolUsage(
        name,
        baseCost,
        { userId: ctx.userId, threadId: ctx.investigationId, onCost: ctx.onCost, adminDb },
        { cached, ok, durationMs, errorMsg, statusCode, freeCall, inputJson },
      );
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
              // Phase 2: per-tool hard timeout (schema-safe on timeout, no throw);
              // recording/evidence tools (ALWAYS_ALLOW) are exempt. Single thunk so
              // the underlying call isn't duplicated.
              out = ALWAYS_ALLOW_TOOLS.has(name)
                ? await (orig(input, opts) as Promise<unknown>)
                : await runWithToolTimeout(
                    name,
                    (signal) => orig(input, withTimeoutSignal(opts, signal)) as Promise<unknown>,
                    toolTimeoutMs(name),
                  );
              ok = deriveOk(out);
              if (!ok) errInfo = extractToolError(out);
              return tagSkipState(tagTier(scrub(out), tier, model));
            } catch (e) {
              ok = false;
              const redacted = redactSecrets(String((e as Error)?.message ?? e)).slice(0, 500);
              errInfo = { errorMsg: redacted, statusCode: null };
              // Resilience (Phase 1): RETURN a schema-safe error result instead of
              // throwing. A throw here escapes into the live AI-SDK step; when the
              // model emitted sibling tool calls in the same step, the orphaned
              // pair triggers the "Tool results are missing for tool calls" crash.
              // Returning keeps the tool-call/result pair intact. The `finally`
              // below still records tool_usage_log truthfully (ok=false).
              return tagTier({ ok: false, error: redacted, _tool_error: true }, tier, model);
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
        // Persistent tool-health prior (Phase 2): latency + reliability from the
        // tool_health view, sample-gated inside scoreExpectedValue so a low-sample
        // tool stays neutral. manual_override bypasses the reliability suppression.
        const health = (await loadToolHealth()).get(name);
        const expectedValue = scoreExpectedValue({
          selectorConfidence: signal.confidence,
          sourceIndependenceBonus: signal.sourceCount >= 2 ? 18 : 0,
          corroborationPotential: ["email", "phone", "domain", "username"].includes(selectorType) ? 12 : 6,
          freshnessNeed: name === "wayback_snapshots" || name === "archive_url" ? 10 : 0,
          p95DurationMs: health?.p95 ?? null,
          reliability: health?.okPct ?? null,
          healthSampleSize: health?.sampleSize ?? 0,
          manualOverride,
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
          // paramsHash excludes pure annotation keys (purpose/reason/…) so the SAME
          // selector re-queried in a later turn of the SAME thread reuses the cached
          // result even when the planner's `purpose` differs (the thread-scoped
          // selector-reuse lookup below keys on it). input_hash keeps the FULL params,
          // so the existing cross-thread exact-match layer is UNCHANGED.
          paramsHash = await hashInput(semanticParams(params));
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

        // ---- Cross-turn selector reuse (thread-scoped) ----
        // The fast in-memory layer is per-isolate and dies between turns, and the
        // input_hash lookup above misses when the planner re-queries the SAME selector
        // with a different `purpose` (purpose is folded into input_hash). Fall back to
        // the freshest SUCCESSFUL row for this THREAD + tool + normalized selector +
        // semantic params (annotation keys excluded via paramsHash). Scoped to
        // investigation_id so cross-thread caching is UNCHANGED; matched on
        // selector_type + selector_normalized + params_hash so a different mode
        // (kind/depth/limit) can never serve a wrong-mode result. Only successful
        // results are ever written (see the success-only store below), so a hit here
        // is always a prior success. Replays are free + corroboration-ineligible,
        // exactly like the two layers above. Uses only columns the write path already
        // persists — no schema change.
        if (sel && paramsHash) {
          try {
            const { data } = await adminDb
              .from("tool_call_cache")
              .select("output_json, created_at, expires_at, source_created_at")
              .eq("investigation_id", ctx.investigationId)
              .eq("tool_name", name)
              .eq("selector_type", selectorType)
              .eq("selector_normalized", sel)
              .eq("params_hash", paramsHash)
              .eq("stale", false)
              .order("created_at", { ascending: false })
              .limit(1)
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
                  runtime: { ...cacheRuntime, cache_layer: "user", selector_reuse: true, stale_cache: false, source_created_at: row.source_created_at ?? row.created_at },
                });
                return attachRuntimeMeta(markCached(output, row.source_created_at ?? row.created_at, "user"), {
                  ...cacheRuntime,
                  cache_layer: "user",
                  selector_reuse: true,
                  stale_cache: false,
                  source_created_at: row.source_created_at ?? row.created_at,
                  corroboration_eligible: false,
                });
              }
            }
          } catch (error) {
            console.warn(`[tool_call_cache] selector-reuse lookup failed for ${name}:`, error);
          }
        }

        // ---- Per-run tool-call cap (graceful) ----
        // Once the run has made MAX_TOOL_CALLS_PER_RUN genuine live executions, stop
        // STARTING new lookups: return a schema-safe skip (like a governor rejection)
        // so the step keeps a valid tool-call/result pair and the model finalizes with
        // what it has. Checked here — AFTER cache hits (still served free) and before
        // the live call — so cached corroboration never costs budget. Recording tools
        // (ALWAYS_ALLOW) are exempt via shouldSkipForToolCap, so the closing
        // record_artifacts is never starved and no collected evidence is stranded.
        // This is the hard backstop; prepareStep also forces synthesis once capped.
        if (ctx.toolCallBudget && shouldSkipForToolCap(ctx.toolCallBudget.genuine, ALWAYS_ALLOW_TOOLS.has(name))) {
          ctx.toolCallBudget.capped = true;
          await logUsage(false, false, Date.now() - t0, "run tool-call cap reached", null, true, {
            input: inputJson,
            runtime: { ...runtimeMetaBase, rejection_reason: "run_capped", rejection_source: "run_cap", stale_cache: !!staleRecord },
          });
          return attachRuntimeMeta({ ok: false, skipped: true, run_capped: true, error: "run tool-call cap reached" }, {
            ...runtimeMetaBase,
            rejection_reason: "run_capped",
            stage: "CAPPED",
            cache_layer: "miss",
            stale_cache: !!staleRecord,
          });
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
        // Count this GENUINE live execution against the per-run cap. Placed here (past
        // every cache/circuit/runtime gate, at the point we commit to running live) so
        // cached hits and governor skips never consume the budget — matching the
        // outcome semantics the wrapper already uses. Recording/evidence tools are
        // exempt so evidence writes don't eat the lookup budget. A live timeout/error
        // still counts: it genuinely ran and consumed time/quota.
        if (ctx.toolCallBudget && !ALWAYS_ALLOW_TOOLS.has(name)) ctx.toolCallBudget.genuine++;
        let ok = true;
        let result: unknown;
        let errInfo: { errorMsg: string | null; statusCode: number | null } = { errorMsg: null, statusCode: null };
        try {
          // Phase 2: bound the live call with a per-tool hard timeout (returns a
          // schema-safe result on timeout, never throws). Recording/evidence tools
          // are exempt — they must never be cut off.
          const rawResult = ALWAYS_ALLOW_TOOLS.has(name)
            ? await (originalExecute(input, opts) as Promise<unknown>)
            : await runWithToolTimeout(
                name,
                (signal) => originalExecute(input, withTimeoutSignal(opts, signal)) as Promise<unknown>,
                toolTimeoutMs(name),
              );
          result = attachRuntimeMeta(tagSkipState(tagTier(scrub(rawResult), tier, model)), {
            ...runtimeMetaBase,
            stage: runtimeDecision.stage,
            cycle_id: runtimeDecision.cycleId,
            cache_layer: "miss",
            stale_cache: !!staleRecord,
            stale_source_created_at: staleRecord?.source_created_at ?? staleRecord?.created_at ?? null,
          });
          ok = deriveOk(result);
          if (!ok) errInfo = extractToolError(result);
          // C-2: record minimax_correlate's FINAL outcome (post-timeout-race) so
          // memory_save can tell "correlate failed this cycle" apart from "correlate
          // never ran" — a timeout stub races the tool's own execute() and wins, so
          // this is the only point that sees what the model actually received.
          if (name === "minimax_correlate" && ctx.guard) ctx.guard.lastCorrelateOutcome = ok ? "ok" : "failed";
          circuit.recordResult(ctx.investigationId, name, sel, purpose, {
            status: circuit.classifyResult(result, null),
            artifactCount: 0,
          });
        } catch (e) {
          ok = false;
          if (name === "minimax_correlate" && ctx.guard) ctx.guard.lastCorrelateOutcome = "failed";
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
          // Resilience (Phase 1): RETURN a schema-safe error result instead of
          // throwing (see the NO_CACHE path above). All bookkeeping — finishCall,
          // tool_usage_log write, circuit.recordResult, billing (via logUsage) —
          // has already run with the real failure recorded; only the throw that
          // orphaned sibling tool calls and crashed the run is replaced. The
          // result carries the same _runtime metadata as a successful live call.
          return attachRuntimeMeta(
            tagTier({ ok: false, error: msg, _tool_error: true }, tier, model),
            {
              ...runtimeMetaBase,
              stage: runtimeDecision.stage,
              cycle_id: runtimeDecision.cycleId,
              cache_layer: "miss",
              stale_cache: !!staleRecord,
            },
          );
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

// ---- Skip classification -------------------------------------------------------
// An "intentional skip" is a non-failure outcome the runtime chose on purpose:
//   • a missing-required-key bail   ("X_API_KEY not configured")
//   • a provider disabled in config ("unavailable: disabled (provider disabled in config)")
//   • a capability missing-key gate ("unavailable: missing_key (...)")
//   • an explicit `skipped: true` flag (skipStub, dead-host, gates, timeouts)
// These must NOT count as failures in tool_usage_log — they're intentional no-ops,
// and counting them inflated the beta failure-rate dashboard with non-errors
// (e.g. synapsint_lookup 7/7 disabled, ipqualityscore/deepfind missing-key).
// This is the single source of truth, shared by deriveOk (the logged ok flag) and
// tagSkipState (the UI taxonomy flag). Genuine 4xx/5xx/parse errors do NOT match.
const SKIP_REASON_RE = /not configured|provider disabled in config|unavailable:\s*(?:disabled|missing_key|gated)|\bgated\b/i;
export function isIntentionalSkip(output: unknown): boolean {
  if (!output || typeof output !== "object") return false;
  const o = output as Record<string, unknown>;
  if (o.skipped === true) return true;
  const text = [o.error, o.note, o.reason, o.detail]
    .filter((v): v is string => typeof v === "string")
    .join(" ");
  return SKIP_REASON_RE.test(text);
}

// ---- Skip-state tagging --------------------------------------------------------
// The UI tool-status taxonomy (src/lib/tool-run.ts → deriveToolStatus) renders a
// call as "skipped" when output.skipped === true. Tag every intentional skip
// (per isIntentionalSkip) so the Tools tab reads it as Skipped rather than a hard
// error. Additive only — billing (isFreeCall) and the logged ok flag (deriveOk,
// which also uses isIntentionalSkip) already treat these as free non-failures.
export function tagSkipState(output: unknown): unknown {
  if (!output || typeof output !== "object") return output;
  const o = output as Record<string, unknown>;
  if (o.ok === true) return output;
  if (o.skipped === true || o.gated === true || o.degraded === true || o.partial === true) return output;
  if (isIntentionalSkip(o)) o.skipped = true;
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
