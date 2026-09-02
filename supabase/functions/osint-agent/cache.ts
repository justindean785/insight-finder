/**
 * cache.ts — Central tool-cache wrapper, tier tagging, auto-evidence, and cache marking.
 * Extracted from index.ts (lines 834–1185).
 * All 77 tools flow through wrapToolsWithCache().
 */

import { createClient } from "npm:@supabase/supabase-js@2";
import type { Tool } from "npm:ai@6";
import { hashInput, normalizeForHash, sanitizeToolOutput, stripNulCharacters, TOOL_CACHE_LRU } from "./safety.ts";
import { tierForTool, modelForTool, type Tier } from "./models.ts";
import { costForTool } from "./costs.ts";
import { DEFAULT_TOOL_TTL_MS, NO_CACHE_TOOLS, redactSensitiveToolInput, TOOL_TTL_MS } from "./validation.ts";
import { creditsCharged } from "./billing.ts";
import { classifyToolOutcome } from "./tool-outcome.ts";
import * as circuit from "./circuit.ts";
import { buildRefusedKeys, dispatchTypeCandidates, isDispatchRefused, quarantineRefusal, reasonForKey } from "./lib/dispatch-quarantine.ts";
import { buildRejectedDispatchKeys, isRejectedDispatch, rejectionRefusal } from "./lib/dispatch-rejection.ts";
import { loadReviewsForThread, type ReviewDb } from "./reviews.ts";
import { guard, takeCorrelateHint } from "./guard.ts";
import { reserveToolCall } from "./orchestrator-budget.ts";
import { isFinalizeWindowLiveLookupExempt } from "./orchestrator-finalize.ts";
import {
  ALWAYS_ALLOW_TOOLS,
  analyzeWeakLead,
  currentStage,
  ensureCycle,
  finishCall,
  notePlanCall,
  isPreProviderGate,
  noteRejectedCall,
  refundPaidCall,
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
  // RAISED 2026-07-25 (production audit, thread d98deb37, build 6d76133): the 12s
  // cap was clipping the fast-fail window too aggressively and driving retries/
  // collisions rather than clean fast fails. 20s keeps it well below the ~46s p95
  // (still a fast-fail relative to a full 30s+ tax) while giving legitimate fast
  // responses room to land instead of tripping the cap mid-flight.
  // DELIBERATELY NOT RAISED. A 2026-08-16 telemetry audit reported a 20_130ms
  // abort against this 20_000ms cap and proposed raising it, by analogy with
  // Indicia. The analogy is wrong and the two are opposite cases:
  //   Indicia RESPONDS SUCCESSFULLY at 13.8-20.5s and we were aborting at 18s,
  //     so the cap was destroying real data -> raised.
  //   gemini_deep_dork has a ~46s p95 and is capped BELOW it ON PURPOSE, to be
  //     a fast-fail corroboration source rather than a 30s tax on every run.
  //     An abort at 20_130ms is the cap working, not an off-by-a-hair bug.
  // Raising it would not make the tool succeed — it would still miss its p95 —
  // it would only make each failure more expensive. Pinned by
  // tool_timeout_caps_test.ts:35 ("cut from its old 30s tail"), which is the
  // test that caught this change.
  gemini_deep_dork: 20_000,        // was 12_000 — 12s cap fired mid-response too often
  // deepfind_reverse_email: removed 8s override — falls back to 12s default.
  // The 8s cap caused 9 timeouts in the 2026-07-08 audit; provider legitimately
  // needs headroom for the reverse-email lookup.
  // jina_reader_scrape: 8s → 18s (2026-07-16, McGovern-run audit). At 8s a slow
  // but recoverable page render timed out, and that single timeout suppressed the
  // provider for the rest of the run (2 later valid scrapes skipped). 18s gives
  // Jina's renderer headroom; the 2-strike circuit tolerance (circuit.ts) is the
  // other half of the fix.
  jina_reader_scrape: 18_000,
  dork_harvest: 25_000,     // wraps several web searches — p95 ~17s
  exa_search: 20_000,       // neural search + contents — p95 ~12s
  exa_find_similar: 20_000,
  exa_get_contents: 20_000,
  // archive.org (Cloudflare-fronted, chronically slow p95 ~60s) — raise past the
  // tools' own per-attempt fetch timeouts so a legit-slow archive resolves instead
  // of the 12s default cap orphaning an un-signalled request (2026-07-05 fix).
  wayback_cdx_search: 25_000,
  archive_url: 25_000,
  // Indicia broker lookups — the provider is simply slower than we allowed.
  // RAISED 20s -> 32s (2026-08-16 telemetry audit) alongside the tool's own fetch
  // timeout (18s -> 30s in tools/indicia.ts). Direct probes with the production
  // key returned HTTP 200 with real records at 20.5s and 13.8s, while every
  // logged failure was our abort at 18.0-18.2s. The wrapper cap must stay ABOVE
  // the tool's own fetch timeout so the tool fails cleanly first and the wrapper
  // never orphans an un-signalled request.
  indicia_email: 32_000,
  indicia_phone: 32_000,
  indicia_person: 32_000,
  indicia_address: 32_000,
  indicia_web_dbs: 32_000,
  indicia_hudsonrock: 32_000,
  // SocialFetch server-side web read (/v1/web/markdown) fetches + renders +
  // converts a full page upstream, which legitimately exceeds the 12s default.
  //
  // ⚠️ CORRECTED 2026-08-28, SECOND PASS. The first pass cut this to 15s (tool
  // 12s) on a brief that reported "21 aborts, avg 22,194ms, ZERO successes ever
  // observed." That claim was FALSE — it was drawn from a 4-run sample of 3
  // calls and generalised. Queried directly against tool_usage_log:
  //
  //     30 days: 127 calls, 76 OK (60%), successes avg 5,446ms, p95 11,161ms
  //     14 days:  71 calls, 43 OK (61%), successes p95 13,349ms
  //     max successful duration, either window: 15,908ms
  //     failures average 12,395ms
  //
  // So this is an ordinary, working, somewhat slow tool — not a dead provider.
  // A 12s tool cap would have severed 3 of 76 observed successes outright and
  // cut straight through the 14-day p95. Trading real evidence for wall clock is
  // the wrong direction, and the premise that justified it did not survive
  // contact with the data.
  //
  // 18s sits above the 15,908ms maximum observed success with headroom, so it
  // costs no evidence, while still trimming the failure path (which aborts at
  // ~12.4s on average and previously ran to a 22s ceiling). The wrapper stays
  // above the tool's own budget per the invariant this table states three times.
  socialfetch_web_read: 22_000,
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
  // Serus is a POLLING tool: its cost is transitive, not a single fetch. It
  // enforces SERUS_OPERATION_DEADLINE_MS = 40s end-to-end (25s intended polling
  // window + 15s network headroom) and now honours this wrapper's AbortSignal.
  // The cap must exceed that deadline so the INTERNAL bound is what fires --
  // asserted in tool_timeout_contract_test.ts. At the old 30s the wrapper fired
  // first and Serus kept polling unsupervised.
  serus_darkweb_scan: 45_000,
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
  // quality outranks a few seconds. RAISED 2026-07-25 (production audit, thread
  // d98deb37, build 6d76133): 30s still clipped completed correlation calls on
  // heavy runs (large artifact batches near the 200-entry ceiling push the smart
  // model's response time past 30s). 60s gives headroom above the observed tail
  // without unbounded growth — input is still hard-capped at 16k chars/1500 tokens.
  minimax_correlate: 60_000,
  // minimax_plan_pivots — SAME provider and SAME smart tier as minimax_correlate
  // above, but it had no entry here at all, so it inherited the 12s default while
  // structurally taking 15-25s. Production `tool_usage_log` (2026-07-30): EVERY
  // recorded failure is our own wrapper firing — `exceeded 12000ms tool timeout`
  // n=12 at avg 12,164ms — not one provider error. Daily average latency ran
  // 15.0-20.8s across 7/25-7/28, and the single success took 17,276ms. We were
  // capping a smart-tier planning call at roughly half its natural duration.
  //
  // This is the correlate recurrence repeating on its sibling: as documented
  // above, execute() does not forward the wrapper signal, so the model call runs
  // to completion regardless — the cap does not save the time, it just discards
  // the finished plan and books it as a failure. That is why the symptom looked
  // like "the planner is broken" rather than "the planner is slow".
  //
  // 45s (not correlate's 60s) because this call's payload is now hard-capped
  // materially smaller — 60 artifacts / 80 already-queried below vs correlate's
  // 200 — so its tail is correspondingly shorter. Calibration against observed
  // latency, not open-ended bumping.
  minimax_plan_pivots: 45_000,
  // OathNet family: every endpoint's own fetch budget is 20s (a couple 15s), but the
  // outer wrapper cap must sit ABOVE that fetch budget or it guillotines the call
  // before the fetch's own timeout can return a clean result. The 2026-07-15 live
  // run proved this: oathnet_lookup ran a 20s fetch but the wrapper killed it at
  // 12,127ms ("exceeded 12000ms tool timeout"), then ONE timeout tripped the
  // circuit breaker and suppressed the WHOLE oathnet family for the rest of the
  // run. Earlier the override was 15s (oathnet_lookup only) — still below the 20s
  // fetch, and the sibling endpoints had no override at all (12s default). Set the
  // whole family to 22s (> the 20s fetch) so the fetch governs the timeout, not the
  // wrapper, and the family isn't nuked on a single slow-but-recoverable call.
  oathnet_lookup: 22_000,
  oathnet_stealer_search: 22_000,
  oathnet_victims_search: 22_000,
  oathnet_victim_manifest: 22_000,
  oathnet_victim_file: 22_000,
  oathnet_subdomains: 22_000,
  oathnet_breach_dbnames: 22_000,
  oathnet_ai_filter: 22_000,
  oathnet_scanner: 22_000,
  // FOFA / markdown.new — added with the tools themselves (backport of the Lovable
  // mirror's 8df15d2). Both ship their OWN fetch budget (fofa_search 20s,
  // markdown_extract 30s) and neither forwards the wrapper signal, so without an
  // override here the 12s default reproduces the exact failure the oathnet and
  // socialfetch_web_read comments above describe: the wrapper guillotines the call
  // before the tool's own fetch timeout can return a clean result, the completed
  // work is discarded, and ONE such timeout trips the circuit breaker and suppresses
  // the tool for the rest of the run. Each cap sits just above its tool's fetch
  // budget so the fetch governs the timeout, not the wrapper.
  fofa_search: 22_000,        // > its 20s fetchT budget
  markdown_extract: 32_000,   // > its 30s fetchT budget; PDF/XLSX conversion is genuinely slow
  // ---------------------------------------------------------------------------
  // Backfill 2026-07-30: tool_timeout_contract_test.ts scans every tool in
  // tool-registry.ts and asserts its wrapper cap EXCEEDS its own fetchT budget.
  // That scan found nine pre-existing violations of the rule the oathnet and
  // socialfetch_web_read comments above already state. They are fixed here so
  // the contract holds with ZERO exceptions — a contract with an allowlist is
  // not a contract, and each of these reproduces the documented failure: the
  // wrapper fires first, the tool's own timeout never returns a clean result,
  // the finished work is discarded, and one timeout trips the circuit breaker
  // for the rest of the run.
  //
  // Four had a real deficit (own fetch budget well above the 12s default):
  leakcheck_lookup: 22_000,        // own fetch 20s
  rapidapi_breach_search: 22_000,  // own fetch 20s
  rapidapi_all_breaches: 22_000,   // own fetch 20s
  census_geocode: 17_000,          // own fetch 15s
  // Five were exactly TIED at 12s == 12s, which is a race, not a margin: whether
  // the wrapper or the fetch wins is a scheduling coin-flip, so the same call
  // sometimes yields a clean provider error and sometimes a circuit-breaking
  // wrapper timeout. 14s lets the fetch's own timeout always govern.
  github_user: 14_000,
  crypto_wallet: 14_000,
  shodan_internetdb: 14_000,
  hackertarget: 14_000,
  urlscan_search: 14_000,
  // ---------------------------------------------------------------------------
  // INJECTED tools — attached after buildTools() via `(tools as ToolRegistry).x = x`
  // rather than defined inline, with their fetch budgets in tools/*.ts. The
  // wrapper-above-fetch contract test could not see EITHER fact, so these two
  // sat in violation while the test reported zero exceptions. Found 2026-08-02
  // when gemini_vision died at 12,228ms on a 17MB PDF in production.
  gemini_vision: 45_000,      // own fetch 25s (VISION_FETCH_TIMEOUT_MS) — and that
                              // budget covers only the FETCH; Gemini inference runs
                              // after it, so the cap needs headroom above 25s, not
                              // merely 27s. Observed successful vision calls run
                              // 4.7-6.5s; the 45s ceiling is for large documents.
  pdl_person_enrich: 20_000,  // own fetch 18s (PDL_HTTP_TIMEOUT_MS). Not in the
                              // 2026-08-02 report — found by scanning all nine
                              // injected tools rather than only the one that failed.
  geoseer_geolocate: 58_000,  // own fetch 50s (GEOSEER_HTTP_TIMEOUT_MS); provider
                              // runs 7-45s in `fast` mode, so the wrapper must sit
                              // above the tool's own budget, never tie it.
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
    // Guard a SYNCHRONOUS throw from factory() — without this the setTimeout
    // above is never cleared and the run leaks a timer (deno's op-sanitizer
    // fails crash_resilience / gemini_parallel_pairing on the throwing-tool path).
    let promise: Promise<T>;
    try {
      promise = factory(ctrl.signal);
    } catch (e) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
      return;
    }
    promise.then(
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

/**
 * Cache entries must represent usable provider results. Intentional skips are
 * operationally non-failures for telemetry, but replaying one would suppress a
 * later live retry after a missing/expired provider key is repaired.
 *
 * Degenerate results (a bare null/undefined, or the runtime's `{value:null}` wrapper
 * that attachRuntimeMeta/tagTier produce for a tool that returned nothing) are NOT
 * usable results — caching one and replaying it would suppress a live retry that
 * might succeed. This closes the reviewer's "permissive for non-object results" gap
 * without touching the ok/error/skip classification of real payloads.
 */
export function isCacheableToolResult(result: unknown): boolean {
  if (result === null || result === undefined) return false;
  if (typeof result !== "object") return true;
  const r = result as Record<string, unknown>;
  // The runtime wraps a non-object raw result as `{value:<raw>, _tier, _model,
  // _runtime}`; a null/undefined `value` with no ok/error is that empty-result shape.
  if (
    "value" in r && (r.value === null || r.value === undefined) &&
    typeof r.ok !== "boolean" && typeof r.error !== "string"
  ) return false;
  if (isIntentionalSkip(r) || r.provider_unavailable === true) return false;
  if (typeof r.ok === "boolean") return r.ok;
  if (typeof r.error === "string" && r.error.length > 0) return false;
  return true;
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
    toolCallBudget?: { genuine: number; reserved: number; capped: boolean };
    shouldStopLiveLookups?: () => boolean;
    onHeartbeat?: () => void;
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
  // ---- subject_unlinked DISPATCH boundary --------------------------------------
  // Quarantine binds at write and read-back; without this it never bound at
  // DISPATCH, so a quarantined selector could still start its own paid tool
  // stack. Loaded ONCE per run and reused, like tool_health above.
  //
  // FAILS OPEN on a load error, matching loadToolHealth's precedent in this same
  // function: this boundary prevents wasted calls and contaminated pivots, it is
  // not an authorization control, and hard-failing every tool call on a transient
  // artifacts read would be a worse outcome than the leak it prevents. The warning
  // is logged so the degradation is observable rather than silent.
  let refusedKeysPromise: Promise<{ keys: Set<string>; rows: Array<Record<string, unknown>> }> | null = null;
  const loadRefusedKeys = () => {
    if (!refusedKeysPromise) {
      refusedKeysPromise = (async () => {
        try {
          const { data, error } = await adminDb
            .from("artifacts")
            .select("kind,value,metadata")
            .eq("thread_id", ctx.investigationId);
          if (error) {
            console.warn("[quarantine-dispatch] load failed (boundary open this run):", error.message);
            return { keys: new Set<string>(), rows: [] };
          }
          const rows = (data ?? []) as Array<Record<string, unknown>>;
          return { keys: buildRefusedKeys(rows, circuit.normalizeSelector), rows };
        } catch (e) {
          console.warn("[quarantine-dispatch] load failed (boundary open this run):", e);
          return { keys: new Set<string>(), rows: [] };
        }
      })();
    }
    return refusedKeysPromise;
  };
  // ---- ANALYST-REJECTION dispatch boundary --------------------------------------
  // A `dismissed` / `wrong` verdict bound at every READ (reviews.ts) but never at
  // DISPATCH: the prompt said DO NOT USE and nothing enforced it, so the model —
  // or a manual "Run this pivot" — could still start a paid call on a selector
  // the analyst had ruled out. Loaded ONCE per run and reused, keyed by
  // `type:normalizedValue` from the artifact's kind (plus its selector-type
  // alias), never by value alone. Rejected keys are derived from the rejected
  // ROWS, so a re-record of the same selector under a new id is still refused.
  //
  // FAILS OPEN on a load error, matching the quarantine boundary above and for
  // the same reason: this prevents wasted calls and contaminated pivots; it is
  // not an authorization control, and refusing EVERY tool call on a transient
  // review read would kill the run outright. The authoritative consumers
  // (prompt block, salvage, cache, clustering, synthesis, recovery) all fail
  // closed on the same load. The warning makes the open boundary observable.
  let rejectedKeysPromise: Promise<Set<string>> | null = null;
  const loadRejectedKeys = () => {
    if (!rejectedKeysPromise) {
      rejectedKeysPromise = (async () => {
        try {
          const reviews = await loadReviewsForThread(
            adminDb as unknown as ReviewDb, ctx.investigationId, ctx.userId,
          );
          if (!reviews.ok) {
            console.warn("[rejected-dispatch] review load failed (boundary open this run):", reviews.error);
            return new Set<string>();
          }
          return buildRejectedDispatchKeys(reviews.rejectedRows, circuit.normalizeSelector);
        } catch (e) {
          console.warn("[rejected-dispatch] review load threw (boundary open this run):", e);
          return new Set<string>();
        }
      })();
    }
    return rejectedKeysPromise;
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
      // `ok` from the caller is GENUINE success (deriveOk / explicit) — billing
      // keys off it, unchanged. For telemetry we additionally classify the
      // non-success outcome so governance skips and empty (no-record) results
      // stop being counted as provider failures: they inflated the beta failure
      // rate AND falsely tripped the circuit breaker's consecutive-failure guard.
      // The logged `ok` column is relaxed to "not a hard failure" (skipped/empty
      // → true); the new `outcome` column keeps the ok/skipped/empty/failed split.
      const outcome = ok ? "ok" : classifyToolOutcome(errorMsg, statusCode);
      const okStored = outcome !== "failed";
      const cost = (cached || freeCall) ? 0 : baseCost;
      const charged = creditsCharged({ ok, cached, free: freeCall, baseCost });
      if (charged > 0) ctx.onCost?.(charged);
      const row: Record<string, unknown> = {
        user_id: ctx.userId,
        thread_id: ctx.investigationId,
        tool_name: name,
        cost_micro_usd: cost,
        charged_micro_usd: charged,
        cached,
        ok: okStored,
        outcome,
        duration_ms: durationMs,
        error_msg: outcome === "ok" ? null : errorMsg,
        status_code: outcome === "ok" ? null : statusCode,
        input_json: inputJson,
      };
      try {
        let { error } = await adminDb.from("tool_usage_log").insert(row);
        // Deploy-ordering safety: if this ships before the `outcome` column
        // migration is applied, retry without it so telemetry is never lost.
        if (error && /outcome/i.test(error.message ?? "")) {
          const { outcome: _omit, ...legacy } = row;
          ({ error } = await adminDb.from("tool_usage_log").insert(legacy));
        }
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
              // Phase 2: per-tool hard timeout (schema-safe on timeout, no throw);
              // recording/evidence tools (ALWAYS_ALLOW) are exempt. Single thunk so
              // the underlying call isn't duplicated.
              ctx.onHeartbeat?.();
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
        // ---- subject_unlinked DISPATCH boundary ----
        // FIRST, before budget reservation, the circuit breaker, the cache
        // lookups and the live call — so a quarantined selector cannot start a
        // direct, pivoted, cached, repeated or paid call. Placed here rather than
        // per-tool because all ~89 tools funnel through this one wrapper.
        //
        // `force` does NOT override it: a manual re-run of a quarantined selector
        // is exactly the escape this boundary exists to close. Clearing it is an
        // analyst linkage decision on the artifact, not a call-site flag.
        {
          const { keys: refusedKeys, rows: refusedRows } = await loadRefusedKeys();
          // Candidates, not the computed type alone — the paid breach tools take
          // `{ type, value }` and detectSelectorType does not read `type`.
          const candidateTypes = dispatchTypeCandidates(selectorType, inp);
          if (isDispatchRefused(refusedKeys, candidateTypes, sel)) {
            const declared = candidateTypes.find((t) => refusedKeys.has(`${t}:${sel}`)) ?? selectorType;
            const why = reasonForKey(refusedRows, circuit.normalizeSelector, declared, sel);
            const refusal = quarantineRefusal(name, declared, sel, why);
            console.warn(
              `[quarantine-dispatch] refused ${name} on ${declared}:${sel}` +
              (why ? ` (${why})` : ""),
            );
            return refusal;
          }
          // Same position, same shape, for the analyst's own rejections. `force`
          // does not override it either: the analyst clears a rejection by
          // resetting the review, not by re-running the call.
          const rejectedKeys = await loadRejectedKeys();
          const rejectedAs = isRejectedDispatch(rejectedKeys, candidateTypes, sel);
          if (rejectedAs) {
            const refusal = rejectionRefusal(name, rejectedAs, sel);
            console.warn(`[rejected-dispatch] refused ${name} on ${rejectedAs}:${sel} (analyst rejected)`);
            return refusal;
          }
        }
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
          if (mem && fresh(mem.createdAt) && isCacheableToolResult(mem.output)) {
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
              const output = row.output_json;
              if (fresh(createdAt, row.expires_at) && isCacheableToolResult(output)) {
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
              const output = row.output_json;
              if (fresh(createdAt, row.expires_at) && isCacheableToolResult(output)) {
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
        if (ctx.toolCallBudget && !reserveToolCall(ctx.toolCallBudget, ALWAYS_ALLOW_TOOLS.has(name))) {
          // reserveToolCall already flipped `capped`. Reservation (not completed-call
          // count) is now the admission gate, so a parallel fan-out cannot overshoot.
          await logUsage(false, false, Date.now() - t0, "run tool-call cap reached", null, true, {
            input: inputJson,
            runtime: { ...runtimeMetaBase, rejection_reason: "run_capped", rejection_source: "run_cap", stale_cache: !!staleRecord },
          });
          return attachRuntimeMeta({ ok: false, skipped: true, run_capped: true, reason: "budget_exceeded", error: "run tool-call cap reached" }, {
            ...runtimeMetaBase,
            rejection_reason: "run_capped",
            stage: "CAPPED",
            cache_layer: "miss",
            stale_cache: !!staleRecord,
          });
        }

        // ---- Finalize-window live-call guard -----------------------------------
        // prepareStep restricts activeTools once the reserve window opens, but it is
        // only called between model steps. A long/parallel step can still attempt new
        // lookups after the window opens; skip them here so CPU is reserved for the
        // record/report closeout. Recording tools are exempt.
        if (
          ctx.shouldStopLiveLookups?.() &&
          !ALWAYS_ALLOW_TOOLS.has(name) &&
          !isFinalizeWindowLiveLookupExempt(name)
        ) {
          await logUsage(false, false, Date.now() - t0, "finalize window open; live lookup skipped", null, true, {
            input: inputJson,
            runtime: { ...runtimeMetaBase, rejection_reason: "finalize_window", rejection_source: "deadline", stale_cache: !!staleRecord },
          });
          return attachRuntimeMeta({ ok: false, skipped: true, finalizing: true, error: "finalize window open; live lookup skipped" }, {
            ...runtimeMetaBase,
            rejection_reason: "finalize_window",
            stage: "REPORT",
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
          // duplicateInFlight: this is a TRUE duplicate of a call already running
          // this step (fix 4, 2026-07-25 audit), not a provider-busy/backoff skip.
          // Tag distinctly (duplicate_suppressed) so it's never mistaken for a
          // provider failure by health/degradation scoring — recordResult/
          // recordFailure are never called on this path (we return before
          // reaching them), so the circuit breaker doesn't see this as an
          // outcome at all, only as an admission-time local suppression.
          return attachRuntimeMeta({
            ok: false,
            skipped: true,
            error: decision.reason,
            _breaker: true,
            ...(decision.duplicateInFlight ? { duplicate_suppressed: true } : {}),
          }, {
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
        // Mark the provider in-flight NOW — before the pacing wait and before any
        // live dispatch — so same-step parallel siblings see the flag in shouldRun
        // regardless of whether a waitMs delay fires between shouldRun and the actual
        // fetch. Placing this after `await waitMs` (the prior TOCTOU) meant calls
        // dispatched during the pacing window all passed the gate before the mark was
        // set. ALWAYS_ALLOW_TOOLS bypass this (same exemption as the timeout gate).
        if (!ALWAYS_ALLOW_TOOLS.has(name)) {
          circuit.markProviderInFlight(ctx.investigationId, name);
          // Exact-duplicate gate (fix 4, 2026-07-25 audit): mark THIS specific
          // (tool, selector, purpose) as in-flight too, so a same-step sibling
          // making the identical call gets the clearer duplicateInFlight reason
          // from shouldRun instead of the generic provider-busy one. Cleared
          // alongside clearProviderInFlight on every exit path below.
          if (sel) circuit.markCallInFlight(ctx.investigationId, name, sel, purpose);
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
        ctx.onHeartbeat?.();
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
          // PAID-CALL ACCOUNTING — the only place the reserved paid slot is
          // released. `startCall` reserves at admission (atomically, so a parallel
          // batch cannot overshoot); a tool that declined BEFORE contacting the
          // provider issued no request and can have spent nothing, so its slot
          // goes back. Keyed on the structural `provider_attempted: false` marker
          // only — never on the outcome bucket, because `skipped` also covers
          // rate-limits, 5xx and timeouts, all of which really did spend.
          if (isPreProviderGate(result)) refundPaidCall(ctx.investigationId, costTierForTool(baseCost));
          // C-2: record minimax_correlate's FINAL outcome (post-timeout-race) so
          // memory_save can tell "correlate failed this cycle" apart from "correlate
          // never ran" — a timeout stub races the tool's own execute() and wins, so
          // this is the only point that sees what the model actually received.
          if (name === "minimax_correlate") guard.lastCorrelateOutcome = ok ? "ok" : "failed";
          circuit.clearProviderInFlight(ctx.investigationId, name);
          if (sel) circuit.clearCallInFlight(ctx.investigationId, name, sel, purpose);
          circuit.recordResult(ctx.investigationId, name, sel, purpose, {
            status: circuit.classifyResult(result, null),
            artifactCount: 0,
            errorMessage: errInfo.errorMsg ?? undefined,
          });
        } catch (e) {
          ok = false;
          if (name === "minimax_correlate") guard.lastCorrelateOutcome = "failed";
          const msg = redactSecrets(String((e as Error)?.message ?? e)).slice(0, 500);
          circuit.clearProviderInFlight(ctx.investigationId, name);
          if (sel) circuit.clearCallInFlight(ctx.investigationId, name, sel, purpose);
          finishCall(ctx.investigationId, name);
          logUsage(false, false, Date.now() - t0, msg, null, false, {
            input: inputJson,
            runtime: { ...runtimeMetaBase, stage: runtimeDecision.stage, cycle_id: runtimeDecision.cycleId, cache_layer: "miss", stale_cache: !!staleRecord },
          });
          circuit.recordResult(ctx.investigationId, name, sel, purpose, {
            status: circuit.classifyResult(null, e),
            artifactCount: 0,
            errorMessage: msg,
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
        // subsequent calls with the same input. TWO gates, both required:
        //  • ok = deriveOk(result) — the AUTHORITATIVE operational-success signal
        //    (catches ok:false, error strings, and any failure class deriveOk
        //    classifies). This is the original guard; it must stay.
        //  • isCacheableToolResult(result) — additionally excludes INTENTIONAL skips
        //    / provider_unavailable, which deriveOk deliberately counts as telemetry
        //    non-failures (so they don't inflate the error metric) but which must NOT
        //    be cached (replaying one suppresses a live retry after a key is repaired).
        // Keeping both means a result is cached ONLY when it is both a genuine success
        // AND a usable (non-skip) result — and the two duplicated predicates can never
        // drift into caching a failure.
        if (ok && isCacheableToolResult(result) && hash && key) {
          TOOL_CACHE_LRU.set(key, { output: result, createdAt: Date.now() });
          try {
            const { error: cacheWriteError } = await adminDb.from("tool_call_cache").upsert(
              {
                user_id: ctx.userId,
                investigation_id: ctx.investigationId,
                tool_name: name,
                input_hash: hash,
                // Both JSONB columns are scrubbed: this is the write that failed
                // FIRST in the 2026-08-02 incident ("[tool_call_cache] write
                // failed for http_fingerprint: unsupported Unicode escape
                // sequence"), two minutes before the same poisoned payload
                // reached assistant.parts and destroyed the final report. Fixing
                // only the message insert would leave that early signal broken
                // and the cache silently un-writable for the offending tool.
                input_json: stripNulCharacters(inputJson),
                output_json: stripNulCharacters(
                  result as unknown as Record<string, unknown>,
                ),
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
        // ---- Correlate hint delivery -------------------------------------------
        // The hint used to ride ONLY on a record_artifacts result. Measured on
        // build 3d5130e (thread 15ebf7d4): the model called record_artifacts once,
        // as call 22 of 23, right before memory_save ended the run. The pass was
        // genuinely due by then — so the hint fired correctly and arrived with no
        // fan-out left to influence. A trigger delivered through a channel the
        // model only opens at the end is not a trigger.
        //
        // So it also rides the ordinary results the model reads mid-run. Attached
        // ONLY here, on the live-success path: a failure, a skip, a cache hit and a
        // finalize-window refusal all return earlier and are untouched, so this can
        // never dress up a non-result as carrying a directive. `takeCorrelateHint`
        // latches once per correlate cycle, so it is a single directive rather than
        // a banner on every payload.
        //
        // Recording tools are excluded HERE because record_artifacts surfaces the
        // hint on its own result — but it now takes it through the SAME latch, so
        // there is exactly one delivery per cycle whichever surface reaches the
        // model first. (Review caught the earlier version: record_artifacts called
        // the UNLATCHED correlateNudge(), so excluding recording tools from this
        // path did nothing to stop a second, ungoverned delivery.)
        if (ok && !ALWAYS_ALLOW_TOOLS.has(name) && result && typeof result === "object" && !Array.isArray(result)) {
          const hint = takeCorrelateHint();
          if (Object.keys(hint).length > 0) {
            return { ...(result as Record<string, unknown>), ...hint } as typeof result;
          }
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
