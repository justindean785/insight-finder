---
name: osint-agent-audit
description: Audit the osint-agent edge function for observability, artifact quality, cost tracking, memory quality, and investigation stability weak spots. Use when the user asks for a "weak spot audit", reports flaky investigations, missing costs, duplicated artifacts/memories, or wants a pre-ship review of the agent.
---

# OSINT agent weak-spot audit

Audits `supabase/functions/osint-agent/index.ts` and its supporting tables (`tool_usage_log`, `agent_memory`, `artifacts`, `save_agent_memories` RPC). Goal: catch the five recurring failure modes before they corrupt an investigation.

## Five audit dimensions

Walk each dimension in order. For each: state PASS / FAIL / N/A with the file:line and a one-line fix.

### 1. Observability — every tool call leaves a trace

- Every `tool({ ... execute })` writes a row to `tool_usage_log` with `tool_name`, `cost_micro_usd`, `duration_ms`, `ok`, `cached`.
- Failed inserts to `tool_usage_log` log a warning, never throw.
- RLS on `tool_usage_log` allows the service-role insert path used by the edge function.
- `cost_micro_usd` is sourced from `costForTool(name)`, not hardcoded per call site.

Check: `rg "tool_usage_log" supabase/functions/osint-agent/` and confirm a single shared logging helper, not scattered inserts.

### 2. Artifact quality — no junk in the resources panel

- Scraped lists (friends, followers, search hits) are NOT recorded as one artifact per item. Threshold rule: if a single tool emits ≥10 candidates of the same kind, store them as one artifact with a `metadata.items` array, not 10 rows.
- Every `record_artifact` call sets `kind`, `value`, `confidence` (0–100), and `source` (the tool name).
- Duplicate `(thread_id, kind, value)` is deduped — either via DB unique index or in-process Set before insert.
- Artifacts have a real `source` tag — never empty string or `"agent"`.

### 3. Cost tracking — the sidebar $-figure is honest

- Every tool listed in the `tools` object has an entry in `costs.ts` `TOOL_COSTS_MICRO_USD`. Find missing ones: list tool names in `index.ts`, diff against keys in `costs.ts`.
- `threads.cost_micro_usd` is incremented atomically after each tool call (not at end of stream — partial costs must survive a timeout).
- Cached calls (`cached: true`) cost `0`, not the full price.
- Orchestrator LLM rounds also contribute (planner / correlate). Confirm `minimax_plan_pivots`, `minimax_correlate` have realistic smart-tier costs.

### 4. Memory quality — `agent_memory` doesn't bloat

- `save_agent_memories` RPC upserts on `(user_id, kind, subject)` — same triple updates one row, different `subject` creates a new row. Confirm via the unique index on `agent_memory(user_id, kind, subject)`.
- Duplicate content does NOT append repeatedly. The RPC keeps the longer content on conflict (current behavior — verify it's preserved).
- `related_values` is a deduped set, not a growing list with repeats.
- `subject` is normalized (`lower(trim(...))`) at write time, both in the RPC and the calling code.

### 5. Investigation stability — one bad tool can't kill the stream

- Every tool `execute` catches its own errors and returns `{ error }`. No `throw` inside `execute`.
- `streamText` has `stopWhen: stepCountIs(50)` (or higher) — not a low cap that truncates mid-investigation.
- `fetchRetry` is used for every external HTTP call. Bare `fetch` is a red flag.
- The orchestrator falls back to the Lovable AI Gateway (Gemini) when MiniMax context limit hits. Confirm `lovableGateway` + `FALLBACK_MODEL_ID` path is still wired.
- Missing API keys degrade gracefully — the tool returns `{ error: "X not configured" }` instead of throwing.

## Output format

Return a table:

| # | Dimension | Status | File:line | Fix |
|---|-----------|--------|-----------|-----|

Followed by:
- **Migrations needed** — list any SQL (indexes, RLS, RPC patches)
- **Code changes** — file-level edits
- **Smoke tests run** — what you executed against the deployed function
- **Follow-up** — anything you flagged but did not fix (with reason)

## Standard smoke tests

After fixes, run at minimum:

1. Username seed → confirm artifacts appear, dedup works, `tool_usage_log` populated, `cost_micro_usd` > 0.
2. Email seed → breach tools fire, memory row created/updated for the email subject.
3. Trigger a friends-list scrape → confirm it lands as ONE artifact with `metadata.items`, not 10+ rows.
4. Force a tool failure (bad key) → investigation continues, stream doesn't abort.
5. Re-run the same seed → cached tool calls log `cached: true, cost_micro_usd: 0`.

## Common findings

- New tools added without a `costs.ts` entry → silent undercount.
- `record_artifact` called inside a loop over scraped results → resources panel flooded.
- `save_agent_memories` called with un-normalized `subject` → duplicate rows.
- `tool_usage_log` insert wrapped in a `throw` path → one logging failure aborts the stream.
- Planner `toolList` out of sync with actual `tools` object → tools exist but never picked.