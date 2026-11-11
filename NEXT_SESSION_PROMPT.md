# Next-session prompt — Insight Finder

> **Target agent:** Claude Code (fresh context). Paste the fenced block below as the opening message, as-is.
> **Written 2026-11-11 (PST).** Replaces the 2026-11-10 prompt (partly executed: #1015 merged as `3c5daf1`; its wording bug was fixed by #1024, `9120a4c`). Every number is a dated measurement, not a state — re-verify.
> **Audit basis (2026-11-11 about 12:55Z):** `main` `9120a4c` plus this docs PR; Vercel production `READY` on `9120a4c`; live `osint-agent` last measured `3f6ed05` (`/health` 72 checks, 0 not ok, at about 11:25Z, not re-measured since); `justindean785/insight-finder` is **public**. Read `SESSION_HANDOFF_2026-11-11_rail-about-half-shipped.md` first.

```
# Objective

Decide ONE thing with evidence: why `e2e/stage1b-wcag.spec.ts` "Evidence Ledger — quarantined row selected (release-gate visible)" fails on the macOS workstation while it passes in CI. Measure first, read-only. Then give JD a proposal. Do not open a PR until JD names it.

This matters because the e2e job runs only on pushes to `main`, never on pull requests. The local run is the only e2e signal before a merge, and it currently carries two known failures (one test, two viewports).

Address the user as JD. Engineering only — the scans contain real people; never put a handle, name, address, phone, ID, credential or storage URL from a run into code, tests, commits, PR text or docs (the repo is public).

# Session hygiene (CLAUDE.md, JD 2026-10-19)

Report one line, unprompted, after any compaction, when a PR merges, and before starting a new task: `Session check: STAY — <reason>` or `Session check: START FRESH — <reason>` (with the handoff path and the opening prompt). Second compaction ⇒ START FRESH.

# Standing rules (do not re-litigate)

- `REVEAL_BREACH_DATA` stays ON. `RUN_LEASE_DISABLED=true` stays. `MAX_PAID_CALLS` stays bounded. Intent is NOT inferred from prose.
- GLM primary (`glm-5.3-flash`, deepseek slot), Anthropic `claude-sonnet-5` is the start-failure backup. Do not re-pin.
- Edge ships only via the `edge-deploy` skill. Never `supabase functions deploy`. This task is frontend/test only; do not touch `supabase/`.
- One PR = one behaviour change + tests. Never mix frontend and edge. Squash only; never delete branches.
- JD's named go is required for any merge to `main`, and for closing a PR.
- Integrity-critical (no change without JD's written sign-off): evidence ranking, `confidence.ts`, `record_finding`, chain-of-custody, credential masking, minor-safety detection, quarantine triggers, linkage paths.
- Do not weaken the accessibility gate to make it pass: no disabling the `color-contrast` rule, no excluding the node, unless JD rules on it after seeing the evidence.
- No Opus/top-tier subagents; prefer direct tool calls. Never echo a key.

# What is known (2026-11-11, handoff §4)

- The violation is axe `color-contrast`, impact serious, on nodes inside the "Filter evidence" dropdown. The menu container has `data-state="closed"`; the reported contrast is 1.04 (`#111214` on `#0b0c0e`). That looks like text scanned while the menu fades out.
- It failed locally at 1280x720 and 1440x900, on `3a7d15b` and again on pristine `3c5daf1` (one rerun of that test alone).
- CI on Ubuntu passed the full e2e suite on `3c5daf1` and on `9120a4c`.
- The last clean local figure, 128 passed / 12 skipped, was taken before #1015 merged.
- Not known: the failure rate, whether the test opens that menu itself, whether #1015 changed what the test scans.

# Steps

1. **Orient (read-only).** `git fetch origin main && git log --oneline -6 origin/main`. The primary checkout at `/Users/dizosint/insight-finder` is on an old branch; do not switch it. Add a new worktree off `origin/main` and run `npm ci` in it. Leave every other worktree alone.
2. **Measure the rate.** Run that one test 5 times, outside the command sandbox: `npx playwright test e2e/stage1b-wcag.spec.ts -g "quarantined row selected" --repeat-each=5`. Report passes and failures per viewport.
3. **Find the cause.** Read the test (around line 154) and its helpers: does it open the "Filter evidence" menu, press Escape, or click something that closes it right before `axeFor(page).analyze()`? Check whether the same test passes on the commit before #1015 (`48c250d`), in a second worktree, to tell "always flaky on macOS" from "started with #1015".
4. **Read the earlier attempt.** The local branch `fix/e2e-macos-flake` (tip `750e885`, far behind `main`, no PR found) may hold earlier macOS flake work. Read its diff against its merge base; do not check it out in the primary checkout and do not rebase it.
5. **Propose, then stop.** One screen for JD: the cause with evidence, the rate, and one recommended fix (for example, waiting for the menu to be fully closed or removed before the axe scan), with what it would and would not hide. Ask "open a PR for this?".

# Verification (only if JD names the PR)

    npm run typecheck && npm run lint && npx vitest run
    npm run test:e2e        # outside the sandbox; not in PR CI

Reference counts (2026-11-11, local, PR head `3a7d15b`): vitest 3,420 passed / 1 skipped / 292 files; e2e 126 passed / 12 skipped / 2 failed (the test above, twice). The fix is proven when the test passes `--repeat-each=10` locally at both viewports and the full e2e run shows 128 passed / 12 skipped. Never bare `tsc`.

# Return

The rate; the cause with file and line; whether it predates #1015; what `fix/e2e-macos-flake` holds; the proposal; what you did NOT do and why; the Session check line.

# Queue after this — do not start unless JD names it (one session each)

Board re-measured 2026-11-11 about 12:50Z. Nothing below is approved.

1. **#1009, then #1014** (frontend). #1014 is based on #1009's branch, not `main`: retarget it after #1009 merges.
2. **#1016** (frontend, base `main`): a dotted handle is a username seed, not a domain. Merge it right before #1017 deploys, so the screen and the stored seed type do not disagree in between.
3. **#1017 → #1018 → #1019** (edge, literally stacked on #1016 and on each other). Read each PR's full diff, not its tip commit. Each conflicts with `main` in `health-handler.ts` since #1007; rebase first. Merge and deploy strictly in order, each with its own build proof and JD's named go. **#1018 (new quarantine trigger) and #1019 (new linkage path) each need JD's explicit ruling.**
4. **#1023** (docs: CLAUDE.md sections to `.claude/rules`). Read the diff first; it will need a rebase against the CLAUDE.md state line.
5. **Still owed from 2026-11-10:** the stored-row proof for #1007. Counts only, never message text: threads created after `2026-11-11T06:24:00Z` whose title or `seed_value` matches `(token=|/object/sign/)`. Expect 0 with at least one thread created; a 0 with no threads is not proof.
6. **Consider running e2e on pull requests that touch `src/` or `e2e/`** (CI change, JD's call): today a regression is first seen after the merge.
7. Older edge: #963 (clean), #973 (conflicts with `main`), #929 (edge test job red).
8. Carried: Investigate chat-flow rework (read drafts #804, #882, #883 first); the likelihood register (`VITE_ASSOCIATION_LIKELIHOOD=1`); agent accuracy from a classified sample; memory across cases (measurement first); small follow-ups to #1007; backfill of the 23 stored rows; `stale.yml`; the public-repo scrub decision (handoff 11-08 §4); #986; `indicia_web_dbs` schema gap; heartbeat fix; GLM pricing table.
```
