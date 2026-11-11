# Next-session prompt — Insight Finder

> **Target agent:** Claude Code (fresh context). Paste the fenced block below as the opening message, as-is.
> **Written 2026-11-11 (PST).** Replaces the 2026-11-10 prompt (partly executed: #1015 merged as `3c5daf1`; its wording bug was fixed by #1024, `9120a4c`). Every number is a dated measurement, not a state — re-verify.
> **Audit basis (2026-11-11 about 13:25Z):** `main` `9120a4c` plus this docs PR; Vercel production `READY` on `9120a4c`; CI push run on `9120a4c` all green including e2e; live `osint-agent` last measured `3f6ed05` (`/health` 72 checks, 0 not ok, at about 11:25Z, not re-measured since); `justindean785/insight-finder` is **public**. Read `SESSION_HANDOFF_2026-11-11_rail-about-half-shipped.md` first.

```
# Objective

Ship the ONE pull request JD names from the ready queue below. Nothing in it is approved yet. Run one track per session (frontend, or one edge PR with its deploy cycle), never both. If JD has not named one, show the queue on one screen and ask which.

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

1. **Orient (read-only).** `git fetch origin main && git log --oneline -6 origin/main`; `gh pr list --state open`; for an edge PR, ONE `/health` read (do not loop it) and `git fetch origin refs/heads/deploy/live:refs/heads/deploy/live`. The primary checkout at `/Users/dizosint/insight-finder` is on an old branch; do not switch it. Work in a new worktree and run `npm ci` in it. Leave every other worktree alone.
2. **Read the named PR's full diff**, not its tip commit and not its title alone. Check its base branch.
3. **Rebase or retarget if needed** (see the queue notes), then verify.
4. **Ship it.** Frontend: verify, wait for CI green on the final head, ask JD "merge #N?", squash-merge on his go, confirm Vercel `target: production` is `READY` on the merge commit. Edge: the full `edge-deploy` cycle, then `/health` proof.

# The ready queue (board re-measured 2026-11-11 about 12:50Z)

- **#1009 → #1014** (frontend). #1009 is based on `main`. #1014 is based on #1009's branch: after #1009 squash-merges, retarget #1014 to `main` and rebase.
- **#1016 ← #1017 ← #1018 ← #1019** is one four-deep chain: a frontend root (#1016, base `main`) with three edge PRs stacked on it. #1016 and #1017 are two halves of one rule ("a dotted handle is a username seed, not a domain"); merge #1016 right before #1017 deploys, so the screen and the stored seed type do not disagree in between. #1018 is "a lookup on a shortened seed handle runs tainted" (a new quarantine trigger) and #1019 is "a recorded profile whose URL ends in the exact seed handle carries that handle" (a new linkage path): **each needs JD's explicit ruling.**
- **Merge-train trap:** squash-only with branches kept means that after a parent squash-merges, the child's base is still the old branch. Retarget each child to `main` and rebase by hand before it merges. Each edge PR also conflicts with `main` in `health-handler.ts` since #1007.
- **#1023** (docs: CLAUDE.md sections to `.claude/rules`). Read the diff first; it needs a rebase against the CLAUDE.md state line.
- Older edge: #963 (clean), #973 (conflicts with `main`), #929 (edge test job red).

# Verification

    npm run typecheck && npm run lint && npx vitest run
    npm run test:edge
    npm run test:e2e        # outside the sandbox; not in PR CI; required for anything touching src/

Reference counts (2026-11-11, local, `3a7d15b`, same tree as `main` `9120a4c`): vitest 3,420 passed / 1 skipped / 292 files; e2e 126 passed / 12 skipped / 2 failed. Edge was last measured 2026-11-10: 3080 passed / 0 failed / 6 ignored. Never bare `tsc`.

**Known local e2e failure, already answered — do not re-investigate:** on the macOS workstation, `e2e/stage1b-wcag.spec.ts` "Evidence Ledger — quarantined row selected" fails at 1280x720 and 1440x900 with axe `color-contrast` 1.04 on the closing "Filter evidence" menu. No regression was found: the spec passed 15 of 15 on Linux at `48c250d` and at `3c5daf1`, and CI e2e was success on `3c5daf1` and `9120a4c`. Treat exactly those two failures as known; any other e2e failure is yours to explain. Details: handoff §4.

# Return

What JD approved and when; what merged, with commit ids; for edge, before/after `/health` (`build`, check count, the new key) and the `verify:deploy` lines; real test counts; what you did NOT do and why; the Session check line.

# Still JD's, and later work — do not start unless JD names it (one session each)

1. **Stored-row proof for #1007** (owed since 2026-11-10): run one upload-only case, then the counts-only query, never message text: threads created after `2026-11-11 06:25:00+00` whose title or `seed_value` matches `(token=|/object/sign/)`. Want 0 leaking with at least 1 thread; a 0 with no threads is not proof.
2. **`stale.yml`** on `main` uses placeholder messages and will close inactive issues and PRs: keep, disable or remove — JD's call.
3. **Test-only hardening, low priority:** wait for the "More filter" menu to be hidden before the axe scan in `stage1b-wcag.spec.ts`. Do not disable the `color-contrast` rule or exclude the node.
4. **Investigate chat-flow rework** (not started): critique with screenshots at 1440x900 and about 1000x650, a plan JD can react to, then build. Read drafts #804, #882, #883 first.
5. **Likelihood register:** whether to set `VITE_ASSOCIATION_LIKELIHOOD=1` in Vercel, and how it reads next to the new rail. JD's call.
6. **Agent accuracy:** start from a classified sample of recent runs, not a theory.
7. **Memory across cases:** first deliverable is a measurement (what is saved per run, what the next run retrieves).
8. **Small follow-ups to #1007** (one edge PR, JD's go): tests for the space-joined form and the multi-upload title; kill-switch parse aligned with the repo convention.
9. **Backfill** of the 23 stored rows that still hold a signed-URL fragment: JD's call.
10. Carried from 2026-11-08: the public-repo scrub decision (handoff 11-08 §4), #986 audit trail, `indicia_web_dbs` schema gap, heartbeat fix, GLM pricing table.
```
