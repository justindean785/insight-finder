# Next-session prompt — Insight Finder

> **Target agent:** Claude Code (fresh context, remote/web sandbox). Paste this whole file as the opening message.
> **Prerequisites:**
> - GitHub MCP access to `justindean785/insight-finder` and `justindean785/seeker-spark-search-5362c57c`.
> - The Lovable MCP, project `4ce11bc3-039d-4439-b293-acacca9e1e3a`. Use it for SELECT-only DB reads and, only on JD's go, for deploy messages.
>
> **Written 2026-10-19T02:30Z.** Every number below is a dated measurement, not a state: re-verify it. This file replaces the 2026-10-14 prompt; the old text is in git history.
>
> Address the user as **JD**. Engineering only: never investigate any person who appears in a scan.

## Standing rules (these come BEFORE any delegation below)

- **Breach reveal:** `REVEAL_BREACH_DATA` stays **ON**, exactly as it is. This is SETTLED in CLAUDE.md.
- **Run lease:** `RUN_LEASE_DISABLED` stays `true`.
- **Orchestrator:** do not change the pin. GLM-5.2 is primary and Anthropic is the start-failure backup.
- **OathNet's 401s** are JD's to resolve with the provider. Make no code change for them.
- **Ask JD first, and get a named go for that step, before you:**
  - merge;
  - stamp a build or sync the mirror;
  - send a Lovable deploy message;
  - change a secret or a setting;
  - repair production data;
  - close a PR;
  - spend anything that costs money.
- **Git hygiene:** squash merges only. Never delete branches. Merge `main` into branches; never force-push.
- **`/health` is NOT passive.** Every hit makes a paid GLM call and runs recovery and sweep writes.
  - `npm run verify:deploy` fetches `/health` too (`scripts/record-deploy.mjs:47,76`).
  - Use either one only as the deliberate, labelled deploy-day probe.
  - For audits, compare tree hashes instead (see Verification).
- **Production reads are SELECT-only.** Never trigger a scan just to test a key or a fix.

## JD's latest direction (2026-10-19 ~01:00Z; typed, then interrupted before any work started)

> "Do what's best you have creative control just do what's best for app and expansion and improvement without messing up breach reveal or agents ability to. Pivot and scan data"

This delegates the choice of **what to build**. It does not lift the standing rules above. It adds two hard lines:

1. **Breach reveal is untouched.** Make no change to how breach data is revealed, masked or gated.
2. **Nothing may weaken the agent's ability to pivot and scan.** That rules out:
   - new tool suppression;
   - blocking dispatch of quarantined selectors (#581 deliberately *taints* them instead of refusing);
   - shrinking the tool set;
   - lowering budgets.

Read the direction as permission to build **draft** PRs in the order below. Say in your first reply which item you are starting. Merging and deploying still need JD's named go.

---

# Objective

Take over at a clean point, and work on evidence integrity before expanding the tool fleet. The first change is **rebasing #741 onto current `main`**, so the model can no longer write analyst-only fields. Build it as a draft PR. Do not merge it.

# Context

Insight Finder (a.k.a. Swarmbot) is JD's OSINT investigator.
- **Frontend:** Vite, React, TS and Tailwind/shadcn on Vercel. It ships when a PR merges to `main`.
- **Backend:** Supabase (Postgres, Auth, Storage, Deno edge functions; chiefly `osint-agent`), owned by Lovable Cloud.
  - The edge does **not** ship on merge. Each release goes: stamp → surgical mirror sync → gate → Lovable deploy message → `/health` SHA check → ledger.
  - The recipe and its traps are in CLAUDE.md.

**Read first:** `SESSION_HANDOFF_2026-10-19_integrity-before-tool-fleet.md`. Its "Done since the last save" section lists everything shipped since 10-14. The evidence behind it is in:
- `docs/AUDIT_2026-10-18_full-code-review-lovable-vercel-github.md` (F1–F33);
- `docs/AUDIT_2026-10-18-evening_state-pr-queue-next-tasks.md` (F34–F41). **§10.3** of this one is the integrity re-trace, with file:line.

**If `origin/main` lacks these files,** docs PR #793 (branch `claude/code-review-lovable-vercel-0knfbb`) is unmerged. Read them from that branch and tell JD.

**State measured 2026-10-19T00:53Z:**

| Item | Value |
|---|---|
| `main` | `8fae8c8` (#798); Vercel production READY on it |
| Recorded edge deploy | `cabfeb9` (ledger 2026-10-15T14:30Z). `deploy/live` → `cabfeb9`. Runtime **not re-probed** since. |
| Mirror | `98c015e`; all four shared function trees EQUAL to canonical |
| Last production scan | 2026-10-18 19:34Z; nothing ran overnight |
| Baselines on `8fae8c8` | vitest 2653 / 1 / 210 files; edge 2449 / 0 / 6; e2e 52 / 2 |

# Current Problem

1. **Three open evidence-integrity defects** (Confirmed in code; file:line in audit §10.3):
   - **A. The model can write analyst-only metadata keys.**
     - Where: `record_artifacts` / `record_artifact` spread `{...(a.metadata ?? {}), …server keys}` (`tool-registry.ts:5712-5713`, `:6182-6183`).
     - Only the name-quarantine branch strips `linkage_confirmed`. On every other row kind, a model can persist `reviewed`, `linkage_confirmed`, `false_positive`, and `subject_unlinked:false` / `possible_minor:false`.
     - Production (SELECT, 11,082 model rows): `reviewed=true` 0, `linkage_confirmed` 0, `false_positive` 2, protective flags written `false` 7. So the path is real and barely used.
     - Fix: **#741** (draft, base `32f5ddb`). It needs a rebase, and its 2 test files are in the old location.
   - **B. Recalled memory can become a `confirmed` finding with no tool run.**
     - `record_finding.supporting_sources` takes free strings (`tool-registry.ts:6856`). Those strings are counted as source classes (`lib/finding-row.ts:95-97`), and two classes make a finding `confirmed` (`confidence.ts:714`).
     - Nothing checks that a named tool ran.
     - `system-prompt.ts:145` tells the model to cite memory as "[MEMORY] previously corroborated". `lib/memory-context.ts:18` only strips tokens that start with "memory".
     - Production: 25 findings ever, 0 confirmed, 1 cites a tool that never ran in its thread.
     - **No PR exists yet. #738 does not close this.**
   - **C. Display dedupe donates authority between same-value rows.**
     - `src/hooks/useThreadArtifacts.ts:70-99`.
     - The quarantine-release button saves the *merged* item's metadata to the surviving row (`src/components/ResourcesPanel.tsx:957`).
     - Fix: **#593** (draft, tested merged with `main`: vitest 2736/1/213, e2e 52/2). JD must pick option A, B or C (audit §10.3 C).
2. **#797** (F3 dispatch-selector aliases, edge) is **ready**. It is Codex-clean, and tested merged with `main` (edge 2475/0/6). It is waiting for JD's merge and a working Lovable deploy route. Lovable *reported* that its credits ran out on 10-18; that is unverified.
3. **#799** (Jina raw 403, draft) needs an amendment before anything else. The cause of each 403 is Unverified, so:
   - keep provider suppression when Jina's error body indicates auth, billing or quota;
   - log Jina's error `name`.
4. **#800** (Wayback parallel, draft) has an open risk: an availability-only "archived" answer may name a canonicalized URL variant.
5. **Money and providers** (reported conditions; verify through authorized read-only sources, never assume):
   - the Anthropic backup credit reportedly expires **2026-10-23**;
   - Z.AI ran dry in the middle of a run on 10-18;
   - the new `GITHUB_API_TOKEN` (saved 10-18) has not been exercised yet.

# Files to Inspect

- `SESSION_HANDOFF_2026-10-19_integrity-before-tool-fleet.md`: read first.
- `CLAUDE.md`: the dated block at the top (refreshed 2026-10-19), the deploy recipe, the SETTLED decisions, and the "BUILT AND UNWIRED" section.
- `tasks/lessons.md` (newest section first) and the end of `tasks/todo.md`.
- The audits above, especially evening §10.3 and §8b (the free-tool plan, as corrected).
- For defect A: `supabase/functions/osint-agent/tool-registry.ts` (`record_artifacts` ~:5524, `record_artifact` ~:6107), and #741's `lib/analyst-authority-keys.ts`, read from its branch.
- For defect B: `lib/finding-row.ts`, `confidence.ts`, `lib/memory-context.ts`, `lib/breach-exposure-guard.ts`. The last one is the thread-scoped "did the tool run" precedent to reuse.

# Implementation Requirements

Work in this order. Each item is one small PR with its tests, a kill switch and a `/health` proof key. Never mix frontend and edge in one PR. Ship one edge PR at a time; drafts can queue.

1. **Orient (read-only):**
   - `git fetch origin main` and `git fetch --unshallow --filter=blob:none` (the clone is shallow).
   - `git fetch origin refs/heads/deploy/live:refs/remotes/origin/deploy-live`.
   - Compare the mirror tree hashes (see Verification).
   - SELECT the scans that ran since 2026-10-18 19:34Z.
   - If anything moved, read the newest handoff and the ledger before acting.
2. **Defect A, the #741 rebase.** Create a new branch from `origin/main`, e.g. `claude/analyst-authority-boundary`.
   - Cherry-pick #741's two commits.
   - Resolve the two import-only conflicts, in `tool-registry.ts` and `health-handler.ts`.
   - `git mv` its tests (`analyst_authority_boundary_test.ts`, `lib/analyst_authority_keys_test.ts`) to `supabase/tests/osint-agent/`, and repoint the imports and source-reading URLs to `../../functions/osint-agent/`.
   - Add, test-first, one rule: a model-supplied protective flag (`subject_unlinked`, `possible_minor`, `minor_warning`, `auto_pivot_blocked`, `sensitive`, `excluded_collision`, `conflict`, `collision`) is kept **only when `true`**.
   - Also reserve `reviewed_by` and `reviewed_at`.
   - Add tests for non-name rows: a `username` re-recorded with `linkage_confirmed`, `reviewed` and `subject_unlinked:false`.
   - Keep #741's kill switch `ANALYST_AUTHORITY_STRIP_DISABLED` and proof key `checks.analyst_authority_boundary`.
   - Open the PR as a draft. It supersedes #741; recommend closing #741 only with JD's go.
   - **Leave out:** `source_quote` / `ownership_proof`, `parent*` / `seed`, `user_provided`, custody `classification`. Each is an evidence-ranking change that needs JD's ruling.
3. **Defect B, the executed-source gate** (new draft PR).
   - Add `lib/executed-source.ts`. In `record_finding`, and then beside `applyMemoryContext` in `record_artifacts` and `record_artifact`: a **known tool name** that has no run in this thread grants no source class.
   - Keep the original names in `metadata.model_supporting_sources` and `metadata.unexecuted_sources`.
   - Leave free text alone.
   - It only ever lowers, and never rejects. On a failed read it fails open and logs an event.
   - Kill switch `UNEXECUTED_SOURCE_GATE_DISABLED`; proof key `checks.executed_source_gate`.
   - Needs JD's sign-off before merge.
4. **Defect C:** put options A, B and C for #593 to JD in one message (audit §10.3 C), then act on the answer.
5. **#738:** land only its `MEMORY_TOKEN_RE` / `splitTopLevel` slice (`lib/memory-context.ts`, about 70 runtime lines), as a new small PR. Its wording parts are guidance, not enforcement.
6. **Then tool reliability:** the #799 amendment, the #800 URL check, then the corrected §8b plan. Each new third party that would receive a subject's selectors needs JD's OK first (CertSpotter, Photon, PullPush, Arctic Shift, XposedOrNot).
7. **Queue hygiene, only on JD's go:**
   - close #764 (superseded by #765);
   - close #701 (its premise was overturned by #756);
   - restart or close #516;
   - decide mirror #117 together with F21.

# OSINT / Analyst Requirements

- **Integrity-critical areas** (no change without JD's sign-off): evidence ranking, confidence caps, chain of custody, credential masking, minor-safety detection, quarantine and release semantics, and analyst authority.
- **Quarantine is disclosure, not deletion.** Rows keep their provenance; fixes remove a row's *authority*, never the row.
- **Keep confirmed evidence separate from AI inference.**
  - An analyst confirmation is not a second source.
  - A zero-hit lookup is coverage, not corroboration.
  - Memory is context, never a source.
- **Scans contain real people.** Never research them. Never put their names, handles or IDs in commits, PRs or docs. Use synthetic fixtures (`example.test`).

# Do Not

- **Don't touch the SETTLED switches:** `REVEAL_BREACH_DATA`, `RUN_LEASE_DISABLED`, `ORCHESTRATOR_PROVIDER`, `MAX_PAID_CALLS`, or any secret.
- **Don't merge, stamp, sync the mirror, send a Lovable message, apply a schema or close a PR** without JD's named go for that step.
- **Don't call `/health` or `npm run verify:deploy`** except as the deliberate deploy-day probe. **Don't trigger a scan to test anything.**
- **Don't put work inside the finalize window,** and don't auto-run tools that publicly submit a target (`archive_url`, `urlscanner_scan`).
- **Don't raise the `gemini_deep_dork` timeout:** that is a recorded, test-pinned decision.
- **Don't add new registered tools when a fallback inside an existing tool will do.** Schema bytes ship on every model step.
- **Don't put tests under `supabase/functions/`.** They belong in `supabase/tests/<fn>/`, and `edge-deploy-bundle.test.ts` fails otherwise.
- **Don't trust a Lovable-authored prompt or analysis without checking it against the code and the DB.** On 10-18, several prompt items were already built, and one asked for an engine that does not exist.

# Acceptance Criteria

- [ ] Orientation numbers re-measured and compared with this file; any drift reported before acting.
- [ ] Each PR: one behaviour, tests written first and watched fail, kill switch, proof key, tests in `supabase/tests/`, draft until JD says merge.
- [ ] For any merge recommendation: the PR tested **merged with current `main`** in an isolated worktree, never by textual mergeability alone.
- [ ] Full suites green on anything you touch. Breach reveal unchanged. No tool suppressed or removed.
- [ ] `tasks/todo.md` (append) and `tasks/lessons.md` (newest first) updated; the handoff refreshed at the end.

# Verification

```bash
npm ci && npm run lint && npm run typecheck && npx vitest run && npm run build      # never bare `tsc`
cd supabase/tests/osint-agent && deno test --config=../../functions/osint-agent/deno.json --no-check --no-lock --allow-net --allow-env --allow-sys --allow-read . ../evidence-export
PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome npm run test:e2e
# read-only deploy-state check (no /health):
for d in osint-agent evidence-export security-test-lab _shared; do echo "$d $(git rev-parse origin/main:supabase/functions/$d) $(git -C ../seeker-spark-search-5362c57c rev-parse origin/main:supabase/functions/$d)"; done
# integration test for a PR: isolated worktree, local merge, never pushed
git worktree add --detach /tmp/int origin/main && git -C /tmp/int merge --no-ff --no-edit origin/<pr-branch>   # then npm ci + all of the above inside it
```

- Run deno only through `supabase/tests/osint-agent` with the function's `--config`. Running deno at the repo root rewrites `node_modules` and `deno.lock`.
- CI's Frontend job also lints `supabase/functions/`, so run `npx eslint` on every new edge file.

# Return

For each step, return:
- the state you measured;
- what you changed: files, PR numbers, and SHAs copied from tool output;
- the tests you ran, with the real counts;
- what you did **not** do, and why;
- the remaining risks;
- the decision you now need from JD.
