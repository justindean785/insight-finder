import { breachExposureGuardSelfTest } from "./lib/breach-exposure-guard.ts";
import { dispatchSelectorAliasesSelfTest } from "./lib/dispatch-selector.ts";
import { providerBusyQueueSelfTest } from "./lib/provider-busy-queue.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { describeCredentialHealth, summarizeCredentialHealth } from "./lib/credential-health.ts";
import {
  corsHeaders, MINIMAX_API_KEY, SUPABASE_URL, SERVICE_KEY, SUPABASE_ANON_KEY,
  OATHNET_API_KEY, SYNAPSINT_API_KEY, OSINTNOVA_API_KEY, SOCIALFETCH_API_KEY,
  CORDCAT_API_KEY, HUNTER_API_KEY, INTELBASE_API_KEY, INTELBASE_ENABLED, REVEAL_BREACH_DATA,
  HIBP_API_KEY, OPSIS_API_KEY, EXA_API_KEY, FIRECRAWL_API_KEY, SERUS_API_KEY,
  GITHUB_API_TOKEN, PERPLEXITY_API_KEY, IPQUALITYSCORE_API_KEY,
  OPENCORPORATES_API_KEY, RANSOMWARELIVE_API_KEY,
  URLSCANNER_API_KEY, GEMINI_FALLBACK_MODEL_ID,
  XAI_API_KEY, GROK_ORCHESTRATOR_MODEL_ID,
  ANTHROPIC_API_KEY, ANTHROPIC_MODEL_ID, ANTHROPIC_MODEL_SOURCE, ANTHROPIC_THINKING, ANTHROPIC_EFFORT, ANTHROPIC_RUN_LIMITS,
  OSINT_AGENT_PROBE_SECRET,
  DEEPSEEK_API_KEY, DEEPSEEK_ORCHESTRATOR_MODEL_ID, PRIMARY_ORCHESTRATOR_MODEL_ID,
  DEEPSEEK_BASE_URL,
  ORCHESTRATOR_PROVIDER, LOVABLE_API_KEY,
  lovableGateway, geminiDirectGateway, ALLOW_LOVABLE_FALLBACK,
  promptBudgetHardCeilingEnabled,
} from "./env.ts";
import { minimaxChat, markMinimaxHealthy, minimaxHealthyWithin } from "./providers.ts";
import { anthropicFallbackEligible, selectOrchestratorProvider, type OrchestratorProvider } from "./orchestrator_select.ts";
import { anthropicModelRejectsForcedToolChoice, anthropicOrchestratorHealth } from "./anthropic-orchestrator.ts";
import { anthropicFallbackDisabled, orchestratorFallbackHealth } from "./lib/orchestrator-fallback.ts";
import { BUILD_MARKER, BUILD_COMMITTED_AT } from "./build-info.ts";
import { opsisCreditHintDisabled, opsisHealthDetail, opsisKillSwitchOn } from "./lib/opsis.ts";
import { opsisFinalizeCollectSelfTest } from "./orchestrator-finalize.ts";
import { opsisSearchGuardSelfTest } from "./lib/opsis-search-guard.ts";
import { ssrfGuardHealthDetail, ssrfGuardLegacy } from "./safety.ts";
import { recoverStaleActiveThreads } from "./recovery.ts";
import { synthesizeMissingFindings, synthesisEnabled, synthesisDryRun } from "./finding-synthesis-sweep.ts";
import { sweepRejectedClusterAssignments, describeSweep } from "./lib/rejected-cluster-sweep.ts";
import { sweepExpiredCache, cacheSweepEnabled, cacheSweepDryRun, describeCacheSweep } from "./cache-sweep.ts";
import {
  CREDENTIAL_HEALTH_SAMPLE_ROWS, CREDENTIAL_HEALTH_WINDOW_MS, MAINTENANCE_SKIPPED_DETAIL, maintenanceRequested,
} from "./lib/credential-health.ts";
import { describeToolCacheVersions } from "./lib/tool-cache-version.ts";
import { negativeLookupSelfTest } from "./lib/negative-lookup.ts";
import { toolInputFailureSelfTest } from "./lib/tool-input-failure.ts";
import { runEndSelfTest } from "./lib/run-end.ts";
import { PERSIST_ON_CLIENT_CANCEL_ENV, clientCancelIsolationCheck } from "./lib/client-cancel.ts";
import { runLeaseSelfTest } from "./lib/run-lease.ts";
import { recordNameQuarantineEnabled } from "./lib/record-name-quarantine.ts";
import {
  deepseekPreflightAlways,
  geminiPreflightPivotEnabled,
  preflightPivotHealthDetail,
  preflightPolicyHealthDetailE2b,
  resolveFallbackProvider,
} from "./lib/preflight-pivot.ts";
import { positionalPairingSelfTest, toolInputObjectRepairSelfTest } from "./message-sanitize.ts";
import { streamErrorDetailSelfTest } from "./stream-error-classify.ts";
import { contradictionClaimSelfTest } from "./contradictions.ts";
import { serusNameFilterSelfTest } from "./auto-persist-findings.ts";
import { clusterBookkeepingSelfTest, legacyNeedsReviewContradiction } from "./lib/cluster.ts";
import { describeDeadTargetMemory } from "./lib/dead-target.ts";
import { providerAuthPriorSelfTest } from "./lib/provider-auth-prior.ts";
import { TOTAL_PROMPT_CHAR_BUDGET } from "./orchestrator-budget.ts";
import { memoryContextSelfTest } from "./lib/memory-context.ts";
import { crossCaseReviewsSelfTest } from "./lib/cross-case-reviews.ts";
import { userSuppliedStatusSelfTest } from "./lib/user-supplied-status.ts";
import { analystAuthorityBoundarySelfTest } from "./lib/analyst-authority-keys.ts";
import { archiveOriginRuleSelfTest, breachOriginCapSelfTest, negativeSourceQualifierSelfTest, sourceOriginRulesSelfTest } from "./source-classification.ts";
import { memoryInputNormalizationSelfTest } from "./lib/memory-input-normalization.ts";
import { indiciaPersonOptInSelfTest } from "./costs.ts";
import { exactBooleanRepairSelfTest } from "./lib/exact-boolean-repair.ts";
import { inputCoercionSelfTest, inputKindInferenceSelfTest } from "./lib/tool-input-coercion.ts";
import { correlateSeedDefaultSelfTest } from "./lib/thread-seed.ts";
import { detectSeedServer } from "./validation.ts";
import { seedAccountIdSelfTest } from "./validation.ts";

/**
 * Release a response body we are never going to read.
 *
 * Every liveness probe in this module needs only the status line, so none of
 * them read their response body — and an unread body is not free. The stream
 * stays open, holding its connection, until GC eventually collects it. Deno's
 * test sanitizer reports exactly this as "A fetch response body was created
 * during the test, but not consumed during the test", which is how it surfaced:
 * 8 tests in health_handler_test.ts plus 1 in reconciliation_gates_test.ts, all
 * failing on this and nothing else, on a completely unmodified main.
 *
 * The reason it hid for so long is that the failure is NETWORK-DEPENDENT: when
 * the provider hosts are unreachable `fetch` rejects, no Response is ever
 * constructed, and the suite reads green. It goes red precisely when the probes
 * succeed — so a clean local run was evidence of no connectivity, not of no leak.
 *
 * `cancel()` is the right release for a body that will never be read: it
 * discards the stream and frees the connection without buffering the payload.
 * Its rejection is swallowed because an already-disturbed or errored body is
 * ALSO released, and a health probe must never fail on cleanup — that would turn
 * a healthy provider into a reported outage.
 */
async function releaseBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // already disturbed / errored — nothing left to release
  }
}

// ---- checks.minimax — is the PRIMARY orchestrator actually reachable? -------
// `orchestrator.ok` only asserts a key exists; after the MiniMax-primary outage
// it must be possible to confirm from a plain ?health=1 that MiniMax itself
// answers. ok:true requires MINIMAX_API_KEY present AND a live round-trip
// (bounded at 5s, one shot — the health response must never hang on a stalled
// upstream). A recent successful orchestrator turn on this warm isolate counts
// as proof-of-life and skips the paid ping.
export type MinimaxCheck = {
  ok: boolean;
  reason?: "missing_key" | "preflight_failed" | "timeout";
  detail?: string;
};

export async function checkMinimax(deps?: {
  hasKey?: boolean;
  chat?: typeof minimaxChat;
  recentlyHealthy?: boolean;
}): Promise<MinimaxCheck> {
  const hasKey = deps?.hasKey ?? !!MINIMAX_API_KEY;
  if (!hasKey) {
    // Config regression, not a routine miss — error-level so it can't hide
    // behind a quietly-working fallback.
    console.error("[health] MINIMAX_API_KEY is not configured — checks.minimax reason=missing_key");
    return { ok: false, reason: "missing_key" };
  }
  if (deps?.recentlyHealthy ?? minimaxHealthyWithin(60_000)) {
    return { ok: true, detail: "recently_ok" };
  }
  const chat = deps?.chat ?? minimaxChat;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5_000);
  try {
    const res = await chat({ user: "ping", maxTokens: 4, temperature: 0, signal: ctrl.signal });
    if (res.ok) {
      markMinimaxHealthy();
      return { ok: true };
    }
    return { ok: false, reason: "preflight_failed", detail: `status=${res.status}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return /abort/i.test(msg)
      ? { ok: false, reason: "timeout" }
      : { ok: false, reason: "preflight_failed", detail: msg.slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

// ---- checks.deepseek — is the SELECTED-by-default primary orchestrator reachable?
// DeepSeek is the lead orchestrator when DEEPSEEK_API_KEY is set (orchestrator_select.ts),
// so a plain ?health=1 must be able to confirm DeepSeek itself answers — independently
// of checks.minimax, so a healthy MiniMax fallback can NOT mask a DeepSeek outage. The
// probe pings deepseek in NON-THINKING mode (`thinking:{type:"disabled"}`) — the same
// shape the live orchestrator uses — so the canary matches production and stays cheap.
// Reported UNCONDITIONALLY (missing key → ok:false reason:missing_key) so operators can
// always see whether DeepSeek is actually configured + reachable.
export type DeepseekCheck = {
  ok: boolean;
  reason?: "missing_key" | "preflight_failed" | "timeout";
  detail?: string;
};

export async function checkDeepseek(deps?: {
  hasKey?: boolean;
  apiKey?: string;
  model?: string;
  doFetch?: typeof fetch;
}): Promise<DeepseekCheck> {
  const hasKey = deps?.hasKey ?? !!DEEPSEEK_API_KEY;
  if (!hasKey) {
    // Config regression when DeepSeek is the intended primary — error-level so it
    // can't hide behind a quietly-working MiniMax fallback.
    console.error("[health] DEEPSEEK_API_KEY is not configured — checks.deepseek reason=missing_key");
    return { ok: false, reason: "missing_key" };
  }
  const apiKey = deps?.apiKey ?? DEEPSEEK_API_KEY;
  const model = deps?.model ?? DEEPSEEK_ORCHESTRATOR_MODEL_ID;
  const doFetch = deps?.doFetch ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5_000);
  try {
    const res = await doFetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 4,
        temperature: 0,
        // Non-thinking canary: match the live orchestrator's request shape and keep
        // the paid health ping to a single cheap token.
        thinking: { type: "disabled" },
      }),
      signal: ctrl.signal,
    });
    // The canary reads the status line only — release the body before returning
    // on EITHER branch, or every plain ?health=1 leaks a connection.
    await releaseBody(res);
    if (res.ok) return { ok: true };
    return { ok: false, reason: "preflight_failed", detail: `status=${res.status}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return /abort/i.test(msg)
      ? { ok: false, reason: "timeout" }
      : { ok: false, reason: "preflight_failed", detail: msg.slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

// Resolve which orchestrator provider is ACTUALLY selected at runtime + its model,
// using the same pure selector index.ts uses — so the health endpoint reports the
// live truth (not a hardcoded guess). Pure; env is injected for testability.
export function resolveSelectedOrchestrator(env?: {
  pin?: string;
  deepseek?: boolean;
  minimax?: boolean;
  grok?: boolean;
  anthropic?: boolean;
}): { provider: OrchestratorProvider; reason: string; model: string } {
  const choice = selectOrchestratorProvider({
    pin: env?.pin ?? ORCHESTRATOR_PROVIDER,
    deepseek: env?.deepseek ?? !!DEEPSEEK_API_KEY,
    minimax: env?.minimax ?? !!MINIMAX_API_KEY,
    grok: env?.grok ?? !!XAI_API_KEY,
    anthropic: env?.anthropic ?? !!ANTHROPIC_API_KEY,
  });
  const model =
    choice.provider === "deepseek" ? DEEPSEEK_ORCHESTRATOR_MODEL_ID :
    choice.provider === "grok" ? GROK_ORCHESTRATOR_MODEL_ID :
    choice.provider === "minimax" ? PRIMARY_ORCHESTRATOR_MODEL_ID :
    choice.provider === "anthropic" ? ANTHROPIC_MODEL_ID :
    "";
  return { provider: choice.provider, reason: choice.reason, model };
}

// Role of a provider's diagnostic RELATIVE to the live selection: only the selected
// provider is "active"; every other configured provider is a "fallback" diagnostic.
// So MiniMax is labeled "fallback" (never "active") whenever DeepSeek is selected.
export function providerRole(
  selected: OrchestratorProvider,
  provider: OrchestratorProvider,
): "active" | "fallback" {
  return selected === provider ? "active" : "fallback";
}

// The orchestrator readiness gate, keyed on the SELECTED provider — symmetric by
// construction, so it can both FAIL a deployment whose active provider has no key and
// PASS one whose active provider is keyed but whose (unused) MiniMax fallback is not.
// Pure so both directions are unit-testable without env or network.
export function orchestratorGate(
  provider: OrchestratorProvider,
  keyPresent: boolean,
  coreOk: boolean,
): { check: { ok: boolean; detail?: string; reason?: string }; ok: boolean } {
  const check = keyPresent
    ? { ok: true }
    : {
      ok: false,
      detail: `selected orchestrator "${provider}" has no API key configured`,
      reason: "missing_key",
    };
  // Mirrors deriveReadiness's contract (orchestrator && core decide ok; tools do not),
  // with the orchestrator term now answering "is the ACTIVE provider usable?".
  return { check, ok: keyPresent && coreOk };
}

export function deriveReadiness(env: {
  MINIMAX_API_KEY?: string | null;
  SUPABASE_URL?: string | null;
  SUPABASE_SERVICE_ROLE_KEY?: string | null;
  SUPABASE_ANON_KEY?: string | null;
  OATHNET_API_KEY?: string | null;
  SYNAPSINT_API_KEY?: string | null;
  OSINTNOVA_API_KEY?: string | null;
  SOCIALFETCH_API_KEY?: string | null;
  CORDCAT_API_KEY?: string | null;
  HUNTER_API_KEY?: string | null;
  INTELBASE_API_KEY?: string | null;
  HIBP_API_KEY?: string | null;
  EXA_API_KEY?: string | null;
  FIRECRAWL_API_KEY?: string | null;
  SERUS_API_KEY?: string | null;
  IPQUALITYSCORE_API_KEY?: string | null;
  GITHUB_API_TOKEN?: string | null;
  PERPLEXITY_API_KEY?: string | null;
  RAPIDAPI_KEY?: string | null;
  OPENCORPORATES_API_KEY?: string | null;
  RANSOMWARELIVE_API_KEY?: string | null;
  URLSCANNER_API_KEY?: string | null;
  FOFA_API_KEY?: string | null;
  GEOSEER_API_KEY?: string | null;
  OPSIS_API_KEY?: string | null;
}): { ok: boolean; checks: Record<string, { ok: boolean; detail?: string; reason?: string; role?: "active" | "fallback" }> } {
  const has = (v: string | null | undefined) => !!(v && v.length > 0);
  const orchestratorOk = has(env.MINIMAX_API_KEY);
  const coreOk = has(env.SUPABASE_URL) && has(env.SUPABASE_SERVICE_ROLE_KEY) && has(env.SUPABASE_ANON_KEY);
  const tools = {
    oathnet: has(env.OATHNET_API_KEY),
    synapsint: has(env.SYNAPSINT_API_KEY),
    osintnova: has(env.OSINTNOVA_API_KEY),
    socialfetch: has(env.SOCIALFETCH_API_KEY),
    cordcat: has(env.CORDCAT_API_KEY),
    hunter: has(env.HUNTER_API_KEY),
    intelbase: has(env.INTELBASE_API_KEY), // note: gated by INTELBASE_ENABLED at runtime
    hibp: has(env.HIBP_API_KEY),
    exa: has(env.EXA_API_KEY),
    firecrawl: has(env.FIRECRAWL_API_KEY),
    serus: has(env.SERUS_API_KEY),
    ipqualityscore: has(env.IPQUALITYSCORE_API_KEY),
    github: has(env.GITHUB_API_TOKEN),
    perplexity: has(env.PERPLEXITY_API_KEY),
    rapidapi_breach: has(env.RAPIDAPI_KEY),
    opencorporates: has(env.OPENCORPORATES_API_KEY),
    ransomwarelive: has(env.RANSOMWARELIVE_API_KEY),
    urlscanner: has(env.URLSCANNER_API_KEY),
    // Listing FOFA here is deliberate: /health's `${enabled}/${total} optional tool
    // APIs configured` is the one deploy signal that does NOT depend on build-info.ts
    // being restamped. When 8df15d2 added fofa_search to the mirror without touching
    // this file or the build marker, BOTH signals stayed frozen at their old values,
    // so a green /health was consistent with the deploy having happened and with it
    // never having been attempted. Any tool added with a new key belongs here.
    fofa: has(env.FOFA_API_KEY),
    // GeoSeer, listed for exactly the reason above — and it has already happened
    // a second time. GeoSeer was added to the mirror and deployed on 2026-08-17
    // WITHOUT touching this file or build-info.ts, so both signals stayed frozen
    // (`build: 2d47656`, `16/19`) and it was impossible to tell from outside
    // whether the tool was live. Adding it here moves the denominator to 20, which
    // is the cheap, unauthenticated way to detect that a deploy actually shipped
    // new capability. Any tool added with a new key belongs here.
    geoseer: has(env.GEOSEER_API_KEY),
    opsis: has(env.OPSIS_API_KEY),
  };
  const enabledOptional = Object.values(tools).filter(Boolean).length;
  const checks: Record<string, { ok: boolean; detail?: string; reason?: string; role?: "active" | "fallback" }> = {
    orchestrator: orchestratorOk
      ? { ok: true }
      : { ok: false, detail: "Set MINIMAX_API_KEY in Supabase secrets" },
    core: coreOk
      ? { ok: true }
      : { ok: false, detail: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY missing" },
    tools: {
      ok: true, // optional tools are never required
      detail: `${enabledOptional}/${Object.keys(tools).length} optional tool APIs configured`,
    },
  };
  return { ok: orchestratorOk && coreOk, checks };
}

export function isHealthProbe(req: Request): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  try {
    const u = new URL(req.url);
    return u.searchParams.get("health") === "1";
  } catch {
    return false;
  }
}

export async function handleHealthProbe(req: Request): Promise<Response> {
  const r = deriveReadiness({
    MINIMAX_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
    SUPABASE_ANON_KEY,
    OATHNET_API_KEY, SYNAPSINT_API_KEY, OSINTNOVA_API_KEY, SOCIALFETCH_API_KEY,
    CORDCAT_API_KEY, HUNTER_API_KEY, INTELBASE_API_KEY, HIBP_API_KEY, EXA_API_KEY,
    FIRECRAWL_API_KEY, SERUS_API_KEY, IPQUALITYSCORE_API_KEY, GITHUB_API_TOKEN, PERPLEXITY_API_KEY,
    OPENCORPORATES_API_KEY, RANSOMWARELIVE_API_KEY,
    URLSCANNER_API_KEY,
    RAPIDAPI_KEY: Deno.env.get("RAPIDAPI_KEY"),
    FOFA_API_KEY: Deno.env.get("FOFA_API_KEY"),
    GEOSEER_API_KEY: Deno.env.get("GEOSEER_API_KEY"),
    OPSIS_API_KEY,
  });
  const u = new URL(req.url);
  const wantProbe = u.searchParams.get("probe") === "1";
  // Maintenance gate. A plain `?health=1` is a LIVENESS probe: the browser fires one
  // every 30s per open case (ChatWindow's sweep) and on every stream end, and until
  // 2026-10-19 each of those ran the stale-run recovery, the rejected-cluster sweep,
  // a 5,000-row `count: "exact"` scan of tool_usage_log, synthesis and the cache
  // sweep — a continuous table scan billed as database compute. Those now run only
  // when the caller asks (`?maintenance=1`, or the authenticated `?probe=1`), which is
  // what the frontend sweep passes. The plain probe keeps the orchestrator readiness
  // and every pure self-test, and reports `checks.maintenance` so a reader can tell
  // which kind of probe produced the payload. Kill switch for the gate itself:
  // HEALTH_MAINTENANCE_ALWAYS=true restores the pre-gate behaviour on every probe.
  const wantMaintenance = wantProbe || maintenanceRequested(u);

  // Which provider is ACTUALLY selected at runtime (same pure selector index.ts
  // uses) + its model. This is the DeepSeek STOP-gate signal: selected_provider tells
  // an operator at a glance whether DeepSeek — not MiniMax — is the live orchestrator.
  const selected = resolveSelectedOrchestrator();

  // Probe DeepSeek (now-default primary when keyed) AND MiniMax in parallel so the
  // health response stays bounded. checks.deepseek is reported UNCONDITIONALLY and is
  // INDEPENDENT of checks.minimax — a healthy MiniMax fallback can never mask a
  // DeepSeek key-missing / probe failure.
  const [deepseekCheck, minimaxCheck] = await Promise.all([
    checkDeepseek(),
    checkMinimax(),
  ]);
  // Role labels: only the SELECTED provider is "active"; the other is a "fallback"
  // diagnostic. So MiniMax is never labeled active when DeepSeek is selected.
  r.checks.deepseek = { ...deepseekCheck, role: providerRole(selected.provider, "deepseek") };
  r.checks.minimax = { ...minimaxCheck, role: providerRole(selected.provider, "minimax") };
  // Anthropic orchestrator (primary by pin; GLM's backup since E2b — `role`). Config + cost-control posture only; deliberately NO
  // network probe — a ping would spend prepaid credits on every /health. Reports presence
  // of the key as a boolean, never the key. Its PRESENCE proves a build with the Anthropic
  // orchestrator is the one running.
  // E2b: is Anthropic armed as GLM's backup? The SAME pure rule index.ts routes by
  // (orchestrator_select.ts → anthropicFallbackEligible), kill switch read at call time.
  const anthropicFallbackOn = anthropicFallbackEligible({
    primary: selected.provider,
    anthropicKey: !!ANTHROPIC_API_KEY,
    modelAcceptsForcedToolChoice: !anthropicModelRejectsForcedToolChoice(ANTHROPIC_MODEL_ID),
    disabled: anthropicFallbackDisabled(),
  });
  r.checks.orchestrator_anthropic = anthropicOrchestratorHealth({
    fallback: anthropicFallbackOn,
    keyPresent: !!ANTHROPIC_API_KEY,
    pin: ORCHESTRATOR_PROVIDER,
    selectedProvider: selected.provider,
    modelId: ANTHROPIC_MODEL_ID,
    modelSource: ANTHROPIC_MODEL_SOURCE,
    thinking: ANTHROPIC_THINKING,
    effort: ANTHROPIC_EFFORT,
    limits: ANTHROPIC_RUN_LIMITS,
  });
  // Which tools' cache keys carry a result-interpretation version. Pure, no DB, so it is
  // reported on every probe — and its PRESENCE is the behavioural proof that the build
  // with versioned cache keys is the one running (see lib/tool-cache-version.ts).
  r.checks.tool_cache_version = describeToolCacheVersions();
  r.checks.negative_lookup_semantics = negativeLookupSelfTest();
  r.checks.tool_input_failure_log = toolInputFailureSelfTest();
  // Why a run's persistence/finish handler fired (lib/run-end.ts). Pure, no DB; presence proves the build.
  r.checks.run_end_log = runEndSelfTest();
  // Does a dropped browser connection end the run? It must not: the server-owned branch is the
  // only writer of the final transcript (lib/client-cancel.ts). PRESENCE proves the deployed
  // bundle; `mode` says whether the PERSIST_ON_CLIENT_CANCEL legacy switch is on.
  r.checks.client_cancel_isolation = clientCancelIsolationCheck(Deno.env.get(PERSIST_ON_CLIENT_CANCEL_ENV));
  // S1a — is admission atomic (one conditional UPDATE, 409 on a live heartbeat)? Pure.
  // Its PRESENCE proves the build with the lease is live; ok:false means the filter
  // drifted from the recovery stale bar. Kill switch: RUN_LEASE_DISABLED.
  r.checks.run_lease = runLeaseSelfTest();
  // Per-case dead-target memory (lib/dead-target.ts). Pure, no DB. Its PRESENCE is the
  // behavioural proof that the build carrying the gate is the one running.
  r.checks.dead_target_memory = describeDeadTargetMemory();
  // Does a 401/402 from an earlier invocation of the case suppress the provider for this
  // run (cleared by any later real answer; 403 and cache replays never carry)? Pure.
  // PRESENCE proves the deployed bundle. Kill switch: PROVIDER_AUTH_PRIOR_DISABLED.
  r.checks.provider_auth_prior = providerAuthPriorSelfTest();
  // Is the prompt char budget a CEILING, or only a target the recent-window tail is
  // exempt from? Pure, no DB. Its PRESENCE is the behavioural proof that the build
  // carrying the second elision pass is the one running — the BUILD_MARKER is a
  // static string the running code echoes about itself and can never prove a bundle.
  // `ok` tracks the kill switch: false means the ceiling has been turned OFF and long
  // threads can ride over budget again, which is a state worth seeing at a glance.
  {
    const hardCeiling = promptBudgetHardCeilingEnabled();
    r.checks.prompt_budget_ceiling = {
      ok: hardCeiling,
      // `tail=summarize` is the proof-of-deploy token for the 2026-09-22 fix: the
      // build that elided the unconsumed tail by bare reference cannot emit it.
      // Read the STRATEGY, not just the key — the key alone only proves #604.
      detail: hardCeiling
        ? `hard ceiling ${TOTAL_PROMPT_CHAR_BUDGET} chars, tail=summarize`
        : `DISABLED via PROMPT_BUDGET_HARD_CEILING_DISABLED — tail exempt above ${TOTAL_PROMPT_CHAR_BUDGET} chars`,
    };
  }

  // Does record_artifacts inherit an active same-name quarantine onto the rows the
  // MODEL writes (lib/record-name-quarantine.ts)? Pure, no DB. Its PRESENCE is the
  // behavioural proof that the build carrying that gate is the one running; `ok`
  // tracks the kill switch so a disabled gate is visible at a glance.
  {
    const on = recordNameQuarantineEnabled();
    r.checks.record_name_quarantine = {
      ok: on,
      detail: on
        ? "record_artifacts inherits active person-name quarantine; exempt=person-seed-only"
        : "DISABLED via RECORD_NAME_QUARANTINE_DISABLED — model-authored rows can name unlinked persons at full authority",
    };
  }

  // May a failed DeepSeek preflight pivot the run to gemini-direct
  // (lib/preflight-pivot.ts)? Pure, no network. Its PRESENCE is the behavioural proof
  // that the build gating that pivot is live. `ok` is true either way: both settings
  // are deliberate operator choices, and the detail names which one is in force.
  r.checks.preflight_pivot = { ok: true, detail: preflightPivotHealthDetail(geminiPreflightPivotEnabled()) };

  // Does the run skip a DeepSeek preflight whose answer cannot change routing
  // (lib/preflight-pivot.ts → shouldRunPreflight)? Pure, no network. Its PRESENCE is
  // the behavioural proof that this build is live; the detail names the policy in force.
  const preflightFallback = resolveFallbackProvider({
    orchestratorProvider: ORCHESTRATOR_PROVIDER,
    hasLovableGateway: !!lovableGateway,
    hasGeminiDirect: !!geminiDirectGateway,
    allowLovableFallback: ALLOW_LOVABLE_FALLBACK,
    anthropicFallback: anthropicFallbackOn,
  });
  // E2b proof key. Its PRESENCE proves the build where Anthropic backs GLM is live;
  // `fallback` is the target routing resolves, from the same resolveFallbackProvider.
  r.checks.orchestrator_fallback = orchestratorFallbackHealth({
    primary: selected.provider,
    anthropicKey: !!ANTHROPIC_API_KEY,
    modelAcceptsForcedToolChoice: !anthropicModelRejectsForcedToolChoice(ANTHROPIC_MODEL_ID),
    disabled: anthropicFallbackDisabled(),
    target: preflightFallback,
  });
  // The probe's RUN decision is the pre-E2b one (lib/preflight-pivot.ts →
  // shouldRunDeepseekPreflight), so the detail is derived from the same legacy target.
  const legacyPreflightFallback = resolveFallbackProvider({
    orchestratorProvider: ORCHESTRATOR_PROVIDER,
    hasLovableGateway: !!lovableGateway,
    hasGeminiDirect: !!geminiDirectGateway,
    allowLovableFallback: ALLOW_LOVABLE_FALLBACK,
  });
  r.checks.preflight_policy = {
    ok: true,
    detail: preflightPolicyHealthDetailE2b(
      preflightFallback ? { provider: preflightFallback } : null,
      legacyPreflightFallback ? { provider: legacyPreflightFallback } : null,
      deepseekPreflightAlways(),
      geminiPreflightPivotEnabled(),
    ),
  };

  // Is Opsis configured, switched off, or absent (lib/opsis.ts)? Presence only, no
  // network call. Its PRESENCE is the behavioural proof that the build carrying
  // the opsis_* tools is live; the detail says whether they can run.
  r.checks.opsis = opsisHealthDetail(!!OPSIS_API_KEY, opsisKillSwitchOn(), !opsisCreditHintDisabled());
  // Is a paid opsis_search refused (free) while runs await reading or when the run cannot
  // read it before the report? Pure probe of lib/opsis-search-guard.ts; PRESENCE proves the
  // build. The wrapper wiring is pinned by opsis_search_guard_test.ts in CI, not by this probe.
  r.checks.opsis_search_guard = opsisSearchGuardSelfTest();
  // Is a paid opsis_search still pending at finalize read (one bounded opsis_results step)
  // before persist → memory → report? Pure. PRESENCE proves the deployed bundle.
  // Kill switch: OPSIS_FINALIZE_COLLECT_DISABLED.
  r.checks.opsis_finalize_collect = opsisFinalizeCollectSelfTest();

  // Does the DEPLOYED sanitizer pair tool-calls by POSITION (message-sanitize.ts)?
  // A self-test, not a label: it runs the live sanitizer on a fixed synthetic
  // overlap probe and checks the result the way the AI SDK does. Pure and
  // silent, so health probes never emit sanitize_positional_pair_repair. Its
  // PRESENCE proves this build is live; ok:false means the pairing rule regressed.
  r.checks.message_sanitize = positionalPairingSelfTest();

  // Does every REPLAYED tool-call carry an object `input` (message-sanitize.ts)?
  // Anthropic answers a non-object `tool_use.input` with HTTP 400 on every request
  // (11 runs, 2026-10-14). A self-test on a fixed synthetic history, pure and
  // silent; `enabled:false` means TOOL_INPUT_OBJECT_REPAIR_DISABLED is set. Its
  // PRESENCE proves this build is live.
  r.checks.tool_input_object_repair = toolInputObjectRepairSelfTest();

  // Do stream errors record the provider's status and code WITHOUT the response
  // body (stream-error-classify.ts)? A self-test on a synthetic error, pure.
  r.checks.stream_error_detail = streamErrorDetailSelfTest();

  // Do excluded rows, relatives and one-word names stay OUT of the name/location
  // conflict check (contradictions.ts makesSubjectClaim)? A self-test on a fixed
  // synthetic case, pure. Its PRESENCE proves this build is live.
  r.checks.contradiction_claims = contradictionClaimSelfTest();

  // Are one-word Serus "names" kept out of name artifacts (auto-persist-findings.ts
  // serusNameAdmissible)? A pure self-test; its PRESENCE proves this build is live.
  r.checks.serus_name_filter = serusNameFilterSelfTest();

  // Is `stop_reason = budget_exhausted` attributed per INVOCATION (#611)? The
  // ceiling latch is request-owned (index.ts `budgetCeiling`, set by
  // wrapToolsWithCache from startCall's refusal), so an overlapping run on the
  // same thread can neither erase it nor inherit it. Pure, no network. Its
  // PRESENCE is the behavioural proof that this build is live.
  r.checks.stop_reason_attribution = {
    ok: true,
    detail: "budget_exhausted only from a ceiling refusal observed by this invocation (request-owned latch)",
  };

  // Which rule marks a clustered artifact CONTRADICTED (lib/cluster.ts)? Pure. Its
  // PRESENCE proves the build with the explicit-signal rule is live.
  r.checks.cluster_contradiction_rule = legacyNeedsReviewContradiction()
    ? { ok: true, detail: "LEGACY via CLUSTER_LEGACY_NEEDS_REVIEW_CONTRADICTION — needs_review counts as contradicted" }
    : { ok: true, detail: "explicit signals only; group-keyed contradicted cluster ids" };

  // SSRF guard coverage (safety.ts isPrivateHost). Its PRESENCE proves the build
  // that also blocks the IPv6 forms of internal addresses is live.
  r.checks.ssrf_guard = { ok: true, detail: ssrfGuardHealthDetail(ssrfGuardLegacy()) };

  // Error hygiene (lib/redact-error.ts). Its PRESENCE proves the build that redacts
  // the catch-all 500 detail and keeps the seed text out of the log is live.
  r.checks.error_redaction = { ok: true, detail: "500 detail and fault/stream logs redacted (configured keys + shapes); seed text not logged" };

  // Do pages on law-enforcement/court .gov hosts and news outlets get their class
  // from the HOST (source-classification.ts classifyOriginHost)? Pure. Its PRESENCE
  // proves the build is live; ok:false means a rule misclassified its own probe.
  r.checks.source_origin_rules = sourceOriginRulesSelfTest();
  // An archived copy read by a page-fetch tool classes as `archive`, never `social_profile_active`. Pure;
  // `switch` reports ARCHIVE_ORIGIN_RULE_DISABLED.
  r.checks.archive_origin_rule = archiveOriginRuleSelfTest();
  r.checks.breach_origin_cap = breachOriginCapSelfTest();
  r.checks.memory_context = memoryContextSelfTest();
  r.checks.user_supplied_status = userSuppliedStatusSelfTest();
  // A1: can a model-supplied metadata blob carry the analyst's review / release / dismissal /
  // provenance keys? Pure probe of the strip module. PRESENCE (and the reserved-key count in the
  // detail) proves which build is live; ok:false means the module failed its own probe. It does NOT
  // prove the record tools still call the module — that wiring is pinned in CI by
  // analyst_authority_boundary_test.ts, and the detail says so.
  r.checks.analyst_authority_boundary = analystAuthorityBoundarySelfTest();

  // Is a memory_save / minimax_correlate call that is right in substance but wrong in SHAPE re-shaped (and only when
  // unambiguous), while values (kind, scope, confidence) are never rewritten? Pure. PRESENCE proves the deployed bundle.
  r.checks.memory_input_normalization = memoryInputNormalizationSelfTest();

  // Is a boolean parameter sent as the EXACT string "true"/"false" repaired instead of burning the step, while every other
  // string and every consent flag stays rejected? Pure. PRESENCE proves the deployed bundle; ok:false = failed its own probe.
  r.checks.exact_boolean_repair = exactBooleanRepairSelfTest();
  // Is indicia_person's missing-first-name search an explicit boolean opt-in (default off, never repaired from a string),
  // ledgered at its real higher cost? Pure; `switch` reports INDICIA_MISSING_FIRST_NAME_DISABLED. PRESENCE proves the bundle.
  r.checks.indicia_person_opt_in = indiciaPersonOptInSelfTest();

  // Is a near-miss tool input (kind alias, query→seed, numeric string, number→string, stray whitespace) coerced INSIDE
  // the schema when — and only when — the result validates? Pure. PRESENCE proves the deployed bundle; `switch` reports
  // INPUT_COERCION_DISABLED; ok:false = a rule failed its own probe.
  r.checks.input_coercion = inputCoercionSelfTest();
  // Does a minimax_correlate call with no seed fall back to the request's own seed (person seed,
  // then the first message's selector, never prose)? Pure probe of lib/thread-seed.ts; PRESENCE
  // proves the build. The execute wiring is pinned by correlate_seed_default_test.ts in CI.
  r.checks.correlate_seed_default = correlateSeedDefaultSelfTest();
  r.checks.input_kind_inference = inputKindInferenceSelfTest(detectSeedServer);

  // breach_exposure needs a breach-class tool that RAN in the case and a non-zero result (record_artifacts), and
  // auto-extraction keeps it only from breach-capable tools. Pure. `switch` reports BREACH_EXPOSURE_GUARD_DISABLED.
  r.checks.breach_exposure_guard = breachExposureGuardSelfTest();

  // Do the analyst-rejection and quarantine-taint dispatch checks see a selector that lives in Serus
  // identifierValue/identifierType, an exact-selector query/q, or discord_id? Before this they saw an EMPTY
  // selector and failed open. Pure. PRESENCE proves the deployed bundle; `switch` reports
  // DISPATCH_SELECTOR_ALIASES_DISABLED; ok:false = the extractor failed its own probe.
  r.checks.dispatch_selector_aliases = dispatchSelectorAliasesSelfTest();

  // E3: is a call refused only because its provider already has a call in flight WAITED for (bounded, never into the
  // finalize window) and re-checked, instead of dropped? Pure. PRESENCE proves the deployed bundle; `switch` reports
  // PROVIDER_BUSY_QUEUE_DISABLED; ok:false = the wait failed its own probe.
  r.checks.provider_busy_queue = await providerBusyQueueSelfTest();

  // Is a bare 17-20 digit platform account ID (Discord/Twitter snowflake, Steam64) kept out of
  // the phone playbook? It classified as `phone` and routed a Discord-ID case into phone
  // tooling. Pure. PRESENCE proves the deployed bundle; ok:false = the classifier failed its
  // own probe. (Client mirror: src/lib/seed.ts, same 15-digit E.164 ceiling.)
  r.checks.seed_account_id = seedAccountIdSelfTest();

  // E4: do the analyst's dismissed/wrong marks carry across the user's cases (latest verdict wins,
  // in-thread overrides, "#caseonly" stays put, phones fold by digits, username != name), while
  // confirmed/key/recheck stay pivot priority only? Pure. PRESENCE proves the deployed bundle;
  // "LEGACY" = CROSS_CASE_REVIEWS_DISABLED=true; ok:false = the index failed its own probe.
  r.checks.cross_case_reviews = crossCaseReviewsSelfTest();

  // Are the agent's own setup rows (triage_decision / cluster_decision / coverage_audit /
  // tool_audit) kept out of identity clusters? A row naming the seed handle used to join
  // the subject's cluster and become the anchor every later merge was logged against.
  // Pure. PRESENCE proves the deployed bundle; ok:false = the rule failed its own probe.
  // Kill switch: CLUSTER_BOOKKEEPING_INERT_DISABLED.
  r.checks.cluster_bookkeeping_inert = clusterBookkeepingSelfTest();

  // Does a source token that records a lookup finding NOTHING — "(404)", "(0 hits)",
  // "(no PTR)", "(circuit-broken)" — contribute a source class? It must not: an empty
  // lookup supplied the second "independent" class on 11 of 14 IP rows of a live case.
  // Pure. Its PRESENCE proves the deployed bundle carries the rule; ok:false means the
  // rule misclassified its own probe. Kill switch: NEGATIVE_QUALIFIER_CLASS_DISABLED.
  r.checks.negative_qualifier_rule = negativeSourceQualifierSelfTest();

  // Re-gate the orchestrator check on the SELECTED provider's key, in BOTH directions.
  // deriveReadiness() still hardcodes orchestrator := has(MINIMAX_API_KEY) (its pure
  // unit tests pin that), which is now the wrong question: MiniMax is the FALLBACK once
  // DeepSeek is selected. A one-directional override would be a false NEGATIVE — drop
  // MINIMAX_API_KEY on a healthy DeepSeek-only deployment and the function would report
  // itself down. So the gate is symmetric: the selected provider's key decides, and
  // overall ok is recomputed from it (core is the other hard requirement; tools are not).
  // Losing the MiniMax fallback is NOT hidden by this — it still surfaces as
  // checks.minimax {ok:false, reason:"missing_key", role:"fallback"}.
  const selectedKeyPresent =
    selected.provider === "deepseek" ? !!DEEPSEEK_API_KEY :
    selected.provider === "minimax" ? !!MINIMAX_API_KEY :
    selected.provider === "grok" ? !!XAI_API_KEY :
    selected.provider === "anthropic" ? !!ANTHROPIC_API_KEY :
    (!!MINIMAX_API_KEY || !!LOVABLE_API_KEY);
  const gate = orchestratorGate(selected.provider, selectedKeyPresent, r.checks.core?.ok === true);
  r.checks.orchestrator = gate.check;
  r.ok = gate.ok;
  // Active-provider reachability, surfaced separately (visible) without coupling the
  // 200/503 status to a transient probe blip — a failed probe on a keyed provider still
  // has the MiniMax fallback, matching the existing MiniMax-blip philosophy.
  const activeCheck = selected.provider === "deepseek" ? deepseekCheck
    : selected.provider === "minimax" ? minimaxCheck : null;
  const orchestratorActiveOk = activeCheck ? activeCheck.ok : selectedKeyPresent;

  if (wantProbe) {
    const supplied = req.headers.get("x-probe-secret") ?? "";
    if (!OSINT_AGENT_PROBE_SECRET || supplied !== OSINT_AGENT_PROBE_SECRET) {
      return new Response(
        JSON.stringify({ ok: false, error: "unauthorized" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
  }

  if (!wantMaintenance) {
    r.checks.maintenance = { ok: true, detail: MAINTENANCE_SKIPPED_DETAIL };
  }
  try {
    if (wantMaintenance && SUPABASE_URL && SERVICE_KEY) {
      r.checks.maintenance = { ok: true, detail: "ran: recovery, rejected-cluster sweep, credential health, synthesis, cache sweep" };
      const admin = createClient(SUPABASE_URL, SERVICE_KEY);
      const recovered = await recoverStaleActiveThreads(admin, { limit: 20, reason: "stale heartbeat recovered by health sweep" });
      r.checks.recovery = recovered.errors
        ? { ok: false, detail: `recovered ${recovered.recovered}; ${recovered.errors} error(s)` }
        : { ok: true, detail: `recovered ${recovered.recovered} stale active run(s)` };
      // Rejected-cluster sweep: an analyst Dismiss clears the persisted
      // cluster_id / subject_id within a probe interval instead of waiting for
      // the thread to be re-run. Bounded, idempotent, converges to one read.
      // Its presence in the payload is the behavioural proof this build is
      // deployed (see CLAUDE.md, "checks.synthesis" for the pattern).
      try {
        const swept = await sweepRejectedClusterAssignments(admin);
        r.checks.rejected_cluster_sweep = { ok: swept.ok, detail: describeSweep(swept) };
      } catch (e) {
        r.checks.rejected_cluster_sweep = { ok: false, detail: String(e).slice(0, 160) };
      }
      // Provider authorization health. The `tools` line above is a PRESENCE test
      // (`has(env.X_API_KEY)`), so it read "17/20 optional tool APIs configured"
      // throughout the period github_code_search answered 401 on every call — and
      // it does not move when a secret's VALUE is rotated, so it cannot confirm a
      // fix either. This reports what providers actually answered: who refused us,
      // and who has succeeded SINCE refusing (the signal a rotation took).
      //
      // `ok` is allowed to go false here on purpose. A refusing provider is
      // actionable, and if this line sits permanently red for a tool that 403s by
      // policy rather than by credential (reddit_user blocks datacenter IPs), that
      // is itself the signal to take it off the default sweep. Top-level `ok`
      // is orchestrator+core only, so this never fails the probe.
      //
      // Bounded on purpose: the newest CREDENTIAL_HEALTH_SAMPLE_ROWS rows inside the
      // window, by the (created_at) index, with NO exact count — the 5,000-row
      // `count: "exact"` read this replaced was the single largest query the function
      // issued, and it ran on every liveness probe. A full sample means the window
      // was cut and the counts are a floor, which describeCredentialHealth says.
      try {
        const since = new Date(Date.now() - CREDENTIAL_HEALTH_WINDOW_MS).toISOString();
        const { data, error } = await admin
          .from("tool_usage_log")
          .select("tool_name,status_code,outcome,created_at")
          .gte("created_at", since)
          .order("created_at", { ascending: false })
          .limit(CREDENTIAL_HEALTH_SAMPLE_ROWS);
        if (error) {
          // NOT ok. An unreadable instrument is not a clean bill of health, and
          // `ok:true` beside "unavailable" is the precise trap CLAUDE.md names:
          // ok:true is not "it ran". The analyst-review path already sets this
          // precedent — "verdicts unreadable: say so rather than implying nothing
          // was rejected". Top-level `r.ok` is decided before this block, so this
          // surfaces the lost evidence without failing the probe. (Codex review.)
          r.checks.credentials = {
            ok: false,
            detail: `unavailable — cannot tell whether any provider is refusing us: ${error.message.slice(0, 100)}`,
          };
        } else {
          const rows = (data ?? []) as Array<Record<string, unknown>>;
          const health = summarizeCredentialHealth(rows);
          // An unbounded or capped select returns short with NO error. Saying so
          // keeps the counts readable as a floor rather than as the whole truth.
          const truncated = rows.length >= CREDENTIAL_HEALTH_SAMPLE_ROWS;
          r.checks.credentials = {
            ok: health.failing.length === 0,
            detail: describeCredentialHealth(health, truncated),
          };
        }
      } catch (e) {
        r.checks.credentials = {
          ok: false,
          detail: `unavailable — cannot tell whether any provider is refusing us: ${String(e).slice(0, 100)}`,
        };
      }
      // Finding synthesis. Deliberately AFTER recovery and inside the same
      // try/catch: a thread must be marked finished before it is a candidate, and
      // a synthesis fault must degrade to a reported check, never to a failed
      // probe. This is a separate request from any run, which is what makes it
      // structurally incapable of failing finalize (see finding-synthesis-sweep.ts).
      // Ships DARK: both scopes default OFF and are independent, so the forward
      // path can be enabled without the backfill — which is a production write
      // into closed cases — and either can be revoked alone.
      const dryRun = synthesisDryRun();
      const scopes = (["forward", "backfill"] as const).filter((sc) => synthesisEnabled(sc));
      if (scopes.length === 0) {
        r.checks.synthesis = { ok: true, detail: "disabled" };
      } else {
        let written = 0, proposed = 0, threads = 0, errs = 0;
        const dist = { zero: 0, one: 0, twoPlus: 0 };
        for (const sc of scopes) {
          const s2 = await synthesizeMissingFindings(admin, { limit: 5, scope: sc, dryRun });
          written += s2.findingsWritten; proposed += s2.findingsProposed;
          threads += s2.threadsScanned; errs += s2.errors;
          dist.zero += s2.distribution.zero; dist.one += s2.distribution.one; dist.twoPlus += s2.distribution.twoPlus;
        }
        const mode = dryRun ? "DRY RUN — nothing written" : `${written} written`;
        const detail = `${scopes.join("+")}: ${mode}; ${proposed} proposed over ${threads} thread(s) ` +
          `(0:${dist.zero} 1:${dist.one} 2+:${dist.twoPlus})`;
        r.checks.synthesis = errs ? { ok: false, detail: `${detail}; ${errs} error(s)` } : { ok: true, detail };
      }

      // Expired tool-call cache. Same placement and same reasoning as the two
      // sweeps above: a separate request from any run, bounded per invocation,
      // and a fault becomes a reported check rather than a failed probe.
      //
      // Note WHERE this sits: `r.ok` was already decided at the orchestrator
      // gate further up. Nothing below can flip it, so a cache-sweep failure
      // cannot turn /health red or make it answer 503 — that is structural, not
      // a promise. Ships DARK (CACHE_SWEEP_ENABLED defaults off) because it
      // deletes production rows; CACHE_SWEEP_DRY_RUN measures the backlog first.
      if (!cacheSweepEnabled()) {
        r.checks.cache_sweep = { ok: true, detail: "disabled" };
      } else {
        const c = await sweepExpiredCache(admin, { dryRun: cacheSweepDryRun() });
        r.checks.cache_sweep = c.errors
          ? { ok: false, detail: `${describeCacheSweep(c)}; ${c.errors} error(s)` }
          : { ok: true, detail: describeCacheSweep(c) };
      }
    }
  } catch (e) {
    r.checks.recovery = { ok: false, detail: String(e).slice(0, 160) };
  }

  type ProbeResult = { ok: boolean; latencyMs: number; error?: string };
  const providers: Record<string, ProbeResult> = {};
  if (wantProbe) {
    const PROBE_TIMEOUT_MS = 8000;
    const probeProvider = async (
      name: string,
      hasKey: boolean,
      fn: (signal: AbortSignal) => Promise<{ ok: boolean; status: number }>,
    ): Promise<ProbeResult> => {
      if (!hasKey) return { ok: false, latencyMs: 0, error: "key_not_configured" };
      const t0 = Date.now();
      const ctrl = new AbortController();
      // Hard 8s cap: race the provider call against a timeout that both aborts
      // the in-flight request (bare fetches honor ctrl.signal) AND resolves a
      // bounded result — so a stalled paid probe can never hang the health
      // response (e.g. MiniMax's own 45s internal timeout, or a hung gateway).
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<ProbeResult>((resolve) => {
        timer = setTimeout(() => {
          ctrl.abort();
          resolve({ ok: false, latencyMs: Date.now() - t0, error: "timeout" });
        }, PROBE_TIMEOUT_MS);
      });
      try {
        return await Promise.race([
          fn(ctrl.signal).then((res) => ({
            ok: res.ok,
            latencyMs: Date.now() - t0,
            ...(res.ok ? {} : { error: `status=${res.status}` }),
          })),
          timeout,
        ]);
      } catch {
        return { ok: false, latencyMs: Date.now() - t0, error: "unreachable" };
      } finally {
        clearTimeout(timer);
      }
    };
    const [ds, mm, gk, gm] = await Promise.all([
      probeProvider("deepseek", !!DEEPSEEK_API_KEY, async (signal) => {
        const res = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${DEEPSEEK_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: DEEPSEEK_ORCHESTRATOR_MODEL_ID,
            messages: [{ role: "user", content: "ping" }],
            max_tokens: 4,
            thinking: { type: "disabled" },
          }),
          signal,
        });
        await releaseBody(res);
        return { ok: res.ok, status: res.status };
      }),
      probeProvider("minimax", !!MINIMAX_API_KEY, (signal) => minimaxChat({ user: "ping", maxTokens: 4, temperature: 0, signal })),
      probeProvider("grok", !!XAI_API_KEY, async (signal) => {
        const res = await fetch("https://api.x.ai/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${XAI_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: GROK_ORCHESTRATOR_MODEL_ID, messages: [{ role: "user", content: "ping" }], max_tokens: 4 }),
          signal,
        });
        await releaseBody(res);
        return { ok: res.ok, status: res.status };
      }),
      probeProvider("gemini", !!Deno.env.get("GEMINI_API_KEY"), async (signal) => {
        const res = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${Deno.env.get("GEMINI_API_KEY")}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: GEMINI_FALLBACK_MODEL_ID, messages: [{ role: "user", content: "ping" }], max_tokens: 4 }),
          signal,
        });
        await releaseBody(res);
        return { ok: res.ok, status: res.status };
      }),
    ]);
    providers.deepseek = ds;
    providers.minimax = mm;
    providers.grok = gk;
    providers.gemini = gm;
  }
  const body: Record<string, unknown> = {
    ok: r.ok,
    service: "osint-agent",
    version: "1.2.2",
    // Build marker derives from the git short SHA (scripts/stamp-build.mjs) so a
    // deployed function is verifiable against source. Compare this to recent
    // `git log` to detect deploy drift. build_committed_at gives the commit date.
    build: BUILD_MARKER,
    build_committed_at: BUILD_COMMITTED_AT,
    // The live orchestrator selection — the DeepSeek STOP-gate signal.
    selected_provider: selected.provider,
    selected_model: selected.model,
    orchestrator_reason: selected.reason,
    orchestrator_active_ok: orchestratorActiveOk,
    checks: r.checks,
    intelbase_enabled: INTELBASE_ENABLED,
    // Account-level breach-reveal policy, surfaced for the same reason as the
    // build marker: so it can be VERIFIED rather than assumed. It defaults ON in
    // source, but an explicit REVEAL_BREACH_DATA=false in the deployed function's
    // secrets silently overrides that — and there is no other way to observe which
    // is in force without running a real breach query and reading the output.
    //
    // This cost real time on 2026-08-10: a case returned breach rows carrying only
    // exposed_field CLASSES and no concrete values, and the deployed setting could
    // not be distinguished from the model simply not recording them. One curl now
    // answers it. Boolean only — never echo secret VALUES on a public endpoint.
    reveal_breach_data: REVEAL_BREACH_DATA,
  };
  if (wantProbe) body.providers = providers;
  return new Response(
    req.method === "HEAD" ? null : JSON.stringify(body),
    {
      status: r.ok ? 200 : 503,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    },
  );
}
