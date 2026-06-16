# Handoff - Insight Finder UI, Streaming, Pivot, and Persistence Fixes

**Date:** 2026-06-13 PDT  
**Repo:** `/Users/dizosint/insight-finder`  
**Branch:** `wip/ui-recovery-2026-06-12`  
**HEAD:** `70bb4a0`  
**Status:** Work is implemented and verified locally, but remains uncommitted. Nothing was pushed or deployed.

## Start Here

Continue in `/Users/dizosint/insight-finder`. Do not use the generated Codex workspace as the authoritative checkout.

The working tree was already dirty before this work. Preserve all existing UI changes and do not reset, checkout, stash, or overwrite unrelated files.

Two Node processes were listening on port `8080` at handoff time:

- PID `9507` on `127.0.0.1:8080`
- PID `11040` on `*:8080`

Resolve the duplicate server ownership before relying on hot-reload behavior.

## Implemented

### Investigation Controls

- The send button becomes a red Stop button while an investigation is active.
- Stopping updates the thread to `stopped`, stops the browser stream, and prevents the Edge Function from beginning another orchestration step.
- An already-running external tool call may finish before the stop takes effect.
- Starting, retrying, rerunning, or pivoting explicitly restores the thread to `active`.

### Scroll Behavior

- Streaming only follows the latest content while the analyst remains near the bottom.
- Scrolling upward pauses automatic following.
- A `Latest` control appears and restores bottom-follow behavior.
- Status changes no longer steal input focus or force the viewport downward.

### Pivot Consistency

- The final report's `Recommended Next Pivots` section is parsed into structured display pivots.
- Chat suggestion chips and the Analysis/Pivots panel now use the same report recommendations.
- Artifact-derived suggestions remain only as fallback behavior.
- Clicking a report pivot submits the exact recommendation prompt rather than constructing an unrelated generic prompt.

### Refresh Persistence

- Final assistant output is now persisted by a server-owned stream instead of depending only on the browser response completing.
- Refreshing or disconnecting during a pivot should no longer discard the assistant's work.
- The chat subscribes to new persisted messages and restores a response that completes after refresh.
- Message ID and content deduplication prevent duplicate assistant responses.

### UI Cleanup

- Removed the duplicate Brain count beside investigation search.
- Preserved the primary Brain navigation card.
- Added a compact `+ New` button in the top-right thread header.
- Improved chat typography and activity-card readability.
- Corrected a ResourcesPanel icon typing problem.

### Thread Metadata

- The Edge Function detects and stores the first seed type.
- Completion only changes a thread to `completed` if it is still `active`.
- A manually stopped investigation is no longer overwritten as completed.

## Files Intentionally Changed

- `src/components/ChatWindow.tsx`
- `src/components/ResourcesPanel.tsx`
- `src/components/ThreadHeader.tsx`
- `src/components/ThreadSidebar.tsx`
- `src/components/panel/PivotsTab.tsx`
- `src/lib/chat-scroll.ts`
- `src/lib/recommended-pivots.ts`
- `src/lib/telemetry.ts`
- `src/test/chat-scroll.test.ts`
- `src/test/recommended-pivots.test.ts`
- `src/test/setup.ts`
- `src/test/telemetry.test.ts`
- `supabase/functions/osint-agent/auth.ts`
- `supabase/functions/osint-agent/index.ts`

Other modified files visible in `git status` contain pre-existing user/team work. Inspect the index and working-tree versions carefully before committing.

## Verification

| Command | Result |
|---|---|
| `npm run typecheck` | Passed |
| `npm run lint` | Passed with 8 pre-existing warnings |
| `npm test -- --run` | Passed: 42 files, 504 tests |
| `npm run build` | Passed |
| `git diff --check` | Passed |
| `deno check supabase/functions/osint-agent/index.ts` | Not usable as a gate: 157 existing legacy Edge Function type errors |

Build warnings:

- Large Vite chunks remain.
- Browserslist data is stale.
- `npm ci` reports 18 dependency vulnerabilities: 6 moderate, 11 high, and 1 critical.
- Dependencies were not upgraded because that would be unrelated and potentially destabilizing.

## Deployment Boundary

The following fixes are frontend-only and are already available from the local Vite checkout:

- top-right new-chat button
- duplicate Brain cleanup
- paused auto-scroll
- `Latest` control
- pivot display synchronization
- realtime message recovery UI

The following fixes require deploying the `osint-agent` Supabase Edge Function:

- server-owned final response persistence after refresh
- stop-at-next-orchestration-step behavior
- first-seed type persistence
- preserving `stopped` status during completion

Do not claim these backend fixes are live until this succeeds:

```bash
supabase functions deploy osint-agent
```

Confirm the target Supabase project before deployment.

## Latest Investigation Audit

Trace reviewed:

`/Users/dizosint/Desktop/osint-trace-taciocero_icloud.com-2026-06-13-05-48-17.json`

Observed:

- 45 tool calls
- 34 successful
- 11 failed or categorized as failed
- 72 artifacts
- 52 of 72 artifacts were low-confidence username-sweep social-profile results
- Successful-call cost was approximately `$0.0618`

Quality issues:

1. Skipped duplicate calls, guard conditions, no-results, and true provider failures are all counted together as failures.
2. Weak username existence hits dominate the artifact count and can look more authoritative than they are.
3. Provider failures included rate limiting, timeouts, aborted calls, and HTTP 400/403/500 responses.
4. The exported trace includes highly sensitive PII, including an SSN-like value and breach-derived personal data.
5. Weak social leads should be separated visually and analytically from corroborated evidence.

Investigation-output quality estimate: **5/10**. The core corroborated leads may be useful, but the failure taxonomy, weak-lead weighting, and PII handling need further work.

Do not change evidence-ranking, chain-of-custody, masking, or audit behavior without explicit approval. Those are evidence-integrity changes under the project rules.

## Next Actions

1. Stop the duplicate `8080` server and confirm which process owns the intended checkout.
2. Inspect the combined staged and unstaged changes before creating commits.
3. Run a logged-in browser regression:
   - start an investigation
   - scroll upward while tools stream
   - expand and copy a tool result
   - stop the investigation
   - run a recommended pivot
   - refresh during the pivot
   - confirm the final response reappears
   - confirm chat chips match Analysis/Pivots
4. Deploy `osint-agent` only after confirming the Supabase project.
5. Re-run the browser regression against the deployed Edge Function.
6. Handle PII masking, weak-lead separation, and failure taxonomy as a separately approved evidence-integrity change.

## Git Safety

- No commit was created for this work.
- No push was performed.
- No branch history was rewritten.
- Do not run `git add -A` without reviewing pre-existing changes.
- Prefer explicit-path commits grouped by behavior.
