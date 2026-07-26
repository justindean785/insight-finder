# Incident 2026-07-26 — ghost recovery (P0-A) + premature termination (P0-B)

**Status:** fix implemented on `claude/new-session-k2g0ua`, **NOT deployed**.
**Deployed build at time of incident:** `e8313e5` (= canonical `main` `601ab40`). No deploy drift — production was exactly what `main` said it was.
**Diagnosis basis:** production row-level forensics (Supabase `skzqwbyvmwqarfgfvyky`) + source, not screenshots.

---

## 1. Deployed lineage (verified)

| Layer | Value | How verified |
|---|---|---|
| Canonical `main` | `601ab40` (stamps `e8313e5`) | `git fetch origin main` |
| Lovable mirror | `BUILD_MARKER "e8313e5"` | Lovable `read_file` |
| **Deployed `/health`** | `build: "e8313e5"`, `ok:true` | server-side fetch |
| Provider | `deepseek` / `deepseek-v4-pro` (pinned); minimax = fallback | `/health` |

Live switches: `FORCE_TOOL_CALL_UNTIL_FINALIZE=false`, `ORCHESTRATOR_WALL_CLOCK_MS=180_000`, `FINALIZE_RESERVE_MS=90_000`, `MAX_ORCHESTRATOR_STEPS=22`, `MAX_TOOL_CALLS_PER_RUN=36`.

---

## 2. P0-A — ghost recovery of a never-started thread

Thread `40f8a6eb-e0e6-4cbc-b0fe-e609f6acb72c`.

| UTC | Event |
|---|---|
| `00:19:10.207` | Thread INSERT. `status='active'`, `title='New investigation'`, `run_started_at` NULL, `last_heartbeat_at` NULL |
| `~00:19:10` | ChatWindow mount sweep → declined (0s stale) |
| `~00:19:40` | +30s sweep → declined (30s < 75s) |
| `~00:20:40` | **+90s trailing sweep** → `GET ?health=1` → `recoverStaleActiveThreads` |
| `00:20:43.070` | Assistant message inserted: "Findings report — recovered run … Last heartbeat was not recorded … No confirmed artifacts" |
| `00:20:43` | `status='finished'` → UI shows COMPLETE |
| `13:58:23.959` | **First user message — 13h38m later** |

Δ create→recovery = **92.86 s**.

### Root cause (three links)
1. `WorkspaceHeader.createInvestigation` inserts only `user_id` → DB default `status='active'`. A blank thread is born looking like a live run.
2. `isStaleActiveThread` falls back to `updated_at` when `last_heartbeat_at` is NULL → at +90s a never-started thread reads as a 90s-dead run (`STALE_RUN_AFTER_MS=75_000`).
3. `shouldInsertRecoveredAssistant` returns `{shouldInsert:true, reason:"no_assistant"}` on its **first branch** when no assistant message exists. A blank thread is the maximally recovery-eligible state in the function.

### Blast radius
- **14 threads** carry a "recovered run" message with **no preceding user message**, recurring since 2026-07-15.
- **192 of 264 threads** had `run_started_at IS NULL` — all eligible.
- `recovered_at`/`recovery_reason` read NULL afterwards because `markRunStarted` nulls both on the next run start. **Absence of those columns is not evidence against recovery.**

### Ruled out
Thread-id reuse, cross-thread realtime leakage, cross-thread counts. All rows share one `thread_id`; `recovery.ts` writes by `thread.id`.

---

## 3. P0-B — COMPLETE on unfinished narration

Two distinct stops; only one is unrecoverable.

### B1 — the hard defect
`13:58:37` user `jdean785` → `13:58:39.006` assistant persisted as **final**: `[step-start, {text:"I'll start", state:"streaming"}]` — **10 characters** → `status='finished'` → COMPLETE.

- With `FORCE_TOOL_CALL_UNTIL_FINALIZE=false`, `toolChoice` is `"auto"` on every intermediate step, so `streamText` stopped naturally on `finishReason:"stop"` at step 1.
- **`stopWhen` cannot prevent this** — it only ADDS stop conditions; the SDK's natural stop is not vetoable.
- The salvage backstop **could not fire by construction**: `needsReportSalvage` began `if (toolCalls <= 0) return false;` and no `tool-*` part existed yet. The backstop was blind to exactly this failure mode.

### B2 — the transient
Messages `22b5f503` / `00cb940c` each end in a stateless text part (4642 / 5260 chars) — the signature of the salvage append. Salvage fired; the reports are durable. The screenshot caught the window between stream close and the salvage insert.

### Contributing factors (evidenced)
- **Overlapping runs on one thread** — repeated `go` started concurrent invocations sharing `status`/`run_started_at`/heartbeat. `markRunStarted` is last-writer-wins; no run-boundary guard.
- **Heartbeat died 3.5s into a 138s run** — a concurrent invocation's `heartbeat.stop()` silenced it while the run was alive.
- **Mixed counter scope** — `extractAssistantReportText` reads only the last assistant; `countRecordArtifactCalls` counts across the entire thread history.
- **`onError` writes green COMPLETE** — `status:'finished'` + `recovery_reason:'stream_error: …'`, but the UI consumed `recovery_reason` only in `shouldAbortClientStream`. Nothing rendered an interrupted state.

---

## 4. Invariants that failed

> **I-1 (recovery eligibility).** A thread may be recovered as an interrupted investigation only if a run actually started on it.

> **I-2 (terminal persistence contract).** `status='finished'` may present as complete only when a durable report-shaped assistant message exists, or an explicit validated no-findings decision.

---

## 5. The fix

| # | Change | Kill switch |
|---|---|---|
| A | `recovery.ts` — `hasRunMarker()` gate; sweeper query mirrors it (never-started threads were also filling the LIMIT-20 budget and starving real dead runs) | `REQUIRE_RUN_MARKER_FOR_RECOVERY` |
| A′ | `ChatWindow.tsx` — a thread with no messages and no run never fires the health sweep | — |
| B | `orchestrator-budget.ts` — **opening-phase** tool gate: force a tool call only while the run has admitted **zero** tool calls AND the latest user message parses as a seed. Releases the instant work starts | `REQUIRE_TOOL_CALL_IN_OPENING_PHASE` |
| B′ | `orchestrator-finalize.ts` — drop the `toolCalls<=0` bail; classify by phase (tool calls or artifacts), length floor, and explicit no-findings decision | `SALVAGE_ON_ZERO_TOOL_CALLS` |
| C | `index.ts` — `meetsCompletionContract()` gates the terminal write; unmet → `recovery_reason=INCOMPLETE_RUN_REASON` | — |
| D | `WorkspaceHeader.tsx` — `deriveWorkspaceStatus` returns `"interrupted"`; amber chip, never green COMPLETE | — |

### Why B is NOT the 07-21 forcing regression
`FORCE_TOOL_CALL_UNTIL_FINALIZE` forced a tool call on **every** intermediate step, removing the model's only natural exit (self-completion 61%→25%). The opening gate applies to the **opening step only** and releases as soon as any tool is admitted, so the natural text-only report exit is fully preserved. Pinned by `intermediate_step_plan_test.ts`.

### Deliberately NOT implemented
A "future-intent narration" regex. It was written and its own unit test killed it: the pattern also matches the legitimate closing line *"Drop a seed and I'll run the investigation from TRIAGE through REPORT."* A false positive staples a fabricated Findings report onto a plain answer — worse than the bug being fixed. Intent is not inferred from prose; unclassifiable cases fall through to the completion contract and are labelled Interrupted.

---

## 6. Count semantics — one real bug

| Surface | Definition | Scope |
|---|---|---|
| Header "N evidence" | `evidence_log` rows, chain-verified | thread |
| Evidence tab badge | `artifacts` rows | thread |
| Header "N tools" + Tools badge | `COUNT(tool_usage_log)` (same value, one source) | thread |
| Activity "shown/succeeded/skipped" | rows minus hidden failures / ok+empty / skipped | thread |

All four are **thread-scoped**; none is run-scoped. Header and badge never disagreed with each other — they share one value. The bug is that value **freezing** (31 while the DB held 74) when the long-lived realtime subscription drops events mid-run; the Tools tab reloads on mount and reads the truth.

### Separate integrity gap (NOT fixed here — needs sign-off)
Chain-of-custody coverage is a minority of artifacts:
- thread `40f8a6eb`: 20 `evidence_log` rows / 56 artifacts
- thread `01b9567f`: 9 `evidence_log` rows / 35 artifacts, and **0 artifacts join to an `evidence_log` row via `artifact_id`**

Also: a single `github_code_search` produced **25 of 35** artifacts on `01b9567f` — the "evidence overload" symptom is one tool's fan-out, not the collector generally.

---

## 7. Verification

**Baseline (untouched `main`)** → **after fix**:
- `npm run typecheck` — clean → clean
- `npx vitest run` — 1099 passed / 1 skipped → **1104 passed / 1 skipped** (90 files)
- Edge (JSR-free subset, 72 of 100 files) — 637 passed / 0 failed → **647 passed / 0 failed**

28 edge test files import `@std/assert` from `jsr.io`, which was blocked by egress policy this session. Deno itself was installed via `npm i -D deno@2` (registry.npmjs.org is allowlisted). **Those 28 files still need a run in an environment with `jsr.io` allowed.**

### Real-UI canary (post-deploy, JD-gated)
1. Brand-new blank thread, no prompt → wait >2 min → **0 messages, 0 artifacts, no recovered report**, still idle. Refresh and re-assert.
2. One seed → proceeds through tools to a report with **no manual `go`**.
3. A genuine final report ends naturally (not forced into another lookup).
4. A no-hit run finishes honestly without fabricating an artifact.
5. A failed/killed run renders **Interrupted**, never green COMPLETE.
6. `/health` shows the new build marker.

---

## 8. Deploy path (unchanged — a mirror merge is NOT a deploy)
1. Merge to `insight-finder` `main`.
2. `node scripts/stamp-build.mjs`, commit `build-info.ts`.
3. Surgical per-function `cp -R` sync to mirror `seeker-spark-search-5362c57c` (never blanket-overwrite).
4. **Explicit** Lovable deploy — project `4ce11bc3-039d-4439-b293-acacca9e1e3a`, `supabase--deploy_edge_functions` for `osint-agent`.
5. Verify `/health` `build` SHA **moved**. Only a moved SHA is proof.

---

## 9. Open / unproven
- **Not deployed.** The `fingerprint.to` run (thread `01b9567f`) that produced a clean report ran on `e8313e5` — it is evidence about current production, **not** a pass for this fix.
- Thread `01b9567f` started a new run at `14:41:51` with **no new user message** — a run began without a user turn. Unexplained; needs edge logs.
- Its persisted assistant message has **1 part** (4301 bytes) despite ~30 tool calls, i.e. the salvage path created the message rather than the stream. Worth confirming against `report_salvaged` logs.
- Source classification: first-party marketing copy labelled `CONFIRMED` at 85%. Needs a call on whether that is a classification or report-generation issue.
- No access to Supabase edge-function logs this session, so salvage-fired vs skipped is inferred from persisted part shape.
