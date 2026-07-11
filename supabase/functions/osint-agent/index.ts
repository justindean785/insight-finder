/**
 * index.ts — OSINT agent entry point (refactored).
 * Health probe → health-handler.ts, tool registry → tool-registry.ts.
 */

import { convertToModelMessages, streamText, generateText, stepCountIs, type UIMessage, type ModelMessage } from "npm:ai@6";

import { MODELS, ORCHESTRATOR_TIER } from "./models.ts";
import { buildWorkflowAddendum } from "./workflow_prompt.ts";
import * as circuit from "./circuit.ts";
import { discoverCapabilities, capabilityEnvKeys, gatedToolNames } from "./capabilities.ts";

import {
  corsHeaders, MINIMAX_API_KEY, LOVABLE_API_KEY,
  lovableGateway, PRIMARY_ORCHESTRATOR_MODEL_ID, FALLBACK_MODEL_ID,
  geminiDirectGateway, GEMINI_FALLBACK_MODEL_ID, ALLOW_LOVABLE_FALLBACK,
  grokGateway, openAdapterGateway, ORCHESTRATOR_PROVIDER,
  GROK_ORCHESTRATOR_MODEL_ID, OPENADAPTER_ORCHESTRATOR_MODEL_ID,
  degradedTools, deadHosts, resetFirecrawlCreditsLow, INTELBASE_ENABLED,
} from "./env.ts";

import { detectSeedServer } from "./validation.ts";
import { sanitizeToolOutput, capPartsSize, capToolPartPayloads } from "./safety.ts";
import { sanitizeModelMessages, capToolResultOutputs, summarizeToolResultValue } from "./message-sanitize.ts";
import { guard, routingGuard, triageState, countRecordArtifactCalls } from "./guard.ts";
import { setupRequest } from "./auth.ts";
import { minimax, minimaxChat, markMinimaxHealthy, minimaxHealthyWithin } from "./providers.ts";
import { selectOrchestratorProvider } from "./orchestrator_select.ts";
import { FINDING_LABELS } from "./catalog.ts";
import { SYSTEM_PROMPT_FULL } from "./system-prompt.ts";
import { wrapToolsWithCache } from "./cache.ts";
import { beginCycle, clearRuntime } from "./runtime-policy.ts";
import {
  TOTAL_PROMPT_CHAR_BUDGET, RECENT_WINDOW,
  MAX_ORCHESTRATOR_STEPS, ORCHESTRATOR_WALL_CLOCK_MS, MAX_TOOL_CALLS_PER_RUN,
  capTotalToBudget, deadlineReached,
} from "./orchestrator-budget.ts";
import {
  shouldForceFinalize, buildFinalizeDirective, buildPerCycleCompactDirective,
  FINALIZE_ACTIVE_TOOLS, FINALIZE_MAX_STEPS,
  extractAssistantReportText, needsReportSalvage, buildSalvageSynthesisPrompt, toolCallCapReached,
} from "./orchestrator-finalize.ts";
import { repairUnknownTool } from "./unknown-tool-guard.ts";

import { isHealthProbe, handleHealthProbe } from "./health-handler.ts";
import { applyClusteringToThread } from "./lib/cluster.ts";
import { buildTools } from "./tool-registry.ts";
import { runAttachmentIntake, type AttachmentIntakeResult } from "./attachment-intake.ts";
import { runAnchorIntake, type AnchorIntakeResult } from "./anchor-intake.ts";
import { isMessageSchemaError, classifyStreamProviderError } from "./stream-error-classify.ts";
import {
  shouldFallbackAfterMinimaxPreflight,
  minimaxPreflightFailureLabel,
} from "./minimax-preflight.ts";
import { evaluateCreditGate, evaluateDailyCapGate, reasonToAbortForCredits } from "./credits.ts";

// ---- Orchestrator resilience knobs (Phase 1: MissingToolResults crash) --------
// Explicit per-step output-token ceiling. Root cause of the crash: MiniMax emits
// PARALLEL tool calls and, when a step's generation runs long, the trailing calls
// get truncated mid-stream so their results never arrive — the run then dies with
// "Tool results are missing for tool calls <id>". Bounding each step's output makes
// that truncation far less likely while still leaving room for a full synthesis
// report (~8k tokens ≈ 6k words). Verified lever: streamText `maxOutputTokens` is
// forwarded as `max_tokens` by @ai-sdk/openai-compatible@1 (getArgs).
const ORCHESTRATOR_MAX_OUTPUT_TOKENS = 8192;
// Force the MiniMax orchestrator to SERIAL tool calls (one per step). This removes
// the truncated-trailing-parallel-call crash at the source. Verified lever for
// ai@6 + @ai-sdk/openai-compatible@1: the chat model's getArgs spreads
// `providerOptions[providerName]` into the request body, stripping only its three
// recognised keys (user/reasoningEffort/textVerbosity), so an unrecognised key
// like `parallel_tool_calls` reaches MiniMax's OpenAI-compatible /chat/completions
// verbatim. `providerName` = the `name` passed to createOpenAICompatible ("minimax").
// Set false = disable parallelism. (cache.ts return-on-throw + the message
// sanitizer are the defense-in-depth net if a provider ever ignores this flag.)
const ORCHESTRATOR_PARALLEL_TOOL_CALLS = false;
// MAX_ORCHESTRATOR_STEPS (named ~30 step cap) + ORCHESTRATOR_WALL_CLOCK_MS (clean
// wall-clock deadline) now live in ./orchestrator-budget.ts alongside the context
// budget, so all of the orchestrator's step/size knobs share one testable source.

function extractManualOverrideSelector(messages: UIMessage[]): string | null {
  const latestUser = [...messages].reverse().find((message) => message.role === "user");
  if (!latestUser || !Array.isArray(latestUser.parts)) return null;
  const text = latestUser.parts
    .filter((part): part is { type: "text"; text: string } =>
      part?.type === "text" && typeof (part as { text?: unknown }).text === "string"
    )
    .map((part) => part.text)
    .join("\n");
  const match = text.match(/^\s*manual override\s*:\s*(.+?)\s*$/im);
  return match?.[1]?.trim() || null;
}

Deno.serve(async (req) => {
  if (isHealthProbe(req)) return handleHealthProbe(req);

  degradedTools.clear();
  deadHosts.clear();
  resetFirecrawlCreditsLow();

  // ---- Reset guard/triage state (module-scoped, must be reset per-request) ----
  guard.artifactsSinceCorrelate = 0;
  routingGuard.artifactsTotal = 0;
  routingGuard.memoryRecallTimestamps = [];
  routingGuard.memoryRecallSubjectsThisStep.clear();
  triageState.ran = false;
  triageState.seed = null;
  triageState.seedType = null;
  triageState.seedDomain = null;
  triageState.cleared.clear();
  triageState.reasons = [];
  triageState.skipped = [];
  triageState.identitySignals.name = false;
  triageState.identitySignals.username = false;

  try {
    // ---- setupRequest handles CORS, auth, thread verification, message persistence ----
    const ctx = await setupRequest(req);
    const { supabase, supabaseAdmin, user, userId, threadId, archiveEnabled, detectedSeedType, messages } = ctx;
    const manualOverrideSelector = extractManualOverrideSelector(messages);

    // ---- Per-user credit gate (beta budget protection) ----------------------
    // The OWNER and any ADMIN are UNLIMITED — never gated, never debited. Only
    // non-admin beta users are checked. Belt-and-suspenders: a true `unlimited`
    // ledger flag OR the 'admin' role both exempt the user, so the owner can
    // never be locked out. On any bookkeeping error we fail OPEN for this run
    // (allow it) but stay non-exempt so the debit/accounting still applies.
    const CREDIT_RUN_RESERVE_MICRO_USD = 20000; // ~$0.02 — enough for one paid call
    let creditsExempt = false;
    try {
      const [creditRes, adminRes] = await Promise.all([
        supabaseAdmin.from("user_credits").select("balance_micro_usd,unlimited,blocked").eq("user_id", userId).maybeSingle(),
        supabaseAdmin.rpc("has_role", { _user_id: userId, _role: "admin" }),
      ]);
      // FAIL OPEN on a bookkeeping READ error. A Supabase query returns
      // { data, error } WITHOUT throwing, so a transient PostgREST/DB error
      // leaves creditRes.data null. Enforcing the gate on null data would
      // wrongly DENY a paying user ("Out of credits") on a DB blip — the
      // opposite of the "never hard-fail a run on credit bookkeeping" intent
      // (Copilot review). Skip the gate (allow the run) and log; creditsExempt
      // stays false so the debit still applies once the ledger is reachable.
      // NOTE: this also skips the `blocked` (paused/banned) check for the
      // duration of the read error — a deliberate best-effort tradeoff. It is
      // backstopped: creditsExempt stays false, so the first paid call debits
      // via debit_user_credits, which returns ok:false/'blocked', and the
      // mid-run hard-stop aborts the run at the next step boundary. So a blocked
      // account gets at most a partial run on a transient blip, not a free one
      // (only a full DB outage — where nothing can enforce `blocked` — lets it
      // through, an accepted degraded mode). Failing CLOSED here instead would
      // lock out every legitimate paying user on any DB blip, which is worse.
      if (creditRes.error) {
        console.warn("[credits] pre-gate read failed (allowing run):", creditRes.error.message ?? creditRes.error);
      } else {
        const creditRow = creditRes.data as { balance_micro_usd?: number; unlimited?: boolean; blocked?: boolean } | null;
        const isAdmin = adminRes.data === true;
        const gate = evaluateCreditGate(creditRow, isAdmin, CREDIT_RUN_RESERVE_MICRO_USD);
        creditsExempt = gate.exempt;
        if (!gate.allow) {
          return new Response(JSON.stringify({
            error: "Out of credits",
            code: gate.code,
            detail: gate.detail,
            balance_micro_usd: Number(creditRow?.balance_micro_usd ?? 0),
          }), { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        // Daily-cap gate (audit F04): a balance check alone lets a capped user
        // keep starting new runs all day. Read the current day's spend via the
        // atomic debit RPC with a zero amount — a pure read that still applies
        // the RPC's own UTC-day rollover correction (20260629_user_credits.sql:94-96),
        // so a fresh calendar day is recognized even if daily_window_start on a
        // raw SELECT hasn't been reset by a real debit yet today.
        if (!creditsExempt) {
          const { data: dailyData, error: dailyErr } = await supabaseAdmin.rpc("debit_user_credits", {
            _user_id: userId,
            _amount_micro_usd: 0,
          });
          // Same fail-OPEN rule, made EXPLICIT + logged (Copilot review): if the
          // rollover-read RPC errors, allow the run rather than enforce/deny on
          // null data.
          if (dailyErr) {
            console.warn("[credits] daily-cap read failed (allowing run):", dailyErr.message ?? dailyErr);
          } else {
            const dailyRow = (Array.isArray(dailyData) ? dailyData[0] : dailyData) as
              | { daily_spent?: number; unlimited?: boolean }
              | null;
            const dailyGate = evaluateDailyCapGate(dailyRow);
            if (!dailyGate.allow) {
              return new Response(JSON.stringify({
                error: "Daily credit cap reached",
                code: dailyGate.code,
                detail: dailyGate.detail,
                daily_spent_micro_usd: Number(dailyRow?.daily_spent ?? 0),
              }), { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } });
            }
          }
        }
      }
    } catch (e) {
      // Never hard-fail a run on credit bookkeeping; allow it (debit still runs).
      console.warn("[credits] pre-gate check failed (allowing run):", e);
    }

    const { tools, availableToolsForAudit } = buildTools({
      supabase, supabaseAdmin, userId, threadId, archiveEnabled, detectedSeedType, messages, manualOverrideSelector,
    });

    const modelMessages = await convertToModelMessages(messages);

    // #238: older-result cap tightened 4000→1500. Safe only BECAUSE older results
    // now go through selector-preserving summarization (summarizeToolResultValue) —
    // every pivot-able selector survives regardless of this cap; only the raw
    // envelope/head shrinks. Recent results keep their full raw cap below.
    const MAX_TOOL_RESULT_CHARS_OLD = 1500;
    const MAX_TOOL_RESULT_CHARS_RECENT = 16000;
    // RECENT_WINDOW, TOTAL_PROMPT_CHAR_BUDGET, approxMsgChars + capTotalToBudget are
    // imported from ./orchestrator-budget.ts (pure + unit-tested).
    const truncateStr = (s: string, max: number) =>
      s.length <= max ? s : s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;
    const truncateValue = (val: unknown, max: number): unknown => {
      if (typeof val === "string") return truncateStr(val, max);
      if (Array.isArray(val)) {
        const joined = JSON.stringify(val);
        if (joined.length <= max) return val;
        return truncateStr(joined, max);
      }
      if (val && typeof val === "object") {
        const joined = JSON.stringify(val);
        if (joined.length <= max) return val;
        return truncateStr(joined, max);
      }
      return val;
    };
    interface TrimPart {
      type?: string;
      output?: unknown;
      text?: unknown;
      [k: string]: unknown;
    }
    // Hard total-prompt budget + reference-summary elision now live in
    // ./orchestrator-budget.ts (TOTAL_PROMPT_CHAR_BUDGET, capTotalToBudget,
    // approxMsgChars). The per-message truncation above caps each tool result;
    // capTotalToBudget then bounds the cumulative array by eliding the oldest
    // tool-result OUTPUTS into a reference+summary (the full payload is already
    // persisted in the artifact store and replayed via memory_recall), never
    // dropping a message so tool-call/result pairing stays intact.
    let trimmedMessages: ModelMessage[] = modelMessages.map((m: ModelMessage, idx: number) => {
      const isRecent = idx >= modelMessages.length - RECENT_WINDOW;
      const max = isRecent ? MAX_TOOL_RESULT_CHARS_RECENT : MAX_TOOL_RESULT_CHARS_OLD;
      if (m.role !== "tool" && m.role !== "assistant") return m;
      if (!Array.isArray(m.content)) return m;
      // Recent results stay raw (the model may pivot off their detail on the very
      // next step); OLDER results are compacted with selector-preserving
      // summarization (issue #238) — the raw envelope is dropped but every
      // pivot-able selector survives, so discovery breadth isn't silently cut.
      const content = (m.content as TrimPart[]).map((part: TrimPart) => {
        if (part?.type === "tool-result" && part.output != null) {
          if (part.output && typeof part.output === "object" && "value" in part.output) {
            const value = isRecent
              ? truncateValue((part.output as { value: unknown }).value, max)
              : summarizeToolResultValue((part.output as { value: unknown }).value, max, part.toolName);
            return { ...part, output: { ...part.output, value } };
          }
          return { ...part, output: isRecent ? truncateValue(part.output, max) : summarizeToolResultValue(part.output, max, part.toolName) };
        }
        if (part?.type === "text" && typeof part.text === "string") {
          return { ...part, text: truncateStr(part.text, isRecent ? 16000 : 4000) };
        }
        return part;
      });
      return { ...m, content } as ModelMessage;
    });
    trimmedMessages = capTotalToBudget(trimmedMessages, TOTAL_PROMPT_CHAR_BUDGET, RECENT_WINDOW);
    // Bound individual tool-result outputs (a few giant results were holding the
    // prompt at the ~250k schema/length ceiling) and then HARD-GUARANTEE the
    // array is structurally valid for the AI SDK: every tool-result has a
    // `{type,value}` output, every assistant tool-call has a matching tool-result
    // (synthesize a placeholder if truncation/a crashed prior cycle severed the
    // pair), and no message has empty/undefined content. Without this, one
    // malformed message (orphaned tool-call or bare-string elided output) makes
    // streamText throw InvalidPromptError/MissingToolResults EVERY cycle and the
    // run wedges until the analyst stops it. Resilience-only — touches no
    // evidence/confidence logic. See message-sanitize.ts.
    const MAX_TOOL_RESULT_CHARS = 8000;
    trimmedMessages = sanitizeModelMessages(
      capToolResultOutputs(trimmedMessages, MAX_TOOL_RESULT_CHARS),
    );

    // Cumulative cost tracker for this run.
    let runCostMicroUsd = 0;
    let costCheckpointCounter = 0;
    // Mid-run credit hard-stop (audit F02): set by the debit callback below
    // when the ledger RPC comes back ok:false (insufficient_balance /
    // daily_cap / blocked). prepareStep aborts the loop at the next step
    // boundary — same mechanism as the analyst Stop button — instead of the
    // debit failure being silently discarded while paid tool calls continue.
    let creditExhaustReason: string | null = null;
    clearRuntime(threadId);
    // Seed breadcrumb for the cycle log — the first user message's text.
    const seedValueRaw = (() => {
      const fu = ((messages ?? []) as Array<{ role?: string; parts?: Array<{ type?: string; text?: string }> }>)
        .find((m) => m?.role === "user");
      return (fu?.parts ?? [])
        .filter((p) => p?.type === "text")
        .map((p) => p?.text ?? "")
        .join(" ")
        .trim() || "(seed)";
    })();
    beginCycle(
      threadId,
      "Classify the seed, reject weak pivots, and select the smallest high-value initial batch.",
      [`seed:${seedValueRaw}`, `stage2:${triageState.ran ? "open" : "pending"}`],
    );
    // Register this run as an active owner of the thread's circuit state. A
    // double-submit / retry can start a second overlapping run for the same
    // threadId (setupRequest verifies ownership but does not lock out an active
    // run); the matching release() in persistFinalMessages only tears the state
    // down once the LAST overlapping run finishes, so the first run to complete
    // can't wipe suppressions / premium dedup / capability disables out from
    // under a still-running sibling.
    circuit.acquire(threadId);
    // Bootstrap per-thread circuit breakers (firecrawl/intelbase pre-disabled).
    circuit.applyBaselineDisables(threadId);
    // Startup provider-readiness gate (Phase B1): gate providers that can't run
    // (missing key / unsupported seed) BEFORE the execution loop. Two layers:
    //   (1) circuit.disableTool → removes them from the SCHEDULABLE set (cache.ts
    //       treats a disabled tool as a free, un-billed skip), and
    //   (2) delete them from the `tools` object → removes them from the tool
    //       SCHEMA the model ever sees, so it can't hallucinate a call to a
    //       provider that would only return "not configured" and waste a step.
    // Pure evaluation over key-PRESENCE booleans (no secret values). Logged ONCE
    // here at boot (never per-run/per-step). Note: a key that is PRESENT but
    // INVALID (e.g. an expired ipqualityscore key) passes this presence gate and
    // is instead caught by the run-level suppression on its first 401/403/429
    // (circuit.recordResult → suppressProvider, Phase B2).
    {
      const envPresence: Record<string, boolean> = {};
      for (const k of capabilityEnvKeys()) envPresence[k] = !!Deno.env.get(k);
      // INTELBASE_ENABLED is a hard-coded code-level kill switch in env.ts (the
      // provider's tools import that constant and self-skip while it is false).
      // The capability gate must follow the SAME source of truth — reading the
      // secret here would advertise intelbase_email_lookup to the model while
      // every call still returns the disabled skip (Codex review on #232).
      envPresence["INTELBASE_ENABLED"] = INTELBASE_ENABLED;
      const caps = discoverCapabilities(envPresence, null);
      for (const cap of caps) {
        if (!cap.available) {
          circuit.disableTool(threadId, cap.tool, `unavailable: ${cap.reason}${cap.detail ? ` (${cap.detail})` : ""}`);
        }
      }
      const removed: string[] = [];
      for (const name of gatedToolNames(caps)) {
        if (name in (tools as Record<string, unknown>)) {
          delete (tools as Record<string, unknown>)[name];
          removed.push(name);
        }
      }
      if (removed.length > 0) {
        console.log(
          `[readiness-gate] removed ${removed.length} unavailable tool(s) from schema (missing key/unsupported seed): ${removed.sort().join(", ")}`,
        );
      }
    }

    // ---- Attachment intake (read images/PDFs BEFORE reasoning) -----------------
    // MiniMax-M2.7 is text-only. Deterministically read any uploaded image/PDF on
    // the latest user message through Gemini vision/document mode, record public
    // anchors (watermark/handle/selectors) as LEAD-TIER artifacts, and inject a
    // summary into the system prompt so the model reasons over what the file
    // actually contained instead of a bare URL. Best-effort: never blocks the run.
    // Kick intake off WITHOUT awaiting here: the Gemini document/vision read
    // (the slow part) then overlaps the MiniMax preflight + tool/prompt setup
    // below instead of stacking serially in front of them. The summary is only
    // needed when the system prompt is assembled (baseSystemPrompt below), so we
    // await it there — time-to-first-token drops from (intake + preflight) to
    // ~max(intake, preflight). Best-effort: a rejection can't happen (intake
    // swallows its own errors) but guard anyway.
    const intakePromise = runAttachmentIntake(messages, { supabase, userId, threadId })
      .catch((e): AttachmentIntakeResult => {
        console.warn("[attachment-intake] unexpected rejection:", (e as Error)?.message);
        return { ran: false, attachments_read: 0, artifacts_inserted: 0, summary: "" };
      });

    // Tracks the cost amount already written to the DB via mid-run
    // checkpoints so the final write only adds the remaining delta.
    let lastCheckpointMicroUsd = 0;
    const onCost = (m: number) => {
      runCostMicroUsd += m;
      // Debit the per-user credit ledger as spend happens (non-exempt users
      // only — owner/admins are unlimited). Best-effort + atomic via the RPC;
      // a failed debit never interrupts the run. As the balance falls, the
      // pre-gate above blocks the user's NEXT run once they're out.
      if (m > 0 && !creditsExempt) {
        supabaseAdmin.rpc("debit_user_credits", { _user_id: userId, _amount_micro_usd: m })
          .then(
            ({ data, error }: { data: unknown; error: unknown }) => {
              if (error) { console.warn("[credits] debit failed:", error); return; }
              const row = (Array.isArray(data) ? data[0] : data) as { ok?: boolean; reason?: string } | null;
              const abortReason = reasonToAbortForCredits(row);
              if (abortReason && !creditExhaustReason) {
                creditExhaustReason = abortReason;
                console.warn(`[credits] mid-run exhaustion (${abortReason}) — aborting at next step boundary`);
              }
            },
            (e: unknown) => console.warn("[credits] debit failed:", e),
          );
      }
      // Checkpoint the running cost to threads every 5 paid tool calls so
      // mid-run crashes (context overflow, network errors) don't wipe the
      // entire spend accounting. onFinish does the final exact write.
      costCheckpointCounter++;
      if (costCheckpointCounter % 5 === 0) {
        // Use the atomic RPC so concurrent runs on the same thread don't
        // overwrite each other's running totals.
        const delta = runCostMicroUsd - lastCheckpointMicroUsd;
        lastCheckpointMicroUsd = runCostMicroUsd;
        if (delta > 0) {
          // Use service-role client — increment_thread_cost is SECURITY DEFINER
          // but has no EXECUTE grant for `authenticated`, so the user-scoped
          // client silently fails and thread spend stays at $0.
          supabaseAdmin.rpc("increment_thread_cost", { _id: threadId, _delta_cost: delta })
            .then(
              ({ error }: { error: unknown }) => { if (error) console.warn("[cost checkpoint] failed:", error); },
              (e: unknown) => console.warn("[cost checkpoint] failed:", e),
            );
        }
      }
    };

    // ---- Anchor read (READ the primary profile + SERP BEFORE the breadth sweep) --
    // When the seed resolves to a handle/profile, deterministically FETCH + READ the
    // subject's primary social profile AND the search-engine results page before the
    // model's first turn — so the run leads with the anchor identity recorded as a
    // READ, instead of constructing the profile URL as INFERRED and burning the run
    // on a ~95-platform dev-handle sweep. Kicked off here (after onCost is defined so
    // its paid reads debit credits) to overlap setup; awaited at prompt assembly. An
    // idempotency guard inside makes a follow-up turn a no-op — no repeat paid calls.
    const emptyAnchor: AnchorIntakeResult = { ran: false, profile_read: false, serp_read: false, artifacts_inserted: 0, summary: "", untrusted: "" };
    const anchorSeed = (() => {
      const head = seedValueRaw.split(/Attached files:/i)[0].trim().split("\n").map((s) => s.trim()).find(Boolean) ?? "";
      return head ? detectSeedServer(head) : null;
    })();
    const anchorPromise: Promise<AnchorIntakeResult> =
      anchorSeed && (anchorSeed.kind === "username" || anchorSeed.kind === "url" || anchorSeed.kind === "person")
        ? runAnchorIntake(anchorSeed, { supabase, userId, threadId, onCost }, messages).catch((e): AnchorIntakeResult => {
            console.warn("[anchor-intake] unexpected rejection:", (e as Error)?.message);
            return emptyAnchor;
          })
        : Promise.resolve(emptyAnchor);

    // Primary: MiniMax-M2.7 via direct API (user's Max plan covers 15k req/5h).
    // Fallback: Gemini 2.5 Pro via Lovable AI Gateway, used only if the MiniMax
    // key is missing or the initial prompt is so large it would overflow
    // MiniMax's ~200k context window on the first step.
    const approxPromptChars =
      (SYSTEM_PROMPT_FULL.length + FINDING_LABELS.length) +
      JSON.stringify(trimmedMessages).length;
    // Pre-pivot only when we'd genuinely overflow MiniMax's ~200k-token window.
    // ~600k chars ≈ 150k tokens, leaving headroom for streamed completions.
    const MINIMAX_CHAR_BUDGET = 600_000;
    const MINIMAX_MSG_BUDGET = 150;
    const minimaxAvailable = !!MINIMAX_API_KEY;
    // Tranche 2: pick the PRIMARY orchestrator provider. With nothing new
    // configured this is always "minimax" and everything below is byte-for-byte
    // the prior behavior. Grok/OpenAdapter only win when their key is set (and
    // ORCHESTRATOR_PROVIDER pins them, or they're the only provider available).
    const orchChoice = selectOrchestratorProvider({
      pin: ORCHESTRATOR_PROVIDER,
      minimax: minimaxAvailable,
      grok: !!grokGateway,
      openadapter: !!openAdapterGateway,
    });
    const minimaxIsPrimary = orchChoice.provider === "minimax";
    // Speed pass: operator can pin the orchestrator to the Lovable AI Gateway
    // (Gemini) via ORCHESTRATOR_PROVIDER=lovable. When pinned, we skip MiniMax
    // entirely — Gemini is faster and supports parallel tool calls natively
    // (the SDK default; providerOptions below only attach the serial-mode
    // flag when MiniMax is live), which is the single largest wall-clock win.
    const lovablePinned = ORCHESTRATOR_PROVIDER === "lovable" && !!lovableGateway;
    // The MiniMax-specific overflow pre-pivot + health probe only apply when
    // MiniMax is the primary. Alternative providers carry their own large
    // context windows and reliability, so they bypass the Gemini fallback path.
    const wouldOverflow =
      minimaxIsPrimary &&
      (approxPromptChars > MINIMAX_CHAR_BUDGET ||
        trimmedMessages.length > MINIMAX_MSG_BUDGET);
    let useFallback = lovablePinned
      ? true
      : minimaxIsPrimary
      ? (!minimaxAvailable || wouldOverflow)
      : false;
    if (minimaxIsPrimary && !minimaxAvailable) {
      // MINIMAX_API_KEY must be set in the deployed environment. Losing it is a
      // config regression, not a routine failover — flag it at error level so it
      // can't hide behind a quietly-working fallback (?health=1 reports the same
      // via checks.minimax.reason="missing_key").
      console.error(
        "[orchestrator] MINIMAX_API_KEY is not configured — MiniMax primary unavailable, falling back",
      );
    }
    // Which gateway takes a fallback turn. Direct Gemini is the default; the
    // Lovable gateway only participates when the operator pinned it as primary
    // (ORCHESTRATOR_PROVIDER=lovable) or opted in via ALLOW_LOVABLE_FALLBACK.
    // Grok/xAI is never a fallback (primary pin only).
    const fallbackTarget = lovablePinned
      ? { gateway: lovableGateway!, modelId: FALLBACK_MODEL_ID, label: "Lovable Gateway fallback", provider: "lovable-gateway" as const }
      : geminiDirectGateway
      ? { gateway: geminiDirectGateway, modelId: GEMINI_FALLBACK_MODEL_ID, label: "Gemini direct fallback", provider: "gemini-direct" as const }
      : (lovableGateway && ALLOW_LOVABLE_FALLBACK)
      ? { gateway: lovableGateway, modelId: FALLBACK_MODEL_ID, label: "Lovable Gateway fallback", provider: "lovable-gateway" as const }
      : null;
    // Pre-flight MiniMax health probe. The fallback selection above only fires
    // when MiniMax's key is missing or the prompt would overflow — it does NOT
    // catch the case where MiniMax is configured and accepts the request but is
    // currently rate-limited / 5xx / unreachable. In that case the run commits
    // to MiniMax and dies mid-stream with no failover (the live "Provider
    // returned error"). So when MiniMax is the chosen provider and a Gemini
    // fallback exists, ping MiniMax first; if it can't answer a trivial probe,
    // fail the whole run over to Gemini instead of dying. Best-effort: any
    // probe-internal fault leaves the original selection untouched so a healthy
    // run is never broken by the probe itself.
    // Skip the preflight when MiniMax answered within the last 60s on this warm
    // isolate — it's demonstrably alive, so the extra round-trip (and up to the
    // 6s timeout on the unhealthy path) is removed from time-to-first-token.
    // A cold isolate has no cached health → the probe still runs (safe default).
    if (minimaxIsPrimary && !useFallback && !lovablePinned && fallbackTarget && !minimaxHealthyWithin(60_000)) {
      // Two-attempt preflight (mirror's preview-verified probe): MiniMax can go
      // quiet for 6–10s under load on a busy turn (large prompt + reasoning
      // warm-up), so give it up to 12s per attempt with one retry (250ms
      // backoff). Combined with #229's policy: a TIMEOUT — even after both
      // attempts — never forces the fallback (cold-isolate timeouts are
      // ambiguous and were flapping healthy turns off MiniMax); only an
      // explicit HTTP failure from MiniMax itself pivots the run.
      const PREFLIGHT_TIMEOUT_MS = 12_000;
      const PREFLIGHT_ATTEMPTS = 2;
      const probeOnce = async (): Promise<{ ok: boolean; status: number }> => {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), PREFLIGHT_TIMEOUT_MS);
          try {
            const res = await minimaxChat({
              user: "ping", maxTokens: 4, temperature: 0, signal: ctrl.signal,
            });
            return { ok: res.ok, status: res.status };
          } finally {
            clearTimeout(timer);
          }
        } catch {
          // Timeout/abort/network — encoded as status 0, the ambiguous class
          // that shouldFallbackAfterMinimaxPreflight refuses to pivot on.
          return { ok: false, status: 0 };
        }
      };
      let lastProbe: { ok: boolean; status: number } = { ok: false, status: 0 };
      for (let attempt = 1; attempt <= PREFLIGHT_ATTEMPTS; attempt++) {
        lastProbe = await probeOnce();
        if (lastProbe.ok) break;
        if (attempt < PREFLIGHT_ATTEMPTS) {
          console.warn(
            `[orchestrator] minimax preflight attempt ${attempt}/${PREFLIGHT_ATTEMPTS} failed (status=${minimaxPreflightFailureLabel(lastProbe)}) — retrying`,
          );
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      if (shouldFallbackAfterMinimaxPreflight(lastProbe)) {
        useFallback = true;
        console.warn(
          `[orchestrator] minimax preflight unhealthy after ${PREFLIGHT_ATTEMPTS} attempts (status=${minimaxPreflightFailureLabel(lastProbe)}) → Gemini fallback for thread ${threadId}`,
        );
      } else if (!lastProbe.ok) {
        console.info(
          `[orchestrator] minimax preflight ${minimaxPreflightFailureLabel(lastProbe)} after ${PREFLIGHT_ATTEMPTS} attempts — keeping MiniMax primary for thread ${threadId}`,
        );
      }
    }
    if (useFallback && !fallbackTarget) {
      throw new Error(
        "MiniMax is unavailable and no fallback is configured — set GEMINI_API_KEY " +
          "(direct Gemini fallback) or opt in to the Lovable gateway with ALLOW_LOVABLE_FALLBACK=true.",
      );
    }
    // Resolve the primary (non-fallback) model from the selected provider.
    const { model: primaryModel, label: primaryLabel } =
      orchChoice.provider === "grok"
        ? { model: grokGateway!.chatModel(GROK_ORCHESTRATOR_MODEL_ID), label: `${GROK_ORCHESTRATOR_MODEL_ID} (xAI Grok)` }
        : orchChoice.provider === "openadapter"
        ? { model: openAdapterGateway!.chatModel(OPENADAPTER_ORCHESTRATOR_MODEL_ID), label: `${OPENADAPTER_ORCHESTRATOR_MODEL_ID} (OpenAdapter)` }
        : { model: minimax.chatModel(PRIMARY_ORCHESTRATOR_MODEL_ID), label: `${PRIMARY_ORCHESTRATOR_MODEL_ID} (MiniMax direct)` };
    const orchestratorModel = useFallback
      ? fallbackTarget!.gateway.chatModel(fallbackTarget!.modelId)
      : primaryModel;
    console.log(
      `[orchestrator] running on ${useFallback ? `${fallbackTarget!.modelId} (${fallbackTarget!.label})` : primaryLabel} ` +
        `(provider=${orchChoice.provider}/${orchChoice.reason}, approx prompt chars=${approxPromptChars}, messages=${trimmedMessages.length})`,
    );

    // Per-step trimmer: re-applies aggressive tool-result truncation to the
    // growing in-stream history so we don't drift back over the budget after
    // a dozen fan-out rounds. Keeps only the last RECENT_WINDOW messages at
    // full size; everything older is heavily compacted.
    const STEP_RECENT_WINDOW = 8;
    const STEP_RECENT_CHARS = 12000;
    // #238: older-result cap tightened 3000→1500 (selector-preserving summary keeps
    // the pivot fuel; only the raw envelope shrinks). Recent stays 12000 raw.
    const STEP_OLDER_CHARS = 1500;
    // Resolve the attachment intake started above (it overlapped the preflight
    // + setup). Its summary must be present before the system prompt is built.
    const intake = await intakePromise;
    const visionIntakeSummary = intake.ran ? intake.summary : "";
    if (intake.ran) {
      console.log(
        `[attachment-intake] read ${intake.attachments_read} file(s), recorded ${intake.artifacts_inserted} lead-tier artifact(s) before reasoning`,
      );
    }
    // Resolve the anchor read started above (it overlapped the preflight + setup).
    // Only the TRUSTED summary (directive + structured facts) goes into the system
    // prompt. The UNTRUSTED fetched prose (bio / SERP answer) is injected as an
    // isolated data MESSAGE below — never the system prompt — so profile/SERP text
    // can't reach the model at instruction priority (prompt-injection isolation).
    const anchor = await anchorPromise;
    const anchorIntakeSummary = anchor.ran ? anchor.summary : "";
    if (anchor.ran && anchor.untrusted) {
      // Merge the untrusted fetched content INTO the current user turn (rather than
      // pushing a second consecutive user message, which strict providers like the
      // Gemini fallback reject). Kept out of the system prompt so it can't reach the
      // model at instruction priority. Falls back to a new message only if the tail
      // isn't a user turn.
      const last = trimmedMessages[trimmedMessages.length - 1] as ModelMessage | undefined;
      if (last && last.role === "user") {
        if (typeof last.content === "string") {
          last.content = `${last.content}\n\n${anchor.untrusted}`;
        } else if (Array.isArray(last.content)) {
          last.content = [...last.content, { type: "text", text: `\n\n${anchor.untrusted}` }] as typeof last.content;
        }
      } else {
        trimmedMessages.push({ role: "user", content: anchor.untrusted } as ModelMessage);
      }
    }
    if (anchor.ran) {
      console.log(
        `[anchor-intake] profile_read=${anchor.profile_read} serp_read=${anchor.serp_read}, recorded ${anchor.artifacts_inserted} anchor artifact(s) before reasoning`,
      );
    }
    // Base orchestrator system prompt, shared by streamText and by the forced
    // finalize step (which appends buildFinalizeDirective() to this exact base).
    const baseSystemPrompt =
      SYSTEM_PROMPT_FULL + FINDING_LABELS + buildWorkflowAddendum(detectedSeedType) + visionIntakeSummary + anchorIntakeSummary;
    // Count of forced finalize steps taken (P0 fix A). A StopCondition ends the run
    // once it reaches FINALIZE_MAX_STEPS so the closing synthesis can't loop for the
    // whole reserve window. Incremented in prepareStep when a finalize step is forced.
    let finalizeStepsRun = 0;
    // Per-run genuine-tool-call budget (MAX_TOOL_CALLS_PER_RUN). Passed into
    // wrapToolsWithCache, which increments `genuine` on each live execution and flips
    // `capped` once the cap is hit; prepareStep reads it to force finalize. Owned by
    // this per-request closure so concurrent runs on a warm isolate never share it.
    const toolCallBudget = { genuine: 0, capped: false };
    // Wall-clock start for BOTH the finalize-reserve check (prepareStep) and the hard
    // deadline StopCondition below. Declared here so prepareStep's closure reads it.
    const runStartedAt = Date.now();
    const prepareStep: NonNullable<Parameters<typeof streamText>[0]["prepareStep"]> =
      async ({ messages: stepMessages, stepNumber }) => {
        const { data: threadState } = await supabase
          .from("threads")
          .select("status")
          .eq("id", threadId)
          .maybeSingle();
        if ((threadState as { status?: string } | null)?.status === "stopped") {
          throw new DOMException("Investigation stopped by analyst", "AbortError");
        }
        if (creditExhaustReason) {
          throw new DOMException(`Run stopped: credit ${creditExhaustReason}`, "AbortError");
        }
        // Clear per-step dedup set at the *start* of every step. Doing this
        // only inside bumpArtifacts() means steps that find zero artifacts
        // never clear the set, silently blocking memory_recall for any
        // previously-queried subject for the rest of the investigation.
        routingGuard.memoryRecallSubjectsThisStep.clear();
        if (!Array.isArray(stepMessages) || stepMessages.length === 0) return {};
        const trimmed: ModelMessage[] = stepMessages.map((m: ModelMessage, idx: number) => {
          const isRecent = idx >= stepMessages.length - STEP_RECENT_WINDOW;
          const max = isRecent ? STEP_RECENT_CHARS : STEP_OLDER_CHARS;
          if (m.role !== "tool" && m.role !== "assistant") return m;
          if (!Array.isArray(m.content)) return m;
          // Older results → selector-preserving summarization (issue #238);
          // recent stay raw for next-step pivot detail.
          const content = (m.content as TrimPart[]).map((part: TrimPart) => {
            if (part?.type === "tool-result" && part.output != null) {
              if (part.output && typeof part.output === "object" && "value" in part.output) {
                const value = isRecent
                  ? truncateValue((part.output as { value: unknown }).value, max)
                  : summarizeToolResultValue((part.output as { value: unknown }).value, max, part.toolName);
                return { ...part, output: { ...part.output, value } };
              }
              return { ...part, output: isRecent ? truncateValue(part.output, max) : summarizeToolResultValue(part.output, max, part.toolName) };
            }
            if (part?.type === "text" && typeof part.text === "string") {
              return { ...part, text: truncateStr(part.text, isRecent ? STEP_RECENT_CHARS : STEP_OLDER_CHARS) };
            }
            return part;
          });
          return { ...m, content } as ModelMessage;
        });
        // Same hardening as the initial prompt: cap oversized tool results and
        // guarantee a schema-valid, tool-paired array on every in-stream step so
        // a mid-run trim can't sever a tool-call/result pair and wedge the run.
        const budgeted = capTotalToBudget(trimmed, TOTAL_PROMPT_CHAR_BUDGET, STEP_RECENT_WINDOW);
        const stepMessagesOut = sanitizeModelMessages(
          capToolResultOutputs(budgeted, MAX_TOOL_RESULT_CHARS),
        );
        // Force the closing synthesis step when ANY run budget is exhausted:
        //  • P0 fix A — the wall-clock reserve window opened, or we hit the last step.
        //  • Run tool-call cap — MAX_TOOL_CALLS_PER_RUN genuine live calls reached
        //    (the wrapper is already skipping new lookups; make the model finalize
        //    instead of burning steps on skipped calls).
        // Either way: restrict tools to record_artifacts and append the finalize
        // directive so the model writes its Findings report NOW instead of the
        // deadline tripping mid-tool-call and leaving "No report yet". A StopCondition
        // (finalizeStepsRun >= FINALIZE_MAX_STEPS) ends the run after.
        const capReached = toolCallCapReached(toolCallBudget.genuine);
        if (capReached && !toolCallBudget.capped) {
          toolCallBudget.capped = true;
          console.log(JSON.stringify({
            event: "run_capped", thread_id: threadId,
            genuine_tool_calls: toolCallBudget.genuine, cap: MAX_TOOL_CALLS_PER_RUN,
          }));
        }
        if (capReached || shouldForceFinalize(Date.now() - runStartedAt, stepNumber ?? 0)) {
          finalizeStepsRun++;
          return {
            messages: stepMessagesOut,
            activeTools: [...FINALIZE_ACTIVE_TOOLS],
            system: baseSystemPrompt + buildFinalizeDirective(),
          };
        }
        // Intermediate (non-finalize) step: append the compact per-cycle directive so
        // the model reports only THIS cycle's new findings as one-line-each instead of
        // re-narrating the whole dossier every turn (the context-bloat root cause). The
        // full dossier is owned solely by the finalize branch above. baseSystemPrompt is
        // byte-identical to the top-level streamText `system`, so this only APPENDS the
        // directive for this step.
        return {
          messages: stepMessagesOut,
          system: baseSystemPrompt + buildPerCycleCompactDirective(),
        };
      };

    // Ends the run cleanly once the wall-clock deadline passes (see constant). The
    // StopCondition receives { steps }; we only need elapsed time, so it's ignored.
    const orchestratorDeadlineReached = () =>
      deadlineReached(Date.now(), runStartedAt, ORCHESTRATOR_WALL_CLOCK_MS);

    const result = streamText({
      // Top-level orchestrator runs on the smart tier — it's the multi-source
      // synthesis step that produces the final report. Per-tool sub-calls use
      // their own tier (see ./models.ts) via wrapToolsWithCache.
      model: orchestratorModel,
      // Bound each step's generation so a long step can't truncate trailing
      // parallel tool calls and orphan their results (the MissingToolResults crash).
      maxOutputTokens: ORCHESTRATOR_MAX_OUTPUT_TOKENS,
      // Serial tool calls on the MiniMax orchestrator (see ORCHESTRATOR_PARALLEL_TOOL_CALLS).
      // Attached ONLY when MiniMax is the live provider — the Gemini fallback / Grok /
      // OpenAdapter paths ignore a foreign provider-option key and shape tool calls
      // themselves, so scoping by the "minimax" key keeps their behavior unchanged.
      providerOptions: (minimaxIsPrimary && !useFallback)
        ? { minimax: { parallel_tool_calls: ORCHESTRATOR_PARALLEL_TOOL_CALLS } }
        : undefined,
      system: SYSTEM_PROMPT_FULL + FINDING_LABELS + buildWorkflowAddendum(detectedSeedType) + visionIntakeSummary + anchorIntakeSummary,
      messages: trimmedMessages,
      tools: wrapToolsWithCache(tools, {
        investigationId: threadId,
        userId,
        supabase,
        supabaseAdmin,
        onCost,
        manualOverrideSelector,
        toolCallBudget,
      }),
      // Unknown-tool guard (Phase B4): the model occasionally emits a tool call
      // for a name that is NOT in the live registry (hallucinations like exify /
      // hackerone_lookup). Validate the emitted name against the wrapped tool set
      // BEFORE execution; an unknown name is redirected to the internal sink
      // (unknown_tool_ignored) so it drops silently — never executes the invented
      // tool, never surfaces the invented name — and the model gets a terse nudge.
      // A KNOWN tool with bad input returns null here (SDK handles it normally).
      experimental_repairToolCall: async ({ toolCall, tools: liveTools }) => {
        const decision = repairUnknownTool(toolCall.toolName, Object.keys(liveTools ?? {}));
        if (!decision.redirect) return null;
        console.warn(`[unknown-tool-guard] dropped hallucinated tool "${toolCall.toolName}"`);
        return { ...toolCall, toolName: decision.toolName, input: JSON.stringify({ requested: decision.requested }) };
      },
      // Named step cap + wall-clock deadline (Phase 2, Play 1). Either stops the
      // agent loop cleanly; onFinish then persists partials and marks finished.
      // Third condition (P0 fix A): once the forced finalize phase has run its
      // budgeted step(s), stop — the model has written its report, so don't spin
      // the remaining reserve window re-synthesizing (and re-recording) artifacts.
      stopWhen: [
        stepCountIs(MAX_ORCHESTRATOR_STEPS),
        orchestratorDeadlineReached,
        () => finalizeStepsRun >= FINALIZE_MAX_STEPS,
      ],
      prepareStep,
      // Meter orchestrator LLM token spend per step so threads.cost_micro_usd
      // reflects the actual model cost, not just tool fan-out cost.
      // Rates (micro-USD per token):
      //   MiniMax-M2.7:      in $0.30/M  out $1.20/M  → 0.30, 1.20
      //   Gemini 2.5 Flash:  in $0.30/M  out $2.50/M  → 0.30, 2.50
      // Fallback rate tracks the DEFAULT fallback model (gemini-2.5-flash, B5);
      // the old Gemini 2.5 Pro rate ($1.25/$10) over-debited the ledger ~4x on the
      // fallback path. An operator LOVABLE_FALLBACK_MODEL_ID override is best-effort
      // metered at the Flash rate.
      onStepFinish: ({ usage }) => {
        // A completed step on the primary provider proves MiniMax is alive —
        // record it so the NEXT turn's preflight probe can be skipped.
        if (!useFallback) markMinimaxHealthy();
        try {
          const u = usage as { inputTokens?: number; promptTokens?: number; outputTokens?: number; completionTokens?: number } | undefined;
          const inTok = Number(u?.inputTokens ?? u?.promptTokens ?? 0);
          const outTok = Number(u?.outputTokens ?? u?.completionTokens ?? 0);
          if (!inTok && !outTok) return;
          const [inRate, outRate] = useFallback ? [0.3, 2.5] : [0.3, 1.2];
          const micro = Math.round(inTok * inRate + outTok * outRate);
          if (micro > 0) onCost(micro);
        } catch (e) {
          console.warn("[orchestrator] usage meter failed:", e);
        }
      },
      // Intentionally NOT bound to req.signal: when the analyst navigates away
      // from the chat, the browser cancels the fetch — but we want the
      // investigation to keep running server-side, persist its artifacts as
      // they come in, and save the final assistant message via onFinish.
      onError: async ({ error }) => {
        const msg = error instanceof Error ? error.message : String(error);
        const errName = error instanceof Error ? error.name : "";
        const isCtxOverflow =
          /context window|context length|2013|invalid params.*context|exceeds limit/i.test(msg);
        // Distinguish the CLIENT-SIDE message-builder schema failures from a
        // genuine provider/length problem. These should now be impossible
        // (serial tool calls + return-on-throw + sanitizeModelMessages before every
        // model call) — if one is ever logged, the builder produced a shape the
        // sanitizer doesn't cover, and this flag makes it queryable instead of
        // silently looking like overflow. Matches the SINGULAR and PLURAL stock
        // MissingToolResults messages (see stream-error-classify.ts).
        const isSchemaError = isMessageSchemaError(msg, errName);
        console.warn(
          "[orchestrator] stream error:",
          JSON.stringify({
            thread_id: threadId,
            provider: useFallback ? fallbackTarget!.provider : "minimax",
            model: useFallback ? fallbackTarget!.modelId : MODELS[ORCHESTRATOR_TIER],
            approx_prompt_chars: approxPromptChars,
            context_overflow: isCtxOverflow,
            // A schema/pairing fault is a builder bug, NOT context overflow —
            // never let the (now correctly-false) overflow flag mask it.
            message_schema_invalid: isSchemaError,
            error_name: errName,
            message: msg.slice(0, 600),
          }),
        );
        // A terminal stream error means onFinish never fires, so without this the
        // thread row stays "active" forever (UI stuck on "running"). Write the
        // ALLOWED terminal value "finished" — threads_status_check rejects
        // "failed_context_limit" (0 such rows in prod, it silently failed and
        // left runs stuck "active"), and the UI derives an empty/failed state
        // from artifacts=0 anyway. The context-overflow distinction is preserved
        // in the structured log above (context_overflow flag). Guard on
        // status="active" so a sibling run that already finished/stopped isn't
        // clobbered. Artifacts are committed incrementally inside each tool, so
        // none are lost on a tail-end throw.
        try {
          const { error: updErr } = await supabase
            .from("threads")
            .update({ status: "finished", updated_at: new Date().toISOString() })
            .eq("id", threadId)
            .eq("status", "active");
          if (updErr) console.warn("[thread status] error-path update failed:", updErr.message);
        } catch (e) {
          console.warn("[thread status] error-path update threw:", e);
        }
      },
    });

    let finalPersisted = false;
    const persistFinalMessages = async ({ messages: finalMessages }: { messages: UIMessage[] }) => {
      if (finalPersisted) return;
      finalPersisted = true;
      // Capture the detected seed kind so it can be persisted onto the thread
      // row at completion — historically seed_type was only stored in the
      // triage decision JSON and the threads.seed_type column stayed null.
      let detectedSeedKind: string | null = null;
        let assistant = [...finalMessages].reverse().find((m) => m.role === "assistant");
        // P0 fix B — salvage backstop. If the run did work but produced no usable
        // report (the "No report yet" gap — e.g. the loop stopped on a tool step
        // before the model synthesized), run ONE bounded, TOOL-FREE generation that
        // restates the gathered artifacts as a Findings report, and persist that as
        // the assistant message. Best-effort: any failure leaves the prior behavior
        // untouched. Fix A makes this rare; B guarantees a report even if A's forced
        // step still emitted no text.
        try {
          const { toolCalls: workToolCalls } = countRecordArtifactCalls(finalMessages);
          const existingReport = extractAssistantReportText(finalMessages as unknown as Array<{ role?: string; parts?: Array<{ type?: string; text?: unknown }> }>);
          if (needsReportSalvage(existingReport, workToolCalls)) {
            const { data: salvageArts } = await supabase
              .from("artifacts")
              .select("kind,value,confidence,source")
              .eq("thread_id", threadId)
              .order("confidence", { ascending: false })
              .limit(200);
            const salvage = await generateText({
              model: orchestratorModel,
              maxOutputTokens: ORCHESTRATOR_MAX_OUTPUT_TOKENS,
              system: baseSystemPrompt,
              prompt: buildSalvageSynthesisPrompt(seedValueRaw, (salvageArts ?? []) as Array<Record<string, unknown>>),
            });
            const salvageText = (salvage?.text ?? "").trim();
            if (salvageText) {
              const salvagePart = { type: "text", text: salvageText } as unknown;
              if (assistant) {
                assistant.parts = [...(assistant.parts ?? []), salvagePart] as typeof assistant.parts;
              } else {
                assistant = { role: "assistant", parts: [salvagePart] } as unknown as UIMessage;
                finalMessages.push(assistant);
              }
              console.log(JSON.stringify({
                event: "report_salvaged", thread_id: threadId,
                tool_calls: workToolCalls, salvage_chars: salvageText.length, artifacts: (salvageArts ?? []).length,
              }));
            }
          }
        } catch (e) {
          console.warn("[report-salvage] backstop failed (non-fatal):", String(e));
        }
        if (assistant) {
          // Cap `messages.parts` payload before persisting. First shrink any
          // single oversized tool payload (e.g. a 600KB socialfetch_lookup
          // dump) so one blob can't bloat the row or, replayed by the client
          // every turn, blow the 2MB request-body limit — small outputs pass
          // through untouched. Then apply the whole-message 3.5MB backstop to
          // avoid silent PostgREST 500s on multi-MB inserts.
          const cappedParts = capToolPartPayloads(assistant.parts as unknown[]);
          const safeParts = capPartsSize(cappedParts, 3_500_000);
          const { error: msgErr } = await supabase.from("messages").insert({
            thread_id: threadId,
            user_id: userId,
            role: "assistant",
            parts: safeParts as unknown,
          });
          if (msgErr) {
            console.error(JSON.stringify({ event: "assistant_message_insert_fail", thread_id: threadId, error: msgErr.message }));
          }
          // Atomic cost increment — only the remaining delta past the last
          // mid-run checkpoint. No read-modify-write fallback: a racy fallback
          // is worse than a missed write, since two parallel runs can silently
          // overwrite each other's totals.
          {
            const finalDelta = runCostMicroUsd - lastCheckpointMicroUsd;
            if (finalDelta > 0) {
              const { error: rpcErr } = await supabaseAdmin.rpc("increment_thread_cost", {
                _id: threadId, _delta_cost: finalDelta,
              });
              if (rpcErr) {
                console.error(JSON.stringify({
                  event: "cost_final_write_failed",
                  thread_id: threadId,
                  delta_micro_usd: finalDelta,
                  error: rpcErr.message,
                }));
              } else {
                lastCheckpointMicroUsd = runCostMicroUsd;
              }
            }
          }

          // ---- Persist investigation cache (per seed, per user) ----
          try {
            const firstUser = finalMessages.find((m) => m.role === "user");
            const seedText = ((firstUser?.parts ?? []) as Array<{ type: string; text?: string }>)
              .filter((p) => p.type === "text").map((p) => p.text ?? "").join(" ").trim();
            const detected = detectSeedServer(seedText);
            if (detected) {
              detectedSeedKind = detected.kind;
              const { data: arts } = await supabase
                .from("artifacts")
                .select("kind,value,confidence,source,metadata")
                .eq("thread_id", threadId)
                .order("created_at", { ascending: true });
              // Cache is long-lived (7d) and is replayed back into a future
              // run's context, so strip credentials / PII / oversized blobs.
              const cachedParts = sanitizeToolOutput(safeParts, 1500);
              const cachedArts = sanitizeToolOutput(arts ?? [], 1500);
              const payload = {
                seed: detected,
                assistant_parts: cachedParts,
                artifacts: cachedArts,
                finished_at: new Date().toISOString(),
              };
              // investigation_cache RLS intentionally denies client (anon/authenticated)
              // writes ("Deny client cache writes"); writes must go through the
              // service-role admin client (bypasses RLS). Using the user-scoped
              // `supabase` here is what left the cache permanently empty (0 rows,
              // ~0% hit). The artifacts read above is fine on the user client.
              await supabaseAdmin.from("investigation_cache").upsert(
                {
                  user_id: userId,
                  seed_kind: detected.kind,
                  seed_value_normalized: detected.normalized,
                  result_json: payload as unknown as Record<string, unknown>,
                  created_at: new Date().toISOString(),
                  expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
                },
                { onConflict: "user_id,seed_kind,seed_value_normalized" },
              );
            }
          } catch (e) {
            console.error(JSON.stringify({ event: "investigation_cache_fail", thread_id: threadId, error: String(e) }));
          }
        }
        // Safety-net telemetry: a run that finishes with ZERO artifact rows
        // either genuinely found nothing OR ran lookups and never called
        // record_artifacts (the domain-seed record gap). Emit a loud, queryable
        // event so we can tell the two apart without re-reading transcripts.
        // Additive only — never blocks completion; failure is swallowed.
        try {
          const { toolCalls, recordCalls } = countRecordArtifactCalls(finalMessages);
          const { count: artifactRows } = await supabase
            .from("artifacts")
            .select("id", { count: "exact", head: true })
            .eq("thread_id", threadId);
          if ((artifactRows ?? 0) === 0) {
            console.error(JSON.stringify({
              event: "zero_artifacts_at_completion",
              thread_id: threadId,
              record_artifact_calls: recordCalls,
              tool_calls: toolCalls,
              in_memory_artifacts: routingGuard.artifactsTotal,
              seed: seedValueRaw.slice(0, 120),
              // ran lookups but never recorded → almost certainly the record gap,
              // not a genuinely empty case.
              findings_likely: toolCalls > 3 && recordCalls === 0,
            }));
          }
        } catch (e) {
          console.warn("[safety-net] zero-artifact check failed:", e);
        }
        // Durable end-of-run signal that this run finalized because it hit the
        // per-run tool-call cap (vs. a natural finish). Visible in edge logs; the
        // capped lookups also carry run_capped:true in tool_usage_log (rejection_reason).
        if (toolCallBudget.capped) {
          console.log(JSON.stringify({
            event: "run_capped_finalize", thread_id: threadId,
            genuine_tool_calls: toolCallBudget.genuine, cap: MAX_TOOL_CALLS_PER_RUN,
          }));
        }
        const { error: statusErr } = await supabase
          .from("threads")
          .update({
            // "finished" is the allowed terminal status (threads_status_check =
            // active|finished) AND the value the UI treats as complete
            // (WorkspaceHeader/ThreadSidebar). The prior "completed" was rejected
            // by the DB constraint, leaving successful runs stuck on "active".
            status: "finished",
            updated_at: new Date().toISOString(),
            ...(detectedSeedKind ? { seed_type: detectedSeedKind } : {}),
          })
          .eq("id", threadId)
          .eq("status", "active");
        if (statusErr) {
          console.warn("[thread status] completion update failed:", statusErr.message);
        }
        // C-1: DETERMINISTIC clustering + confidence promotion — the last step of the
        // run, executed REGARDLESS of whether the LLM correlate tool succeeded, failed,
        // or was never called (the ccc149bc run recorded 73 artifacts with cluster_id:null
        // precisely because correlate never fired). Local union-find over shared strong
        // selectors; the LLM only ever adds candidate edges, never a merge. Best-effort:
        // a clustering error must never fail an otherwise-complete investigation.
        try {
          const clustered = await applyClusteringToThread(supabaseAdmin, threadId, userId);
          console.log(JSON.stringify({ event: "cluster_applied", thread_id: threadId, ...clustered }));
        } catch (e) {
          console.warn("[cluster] applyClusteringToThread failed (non-fatal):", String(e));
        }
        // Investigation is done generating — release this run's hold on the
        // in-memory circuit-breaker state so it doesn't linger on the warm
        // isolate. This is the genuine end-of-run hook: the request handler
        // returns its streaming Response while generation continues in the
        // background (EdgeRuntime.waitUntil below), so a request-level `finally`
        // would clear breakers mid-investigation. release() (vs. an outright
        // clearThread) only deletes the state once the LAST overlapping run for
        // this thread finishes, so a double-submit / retry can't wipe a sibling
        // run's suppressions mid-flight. The LRU cap in circuit.ts is the
        // backstop for the paths where this never runs (isolate death,
        // unhandled rejection).
        circuit.release(threadId);
    };

    // Create a server-owned UI stream branch. Unlike consumeStream(), this
    // runs the UI-message onFinish callback even if the browser refreshes and
    // cancels its response branch. The guard above prevents a connected client
    // and the background branch from saving the same assistant message twice.
    const persistenceStream = result.toUIMessageStream({
      originalMessages: messages,
      onFinish: persistFinalMessages,
    });
    const consumePersistenceStream = async () => {
      for await (const _chunk of persistenceStream) {
        // Drain the stream so generation, tool calls, and persistence complete.
      }
    };
    try {
      const task = consumePersistenceStream();
      const ert = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
      if (ert && typeof ert.waitUntil === "function") ert.waitUntil(task);
      else void task;
    } catch {
      // Best-effort background completion; stream-level errors are logged above.
    }

    return result.toUIMessageStreamResponse({
      headers: corsHeaders,
      originalMessages: messages,
      // Surface the REAL (redacted) provider reason to the client instead of the
      // SDK's default generic mask ("An error occurred" / "Provider returned
      // error"). The failed-run card then shows an actionable message, and a
      // context-overflow vs. rate-limit vs. unreachable failure is
      // distinguishable. Strip anything that looks like a credential first.
      onError: (error) => {
        const m = error instanceof Error ? error.message : String(error);
        const name = error instanceof Error ? error.name : "";
        // Phase 1 graceful escape: a MissingToolResults / InvalidPrompt schema fault
        // is an internal message-builder hiccup, NOT a provider failure. With serial
        // tool calls + return-on-throw + the sanitizer this should be unreachable,
        // but if one still escapes we end the run cleanly: artifacts are persisted
        // incrementally and the stream onError above already marked the thread
        // "finished", so surface a soft, non-alarming note instead of a red
        // provider-error card. Genuine provider/context errors fall through below
        // and keep their real (redacted) message — we do NOT mask those.
        if (isMessageSchemaError(m, name)) {
          return "Investigation ended early — partial results were saved.";
        }
        const friendly = classifyStreamProviderError(m, name);
        if (friendly) return friendly;
        const redacted = m
          .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
          .replace(/sk-[A-Za-z0-9._-]+/g, "sk-[REDACTED]")
          .replace(/xai-[A-Za-z0-9._-]+/g, "xai-[REDACTED]")
          .replace(/AIza[A-Za-z0-9_-]+/g, "AIza[REDACTED]");
        return redacted.slice(0, 300) || "Provider stream error";
      },
      onFinish: persistFinalMessages,
    });
  } catch (e) {
    // setupRequest throws Response objects for 401/403/400 — return them directly
    if (e instanceof Response) return e;
    console.error("osint-agent error", e);
    const message = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: "Internal Server Error", code: "ORCHESTRATOR_FAULT", detail: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

});
