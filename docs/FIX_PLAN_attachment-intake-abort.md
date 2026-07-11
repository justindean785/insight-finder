# Fix Plan — attachment-intake abort (`The signal has been aborted`)

Status: **PR α IMPLEMENTED** (branch `fix/attachment-intake-abort`, PR open, NOT merged/
deployed — JD gates the merge+deploy, same as A/B/C). **PR β still PLAN-only** (gated on the
`thinkingConfig` doc check, V2 below). Diagnosis: memory
`insight-finder-attachment-intake-abort.md`. Verified against `origin/main` @ 8cbc34b
(post-deploy; carries build `4692afa` fixes).

> **Scope bump discovered during implementation:** `geminiVision`'s sibling
> `geminiGroundedSearch` (`providers.ts`) is a byte-identical `try/finally`-no-catch with the
> same 60s timeout → the same uncaught-abort bug on the orchestrator's grounded-search path.
> Rather than ship the fix for one twin and knowingly leave the other, PR α applies the
> identical defensive catch to BOTH. Same category, no success-path behavior change.

Live symptom: `[attachment-intake] error: The signal has been aborted` on a 788KB
multi-page PDF (thread `44e35007`, 2026-07-11). Orchestrator then reasons WITHOUT the
PDF, silently; that run only recovered because the model happened to call
`jina_reader_scrape` on the signed URL.

---

## Root cause (confirmed against source)

Uncaught `AbortError` from a doc-read that exceeds Gemini's 60s timeout, propagating up
through a call chain that has no `catch` until the very top:

1. `providers.ts:457` — `geminiVision` sets `setTimeout(() => ctrl.abort(), 60000)` and
   wraps the fetch in `try { … } finally { clearTimeout }` — **no `catch`**. On timeout
   `fetchRetry` rejects `AbortError`, which passes straight through `finally`.
2. `tools/gemini_vision.ts:219` — `runGeminiVision` does `const res = await geminiVision(…)`
   with **no try/catch**. Its `if (!res.ok)` branch only handles *graceful* failures, so
   the throw sails past it.
3. `attachment-intake.ts:124` — files are read via **`Promise.all`**. Promise.all is
   fail-fast: one file's `AbortError` rejects the WHOLE batch.
4. `attachment-intake.ts:214` — top-level `try/catch` logs `[attachment-intake] error:`
   and returns `empty`. The orchestrator proceeds with no attachment context and no signal.

Two consequences beyond the single-file timeout:
- **Amplification:** with 2+ attachments, one slow file loses *all* of them (Promise.all).
- **Blindness:** the `attachment_intake_skip` trace (added in #302) fires only on the
  graceful `!vis.ok` path — the *throw* bypasses it, so even the intended telemetry misses
  this failure mode.

Not a `fetchBytes` issue: its 25s storage-fetch timeout IS caught (`gemini_vision.ts:123`)
and returns a clean `{ok:false}`. The uncaught path is specifically the Gemini
*generateContent processing* timeout.

---

## Why 60s is hit (the trigger)

788KB is far under the 18MB `MAX_VISION_BYTES` cap — this is a **processing-time**
ceiling, not a size one. `gemini-2.5-flash` is a *thinking* model; on a multi-page PDF the
think+extract pass exceeded 60s. Extraction is not a reasoning task, so the thinking budget
is largely wasted latency here.

**Latency constraint (load-bearing — do not violate):** intake is `await`ed at
`index.ts:584`, before `baseSystemPrompt` assembly, i.e. it is on the path to first token
(TTFT = `max(intake, preflight)`, preflight ≈ 24s). #302 exists precisely to keep TTFT low.
Therefore **raising the doc-read timeout is the wrong primary lever** — it moves worst-case
TTFT toward the new ceiling. The primary lever must *reduce* processing time.

---

## Fix components

### Fix 1 — Catch the throw at the provider layer  *(the actual bug; do this one first)*
Add a `catch` to `geminiVision` (`providers.ts`) that returns the SAME `{ok:false, status:0,
text:"", citations:[], queries:[], raw:{error}}` shape it already returns when
`GEMINI_API_KEY` is missing — so the contract is unchanged, just extended to the abort case.
Distinguish `err.name === "AbortError"` → `error: "gemini vision timed out (60s)"` from other
errors.
- **Blast radius (V3):** exactly one caller outside `providers.ts` — `runGeminiVision` —
  which already handles `{ok:false}`. Returning a handled failure is strictly safer for it
  than an exception. No reverse-image or orchestrator path bypasses this.
- **Free win:** with `res.ok===false`, `runGeminiVision` returns its structured failure,
  which makes attachment-intake's existing `attachment_intake_skip` trace fire on abort —
  closing the telemetry blind spot at no extra cost.
- Siblings: the two Gemini *text* providers in `providers.ts` (~:210, ~:352) share the same
  `try/finally`-no-catch shape. Out of scope for this fix, but note them for a follow-up.

### Fix 2 — Isolate per-file failures  *(amplifier)*
`attachment-intake.ts:124`: replace `Promise.all` with per-file isolation so one file can't
sink the batch. Either `Promise.allSettled`, or wrap each per-file body in its own try/catch
that returns the skip `out`. With Fix 1 in place this is defense-in-depth (runGeminiVision no
longer throws), but it hardens against any future throw in the per-file path. Small, low-risk.

### Fix 3 — Cut doc-read processing time  *(the trigger; primary latency lever)*
Reduce the Gemini think time on document extraction instead of raising the timeout.
- **Primary:** disable / minimize thinking for doc mode via `thinkingConfig` in
  `visionGenerationConfig` (doc branch only — leave image/grounding untouched).
  ⚠️ **VERIFY BEFORE CODING (V2, open):** the exact `thinkingConfig` field name and the
  value that disables thinking for `gemini-2.5-flash` on the REST `v1beta:generateContent`
  endpoint — confirm against current Gemini API docs, do NOT assert from memory. If thinking
  cannot be disabled on this SKU, fall back to a lower-latency vision model for doc mode.
- **Belt-and-suspenders only:** a *modest* doc-mode timeout (e.g. 75–90s) so a read that's
  nearly done isn't killed — accept the bounded TTFT cost. Keep image mode at 60s.
- **Deferred:** size/page-gate very large PDFs straight to `jina_reader_scrape` (jina on PDFs
  is itself unreliable — better as an explicit fallback than a primary path).

### Fix 4 — Stop the silent degrade  *(recovery, not luck)*
When a *document* intake fails, inject an explicit line into `baseSystemPrompt` naming the
file + URL and instructing the model to read it itself (`jina_reader_scrape`, or retry
`gemini_vision`) before answering. Converts today's luck-dependent recovery into an
instructed one. Low risk, high value; pairs with Fix 1 (which now surfaces the failure).

### Deferred (separate observability pass, not this PR)
- Record intake outcomes to `tool_health`. Intake calls `runGeminiVision` directly, bypassing
  `wrapToolsWithCache`/`tool_usage_log`, so it's invisible to health rollups. Fix 1 restores
  the *log* trace; a proper `tool_health` row is a larger change — defer.

---

## Sequencing / PRs
- **PR α (safety):** Fix 1 + Fix 2 + Fix 4. Pure hardening — no API-behavior change, no new
  latency. Ships the silent-failure fix and restores visibility. Can land independently.
- **PR β (latency):** Fix 3, gated on V2. Touches Gemini request behavior → verify on a live
  PDF via the `attachment_intake_read` / `_skip` traces before/after.

## Open verification items (do before/within implementation)
- **V2 (blocks PR β):** confirm `thinkingConfig` field + disable-value for gemini-2.5-flash
  on v1beta generateContent — from live docs, not memory.
- **Live repro (blocks "done"):** re-run the Moneyflyoften.pdf case (or any multi-page PDF)
  post-fix; confirm `attachment_intake_read` with non-empty `extracted_chars`, no
  `[attachment-intake] error:` line, and TTFT not regressed.

## Out of scope (explicit)
Cluster / confidence / migration / evidence-integrity logic — untouched. This is a plan only;
no code changes until JD signs off (same gate A/B/C had).

## Provenance
Verified against `origin/main` @ 8cbc34b: `geminiVision` `providers.ts:417` (timer :457,
`try/finally` no catch); `runGeminiVision` call `tools/gemini_vision.ts:219`; intake
`Promise.all` `attachment-intake.ts:124`, top catch `:214`; intake await-point
`index.ts:584`. Related: [[insight-finder-attachment-intake-abort]],
`docs/FIX_PLAN_thread-92a7d650.md`.
