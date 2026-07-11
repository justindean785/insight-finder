# Fix Plan — thread 92a7d650 truncation + message bloat

Status: **planning doc for review**. Fix C implemented under this plan (PR on `main`, not merged/deployed); Fix B and Fix A are separate future sessions, each gated on the prior landing clean.

## Scope & non-goals
Three fixes for two confirmed, independent defects. **Nothing here touches cluster/confidence/migration/evidence-integrity logic.**

Diagnosis (confirmed + independently re-verified against live CSV export of thread 92a7d650):
- **Root cause of truncation:** `ORCHESTRATOR_WALL_CLOCK_MS` (240s) hard deadline trips at a tool-step boundary. The forced-finalize reserve (`shouldForceFinalize`, meant to fire at 195s, `orchestrator-finalize.ts:52-61`) is only evaluated at step boundaries (`prepareStep`); a single long step that spans from <195s to >240s jumps the reserve window entirely, so the hard-deadline `stopWhen` fires mid-tool-chain and no synthesis step ever runs.
- Confirmed on two independent turns (267s and 261s wall clock, both well under the 22-step cap). On both, the assistant message persisted within ~115ms of the last tool call completing — regardless of whether that call succeeded (`record_artifacts`) or failed (`minimax_correlate` timeout). **Correlate is a confirmed red herring** — one truncated turn has zero correlate calls.
- **Salvage backstop gap:** `needsReportSalvage` (`orchestrator-finalize.ts:129-132`) fires only when the last assistant message's concatenated text is <200 chars (`MIN_REPORT_CHARS`). One truncated turn had 11,605 chars of text — all `<think>` reasoning + inter-step narration, zero report — so the gate passed and salvage never ran.
- **Separate storage defect:** persisted messages embed full raw tool input/output JSON (intentional, for UI tool-replay per `ChatWindow.tsx:441-450`). One 704,926-char message is ~86% a single unbounded `socialfetch_lookup` payload (`output.data` = 605,987 bytes). `capPartsSize` (`index.ts:862`, `safety.ts:229-252`) is meant to guard this but is inert — it only triggers above 3.5MB, and even then matches the wrong part-type strings (`"tool-result"`/`"tool-call"`, which are ModelMessage types; persisted UIMessage parts are `tool-<name>`/`dynamic-tool`). This does NOT compound into the next turn's prompt (the compaction pipeline crushes it to the 220k budget on re-entry) — it's storage/replay hygiene plus a future 2MB request-body 413 time-bomb, not what kills synthesis.

---

## Fix C — Cap oversized tool-output on persist *(ship first: smallest, safest)*

**Mechanism:** Add a per-part output cap applied just before the `messages.insert` (`index.ts` ~863), independent of `capPartsSize`'s whole-blob threshold. For every part whose `type` starts with `tool-` (or `=== "dynamic-tool"`), run its `output` and `input` through `sanitizeToolOutput` (`safety.ts:176`) — mirroring the cache-path pattern at `index.ts:910` — but only when that field's serialized size exceeds a threshold, so small outputs pass through byte-identical. Also fix `capPartsSize`'s part-type strings so its 3.5MB whole-message backstop actually engages (do **not** change the 3.5MB threshold itself — only the type matching).

**Files/functions:** `safety.ts` (new `capToolPartPayloads`; fix `capPartsSize` type strings; reuse `sanitizeToolOutput`), `index.ts` (persist block ~858-868).

**What could go wrong / test:**
- UI tool-replay (`ChatWindow.tsx:441-450`) reads full `part.input`/`part.output` — after truncation it shows clipped blobs. Part shape (keys/types) preserved; only oversized string/array values shrink. Acceptable for a 600KB raw dump.
- Test: real `last_scan_messages_full.csv` message [13] — the 606KB part must shrink, total message must drop well under 2MB, and small tool outputs must be byte-identical.

**Risk: LOW.** Pure persist-side transform. No runtime/loop/evidence behavior change. Independent of A/B.

---

## Fix B — Salvage gate detects "no report," not "<200 chars" *(ship second: the safety net)*

**Mechanism (as originally drafted):** strip `<think>…</think>` (and unclosed `<think>` to end) before measuring, and/or check for report-shaped structure (finding labels / summary-findings-gaps shape) rather than raw character count. **⚠️ See "Verification results" below — the strip-`<think>` + length approach is confirmed INSUFFICIENT; a positive report-structure signal is mandatory, not optional.**

**Files/functions:** `orchestrator-finalize.ts` (`extractAssistantReportText`, `needsReportSalvage`, `MIN_REPORT_CHARS`).

**What could go wrong / test:** false-positive salvage (wasted `generateText` cost/latency); false-negative (still misses). Golden-data test set: all assistant messages in the export — the two truncated turns must trigger salvage; the healthy turns that produced reports must not.

**Risk: MEDIUM.** Contained to pure functions with a real golden-data test set. Load-bearing guarantee — with B reliable, a jumped finalize-reserve still yields a report post-loop (caveat: salvage runs a fresh `generateText` after an already ~240s+ turn, consuming platform wall-clock — B reduces misses but A is still needed).

---

## Fix A — Finalize-reserve robust to a single long step *(ship last: highest risk)*

**Options:**
- **A1 — Widen reserve:** raise `FINALIZE_RESERVE_MS` (45s → ~75–90s) so the reserve window exceeds any plausible single step. Necessary but not sufficient alone.
- **A2 — Deadline triggers finalize, not hard-stop (recommended core):** remove the 240s hard `stopWhen`; let `shouldForceFinalize` (earlier trigger) be the primary path, with a much higher absolute ceiling as the only true hard stop, giving a forced-finalize step room to run. **Verified expressible** — see below.
- **A3 — Mid-step tripwire:** check elapsed inside the tool wrapper; once past reserve, refuse *new* tool calls so the current step ends and the next boundary forces finalize. Most invasive; interacts with #284/#300. (SDK also exposes a native `stepTimeout` — evaluate in the Fix A session.)

**Recommended:** A1 + A2, keep A3 in reserve.

**Tradeoff:** forcing finalize generates the report (≤`ORCHESTRATOR_MAX_OUTPUT_TOKENS`=8192) with tools restricted to `record_artifacts` — bounded by model generation (~10–40s), not tool fan-out, but not instant. The absolute ceiling must leave that runway above the finalize trigger.

**Files/functions:** `orchestrator-budget.ts` (`ORCHESTRATOR_WALL_CLOCK_MS`, new absolute-ceiling constant), `orchestrator-finalize.ts` (`FINALIZE_RESERVE_MS`, `shouldForceFinalize`), `index.ts` (`stopWhen` 722-726, `orchestratorDeadlineReached`); if A3: `cache.ts` (`wrapToolsWithCache`).

**Risk: HIGH.** Core loop timing; platform-limit- and SDK-semantics-dependent; interacts with #284/#300 (correlate 30s cap, AbortSignal forwarding).

---

## Ordering / dependencies

```
C  ──(independent, ship first: kills the 2MB body bomb)
B  ──(reliable safety net)──►  A  (loop optimization, de-risked by B)
```
- C independent, ship first.
- B before A — B makes post-loop salvage reliable; A built on a working B is an optimization, not a load-bearing fix.

## Complexity / risk ranking (safest → riskiest)
1. **Fix C** — LOW. Persist-side only; golden-data testable; no behavior change.
2. **Fix B** — MEDIUM. Two pure functions; CSV golden set; main risk is false-positive salvage cost.
3. **Fix A** — HIGH. Core loop timing; platform-limit- and SDK-semantics-dependent; interacts with #284/#300.

---

## Open uncertainties — verify against live code/data before implementing

1. **Supabase edge-function wall-clock/CPU ceiling for this project** (HIGH, blocks A2's ceiling choice and bounds salvage headroom). Not confirmed from the code; needs the platform config / a live long-run observation. **Supabase's own documentation conflicts on the actual execution ceiling (60s / 150s idle / 400s worker-lifetime across different doc pages, with real-world reports of failures near 200s despite the 400s figure). Do not pick Fix A's absolute ceiling from documentation — resolve via a deliberate live test before implementing A.**
2. **ai@6 `stopWhen`-vs-`prepareStep` ordering** (MEDIUM-HIGH for A) — whether `prepareStep` can guarantee one finalize step before a stop condition ends the loop. **RESOLVED — see Verification results.**
3. **Whether MiniMax emits report text outside `<think>`, and whether `<think>` is well-formed** (MEDIUM for B). **RESOLVED — see Verification results; contradicts the drafted Fix B mechanism.**
4. **Exact `socialfetch_lookup` output shape** — where the 606KB lives. **RESOLVED — `output.data` = 605,987 bytes; `input` = 64 bytes.**
5. **`FINALIZE_ACTIVE_TOOLS = ["record_artifacts"]` sufficiency** — confirm the finalize step can't launch a slow tool (LOW).

---

## Verification results (this session — read-only, no code)

**Uncertainty #2 — ai@6 `stopWhen`/`prepareStep` ordering — RESOLVED, validates Fix A2.**
- Installed SDK: `ai@6.0.206` (spec `^6.0.191`). The `streamText` agent loop is a recursive `streamStep` (`node_modules/ai/dist/index.mjs`): `prepareStep` runs at the **start** of a step (~line 7502); `isStopConditionMet` is evaluated **after** the step completes to gate whether the next `streamStep` recurses (~lines 7952-7970: `if (hasToolCalls && !await isStopConditionMet(...)) streamStep(currentStep+1)`).
- **Answer:** `prepareStep` **cannot** inject a finalize step past a stop condition — if a `stopWhen` condition is met after step N, step N+1 (and its `prepareStep`) never run. This exactly confirms the diagnosis mechanism, and means Fix A2 (removing the 240s from `stopWhen` so `shouldForceFinalize` in `prepareStep` can force a finalize step at the next boundary, with only `finalizeStepsRun`/a high absolute ceiling as hard stops) is the **correct and necessary** approach — not merely optional. Bonus: the SDK exposes a native per-step `stepTimeout` (relevant to A3).

**Uncertainty #3 — `<think>` well-formedness / report location — RESOLVED, CONTRADICTS the drafted Fix B mechanism.**
- Analyzed **all** assistant messages in the export (7 turns). `<think>` tags are **well-formed/balanced in every sample** (no unclosed `<think>`) — so the "strip unclosed `<think>` to end" branch is moot.
- **The drafted strip-`<think>`-then-length approach is INSUFFICIENT.** After stripping `<think>`, the two truncated turns still have **526 and 1114 chars** of non-`<think>` text — both **above** the 200-char threshold — so strip-then-length would STILL fail to trigger salvage. That residual is **inter-step narration** ("Going deeper — …", "Recording now and diving into…"), not a report.
- The real discriminator: healthy turns emit a **structured final report** (e.g. `## 🕵️ Investigation Report — Final`, a `| # | Finding | Source | Tier |` findings table, `[CONFIRMED]`/`[VERIFY]` labels, `Confidence: N%`); truncated turns have only running narration. **Fix B must use a positive report-structure signal (report header / findings table / tier labels), not strip-`<think>` + length.** The "positive signal" option in the drafted plan is therefore **mandatory, not optional**. This does not gate Fix C.
