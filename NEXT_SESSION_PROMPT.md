# Next-session prompt — Insight Finder

> **Target agent:** Claude Code (fresh context). Paste the fenced block below as the opening message, as-is.
> **Written 2026-11-10 (PST).** Replaces the 2026-11-08 prompt (executed: the attachment-seed fix shipped as #1010 + #1007, live build `3f6ed05`). Every number is a dated measurement, not a state — re-verify.
> **Audit basis (2026-11-11 06:30Z):** `main` `7de2257` plus the ledger PR #1021 and this docs PR; live `osint-agent` `3f6ed05` (`/health` 72 checks, 0 not ok); `justindean785/insight-finder` is **public**. Read `SESSION_HANDOFF_2026-11-10_attachment-seed-shipped.md` first.

```
# Objective

Put ONE decision in front of JD and then ship what he names: the merge order for the ready queue. Nothing in it is approved yet. Run one track per session (frontend, or one edge PR with its deploy cycle), never both.

Address the user as JD. Engineering only — the scans contain real people; never put a handle, name, address, phone, ID, credential or storage URL from a run into code, tests, commits, PR text or docs (the repo is public).

# Session hygiene (CLAUDE.md, JD 2026-10-19)

Report one line, unprompted, after any compaction, when a PR merges, and before starting a new task: `Session check: STAY — <reason>` or `Session check: START FRESH — <reason>` (with the handoff path and the opening prompt). Second compaction ⇒ START FRESH.

# Standing rules (do not re-litigate)

- `REVEAL_BREACH_DATA` stays ON. `RUN_LEASE_DISABLED=true` stays. `MAX_PAID_CALLS` stays bounded. Intent is NOT inferred from prose.
- GLM primary (`glm-5.3-flash`, deepseek slot), Anthropic `claude-sonnet-5` is the start-failure backup. Do not re-pin.
- Edge ships only via the `edge-deploy` skill: stamp (parent == marker) → surgical mirror sync → `npm run verify:deploy` hard gate (`mirror tree -> equal` + `mirror pushed`) → Lovable deploy message → `/health` build moved → `npm run record:deploy` → ledger PR + `deploy/live`. Never `supabase functions deploy`.
- One PR = one behaviour change + tests. Never mix frontend and edge. At most one edge PR in flight. Squash only; never delete branches.
- JD's named go is required for: any merge to `main` he has not named, any edge merge or deploy, stamp, mirror push, Lovable message, secret or flag change, schema, closing a PR. Never answer a Lovable tool-approval pause yourself.
- Integrity-critical (no change without JD's written sign-off): evidence ranking, `confidence.ts`, `record_finding`, chain-of-custody, credential masking, minor-safety detection, quarantine triggers, linkage paths.
- No Opus/top-tier subagents; prefer direct tool calls. Never echo a key.

# Steps

1. **Orient (read-only).** `git fetch origin main && git log --oneline -6 origin/main`; ONE `/health` read (expect `3f6ed05`, 72 checks; do not loop it); `gh pr list --state open`; `git fetch origin refs/heads/deploy/live:refs/heads/deploy/live`. If ledger PR #1021 is still open, ask JD to merge it first.
2. **Close the one unproven item from the last session.** Counts only, never message text: threads created after `2026-11-11T06:24:00Z` whose title or `seed_value` matches `(token=|/object/sign/)`. Expect 0 with at least one thread created. If no thread has been created yet, say so; do not report a vacuous 0 as proof.
3. **Give JD a one-screen merge order** and ask for a named go per PR:
   - Frontend: #1015 (right rail; add before/after screenshots at the same viewport first, and ask JD about the `assessmentReading()` `TODO(human)` stub), #1016 (dotted handle, frontend half), #1009, #1014 (based on another branch; retarget after its base merges).
   - Edge: #1017 → #1018 → #1019 (dotted handle). Each conflicts with `main` in `health-handler.ts` since #1007; rebase first. **#1018 (new quarantine trigger) and #1019 (new linkage path) each need JD's explicit ruling.**
   - #1016 and #1017 are two halves of one rule. Merge #1016 right before #1017 deploys, so the screen and the stored seed type do not disagree in between.
   - Older edge: #963 (clean), #973 (conflicts with `main`), #929 (edge test job red).
4. **Ship what JD names**, one track. Frontend: verify, squash-merge, confirm Vercel `target: production` is READY on the merge commit. Edge: the full `edge-deploy` cycle, then `/health` proof.

# Verification

    npm run typecheck && npm run lint && npx vitest run
    npm run test:edge
    npm run test:e2e        # not in PR CI; required for anything touching src/

Baselines (2026-11-10, local, `main` + #1010 + #1007): edge 3080 passed / 0 failed / 6 ignored; vitest 3393 passed / 1 skipped / 291 files; e2e 128 passed / 12 skipped. Never bare `tsc`. On the macOS workstation, e2e, `gh` and `verify:deploy` must run outside the command sandbox (handoff §7).

# Return

What JD approved and when; what merged, with commit ids; for edge, before/after `/health` (`build`, check count, the new key) and the `verify:deploy` lines; real test counts; what you did NOT do and why; the Session check line.

# Queue after this — do not start unless JD names it (one session each)

1. **Investigate chat-flow rework** (not started): critique with screenshots at 1440x900 and about 1000x650, a plan JD can react to, then build. Read drafts #804, #882, #883 first.
2. **Likelihood register:** whether to set `VITE_ASSOCIATION_LIKELIHOOD=1` in Vercel, and how it reads next to the new rail. JD's call.
3. **Agent accuracy:** start from a classified sample of recent runs, not a theory.
4. **Memory across cases:** first deliverable is a measurement (what is saved per run, what the next run retrieves).
5. **Small follow-ups to #1007** (one edge PR, JD's go): tests for the space-joined form and the multi-upload title; kill-switch parse aligned with the repo convention.
6. **Backfill** of the 23 stored rows that still hold a signed-URL fragment: JD's call.
7. **`stale.yml`** on `main` uses placeholder messages and will close inactive issues and PRs: keep, fix or remove — JD's call.
8. Carried from 2026-11-08: the public-repo scrub decision (handoff 11-08 §4), #986 audit trail, `indicia_web_dbs` schema gap, heartbeat fix, GLM pricing table.
```
