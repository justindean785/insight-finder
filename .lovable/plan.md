## TL;DR

The 10-minute investigations and dead-tool calls **are already fixed in the repo** — the fixes just aren't live. The deployed `osint-agent` still reports `build:d026c04` (2026-07-03), but 5 PRs merged after that stamp (#46, #47, #48, #49, #51) contain exactly the perf, timeout, readiness-gate, and fallback-model fixes you need. Because `build-info.ts` was never re-stamped after those merges, Lovable's auto-deploy pipeline didn't treat the function as changed and the old build stayed live.

Fix is a one-line stamp bump to force redeploy, then verify `/health` returns the new marker. Separately, this plan lists the remaining beta-readiness gaps the audit surfaced so nothing gets lost.

---

## Evidence

**Deployed vs. source drift**

- `curl .../osint-agent?health=1` → `build:"d026c04"`, stamped `2026-07-03`.
- `git log b9dcc6e..HEAD -- supabase/functions/osint-agent/` → 5 merged PRs since that stamp, none re-ran `scripts/stamp-build.mjs`.

**What those 5 PRs actually contain (matches your reported symptoms 1:1):**

| PR | Fixes symptom |
|----|--------------|
| **#46** perf/hardening | 6-min wall-clock deadline + 30-step cap (kills 10-min runs); **readiness gate deletes keyless/disabled/gated tools from the schema before the model sees them** (kills dead-tool calls at the source); per-tool timeout caps on `gemini_deep_dork` (12s), `deepfind_reverse_email` (8s), `jina_reader_scrape` (8s); unknown-tool guard; fallback repointed off the 403-ing `google/gemini-2.5-pro` to a Flash-class model. |
| **#47** | 90s idle-timeout wired into all four LLM providers (`createIdleTimeoutFetch`) — stops orchestrator stream from hanging forever on stalled providers. SSN minor-safety FP + Serus phone E.164 fixes. |
| **#48** | Stop-button actually aborts (widens `threads.status` CHECK to allow `'stopped'`); O(n) message-budget; cost-parity entries for `coverage_audit`/`detect_contradictions`/`tool_audit`/`record_finding`/`unknown_tool_ignored`. |
| **#49, #51** | Name/location conflict folding — stops the "different people" −25 penalty from firing on nickname/initial/city-state variants. |

`grep` confirms all this code is present in the working tree (`ORCHESTRATOR_WALL_CLOCK_MS = 6 * 60_000` in `orchestrator-budget.ts:49`, `readiness-gate` in `index.ts:298`, `createIdleTimeoutFetch` in `env.ts:39`). It is simply not deployed.

**Why the deployed function still calls "dead" tools:** the readiness gate (PR #46, Phase B1) is what removes keyless/disabled providers from the tool schema the model sees. Without it live, the planner still proposes `firecrawl_*`, `intelbase_email_lookup` (gated off), and other disabled tools, then they return `{ skipped: true }` and show as "failed" in the timeline. Live deploy = symptom gone.

---

## Fix

### Step 1 — Force redeploy by re-stamping build-info (the only code change)

Edit `supabase/functions/osint-agent/build-info.ts` to reflect the current HEAD (`64dc33b`):

```ts
export const BUILD_MARKER = "64dc33b";
export const BUILD_COMMITTED_AT = "2026-07-04T00:00:00-07:00";
```

This is exactly what `scripts/stamp-build.mjs` produces and matches the pattern used by every prior `sync(...)` PR. Lovable's auto-deploy watches file mtimes/hashes inside `supabase/functions/**`; touching `build-info.ts` is what actually promotes the function.

### Step 2 — Verify

`curl "https://skzqwbyvmwqarfgfvyky.supabase.co/functions/v1/osint-agent?health=1"` should return `"build":"64dc33b"`. If it does, symptoms 1 and 2 (10-min hangs, dead-tool calls) are resolved live.

---

## Remaining beta-readiness gaps (surfaced by the audit — not fixed in this plan)

These are real, but distinct from the deploy problem. Flagged for your call before build mode:

1. **Pivot / planner ranking is correct in code but has one blind spot.** `graph_pivots.ts` + `playbooks.ts` correctly cheapest-first, drop dead-ends, cap premium re-confirms, and route by seed type. Gap: the planner's `toolList` (system prompt) is what the LLM picks from, and the readiness gate only prunes the *schema*. If the planner prompt still names a tool that got readiness-gated, the LLM will keep suggesting it and get repaired to the internal sink. Low-severity, but worth a follow-up: filter `toolList` through the same readiness check.
2. **Status taxonomy — "skipped/unavailable" still renders as red "failed"** (BETA_FINDINGS.md §B). Backend already distinguishes via `isFreeCall`; frontend `ChatWindow.tsx` timeline collapses both to failed. Cross-lane, needs a UI change to add a third chip state. This is why the board *looks* full of failures even when the run is healthy.
3. **Evidence-integrity items** (BETA_FINDINGS.md §C): confidence-vs-corroboration inconsistency; famous-name collision (Adrian Broner → Adrien Broner) not flagged; whois existence elevating linkage confidence. Sign-off-gated, not touched here.
4. **Duplicate secret entries** in the Cloud dashboard (`IPGEOLOCATION_API_KEY`, `VIRUSTOTAL_API_KEY`, `LEAKCHECK_API_KEY`, `STOLENTAX_API_KEY`, `INTELBASE_API_KEY` each appear twice, dated May 27). User action: de-dupe in Backend → Secrets.
5. **`INTELBASE_ENABLED` is unset**, so `intelbase_email_lookup` stays gated even though the key is present. If you want intelbase live, add that secret; otherwise it correctly stays disabled.
6. **`index.ts` still 3,854 LOC monolith** (Beta Readiness Audit BLOCKER-2). P1, not a runtime issue, defer past limited beta.

---

## Files touched

- `supabase/functions/osint-agent/build-info.ts` — 2-line bump. Nothing else.

## Non-goals

- No feature code changes to osint-agent.
- No frontend changes.
- No migration changes.
- No secret changes (user's call whether to add `INTELBASE_ENABLED` or de-dupe secrets).
