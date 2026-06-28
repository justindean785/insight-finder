/**
 * index.ts — OSINT agent entry point (refactored).
 * Health probe → health-handler.ts, tool registry → tool-registry.ts.
 */

import { convertToModelMessages, streamText, stepCountIs, type UIMessage, type ModelMessage } from "npm:ai@6";

import { MODELS, ORCHESTRATOR_TIER } from "./models.ts";
import { buildWorkflowAddendum } from "./workflow_prompt.ts";
import * as circuit from "./circuit.ts";
import { discoverCapabilities, capabilityEnvKeys } from "./capabilities.ts";

import {
  corsHeaders, MINIMAX_API_KEY, LOVABLE_API_KEY,
  lovableGateway, PRIMARY_ORCHESTRATOR_MODEL_ID, FALLBACK_MODEL_ID,
  grokGateway, openAdapterGateway, ORCHESTRATOR_PROVIDER,
  GROK_ORCHESTRATOR_MODEL_ID, OPENADAPTER_ORCHESTRATOR_MODEL_ID,
  degradedTools, deadHosts, resetFirecrawlCreditsLow,
} from "./env.ts";

import { detectSeedServer } from "./validation.ts";
import { sanitizeToolOutput, capPartsSize } from "./safety.ts";
import { guard, routingGuard, triageState } from "./guard.ts";
import { setupRequest } from "./auth.ts";
import { minimax, minimaxChat, markMinimaxHealthy, minimaxHealthyWithin } from "./providers.ts";
import { selectOrchestratorProvider } from "./orchestrator_select.ts";
import { FINDING_LABELS } from "./catalog.ts";
import { SYSTEM_PROMPT_FULL } from "./system-prompt.ts";
import { wrapToolsWithCache } from "./cache.ts";
import { beginCycle, clearRuntime } from "./runtime-policy.ts";

import { isHealthProbe, handleHealthProbe } from "./health-handler.ts";
import { buildTools } from "./tool-registry.ts";

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

    const { tools, availableToolsForAudit } = buildTools({
      supabase, supabaseAdmin, userId, threadId, archiveEnabled, detectedSeedType, messages, manualOverrideSelector,
    });

    const modelMessages = await convertToModelMessages(messages);

    const MAX_TOOL_RESULT_CHARS_OLD = 4000;
    const MAX_TOOL_RESULT_CHARS_RECENT = 16000;
    const RECENT_WINDOW = 10;
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
    const trimmedMessages: ModelMessage[] = modelMessages.map((m: ModelMessage, idx: number) => {
      const isRecent = idx >= modelMessages.length - RECENT_WINDOW;
      const max = isRecent ? MAX_TOOL_RESULT_CHARS_RECENT : MAX_TOOL_RESULT_CHARS_OLD;
      if (m.role !== "tool" && m.role !== "assistant") return m;
      if (!Array.isArray(m.content)) return m;
      const content = (m.content as TrimPart[]).map((part: TrimPart) => {
        if (part?.type === "tool-result" && part.output != null) {
          if (part.output && typeof part.output === "object" && "value" in part.output) {
            return { ...part, output: { ...part.output, value: truncateValue((part.output as { value: unknown }).value, max) } };
          }
          return { ...part, output: truncateValue(part.output, max) };
        }
        if (part?.type === "text" && typeof part.text === "string") {
          return { ...part, text: truncateStr(part.text, isRecent ? 16000 : 4000) };
        }
        return part;
      });
      return { ...m, content } as ModelMessage;
    });

    // Cumulative cost tracker for this run.
    let runCostMicroUsd = 0;
    let costCheckpointCounter = 0;
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
    // Capability discovery: gate providers that can't run (missing key / gated /
    // disabled / unsupported seed) BEFORE the execution loop, so they never
    // become attempted live calls or consume credits. Pure evaluation over key
    // PRESENCE booleans (no secret values); unavailable tools are disabled via
    // the breaker, which cache.ts skips without billing.
    {
      const envPresence: Record<string, boolean> = {};
      for (const k of capabilityEnvKeys()) envPresence[k] = !!Deno.env.get(k);
      for (const cap of discoverCapabilities(envPresence, null)) {
        if (!cap.available) {
          circuit.disableTool(threadId, cap.tool, `unavailable: ${cap.reason}${cap.detail ? ` (${cap.detail})` : ""}`);
        }
      }
    }
    // Tracks the cost amount already written to the DB via mid-run
    // checkpoints so the final write only adds the remaining delta.
    let lastCheckpointMicroUsd = 0;
    const onCost = (m: number) => {
      runCostMicroUsd += m;
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
    // The MiniMax-specific overflow pre-pivot + health probe only apply when
    // MiniMax is the primary. Alternative providers carry their own large
    // context windows and reliability, so they bypass the Gemini fallback path.
    const wouldOverflow =
      minimaxIsPrimary &&
      (approxPromptChars > MINIMAX_CHAR_BUDGET ||
        trimmedMessages.length > MINIMAX_MSG_BUDGET);
    let useFallback = minimaxIsPrimary ? (!minimaxAvailable || wouldOverflow) : false;
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
    if (minimaxIsPrimary && !useFallback && lovableGateway && !minimaxHealthyWithin(60_000)) {
      try {
        const probePromise = minimaxChat({ user: "ping", maxTokens: 4, temperature: 0 });
        // Swallow a late rejection if the timeout wins the race below, so it
        // never surfaces as an unhandled rejection after we've moved on.
        probePromise.catch(() => {});
        const probe = (await Promise.race([
          probePromise,
          new Promise<{ ok: boolean; status: number }>((resolve) =>
            setTimeout(() => resolve({ ok: false, status: 0 }), 6000)),
        ])) as { ok: boolean; status: number };
        if (!probe.ok) {
          useFallback = true;
          console.warn(
            `[orchestrator] minimax preflight unhealthy (status=${probe.status || "timeout"}) → Gemini fallback for thread ${threadId}`,
          );
        }
      } catch (e) {
        // Network error / abort during the probe → MiniMax is unreachable.
        useFallback = true;
        console.warn(
          `[orchestrator] minimax preflight threw → Gemini fallback:`,
          e instanceof Error ? e.message : String(e),
        );
      }
    }
    if (useFallback && !lovableGateway) {
      throw new Error(
        "Neither MINIMAX_API_KEY nor LOVABLE_API_KEY is configured for the orchestrator.",
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
      ? lovableGateway!.chatModel(FALLBACK_MODEL_ID)
      : primaryModel;
    console.log(
      `[orchestrator] running on ${useFallback ? FALLBACK_MODEL_ID + " (Lovable Gateway fallback)" : primaryLabel} ` +
        `(provider=${orchChoice.provider}/${orchChoice.reason}, approx prompt chars=${approxPromptChars}, messages=${trimmedMessages.length})`,
    );

    // Per-step trimmer: re-applies aggressive tool-result truncation to the
    // growing in-stream history so we don't drift back over the budget after
    // a dozen fan-out rounds. Keeps only the last RECENT_WINDOW messages at
    // full size; everything older is heavily compacted.
    const STEP_RECENT_WINDOW = 8;
    const STEP_RECENT_CHARS = 12000;
    const STEP_OLDER_CHARS = 3000;
    const prepareStep: NonNullable<Parameters<typeof streamText>[0]["prepareStep"]> =
      async ({ messages: stepMessages }) => {
        const { data: threadState } = await supabase
          .from("threads")
          .select("status")
          .eq("id", threadId)
          .maybeSingle();
        if ((threadState as { status?: string } | null)?.status === "stopped") {
          throw new DOMException("Investigation stopped by analyst", "AbortError");
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
          const content = (m.content as TrimPart[]).map((part: TrimPart) => {
            if (part?.type === "tool-result" && part.output != null) {
              if (part.output && typeof part.output === "object" && "value" in part.output) {
                return { ...part, output: { ...part.output, value: truncateValue((part.output as { value: unknown }).value, max) } };
              }
              return { ...part, output: truncateValue(part.output, max) };
            }
            if (part?.type === "text" && typeof part.text === "string") {
              return { ...part, text: truncateStr(part.text, isRecent ? STEP_RECENT_CHARS : STEP_OLDER_CHARS) };
            }
            return part;
          });
          return { ...m, content } as ModelMessage;
        });
        return { messages: trimmed };
      };

    const result = streamText({
      // Top-level orchestrator runs on the smart tier — it's the multi-source
      // synthesis step that produces the final report. Per-tool sub-calls use
      // their own tier (see ./models.ts) via wrapToolsWithCache.
      model: orchestratorModel,
      system: SYSTEM_PROMPT_FULL + FINDING_LABELS + buildWorkflowAddendum(detectedSeedType),
      messages: trimmedMessages,
      tools: wrapToolsWithCache(tools, {
        investigationId: threadId,
        userId,
        supabase,
        supabaseAdmin,
        onCost,
        manualOverrideSelector,
      }),
      stopWhen: stepCountIs(50),
      prepareStep,
      // Meter orchestrator LLM token spend per step so threads.cost_micro_usd
      // reflects the actual model cost, not just tool fan-out cost.
      // Rates (micro-USD per token):
      //   MiniMax-M2.7:    in $0.30/M  out $1.20/M  → 0.30, 1.20
      //   Gemini 2.5 Pro:  in $1.25/M  out $10.00/M → 1.25, 10.00
      onStepFinish: ({ usage }) => {
        // A completed step on the primary provider proves MiniMax is alive —
        // record it so the NEXT turn's preflight probe can be skipped.
        if (!useFallback) markMinimaxHealthy();
        try {
          const u = usage as { inputTokens?: number; promptTokens?: number; outputTokens?: number; completionTokens?: number } | undefined;
          const inTok = Number(u?.inputTokens ?? u?.promptTokens ?? 0);
          const outTok = Number(u?.outputTokens ?? u?.completionTokens ?? 0);
          if (!inTok && !outTok) return;
          const [inRate, outRate] = useFallback ? [1.25, 10] : [0.3, 1.2];
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
        const isCtxOverflow =
          /context window|context length|2013|invalid params.*context|exceeds limit/i.test(msg);
        console.warn(
          "[orchestrator] stream error:",
          JSON.stringify({
            thread_id: threadId,
            provider: useFallback ? "lovable-gateway" : "minimax",
            model: useFallback ? FALLBACK_MODEL_ID : MODELS[ORCHESTRATOR_TIER],
            approx_prompt_chars: approxPromptChars,
            context_overflow: isCtxOverflow,
            message: msg.slice(0, 600),
          }),
        );
        if (isCtxOverflow) {
          // Await the status write so it actually persists before the isolate
          // potentially dies. Otherwise the UI is stuck on "running".
          try {
            const { error: updErr } = await supabase
              .from("threads")
              .update({ status: "failed_context_limit" })
              .eq("id", threadId);
            if (updErr) console.warn("[thread status] update failed:", updErr.message);
          } catch (e) {
            console.warn("[thread status] update threw:", e);
          }
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
        const assistant = [...finalMessages].reverse().find((m) => m.role === "assistant");
        if (assistant) {
          // Cap `messages.parts` payload to avoid silent PostgREST 500s when
          // a long fan-out produces multi-MB tool-result blobs. We strip
          // `output.raw` from any tool-result part above the cap.
          const safeParts = capPartsSize(assistant.parts as unknown[], 3_500_000);
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
              await supabase.from("investigation_cache").upsert(
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
