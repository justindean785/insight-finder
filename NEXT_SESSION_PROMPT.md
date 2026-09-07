# Next-session prompt — Insight Finder

> Paste this whole file as the opening message of a fresh session. It is self-contained.
> **Written 2026-09-07T13:30Z. Every number is a dated measurement, not a state — re-verify.**

---

## Start here — 5 minutes, before anything else

```bash
git fetch origin main && git log --oneline -5 origin/main
curl -s "https://skzqwbyvmwqarfgfvyky.supabase.co/functions/v1/osint-agent?health=1"
```

**Expect `main` = `a19f065` and live edge build = `7b0138d`.** If either moved, another session has
worked this repo — read the newest `SESSION_HANDOFF_*.md` first. That has now happened three times,
and on 2026-09-07 it produced **two conflicting PRs for one task** (#548 and #551).

**Then, before you write any code: `list_pull_requests`.** Nine PRs are open. The 2026-09-07
duplicate-PR incident happened because a session started work without checking.

Read, in order:
1. `SESSION_HANDOFF_2026-09-07_drop-suppression-and-the-duplicate-pr.md` — newest; §5 records the `artifactDedupKey` ruling.
2. `CLAUDE.md` — authoritative on deploy topology and on decisions that must not be re-litigated. **Its test baselines are stale** (see §6 below).
3. `gameplan9/7/2026` — the operator's Game Plan. Its structure is sound; several numbers have drifted, corrected in §3–§5 below.

---

## 1 · Verified state (2026-09-07T13:30Z)

| Axis | Value |
|---|---|
| `origin/main` | `a19f0653c8155413dc029797673933cc5b452868` |
| Live `osint-agent` build | `7b0138d` — **no edge deploy since 2026-09-03** |
| Vercel production | `dpl_7aNx7yjbVAdpAgy1xnzAyuT1biAp`, READY, SHA `a19f065`, alias `insight-finder-sandy.vercel.app` |
| Frontend suite | **1918 passed / 1 skipped / 155 files** |
| Lint | 0 errors, 11 pre-existing `react-refresh` warnings |
| Open PRs | **9** (8 draft, #502 non-draft) |
| Mirror `HEAD` | `68521e8` "Fixed chat error handling" — Lovable-authored, unsynced |

`/health` carries nine checks. **Read `detail`, not just `ok`** — `cache_sweep` and `synthesis` both
report `ok:true, detail:"disabled"`. `ok:true` does not mean it ran.

---

## 2 · ✅ `artifactDedupKey` — OPERATOR RULING, 2026-09-07. This is settled; build to it.

**`artifactDedupKey` is the highest-value accuracy item. It was blocked on an unrecorded ruling that
confused two sessions. The operator has now ruled. Do not re-open the rejected halves; do not
re-litigate the permitted shape.**

### ⛔ Rejected — permanently, both halves

**(a) Dedup by DELETING rows is off the table permanently.** #305's migration would have deleted
~120 genuinely distinct rows and orphaned 53 analyst reviews. No future design may delete an
artifact row to achieve dedup.

**(b) Merged confidence = `GREATEST`, without selector scope, is rejected.** That is #307's shape.
Taking the maximum bypasses a minor-safety cap whenever one copy is capped low and another is not.

### ✅ §B stays OPEN, in this narrowed form

A write-path merge is permitted **only** if it satisfies every one of these:

| Rule | Requirement |
|---|---|
| **Merge key** | Same `canonicalKind` **and** same normalized value, **scoped to the selector** |
| **No deletion** | **No row is ever deleted, and no analyst review is ever orphaned** |
| **Provenance** | `sources[]` retains **per-source first-seen** |
| **Confidence** | Follows the **corroboration rules** and **respects existing caps**. Not `GREATEST` |
| **Quarantine** | **Fails closed** — if any copy is quarantined, the merged row is quarantined |
| **Scope** | **New writes only.** Backfill of existing rows is a **separate, later** decision |

Implement behind a flag, with failure-first tests that drive the write path
(`auto-persist-findings.ts` / `lib/artifact-hygiene.ts`) rather than restating the predicate.

**Start with B1, which needs none of the above design work** — it is a straight bug: the merge
*already fires* into `metadata.sources` while the insert is **not** suppressed. **46 rows across 15
threads** carry ≥2 `sources` entries *and* a sibling duplicate row.

### The record behind the ruling, for context

**Do not re-derive this. It is settled — this is here so you understand why the rules above are shaped as they are.**

- **PR #305** (closed unmerged 2026-07-14) carried a dedup migration whose key **ignored selector
  scope**. Production simulation: it would have deleted **~120 genuinely distinct rows** (different
  platform / subject / host / breach) and **orphaned 53 real analyst reviews**. That is the
  "data-loss / review-orphaning failure".
- **PR #307** (closed unmerged 2026-08-20) was the careful fix: a selector-scope-aware key plus one
  canonical `merge_artifact_into(loser, survivor)` that asserts thread + user equality, preserves the
  survivor's `subject_id`/`cluster_id`, **unions** provenance and classes, re-points evidence and
  reviews, and surfaces conflicting analyst verdicts as `recheck` with lineage rather than discarding
  them. Its production simulation: 6,889 → 6,387 artifacts, 502 true duplicates across 376 groups,
  **0 distinct-platform / subject / selector loss, 53 reviews re-pointed, 0 discarded.**
- #307 derives merged confidence with **`GREATEST`** — the likely origin of the "minor-safety
  confidence bypass" concern: if one copy is capped low for minor-safety reasons and another is not,
  taking the maximum bypasses the cap.

Note what the ruling keeps and what it drops from #307. #307's **structure** is the model — one
canonical merge, selector-scoped key, provenance unioned, reviews re-pointed, conflicting verdicts
surfaced as `recheck` rather than discarded, and a production simulation showing zero loss. What the
ruling **drops** from it is the `GREATEST` confidence derivation, replaced by the corroboration
rules plus existing caps. #305's delete-based approach is excluded entirely.

**The work splits in two:**
- **B1 — a straight bug**, and the place to start. The merge already fires into `metadata.sources`
  while the insert is not suppressed (46 rows / 15 threads). No merge-semantics design needed.
- **B2 — the design work**, now unblocked and bounded by the six rules above.

---

## 3 · Phase 0 — drain the queue (do this first; it is mostly mechanical)

Measured 2026-09-07 against `a19f065`. **Three PRs already conflict** — the Game Plan does not
mention this.

| PR | Merges onto `a19f065`? | Files | Edge files | Migration | Ships how |
|---|---|---|---|---|---|
| **#550** unify "verified" count across Overview/Evidence/Report | **CLEAN** | 6 | 0 | no | Vercel on merge. **No deploy.** |
| **#549** recover corroborating classes a compound breach label discards (closes #497) | **CLEAN** | 2 | **2** | no | **Needs mirror sync + edge deploy + `/health` SHA move** |
| **#547** finding-synthesis dedup key as a partial unique index | **CLEAN** | 4 | 1 | **yes** | Migration + edge deploy |
| **#516** account-deletion slice of #502, shipped dark | CLEAN | 8 | 0 | yes | — |
| **#529** analyst-operable quarantine release | **CONFLICT** | 3 | 0 | no | rebase first |
| **#519** page the dispatch-boundary read | **CONFLICT** | 9 | **9** | no | rebase first |
| **#502** audit remediation + run-wedge fix + #476 | **CONFLICT** | 39 | 20 | yes | rebase first |
| **#541** 2026-09-03 handoff doc | — | — | — | — | superseded by the 09-07 handoff; close or merge |
| **#552** 2026-09-07 handoff doc | — | — | — | — | this session's record |

**Suggested order:** #550 (zero risk, ships immediately) → #549 (first edge deploy in days; follow
the CLAUDE.md recipe exactly and confirm the `/health` SHA moves) → #547 (migration; validate in CI
first). Then rule on **#502 vs #516** — do not keep both — and rebase #529/#519 before deciding.

> #548 and #551 are **already resolved**: #551 merged as `a19f065`, #548 closed as superseded.
> Ignore any older document that lists #548 in the queue.

### Repo housekeeping — zero risk, half a day

Measured, and the Game Plan **understates** the branch problem:

- **410 remote branches**, of which **79 are already merged into `main`** (Game Plan says "~20 stale `chore/*`"; only 17 match that pattern). Deleting the 79 merged ones is safe.
- **25 root-level** `SESSION_HANDOFF_*` / audit docs. A `docs/` directory **already exists** — move them to `docs/handoffs/`.
- Both `bun.lockb` (306 KB) and `package-lock.json` (395 KB) are committed. CI uses `npm ci` — **delete `bun.lockb`**.
- `insight-finder-beta-demo.mp4` is **7.1 MB** and tracked. `deploy-log.jsonl` is only 11 KB — leave it.
- `b030afc` committed the Game Plan to a path literally named **`gameplan9/7/2026`** — the date's slashes became directories. Move it to `docs/`.

---

## 4 · Phase 1 — accuracy (the headline problem)

**Re-measured 2026-09-07, last 14 days: 36 threads, 1,955 artifacts, 168 actionable
(not quarantined, confidence ≥ 65) = 8.6%, i.e. 4.7 actionable per ~54-artifact scan.**
The Game Plan's *4.8 of 60 (7.9 %)* is **confirmed with cohort drift** — the problem is real and
essentially unchanged.

Supporting corpus figures (all 2026-09-07): 11,079 artifacts · **4,322** at confidence 50–64 ·
**5,063** below 50 · 1,613 at ≥65 · 218 threads · 69 with a `recovery_reason` ·
**513 of 1,955 recent artifacts (26 %) quarantined**.

Ordered work:

1. **Verify the #537 report-truth wave on a live run** (cheap, do it early, zero risk). Seed a handle with a leading `@` → expect kind `username`. Dismiss two rows, Confirm one, Key one. Export; expect cluster headline ≤ strongest member's capped confidence, the confirmed row rendered ANALYST-CONFIRMED, kind-alias twins folded, and the Evidence Record carrying the analyst-decisions line. On a later run confirm a Dismissed selector is refused at dispatch — **that closes audit F8**.
2. **`artifactDedupKey`** — **ruled and unblocked**; build to the six rules in §2, starting with B1. Duplicates measured: **852 redundant rows of 11,079 across 138 threads** (supersedes "840 across 695 selectors"): 503 same value / different `source` string · 317 identical key, **143 of them written inside one sub-2-second batch** · 32 case-only. Max 6 copies of one value in one thread.
3. **The evidence-authority / causal-provenance boundary** — the operator's stated next investigative priority. Full brief and fixtures in the 09-07 handoff §6. Governing principle: *allow broad discovery, but do not grant subject authority without durable linkage.* **This is NOT the declined bare-name dispatch guard** — searches stay permitted; the control belongs at persistence/read authority.
4. **#477** — `record_finding` persists the model's label unchecked against server-computed confidence. **#494** — `ransomwarelive_lookup` malformed HTTP-200 JSON collapses into the genuine-negative shape; fail closed on unparseable payloads.

---

## 5 · Phase 2 — efficiency

- **`tool_call_cache`: 11,741 rows, 11,678 expired, 43 MB.** `CACHE_SWEEP_ENABLED` is off by design. **Trap:** the delete sends up to 5,000 UUIDs in one `.in()`; the PostgREST gateway rejects anything over ~24 KB, so flipping the flag as-is means every probe errors and nothing drains. Chunk at **300**, exactly as `lib/rejected-cluster-sweep.ts` already does (that sweep converged 216 → 0 in production). Update the test that pins the 5,000 constant.
- **Issue #238 — orchestrator prompt summarization.** The Game Plan's *225–257K chars/step* could not be re-verified from production telemetry; treat it as unconfirmed until you measure it. The approach (replace a tool's raw result in message history with a compact summary once its artifacts are recorded, hooked at `wrapToolsWithCache`) is sound regardless. Never touch `record_artifacts`, confidence scoring, or chain-of-custody.
- **Issue #65 — server-side run cancellation.** #545/#551 fixed the *reporting* of dropped connections; the *spend* is unfixed — runs drain under `EdgeRuntime.waitUntil`. Bind continuation to `last_heartbeat_at` in the step loop, **not** the finalize window (settled boundary). Ship behind a flag.
- **God-file splits** (behavior-identical, one PR per file, full gates each): `tool-registry.ts` 384 KiB · `ChatWindow.tsx` 130 KiB · `src/lib/intel.ts` 122 KiB · edge `index.ts` 108 KiB · `src/index.css` 100 KiB.
- **No production monitoring** since #483. `edge-health.yml` still exists but is `workflow_dispatch`-only. Stand up an external uptime monitor, not a GitHub cron — the cron is what drained the Actions allowance.

---

## 6 · Documents that will mislead you

| Document | Correction |
|---|---|
| `CLAUDE.md` | Frontend baseline `1818 / 1 / 149` → **`1918 / 1 / 155`**. Third recurrence of this defect — **fix it this session.** |
| `CLAUDE.md` | Handoff index names 2026-08-31 as newest; the 09-03 and 09-07 handoffs supersede it |
| `CLAUDE.md` | Dated-state block still describes `main = 35ff20b`; it is `a19f065` |
| Old `NEXT_SESSION_PROMPT` §A | Name-pivot guard — **DECLINED.** Do not implement or propose |
| Old `NEXT_SESSION_PROMPT` §B | **Ruled 2026-09-07** — open in narrowed form; see §2 |
| Game Plan | Merge order lists #548 (closed); says "~20 stale branches" (79 merged of 410); `840/695` duplicates → `852` / 11,079 |

---

## 7 · Hard rules — do not re-litigate

- **No auto-merge, no auto-deploy.** The operator authorizes each merge and each deploy.
- **A mirror push is not a deploy.** Only a moved `/health` build SHA proves one. `deployed_bytes_verified` is `false` by design — the marker proves provenance, not byte identity.
- **The mirror is writable by a second agent.** Sync only files that actually changed; never blanket-overwrite. Check `git log origin/main` in the mirror after every sync.
- **Integrity-critical changes** (evidence ranking, confidence caps, chain-of-custody, merge semantics) require **explicit written sign-off before code.**
- **Quarantine is disclosure, not deletion.** A change that makes a quarantined row disappear is a regression.
- **`REVEAL_BREACH_DATA` stays ON. `MAX_PAID_CALLS` stays bounded. Intent is never inferred from prose.**
- **Never touch `toolChoice`, `stopWhen`, the finalize window, or termination logic** — two production outages trace to exactly that. Invariants I-1 and I-2 are load-bearing.
- **No real investigated selectors** in code, comments, tests, or PR bodies. Thread IDs and artifact IDs only.

---

## 8 · Traps that have cost real time

1. **Measure the SDK, not the comment about it.** Two sessions built against "`useChat`'s store survives an unmount." On the lockfile-pinned `@ai-sdk/react@3.0.199` it does not — `useChat` builds its `Chat` in a `useRef`, so the store is per-mount. Corrected in `ChatWindow.tsx` by #551.
2. **`package.json` ranges ≠ resolved versions.** Read `package-lock.json`. A PR body cited `3.0.193`/`6.0.191`; the lockfile resolves `3.0.199`/`6.0.197`.
3. **A behavioural test can pass vacuously.** Assert that something *happened* (a positive signal) before asserting something didn't render. A missing method on a mock made a whole suite pass while no run ever started.
4. **The dev harness cannot exhibit every defect.** Its in-process mock resolves reads instantly, so timing-window bugs have zero duration there. It proves boundaries, not fixes.
5. **`ok:true` is not "it ran."** Read `detail` on `/health`.
6. **The clone is shallow.** `git fetch --unshallow --filter=blob:none` before trusting any divergence or merge-base measurement.
7. **`deno test` rewrites `deno.lock`** — check `git status` before staging.
8. **SQL three-valued logic drops NULL rows** — wrap nullable booleans in `coalesce(..., false)`.
9. **Check the PR list before starting work.** See §1.

---

## 9 · Definition of done for this next block

- [x] §2 ruling written into this file (operator, 2026-09-07)
- [ ] #550 merged and live on Vercel
- [ ] #549 merged, mirror-synced, deployed, `/health` build SHA **moved** off `7b0138d`
- [ ] #547 migration validated in CI and applied
- [ ] #502 vs #516 ruled on; #529/#519 rebased and ruled on
- [ ] `CLAUDE.md` baselines and handoff index refreshed
- [ ] 79 merged branches deleted; handoff docs moved to `docs/handoffs/`; `bun.lockb` removed
- [ ] Actionable-rate re-measured on a fresh 14-day cohort against the 8.6 % baseline
