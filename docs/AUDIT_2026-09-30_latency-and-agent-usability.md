# Latency & Agent-Usability Audit — 2026-09-30

**Scope:** read-only. No code, settings, provider, deploy or data changes were made, and no scans were run.
**Auditor:** Claude Code session on branch `claude/insight-finder-latency-audit-f3l04m`.
**Measured:** 2026-09-30T22:38Z – 23:10Z.
**Canonical `main`:** `0cdae6c`.
**Live edge build:** `06ba9b9`.

**Confidence labels:**
- **Confirmed** — source-backed and corroborated.
- **Likely** — strong overlap, missing one hard link.
- **Possible** — plausible lead.
- **Unverified** — present but not checked.
- **Excluded** — checked and ruled out.

---

## 0. The five most consequential findings

> **The model is not the main bottleneck. The application's design is.** One ordinary follow-up (a
> median of **68 characters**) runs a full investigation: a median of **7 model steps and 12 tool
> calls**, with about **65k input tokens re-sent every step**. The first answer text starts a median
> of **111 s** after Send, and the whole run takes a median of **135 s**. A model that decodes twice
> as fast would save about 26 s of that.

| # | Finding | Label | Operator impact |
|---|---|---|---|
| 1 | **Every message enters the full tool-calling loop.** There is no quick-question, report-only or no-tools path, and "Write report" and Continue take the same path as a new seed. Follow-ups: n=136, a median of 12 tool calls, and **111 s p50 / 157 s p95 before the answer step starts**. | Confirmed | Asking a question costs as much as launching an investigation. |
| 2 | **The time is spent in the step architecture, not in decode speed.** Measured decode is 13.1 ms per output token (about 76 tok/s). A text step costs a fixed ~5.2 s, and a tool step ~9.8 s including tool execution. The median run is 7 steps, **406k input tokens and 4k output tokens**. Decoding is about 53 s of a 141 s median run. | Confirmed (measured); split between prefill, TTFT and tool time is **Likely** | Swapping the model alone recovers at most about 20–35% of wall time. |
| 3 | **Runs overlap on the same thread, and the operator cannot see that the server is still working.** **26% of runs** (60 of 229) overlapped another run on the same thread: 40 pairs across 17 threads. In the week of 2026-09-28 it was **53%** (25 of 47). The second run starts a median of **74 s** into the first (minimum 8 s), and 8 of those re-sent identical text. The Send guard ignores server-active runs, and reloading the page loses both Stop and the live state. | Confirmed | Duplicate spend and duplicate latency. A known pairing-wedge class also rides on overlap. |
| 4 | **Invisible work after the answer.** The per-cycle directive forbids report-shaped output on intermediate steps. When a run stops naturally with that compact text, the **salvage** backstop runs another full generation (up to 8,192 tokens, thinking **not** disabled). That text is appended to the stored message but **never streamed**. In non-overlapped natural stops, 31% show more than 20 s of time outside any step (p90 **79 s**). Continue: p50 **17 s**, p90 **82 s**. The SDK's `flush()` awaits `onFinish`, so a stream branch can be held open for all of it. | Likely (attribution by structural correlation; the salvage event is only logged to the console) | "Done, then a different report appears a minute later", or "stuck on Running". |
| 5 | **Silent waits before the stream opens, and provider settings that do nothing.** Details: (a) a serial **DeepSeek-slot preflight** (2 × 12 s) runs on every request even though the pivot it exists for is disabled; **4% of runs waited ≥24.5 s** before starting. (b) The client blocks the first Send on each thread on a **5 s `/health` probe**, which also makes paid LLM pings server-side; it measured **6.7 s** today. (c) Z.AI accepts **only `tool_choice: "auto"`**, so the app's `"required"` / `"none"` do not enforce anything. (d) `parallel_tool_calls:false` is ignored: **55% of tool steps made several calls**. (e) The live model is **`glm-5.2`, not GLM-5.3**. | Confirmed (code, docs, production); preflight → 24.5 s tail is **Likely** | Unexplained multi-second stalls, and a refused first Send with a "cold-starting" toast. |

**Recommendation in one line:**
- **Keep GLM-5.2 for now and fix the application.**
- Then **split responsibilities**: a quick-answer path, the investigation loop, and a report path.
- Decide on a model or provider change only after the offline replay benchmark in §9. Do **not** move to GLM-5.3, which forces thinking on and would likely be slower.

---

## 1. Verified deployed configuration

| Fact | Value | Evidence | Label |
|---|---|---|---|
| Canonical `main` | `0cdae6c` (#649) | `git rev-parse origin/main` | Confirmed |
| Production frontend | Vercel `dpl_4nNbeCLoE4KspffQTf2uFS4d1cpS`, `READY`, **`target: production`**, `githubCommitSha 0cdae6c…` | Vercel `list_deployments` (team `team_AStX…`) | Confirmed (the alias stylesheet probe was not repeated) |
| Live edge build | `/health` → `build: 06ba9b9`, version 1.2.2, committed 2026-09-24T21:38 −07:00 | `GET …/osint-agent?health=1` at 2026-09-30T22:38:58Z | Confirmed |
| Ledger | `deploy/live` → `06ba9b9`. Last `deploy-log.jsonl` row: marker `06ba9b9`, stamp `7a8ba5f`, `mirror_tree_equality: equal`, 0 problems, 0 warnings, `deployed_bytes_verified: false` | repo | Confirmed (bytes unverified by design) |
| Undeployed edge code | None. `git diff 06ba9b9 origin/main -- supabase/functions` touches only `build-info.ts` (the stamp offset) | git | Confirmed |
| Mirror | `main` = `30e818b`. `diff -rq` is **empty** for `_shared`, `evidence-export`, `security-test-lab` and `osint-agent`. Two new Lovable-bot commits on 2026-09-30 (`e2d7a54` "Work in progress", `30e818b` "Wrote audit report breakdown") touch only `src/integrations/supabase/previewAuthStorage.ts` (the mirror's frontend) | mirror clone | Confirmed. Watch item: bot commits keep landing on the mirror. |
| Provider **slot** | `selected_provider: deepseek`, `orchestrator_reason: pinned` (secret `ORCHESTRATOR_PROVIDER` = deepseek) | `/health`; `orchestrator_select.ts:33-67`† | Confirmed |
| **Endpoint vendor** | Z.AI. `model_id` in telemetry is `glm-5.2 (api.z.ai)`. Base URL secret `DEEPSEEK_BASE_URL` (code default `https://api.deepseek.com/v1`, `env.ts:210-212`†) | `orchestrator_invocations` (231 of 231 slot runs) | Confirmed |
| **Exact model** | **`glm-5.2`**, from secret `DEEPSEEK_ORCHESTRATOR_MODEL_ID` (code default `deepseek-v4-pro`, `env.ts:195-196`†). Nothing in the repo references GLM-5.3. | `/health.selected_model`; telemetry | Confirmed |
| "GLM-5.3" belief | False for this API endpoint. It would be true only on Z.AI's **Coding Plan** endpoint (`/api/coding/paas/v4`), where "Requests for GLM-5.2/GLM-5.1 will be automatically routed to GLM-5.3". The telemetry label records host `api.z.ai`; the exact path is unverified. | docs.z.ai/devpack/overview | Likely (path not visible without reading the secret) |
| Fallback chain | Chosen **once per request** before streaming. No per-step or mid-stream fallback. Gemini-direct (`gemini-2.5-flash`) only if the preflight returns HTTP ≥400 **and** `GEMINI_PREFLIGHT_PIVOT_ENABLED` is on (it is off). Lovable gateway only if pinned or `ALLOW_LOVABLE_FALLBACK`. MiniMax is labelled "fallback" in `/health` but is only a diagnostic for the orchestrator. It is a real per-call fallback chain for tool-level LLM calls (`providers.ts:230-296`†). | `index.ts:616-622, 734-756`; `/health.checks.preflight_pivot` | Confirmed |
| gemini-direct history | 16 runs 2026-09-11 → 09-23, 16 of 16 with errors, p50 0.8 s | telemetry | Confirmed. No longer used. |
| SDK | `ai@6.0.193`, `@ai-sdk/openai-compatible@1.0.39`, `.chatModel()` = **Chat Completions** | `deno.lock:9,11`†; package source inspected | Confirmed |

### Effective model settings

Where each setting is controlled: code constants unless marked as env.

| Setting | Value | Where | Honoured by Z.AI? |
|---|---|---|---|
| Thinking | `thinking:{type:"disabled"}` on orchestrator steps | `index.ts:1211-1212`† (sent: openai-compatible spreads `providerOptions.deepseek` into the body, verified in package source) | Yes. GLM-5.2 thinks by default and allows disabling it (docs.z.ai/guides/capabilities/thinking-mode). **Salvage `generateText` passes no providerOptions** (`index.ts:1687-1692`), so it **thinks by default**. |
| `parallel_tool_calls` | `false` | same | **No.** 785 of 1,424 tool steps (55%) contained 2 to 8 calls. The parameter is not in Z.AI's request schema. |
| `tool_choice` | `"required"` on step 0 of every message, `"none"` on the finalize report phase, otherwise `"auto"` | `index.ts:1160`; `orchestrator-budget.ts:110-120`; `orchestrator-finalize.ts:151-169`† | **No.** Z.AI: "The default value is auto, and **only auto is supported**" (docs.z.ai/api-reference/llm/chat-completion). Observed 6 of 224 step-0 steps with no tool call, including 3 of 4 Report requests. |
| Max output | 8,192 tokens | `index.ts:98` | n/a. Not env-overridable. 1 step ended `length`. |
| Temperature | provider default | — | — |
| Retries | SDK default (`maxRetries` unset → 3 attempts). Visible as "Failed after 3 attempts. Last error: Insufficient balance…" | error_message | Confirmed |
| Transport timeout | 90 s idle, reset per chunk | `env.ts:38-39`, `fetch_retry.ts:106-160`† | — |
| Run budget | 22 steps, **180 s** wall clock, forced finalize from **90 s**, 36 tool reservations, `MAX_PAID_CALLS=12` **per request** (`clearRuntime` runs every request) | `orchestrator-budget.ts:63,164,275`; `orchestrator-finalize.ts:43`† | — |
| Streaming | `toUIMessageStreamResponse`. No custom progress, stage or heartbeat parts. No `stream_options.include_usage`. | `index.ts:2075` | — |
| Prompt caching | None configured. Z.AI caches **automatically**: cached input costs $0.26 vs $1.40 per 1M, and hits are reported in `usage.prompt_tokens_details.cached_tokens`. **The app does not record cache hits.** | docs.z.ai/guides/capabilities/cache | Hit rate is Unverified |

**Secrets by name only:**
- Orchestrator: `ORCHESTRATOR_PROVIDER`, `DEEPSEEK_BASE_URL`, `DEEPSEEK_ORCHESTRATOR_MODEL_ID`, `GLM_API_KEY` or `DEEPSEEK_API_KEY`.
- Fallbacks: `GEMINI_API_KEY` (presence implied, because a fallback target exists), `MINIMAX_API_KEY` (present, `checks.minimax.ok`).
- Flags: `GEMINI_PREFLIGHT_PIVOT_ENABLED` (off), `ALLOW_LOVABLE_FALLBACK`.

`/health` reports 17/20 optional tool APIs configured and `reveal_breach_data: true`, which was not touched.

---

## 2. Measured latency breakdown

**Data source:** production DB, SELECT only through the Lovable connector.

| Store | Rows | Window |
|---|---|---|
| `orchestrator_invocations` | 247 (231 on the GLM slot, 16 gemini-direct) | 2026-09-11T03:34Z → 2026-09-30T19:36Z |
| `orchestrator_step_metrics` | 1,602 | same |
| `tool_usage_log` | 17,516 | 2026-06-08 → |
| `messages` | 2,362 | — |

**Request type** is inferred by joining each run to the latest user message in its thread:
- **new investigation:** the first user turn;
- **continue:** starts with the `CONTINUE_PROMPT` text;
- **report:** starts with the `REPORT_PROMPT` text;
- **follow_up:** anything else.

Recovery requests have no distinguishing marker and are folded into follow_up.

### 2.1 Per request type (GLM-5.2 slot)

| Type | n | Run p50 / p95 | Admit p50 / p95 † | Time to answer step p50 / p95 ‡ | Answer step p50 | Steps p50 | Tools p50 | Forced finalize | Errors |
|---|---|---|---|---|---|---|---|---|---|
| Follow-up (median 68 chars) | 136 | **134.7 s / 223.1 s** | 1.6 s / **32.8 s** | **111 s / 157 s** | 21.6 s | 7 | **12** | 81 (60%) | 7 |
| New investigation | 49 | 165.3 s / 215.6 s | 1.6 s / 3.8 s | 125 s / 167 s | 42.7 s | 9 | 22 | 45 (92%) | 5 |
| Continue | 41 | 112.7 s / 201.8 s | 1.5 s / 9.6 s | 92 s / 132 s | 8.5 s | 6 | 9 | 19 (46%) | 4 |
| Report | 4 | 71.1 s / 104.9 s | 1.6 s / 9.1 s | 9 s / 15 s (n=3) | **87 s** | 1 | 0 | 0 | 0 |

- † **Admit** is from the user-message insert (`auth.ts:248`) to `runStartedAt` (`index.ts:909`). It covers the title update, credit RPCs, message conversion and trimming, **preflight**, attachment intake and the reviews load. Auth, rate limiting, body parse, thread checks and recovery come *before* the insert and are **not measured**.
- ‡ **Time to answer step** is admit plus the step walls before the first text-only step. It is roughly when the answer text starts streaming, minus the unmeasured TTFT of that step (≤5 s, from the regression intercept). Tool steps also emit short narration (median 150–620 output tokens, including tool arguments).
- "Run" (`duration_ms`) starts at `runStartedAt`, so it **excludes admission**. Operator-felt latency is Run plus Admit plus the unmeasured pre-insert time.
- Run duration has not improved week over week. p50 by week: 155 s, 150 s, 114 s, 137 s (weeks of 09-07, 09-14, 09-21, 09-28).

### 2.2 Where time goes inside a run (all 231 runs)

| Component | Measure | Label |
|---|---|---|
| Model steps | p50 sum of step walls **122 s** of a 141.5 s p50 run | Confirmed |
| Text-step cost model | `wall ≈ 5.2 s + 13.1 ms × output tokens`, R² 0.81, n=178. **Decode ≈ 76 tok/s.** | Confirmed |
| Tool-step cost | intercept **9.8 s** + 10.5 ms/token, R² 0.34, n=1,424. Median 11–13 s whether a step made 1 call or 8. The extra ~4.6 s over a text step is tool execution plus wrapper DB round trips. | Likely |
| Input per step | p50 62–69k tokens, p95 ~97–115k. **Per run: p50 406k, p95 789k input tokens.** Across all runs: 99.3M input vs 1.08M output (**92:1**). | Confirmed |
| Output per run | p50 4,046 tokens (≈53 s of pure decode at the measured rate) | Confirmed |
| Outside-step time ("gap" = run − Σ step walls) | p50 4.5 s, **p95 85 s**. Concentrated in natural stops and overlapped runs (§3, F4). | Confirmed (measured); cause Likely |
| Runs over the 180 s budget | 52 of 231 (the budget clock starts after admission, and the tail after the last step is not bounded) | Confirmed |
| Stop reasons | `finalize_forced` 142 (61%, p50 169 s) · `natural_stop` 54 (23%, p50 99 s) · `unknown` 17 · `stream_error` 17 · `length_limit` 1 | Confirmed |
| Stream errors | "Tool result(s) missing" ×6 (09-12, 09-24, before the #608 positional-pairing deploy) · Z.AI **"Insufficient balance"** ×2 (09-13, and **2026-09-30T02:01Z**; runs before and after succeeded, so transient) · analyst stop ×9 · other ×16 (gemini-direct era) | Confirmed |

### 2.3 Tool latency, outcome-separated

Window 2026-09-11 → 09-30; "live" excludes cached and skipped calls.

| Tool | n | ok / empty / skipped / failed | p50 / p95 live | Σ time | Note |
|---|---|---|---|---|---|
| `minimax_correlate` (MiniMax-M2.7 LLM) | 122 | 87 / 0 / 34 / 1 | **24.8 s / 37.3 s** | 2,256 s | The largest single tool sink. Three-month p50 is 24.1 s (n=433). M2.x cannot disable thinking (platform.minimax.io). |
| `socialfetch_web_read` | 169 | 112 / 0 / 18 / 39 | 6.6 / 18.4 s | 1,161 s | 23% failed |
| `serus_darkweb_scan` | 152 | 107 / 23 / 22 / 0 | 7.4 / 15.7 s | 997 s | |
| `minimax_web_search` | 293 | 243 / 0 / 49 / 1 | 3.6 / 5.5 s | 923 s | |
| `gemini_deep_dork` | 60 | 37 / 0 / 13 / 10 | 11.6 / 20.4 s | 589 s | |
| `indicia_person` / `_address` / `_phone` / `_email` | 23 / 11 / 9 / 9 | mixed | ~23–28 s | ~860 s | Slow per call |
| `wayback_cdx_search` | 26 | **0** / 13 / 3 / 10 | 18.1 / 25.7 s | 380 s | **Three-month window: 24 ok out of 111 non-skipped (22%), no ok since 2026-08-28.** This is a lead to investigate, not grounds to disable. Note that `/health.checks.credentials` lists it as "recovered", which disagrees with the outcome data. |
| `memory_recall` / `memory_save` | 101 / 179 | mostly ok | **0.45 / 0.41 s** | 48 s / 76 s | **Memory is not a latency factor (Excluded).** |
| `record_artifacts` | 439 | 430 ok | 0.37 s | 210 s | |

### 2.4 Representative timelines

Thread `75b76714…`, 2026-09-30. All figures are milliseconds from `orchestrator_*`, with no case content.

**A. New investigation, 18:58:05Z** (17-char seed; 158 s; `finalize_forced`; not overlapped)

| Elapsed | Component | Evidence |
|---|---|---|
| 0 → 1.7 s | admission, including preflight | admit 1,712 ms |
| 1.7 → 24.3 s | step 0: 30.8k in / 244 out / **8 tool calls** | step_wall 22,566 |
| → 42.6 s | step 1: 1 tool, 1,862 out tokens | 18,310 |
| → ~117 s | steps 2–9: 1–4 tools each, 4.9–21.5 s apiece | step walls |
| → ~157 s | step 10: **text answer, 3,414 out tokens, 40.0 s** | 40,034 |
| → 158 s + ~1.9 s | tail: assistant insert → invocation finish | fin − asst 1,850 |

The operator sees tool activity from about 3–5 s, and **answer text from about 117 s**.

**B. Short follow-up, 19:36:51Z** (17 characters; 107 s; natural stop)

| Elapsed | Component |
|---|---|
| 0 → 2.2 s | admission |
| 2.2 → 104.6 s | **one step: 86.9k input tokens, 6,991 output tokens, 0 tool calls, 102.4 s** |
| → +4.8 s | tail |

A 17-character question produced a ~7k-token answer, which accounts for about 92 s of decode. Verbosity is a latency driver in its own right, and `"required"` did not force a tool call here, which is consistent with Z.AI ignoring it.

**C. Overlapped Continue pair, 19:03:07Z and 19:04:13Z** (two 335-character Continue prompts started 66 s apart)
- The second run began while the first was still at step 5. Their persistence overlapped.
- The runs' first assistant rows landed 54 s and 76 s before each run finished.
- Uncertainty: with two runs on one thread, rows cannot be attributed to a run. There is no run id on `messages`.

### 2.5 Overlapping spans and what cannot be separated

- Tool time lives **inside** step walls. Do not add it to step time.
- Several tools run concurrently (limit 3), so Σ tool time in §2.3 overstates wall time.
- The salvage generation, finalize chain inserts and clustering fall in the "gap". The finalize chain's three model steps are counted as steps.
- **Cannot be separated with current instruments:**
  - provider TTFT vs prefill vs server queueing inside a step;
  - model vs tool time inside a tool step;
  - `prepareStep` time;
  - pre-insert admission;
  - salvage duration;
  - client TTFB;
  - client render time;
  - Z.AI cache hits.

  The smallest measurement for each is in §8.

---

## 3. Root causes: confirmed vs unresolved

**F1 — No request routing: every message is an investigation.** Confirmed.
- `detectSeedServer` returns `{kind:"other"}` for any non-empty text (`validation.ts:18-80`), so `latestUserAsksForInvestigation` is always true (`index.ts:928-935`) and step 0 sends `toolChoice:"required"` (`index.ts:1160-1171`, `orchestrator-budget.ts:110-120`).
- The whole ~96-tool set, the full system prompt and the per-cycle directive go on every step.
- Z.AI ignores the `"required"` (§1), so the **real driver is the prompt plus tool exposure**: 97% of step 0s call tools anyway.
- **Consequence for the fix:** removing `"required"` alone will not make questions fast. A quick path needs *no tools in the request*, not `tool_choice:"none"`, which Z.AI also does not support.

**F2 — Per-step cost dominated by re-sending ~65k tokens and a fixed intercept.** Confirmed (measured); split Likely.
- The median run is 7 steps × ~65k input tokens.
- The 220k-char budget covers **messages only**. The system prompt (~48 KB source) and ~96 tool schemas (~95–105k chars per CLAUDE.md) are added on top of it.
- The per-step trim changes older messages as the window slides (`index.ts:956-993`†). That may defeat Z.AI's automatic prefix cache for the history portion; hit rate is Unverified.

**F3 — Overlapping runs.** Confirmed.
- `isSubmitBlocked` checks only the local useChat status and a click lock (`src/lib/submit-guard.ts:16-18`). `serverRunActive` only hides run controls.
- There is no server-side same-thread lock (CLAUDE.md, `SCOPE_same-thread-concurrency.md`).
- After a reload the client shows no LiveActivityCard, no timer and no Stop, while Send stays enabled.
- Stop → Send quickly re-activates the thread before the old run polls `status` at its next `prepareStep` (`ChatWindow.tsx:1922-1954`; `index.ts:938-946`).
- The Stop toast confirms the DB write, not that the server halted.

**F4 — Salvage and flush tail.** Likely.
- The per-cycle directive (`orchestrator-finalize.ts:455-469`) forbids report shape on intermediate steps.
- `needsReportSalvage` returns true for any non-report-shaped final text when the run did work or the thread has artifacts (`orchestrator-finalize.ts:760-786`). `countRecordArtifactCalls` counts tool parts in the **entire replayed history** (`guard.ts:273-286`).
- Salvage calls `generateText` with no `providerOptions` (thinking on by default for GLM-5.2) and `maxOutputTokens 8192`. It runs inside `persistFinalMessages`, **before** the assistant insert and the status flip (`index.ts:1611-1700`).
- The SDK's `handleUIMessageStreamFinish` awaits `onFinish` in `flush()` and also calls it on `cancel()` (`ai@6.0.193` dist, verified). Both the client and persistence branches carry `onFinish: persistFinalMessages`, with first caller winning (`index.ts:2057-2102`).
- Salvage text is never streamed. It appears only when the client re-reads messages.
- **Evidence** (non-first-turn runs with more than 20 s outside steps, overlapped runs included, n=51, compared with the other 129 non-first-turn runs):
  - the last text block has a median of 11.6k characters, against 6.1k;
  - 45% of those blocks open with a report heading, against 9%.
- The salvage event itself is console-only, so attribution is not proven.

**F5 — Pre-stream waits.**

| Item | Detail | Label |
|---|---|---|
| (a) Preflight | `index.ts:693-756` runs whenever the slot is primary and a fallback target exists: two attempts of 12 s each plus 250 ms. **With the pivot disabled, it can only produce log lines** (`index.ts:738-756`). It has no warm-isolate skip, unlike MiniMax's `minimaxHealthyWithin`. It omits `thinking:disabled`, unlike the `/health` canary. | Confirmed (code). 9 runs (4%) had admit ≥24.5 s (avg 42 s), which fits two 12 s timeouts; attribution is Likely because preflight outcomes are console-only. |
| (b) First-Send readiness probe | Awaits `GET ?health=1` with a **5 s** timeout on the first send per ChatWindow mount; a timeout **refuses the send** with a "cold-starting" toast (`ChatWindow.tsx:2048-2083`). `/health` runs two **paid** LLM pings, Z.AI and MiniMax, with 5 s caps (`health-handler.ts:344-347, 125-171`), then serial DB sweeps. One sample today took **6.74 s TTFB**. The client also hits `/health` every 30 s while a run is loading, and at 30 s and 90 s after it ends (`ChatWindow.tsx:2589-2617`). | Confirmed (code). Refusal frequency Unverified: there is no client telemetry. |
| (c) Admission chain | About 10 serial round trips before streaming: getUser, rate limit, thread select, recovery re-read, message insert, a title update that is a no-op after the first turn, credits and role, debit RPC, reviews. Several are independent (`auth.ts:119-268`, `index.ts:173-821`†). | Likely ≈0.3–1.5 s |

**F6 — Forced finalize chain.** Confirmed (code), share Likely.
- 61% of runs end `finalize_forced`, triggered at 90 s of the 180 s budget or at step 21.
- Finalize is **three serial full-context generations** (persist → memory → report; `orchestrator-finalize.ts:135-175`†) before the report streams.
- `memory_save` itself is fast (0.41 s p50). The cost is the extra model round trips.

**F7 — Client render and refresh load during runs.** Possible (code only; not profiled).
- Artifact realtime inserts fan out unthrottled into `dedupeArtifacts`, `buildConfidenceProfile`, `buildIdentityClusters` and every visited hidden tab (`useThreadArtifacts.ts:213-281`†).
- `useReviewStates` returns a fresh object every render and busts memos (`review.ts:504`†).
- Each ~15 s heartbeat triggers an unbounded `tool_usage_log` select with `count:exact` (`useThreadToolActivity.ts:291-413`†) and four sidebar queries (`ThreadSidebar.tsx:157-224`†).
- The live message's full markdown is re-parsed every 80 ms tick, and the transcript is not virtualized.

**F8 — Full-history uploads.** Confirmed (code), size Likely.
- There is no `prepareSendMessagesRequest`, so the client sends every message, including tool outputs, every turn (`ChatWindow.tsx:1570-1579`). The server uses the body and never re-reads history from the DB (`auth.ts:191`†).
- Persisted-history size at run start: p50 150 KB, p95 633 KB, max 1.26 MB. 5 runs were over 1 MB, against a 2 MB limit that returns a 413.
- In-session bodies can be larger, because uncapped tool outputs stay in client state (`safety.ts:342-347, 470-473`†).
- Transfer time is probably 1–3 s on mobile uplinks at p95: an estimate, not measured.

**Excluded or not the cause:**
- **Memory recall** (0.45 s p50; it is a model-invoked tool, not preloaded).
- **Prompt-tail summarization**: local code, no LLM call.
- **Title generation**: no LLM call.
- **DSML or think-stripping stream buffering**: the stream is not buffered.
- **Provider fallback hops**: none happen now.
- **Undeployed code**: none.

---

## 4. Quality-of-life defects

Each is given as Trigger → behaviour → cause → impact → fix → verification.

| # | Trigger | Observed behaviour | Cause | Operator impact | Proposed fix | Verify |
|---|---|---|---|---|---|---|
| Q1 | Ask a quick question | 2+ minutes and about 12 lookups | F1 | Cannot converse with the case | Explicit **Ask** mode: no tools, small prompt, 1 step (§6 S5) | Follow-up p50 falls from 135 s to under 30 s on replay and production |
| Q2 | "Write report" | Full loop and 96 tool schemas. The model *usually* skips tools because Z.AI ignores `"required"`, but it can still call them, since `"none"` is ignored too. | F1, F5c | Unpredictable; a report can trigger lookups | Report path with tools **removed** from the request | Report runs have 0 tool calls and 1 step |
| Q3 | Send soon after a run "looks" done, or after reload | A second run starts (26% of runs; 53% this week) | F3 | Double cost; answers interleave; pairing wedges | Block Send/Continue while the server run is active; show "Server still running · last progress Ns ago · Stop" | Weekly overlap rate |
| Q4 | Reload during a run | Transcript shows only the user message; no Stop, no timer; header says Running | Assistant row persisted only at finish; no resume | Cannot cancel, cannot tell progress | Server-owned run state: last event time, step, tool; Stop available from the header | Harness scenario plus e2e |
| Q5 | First Send in a newly opened thread | Blocked up to 5 s, or refused with "cold-starting" | F5b | Silent-feeling stall; retry needed | Take the probe off the critical path, or use a non-LLM `?ping=1` | Remove the await; e2e |
| Q6 | Run reaches 90 s | Live card shows the last tool; no "collecting done, writing report" state | No stage events | Looks stuck during the ~40–90 s report step | Emit `data-stage` parts (collect → finalize → report → persist). **Useful even though it does not cut time**, because the report step is real work of 21–87 s. | Stage visible in harness |
| Q7 | Continue / natural stop | Answer finishes, then a different, longer report appears later (salvage) | F4 | Confusing, and extra waiting | Salvage decision in §6 S4 (needs sign-off, termination invariants) | Salvage frequency + gap metric |
| Q8 | Continue clicked while locked | Dropped silently; the button is always enabled (`ChatWindow.tsx:2188, 3160`) | `sendCycle` guard | "Click did nothing" | Disable with a reason tooltip | unit + e2e |
| Q9 | Stop | Toast "stopped" while the server finishes its current step or tool | Status polled only at `prepareStep` | False confidence | Label it "Stopping…" until the heartbeat stops | e2e |
| Q10 | Pre-stream failures (401 / 403 / 413 / 429) | Generic "Scan request failed…"; only 402 is recognised; Retry is offered on non-retryable errors (`ChatWindow.tsx:95-107, 895-902`†) | The JSON error body carries no HTTP status | Wrong remedy | Carry the status code | unit |
| Q11 | Long sessions / mobile | Per-tick markdown re-parse, non-virtualized transcript, hidden tabs recomputing | F7 | Jank, battery drain | Profile first (§8), then memo and virtualize | Harness CPU profile at 390 px |

---

## 5. Ranked fixes that keep GLM-5.2 (option A)

Impact figures are quantified only where the data supports it.

| Rank | Fix | Expected effect | Effort | Risk | Confidence |
|---|---|---|---|---|---|
| 1 | **Explicit Ask / Report modes** (client flag, no prose inference): no tools, compact prompt, 1–2 steps, no finalize or salvage | Quick questions: text-only step-0 p50 is **22.8 s for about 1.4k tokens** today. Removing ~100k chars of schemas should lower that further (unmeasured). **About 5× faster than 135 s.** | M (edge + frontend, separate PRs) | Medium: touches the opening gate (termination area). It is additive and gated by an explicit UI action, so it does not touch the seed path. | High |
| 2 | **Block overlapping runs + show server run state** | Removes duplicate runs (26–53%) and the pairing-wedge exposure | S–M (frontend first; a server lock later) | Low | High |
| 3 | **Remove the dead preflight** (skip it when the pivot flag is off, or cache health per isolate) | Removes one serial RTT from every request and very likely the 4% ≥24.5 s admission tail | S (edge) | Low; kill switch | Medium-high (tail attribution Likely) |
| 4 | **Probe off the Send path; lightweight `?ping`** without LLM pings | First-send stall or refusal removed; fewer paid pings (each loading minute currently causes about 2 pings) | S (edge + frontend) | Low | High |
| 5 | **Salvage/tail redesign** (sign-off required) | Up to about 17 s p50 / 82 s p90 on Continue; about 79 s p90 on natural stops | M | **High**: invariant I-2 area | Medium |
| 6 | **Output brevity** for follow-ups and Continue (prompt + `maxOutputTokens` per mode) | Example B: 7k tokens ≈ 92 s. Each 1k tokens saved ≈ 13 s. | S | Low–medium (quality) | High on the arithmetic, medium on adoption |
| 7 | **Cache-friendly prompt layout + log `cached_tokens`** | Unknown until measured: Z.AI cached input is 5.4× cheaper and may lower prefill | S (measure) → M | Low | Low (unmeasured) |
| 8 | **`minimax_correlate` off the critical path**, or a faster model | 24.8 s p50 per call; 122 calls in 19 days | M | Medium (evidence-quality tool) | Medium |
| 9 | **Parallelize admission reads**; drop the duplicate thread read and the no-op title update | About 0.3–1.5 s per request (estimate) | S | Low | Medium |
| 10 | **Client refresh hygiene** (throttle artifact fan-out, stable review object, bound `tool_usage_log` reload) | Jank and network load; not measured | M | Low | Low until profiled |
| 11 | **History trimming before upload** | 150–633 KB less per turn | M | Medium: the server relies on the body | Medium |

**Not recommended, and why:**
- Raising `MAX_PAID_CALLS` or the wall-clock budget: settled, and it does not finish runs faster.
- Disabling tools on this data: measured outcomes support *investigating* `wayback_cdx_search`, not removing it.
- Flipping `REQUIRE_TOOL_CALL_IN_OPENING_PHASE` or `FORCE_TOOL_CALL_UNTIL_FINALIZE` globally: this is the oscillation CLAUDE.md warns about. The `"required"` flag is inert on Z.AI anyway.
- Inferring "is this a question?" from prose: settled, not allowed. Modes must be explicit UI actions.

---

## 6. Model and provider comparison (options B, C)

Sources are official vendor pages, fetched 2026-09-30 by a research sub-agent. Key claims were spot-checked against the saved pages (Z.AI `tool_choice` enum, GLM-5.3 thinking, Coding Plan routing, GLM-5.2 price, Anthropic forced tool-use table).

**Cost per run** uses the measured median of 406k input and 4k output tokens. The cached column assumes **80% of input is a cacheable repeated prefix**; that is an assumption, because the hit rate is unmeasured. Tokenizers differ between vendors, so these are illustrative.

| Provider · model | Context / max out | Forced tool choice | Parallel control | $/1M in · cached · out | $/run uncached → 80% cached | Notes |
|---|---|---|---|---|---|---|
| **Z.AI `glm-5.2` (current)** | 1M / 128K | **No (auto only)** | not in schema | 1.40 · 0.26 · 4.40 | **$0.59 → $0.22** | Thinking on by default; disabling is allowed |
| Z.AI `glm-5.3` | 1M / 128K | No | — | same | same, **plus reasoning tokens** | **Thinking cannot be disabled**; `"disabled"` makes the request fail. Default effort `max`. Same base model as 5.2. Likely slower for this workload. |
| Z.AI `glm-5.3-flashx` / `-flash` | 1M / 128K | No | — | 0.37 · 0.075 · 1.25 / 0.15 · 0.03 · 0.50 | $0.16 / $0.06 → $0.06 / $0.02 | FlashX states "200 tokens/s", Z.AI's only published speed figure. Forced thinking. |
| OpenAI `gpt-6-luna` | ~1M / 128K | yes (Chat Completions only with `reasoning_effort:"none"`) | yes | 0.10 · 0.01 · 0.50 | $0.04 → $0.02 | Needs `@ai-sdk/openai`. Zero Data Retention by approval. |
| OpenAI `gpt-6.1-sol` | 1.05M / 128K | yes, **Responses API only** for tools | yes | 2.00 · 0.10 · 10.00 | $0.85 → $0.28 | Tool calls on flagships need Responses, not `openai-compatible` |
| Anthropic `claude-sonnet-5-5` | 1M / 128K | **No** (`any`/`tool` → 400) | `disable_parallel_tool_use` | 2.00 · 0.20 · 10.00 | $0.85 → $0.31 | `@ai-sdk/anthropic`. No training on API data; ZDR via sales. |
| Anthropic `claude-haiku-4-5-20251001` | 200K / 64K | yes | yes | 1.00 · 0.10 · 5.00 | $0.43 → $0.15 | 200K context; p95 input per step (~115k) fits |
| Google `gemini-3.8-flash` | 1.05M / 65.5K | yes (`any`) | parallel supported | 0.75 · 0.075 · 3.75 | $0.32 → $0.10 | Thinking cannot be turned off on 3.x. Docs warn that large tool schemas may be rejected. 55-day abuse logs. |
| DeepSeek `deepseek-flash` | 1M / 384K | only with thinking off | Unverified | 0.30 · 0.006 · 1.20 (peak) | $0.13 → $0.03 | `@ai-sdk/deepseek`; retention Unverified |
| MiniMax `MiniMax-M3` | 1M / 512K | Unverified on the OpenAI API | Unverified | 0.30 · 0.06 · 1.20 | $0.13 → $0.05 | States ~100+ tps. Already a vendor here (M2.7 for tools). |

**Sources:**
- Z.AI: docs.z.ai/guides/overview/pricing, /guides/llm/glm-5.2, /guides/llm/glm-5.3, /guides/vlm/glm-5.3-flash, /api-reference/llm/chat-completion, /guides/capabilities/{function-calling, thinking-mode, cache}, /devpack/overview, /legal-agreement/terms-of-use.
- OpenAI: developers.openai.com/api/docs/{models/gpt-6-luna, models/gpt-6.1-sol, guides/function-calling, guides/prompt-caching, guides/your-data}.
- Anthropic: platform.claude.com/docs/en/{about-claude/pricing, agents-and-tools/tool-use/define-tools, build-with-claude/prompt-caching, manage-claude/api-and-data-retention}.
- Google: ai.google.dev/gemini-api/docs/{models, pricing, caching, function-calling, usage-policies}.
- DeepSeek: api-docs.deepseek.com/{quick_start/pricing, guides/thinking_mode, guides/kv_cache}.
- MiniMax: platform.minimax.io/docs/guides/{pricing-paygo, rate-limits, text-generation}.

All accessed 2026-09-30. Anything marked Unverified had no official page.

**What stays slow after any model change:**
- the per-step re-send architecture (7+ round trips);
- tool latency (`minimax_correlate` ~25 s, `indicia_*` ~25 s);
- the finalize chain and salvage tail;
- the admission chain;
- overlap;
- client render and refresh.

At the measured median, a model with 2× decode speed and half the fixed per-step intercept saves roughly 26 s (decode) + ~18 s (7 × 2.6 s) ≈ **45 s of a ~141 s run**. That is real, but smaller than F1 plus F3 plus F4 combined.

**Data handling:**
- Z.AI's Terms of Use prohibit using the service to "collect, process, disclose, infer, or generate the personal information of others" without authorization, and allow individual-user content to be used for model improvement. The service is operated from Singapore.
- For an OSINT product that is a **compliance question for JD, separate from latency**, and it should be reviewed before scale-up whichever model is chosen.
- OpenAI, Anthropic and Google state that API data is not used for training. Retention periods differ as listed.

**SDK compatibility notes:**
- The current `"required"` / `"none"` / `parallel_tool_calls` settings are already inert on Z.AI.
- Anthropic's 5.5 models and DeepSeek in thinking mode would **reject** a forced `tool_choice` with a 400. Any migration must remove it first, which option A's changes do anyway.
- OpenAI flagships need `@ai-sdk/openai` (the Responses API) for tool calls.

## 7. Recommendation

**Keep GLM-5.2 and tune the application now. Then split responsibilities (option D).** Replace the model only if the benchmark says so.

1. **Split by explicit operator intent, with no prose inference:**
   - **Ask:** no tools, small prompt, one step, streamed.
   - **Investigate / Continue:** the current loop.
   - **Report:** no tools, one generation from persisted artifacts, streamed, no salvage.

   This is the smallest architecture change that addresses the measured problem. It reuses the existing streaming path and needs no job queue.
2. A **lighter model for bounded tasks** (Ask, `minimax_correlate`, maybe Report) is reasonable *after* §9 shows equal evidence quality. Candidates by fit: `glm-5.3-flashx` (same vendor and API, forced thinking), `gemini-3.8-flash`, `gpt-6-luna`, `claude-haiku-4-5`.
3. **Do not switch the investigation orchestrator yet.** Its latency is mostly architecture. The integrity and quarantine behaviour has been tuned against GLM-5.2, and a switch changes both.
4. **Do not move to GLM-5.3.** It forces reasoning, with default effort `max`, on the same base model.

---

## 8. Staged implementation plan

**Rules:**
- small PRs, and never mix frontend and edge in one PR;
- schema first;
- at most one edge PR in flight;
- each behaviour change carries a kill switch and a new `/health` key or durable event.

**Nothing below is started. Each stage needs JD's approval.**

| Stage | Channel | Change | Acceptance | Rollback |
|---|---|---|---|---|
| **S0a** | Lovable (schema) | Add nullable columns. On `orchestrator_invocations`: `request_received_at`, `admission_ms`, `preflight_ms`, `preflight_outcome`, `salvage_fired`, `salvage_ms`, `tail_ms`, `request_mode`. On `orchestrator_step_metrics`: `first_chunk_ms`, `cached_input_tokens`, `prepare_ms`. Verified against the live DB. | Columns exist live | Drop the columns (unused) |
| **S0b** | edge | Write those fields; persist partial step rows incrementally so killed runs are not lost. `/health` key `checks.latency_telemetry`. Kill switch `LATENCY_TELEMETRY_DISABLED`. | 24 h of rows with non-null fields; no change to run durations | Kill switch |
| **S1** | edge | Skip the slot preflight when the pivot is disabled, or cache it 60 s per isolate. `/health` `checks.preflight_policy`. Kill switch. | Admit p95 below 5 s over 7 days; `preflight_ms` near 0 | Env flag |
| **S2a / S2b** | edge, then frontend | `?ping=1` (no LLM, no sweeps); client probe non-blocking and on `ping`; periodic sweeps use `ping` plus a separate recovery call | First Send never waits on the LLM; LLM pings per run drop to 0 | Revert the frontend PR |
| **S3** | frontend | Send/Continue blocked while the server run is active, with a visible reason; Stop from the header after reload; "Stopping…" state | Overlap rate below 5% of runs over 7 days (from 26–53%) | Revert |
| **S4** | edge (**sign-off**) | Salvage policy: skip on Continue/Ask; stream the report instead of generating it after the fact, or run salvage *after* the status write as a separate message. Must keep I-2. | Continue gap p90 under 15 s; I-2 tests green | Kill switch |
| **S5a / S5b** | edge, then frontend | `mode: ask \| report` in the request body; server builds a tool-less request; UI adds "Ask (no new lookups)" and routes Write report through it. `/health` `checks.request_modes`. | Ask p50 under 30 s; Report 0 tools; seed path unchanged (e2e 51/2 holds) | Env kill switch; UI flag |
| **S6** | edge | Per-mode output caps plus brevity directive for Ask/Continue | Median output tokens for Continue/Ask down ≥30% with no loss in report readiness | Revert |
| **S7** | frontend | Render and refresh fixes, driven by the S-harness profile | Main-thread long tasks during a streamed 30 KB report down ≥50% (harness, 390 px, 4× CPU) | Revert |
| **S8** | edge | `minimax_correlate` async or on a faster model (after the benchmark) | Tool p50 under 10 s with an equivalent contradiction/cluster outcome on replay | Revert |

**Instrumentation gaps** (addressed by S0):
- provider TTFT;
- pre-insert admission;
- preflight outcome and duration;
- `prepareStep`;
- salvage fire and duration;
- the tail after the last step;
- Z.AI `cached_tokens`;
- request mode;
- a run id on `messages` and `tool_usage_log`, needed to attribute rows under overlap;
- client TTFB, first visible text, stream close and render cost (a small client beacon: `performance.mark` + one insert per run).

Also: killed runs write **no** step rows today (they are buffered until `finish()`), so the slowest runs are under-represented in every figure above.

---

## 9. Benchmark plan

Nothing here has been executed.

**Tasks** (sanitized fixtures only; start from the two canonical cases CLAUDE.md names, the collision case and the uncontaminated budget-exhaustion case; `src/dev/fixtures.json` is gitignored, so sanitize before use):
1. quick follow-up question;
2. new investigation;
3. Continue after partial collection;
4. verification of an existing finding;
5. final report.

**Tier 1 — offline, model-only replay** (no live tools, no case PII sent anywhere new):
- Record tool responses once from the existing `tool_call_cache` or `tool_usage_log` payloads for the sanitized fixtures. The replay harness answers tool calls deterministically from that recording, and unknown calls return a fixed "not recorded".
- Hold constant: tools exposed, budgets (22 steps / 180 s / 36 calls), system prompt, and the input messages.
- **Metrics:**
  - TTFT;
  - time to first answer token;
  - total duration;
  - steps;
  - output tokens;
  - tool-selection match against a reference set;
  - tool-argument validity (zod parse rate);
  - unsupported claims (claims with no persisted artifact backing);
  - quarantine and identity-boundary violations (existing `unproven-linkage` / `isClusterIneligible` checks);
  - report readiness (`hasReportShape` plus `meetsCompletionContract`);
  - cost from returned usage.
- **Runs:** 5 tasks × 3 fixtures × 3 repetitions = 45 runs per model. At the medians above that is about 18M input tokens per model: roughly $26 uncached for GLM-5.2, and $1–$40 per candidate by the table.
- **Needs approval:** the exact models, N, a spending ceiling (suggested ≤ $150 total for 4 candidates plus baseline), and data handling (sanitized fixtures only; ZDR where offered).

**Tier 2 — live end-to-end:**
- 2 benign seeds (`example.com`-class) × 5 tasks × the top 2 models.
- Live tools billed; this is a paid scan, so separate approval is required.

**Offline first:** the replay harness, the scoring code and the client harness extensions can be built and validated against GLM-5.2 recordings before any new model is called:
- a 30 KB streamed report at 13 ms per token;
- artifact INSERT bursts;
- 15 s heartbeats;
- a 500-artifact snapshot.

---

## 10. What was verified, confidence, gaps, next measurements

**Verified directly by this session:**
- live `/health`;
- git, ledger and mirror state;
- Vercel production deployment;
- 12 production SQL aggregates;
- AI SDK and openai-compatible package source;
- the code paths cited with line numbers without †;
- the Z.AI and Anthropic doc claims (spot-checked).

**From delegated code traces, not individually re-read** (marked †): most `auth.ts`, `cache.ts`, `lib/cluster.ts`, client refresh and hook line references.

**Overall confidence:**
- High that the model is not the main bottleneck.
- High on F1, F3 and F5 (code).
- Medium on the F4 attribution.
- Low on client render cost (unprofiled).

**Gaps:**
- no TTFT;
- no client-side timings;
- salvage and preflight only in console logs;
- Supabase edge logs not accessible from this session;
- Z.AI cache hit rate unknown;
- request type is inferred from prompt text;
- recovery requests are indistinguishable;
- the durable window is 19 days (n=231);
- one `/health` latency sample.

**Correction to the approved checklist:** it described `/health` as "free, no LLM call". It is not. Each GET makes a 4-token paid ping to Z.AI, plus MiniMax when that has not answered within 60 s. This audit made **one** such call and deliberately did not repeat it.

**Next measurements, in order:**
1. S0 telemetry for 7 days.
2. The `cached_tokens` rate.
3. Preflight outcome distribution.
4. Salvage frequency by request type.
5. Client beacon for first visible text.
6. Harness CPU profile.
