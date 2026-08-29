# Audit + merge plan — 2026-08-29

> **Every number in this document is a measurement taken on 2026-08-29 against a primary
> source, not a claim copied from a handoff.** Where something could not be re-measured, it
> says so. Like every other dated document in this repo: this is a measurement, not a state —
> re-check `/health`, `list_deployments` and `list_pull_requests` rather than trusting it.

**Scope.** Re-measured both deploy axes, all five gates, the seven open PRs (each analysed then
adversarially re-checked), the Lovable backend axis, 382 branches, and the defects the repo
declares open. Corrections the audit made to *itself* are kept in place, marked, and are among
the more useful parts of the document.

---

## ⛔ STANDING CONSTRAINT — breach-data visibility is FROZEN

**Do not change** `REVEAL_BREACH_DATA`, breach-reveal behaviour, masking, redaction,
credential display, UI visibility, export visibility, or any related default.

Everything remains shown for now because **JD is the sole user**. This will be revisited
before public or multi-user release. **Treat any direct *or indirect* change to this
behaviour as out of scope and stop for explicit approval.**

This is broader than `CLAUDE.md`'s existing "REVEAL_BREACH_DATA stays ON" item: it covers the
whole visibility surface, not just the one flag, and it binds indirect changes too.

### Scope — precisely what the freeze does and does not cover

**Covered.** Breach evidence **shown to JD in the UI and in exports**. Everything stays visible.

**NOT covered — these proceed normally:**

- **Real third-party PII in fixtures, test constants and runtime comments.** Sanitising that is
  *required* (the #491 ruling) and has nothing to do with breach-reveal behaviour for JD's own
  investigations. The freeze is not a reason to keep a real person's home address in
  `tool-registry.ts`.
- **Application secrets.** The freeze never justifies exposing an API key, token, or credential.
- **Unrelated log and security redaction.** #502's SSRF guard, CSP header, and log-channel
  redaction work are outside the freeze and proceed.

> ### ⚠️ Live interaction with this cycle's work
> **Split out any #502 hunk that would MASK or HIDE breach evidence** and hold it for explicit
> approval — that is the direction that violates the freeze. The rest of #502's
> credential-redaction work (logs, error channels, SSRF, CSP) proceeds. Identify these hunks
> during the rebase, before merge.
>
> An earlier draft of this section said "any hunk that alters what is displayed, masked, or
> redacted." That was too broad and would have blocked legitimate log-redaction work. The
> correct test is: **does it reduce what JD can see?**

**This constraint must be restated in every implementation handoff and in the pre-merge and
pre-deploy checklists.**


## Context

JD asked for a current-state audit — open PRs, the Lovable backend axis, branches — and a
plan. The project's standing problem, written into `CLAUDE.md` itself, is that "we do all
these upgrades and it never changes the app": finished, green, reviewed work piles up in
unmerged PRs while the deployed app stands still. This audit re-measures both deploy axes
and the whole PR/branch backlog against primary sources, then proposes the order in which
to clear it.

---

## §1 · Confirmed measurements (primary sources, this session)

| Axis | Measured | Verdict |
|---|---|---|
| Canonical `origin/main` | `0513782` | — |
| Vercel production | `dpl_6pUtxCckzJHoizCfQNuj4zqAqt7t`, READY, `target:"production"`, sha `0513782` | **Current — equals `main`** |
| Live edge `/health` | `build:"cf06cbb"`, `ok:true`, v1.2.2, `checks.synthesis:{ok,"disabled"}` present | **Current** (see below) |
| `deploy/live` ref | `cf06cbb` | consistent |
| Commits `cf06cbb..origin/main` | 3 — all docs / ledger / build stamp. Only edge file touched is `build-info.ts` | **No unshipped runtime code** |
| Mirror parity `diff -rq` × 4 fn dirs | **empty** (osint-agent, evidence-export, security-test-lab, _shared) | **Equal** |
| Lovable project `4ce11bc3…` | `status:ready`, `agentFinished:true`, `latest_commit_sha:61905d0` | synced |
| `npx vitest run` (clean `npm ci`) | **1611 passed / 1 skipped / 131 files**, exit 0, 40.7s | matches documented baseline |
| `deno test` edge suite | **1446 passed / 0 failed / 5 ignored**, exit 0, 58s | matches documented baseline |
| `npm run typecheck` | exit 0 | clean |
| `npm run lint` | 0 errors, 10 pre-existing `react-refresh` warnings | clean |
| `npm run build` | ✓ 9.79s | clean |
| Open PRs | 7 — #514, #513, #512 (drafts, opened today); #502, #493, #491, #435 | see §3 |
| Remote branches (canonical) | 375 | see §4 |

### The `mirror_tree_equality: "differs"` scare — resolved, and it is not a contradiction

`CLAUDE.md`'s dated-state block says "mirror tree EQUAL to canonical"; the deploy-ledger row
for the same build says `"differs"`. Both are true at their own timestamps — they are two
measurements 107 seconds apart:

| UTC | Event |
|---|---|
| 01:06:20 | mirror `f0d2724` — runtime files synced |
| **01:09:03** | canonical `1ffb956` writes the ledger row → measures mirror at `f0d2724` → **`differs`** (test files not yet across) |
| 01:09:50 | mirror `c02cb9c` — test files synced → now equal |
| **01:11:01** | canonical `0513782` writes CLAUDE.md → **`EQUAL`**, correct as written |
| 01:24:12 | Lovable's `gpt-engineer-app[bot]` pushes 11 commits → **diverged again, 13 minutes later** |
| 04:42:57 | mirror `61905d0` reverts the drift → equal again (verified by me at ~05:0x) |

The real lesson is the last two rows: the CLAUDE.md line went stale **13 minutes** after it
was written, by a second agent this repo never sees. That is the standing hazard, restated
with a fresh instance.

**The headline: both deploy axes are genuinely current, and both gates are genuinely
green.** The SHA gap between `/health` (`cf06cbb`) and `main` (`0513782`) is the
documented split-channel + stamp-offset artifact, not a stale deploy — I enumerated all
three intervening commits and none changes executed code.

---

## §2 · The verdict

**Deploy state is current and the baseline gates are green. Production is not defect-free.**
Those are two different statements and an earlier draft of this audit wrongly collapsed them
into "nothing is broken."

| Axis | Verdict |
|---|---|
| Deploy state (both axes) | **current** — Vercel = `main`, edge `cf06cbb` with no unshipped runtime code, mirror equal |
| Baseline gates | **green** — 1611/1446/typecheck/lint/build all pass on a clean install |
| **Production behaviour** | **has confirmed defects** — see below |

Confirmed broken or wrong in production *right now*:

- **The Analysis tab is dead** (§4) — a nonexistent column takes down the whole Intelligence page.
- **The only health monitor reports a false failure** (§10) — it asserts a `/health` key that no longer exists.
- **Shared-infrastructure confidence inflation** (§5) — an address match alone can carry a cluster to the CONFIRMED band.
- **Discovery-tier evidence cannot corroborate** (§6) — resolution order makes the ≥2-class bar unreachable for people-search hits.
- **The dispatch boundary is open** (§11) — quarantined selectors still reach tool dispatch.
- **Stale-run recovery is not running unattended** (§9) — the pg_cron that was believed to drive it never applied.

Two facts frame the plan:

1. **Three of the seven open PRs are drafts opened today and a draft cannot merge.** That
   is the mechanism behind "we do all these upgrades and it never changes the app."
2. **Merging #502 / #493 / #491 / #512 / #513 obligates a backend deploy.** All five touch
   the live edge tree — **#512 included**: `index.ts:69 → tool-registry.ts:120 →
   tools/serus.ts:19 → serus_core.ts` (§10). Only #514 and the account-deletion slice do not.

---

## §3 · Per-PR disposition

Every row below was re-measured (`git merge-tree` reproduced locally on the unshallowed
clone), then adversarially re-checked by a second agent. The verifier **overturned** the
first pass on #514 and materially corrected it on #493 and #512.

| PR | State | Conflict | Edge runtime? | Disposition |
|---|---|---|---|---|
| **#493** telemetry `outcome:"empty"` | ready, green | none | **yes** | **Merge first** |
| **#491** google_dorks address seeds | ready, green | none | **yes** | Merge — **after your PII call** |
| **#502** audit + run-wedge + #476 | ready, **conflicted** | 3 files / 4 hunks | **yes** | **Split, rebase, merge** |
| **#512** serus `skipped` type | **draft**, green | none | **yes** — see note | Fix 2 doc errors + add a real typecheck gate, then merge |
| **#513** cache sweep on health path | **draft**, green | none | **yes** | pending |
| **#514** deploy-gate docs | **draft**, green | none | no | **Do not merge as written** |
| **#435** paid-call accounting | ready, green (**stale CI**) | none | **yes** | Blocked on *your* ruling |

### #502 — the rebase is ~1 hour, not days

The `+2754/−192` across 39 files is misleading. `git merge-tree --write-tree origin/main
0896e00` exits 1 with **exactly three conflicting files and four hunks**, and only 6 of the
39 files were touched by main at all.

| Conflict | Resolution |
|---|---|
| `CLAUDE.md` (2 hunks) | Trivial — take main's baselines verbatim; #502's `1420/1504` are the stale numbers |
| `tool-registry.ts` (1 hunk) | **Forced against the PR.** Its 22s→9s socialfetch cut rests on 13 calls / 36h; #511 already refuted that with 30 days / 127 calls / max successful 15,908ms. Main's `tool_timeout_caps_test.ts:174` asserts `18_000` — resolving in #502's favour makes CI red |
| `health-handler.ts` (1 hunk, ~20 lines) | The only real thinking. Nest main's recovery+synthesis inside #502's throttle `else`-branch |

> **⚠️ The trap in the third conflict.** If the throttle's early-return is placed ahead of
> the synthesis block, throttled `/health` probes return **no `checks.synthesis` key** — the
> very key `CLAUDE.md` designates as the behavioural proof-of-deploy. `pg_cron` hits
> `?health=1` every 60s against a 60s throttle, so a manual curl would often land on the
> throttled path and appear to prove a stale deploy. Main's only guard,
> `finding_synthesis_sweep_test.ts:239`, is a source-text `includes()` check and will not
> catch it. **Set `r.checks.synthesis` on the throttled path too.**

**Two slices to drop, one to split out:**

- **Drop** the `circuit.ts` `TIMEOUT_SUPPRESS_CONSECUTIVE_OVERRIDE = {socialfetch_web_read: 2}`.
  It rests on the same refuted 13-call sample, silently reverses #510's deliberate "strike
  COUNT is unchanged", **auto-merges with no conflict marker**, and no test covers it.
- **Split out** the #476 account-deletion slice — the migration, the CI assertions, `ci.yml`,
  `Settings.tsx`, `types.ts`, and its contract test. All sit in the 33 non-overlapping files,
  touch **zero edge runtime**, and ship on Vercel + migration alone. **Closes a beta blocker
  with no Lovable deploy.** Renumber the migration above `20260828200000` first.
- **Still genuinely needed** (grep-verified absent from main): `enforceToolPairing`,
  `delete_my_account`, `RECOVERY_SWEEP_MIN_INTERVAL_MS`, `invalidateSelectorSignals` — all 0
  hits. Only the socialfetch slice is superseded.

**Its CI green is not evidence.** It ran 2026-08-25 against a base 18 commits back and never
executed main's `tool_timeout_caps_test.ts`. And there is **no human review** on 2754 lines
spanning SSRF/CSP/credential redaction, the orchestrator termination path, and a destructive
`SECURITY DEFINER` account-deletion RPC.

### #514 — do not merge as written

The first pass called it a free win: docs-only, zero conflict, zero runtime. The adversarial
pass **refuted its substance**. The procedure it enshrines is inverted:

`scripts/record-deploy.mjs:88-114` resolves the canonical side by pickaxing `build-info.ts`
for the marker **returned by `/health`** — i.e. from the *live deployment*, not from the code
being shipped. Run at step 4 (pre-deploy) that is the OLD tree by construction, and because
`BUILD_INFO_PATH` sits inside the compared directory, step 2's stamp alone forces a mismatch.

> Measured: at step 4 of the actual `cf06cbb` deploy, canonical `738c64e5` vs synced mirror
> `e6a012d`. **The gate returns `differs` on every genuine deploy and `equal` mainly when the
> sync failed to land** — it green-lights the stale-deploy case, blocks the healthy one, and
> then tells the operator to "resolve the difference" by reverting their own sync.

Two further defects, both reproduced: bare `npm run verify:deploy` prints
`mirror tree : (no mirror checkout) -> not_run` — the command as written in the PR **cannot
satisfy its own gate**; it needs `-- --mirror <clone>`. And `record-deploy.mjs:184` exits on
`markerProvenanceOk` alone, so **the tree status is decoupled from the exit code in both
directions** (verified: exit 1 with the mirror equal).

The *intent* is right and the incident it documents is real. The text is wrong.

### #491 — cleanest code of the seven, one owner decision

Conflict-free, contract test passes, every technical claim reproduced. Blocked only on a
question that has sat unanswered in the PR thread since 2026-08-28: a real person's full name
and residential address appear **61 + 16 times across 9 files**, including a comment in the
live runtime file `tool-registry.ts:3091` and as hardcoded test constants. Irreversible on
merge. The verifier also flagged that the `kind_mismatch` refusal feeds the circuit breaker —
three of them disable `google_dorks` for the whole thread.

### #435 — zero code work, one ruling from you

Merges clean, and clean pairwise against #493 and #502. You parked it 2026-08-20 on a
semantics question that is still unresolved: does `MAX_PAID_CALLS_PER_RUN` bound **spend**
(refund pre-provider gates) or **fan-out** (charge on admission)? This is *not* the settled
"cap stays bounded" decision — it is about accounting, not the cap value. The verifier found
its 9 new tests **do not drive the shipped control flow**; the integration seam is unpinned.

### #493 — merge first

Small, clean, self-contained; its tests pass on the actual merged tree (21/21 own file, 93/0
across cache/outcome/circuit/billing). Two corrections from the verifier: it is **not**
"telemetry-only" — `20260701_tool_health_view.sql` aggregates reliability off `outcome`, which
feeds `scoreExpectedValue`, so this changes tool-selection behaviour; and one inline comment
about `ransomwarelive_lookup`'s `listed:false` branch is factually wrong.

### #512 — real fix, false justification

The defect is real (`deno check tools/serus_core.ts` → TS2353 at :344, reproduced on main).
But the 15-line JSDoc it commits **into a live runtime file** states that `serus_core.ts` is
outside the `deno check index.ts` graph — **verified false**: `index.ts:69 → tool-registry.ts:120
→ tools/serus.ts:19 → serus_core.ts`. The verifier also found a live consumer the first pass
missed: `circuit.ts:576` does `if (r.skipped === true) return "ok"`. And one of its three tests
is vacuous.

> **Corrected classification.** An earlier draft of this table said "edge runtime: no." That
> contradicts §10 and is wrong. `serus_core.ts` **is live-tree code**. The declaration change
> is type-erased and therefore behaviourally inert, but the file ships, the tree hash moves, and
> the PR carries a deploy obligation. Inert ≠ not deployed.

**This PR must also close the gate that let the hole exist.** The reason nothing caught it is
that `test:edge` runs `--no-check` and nobody typechecks the live import graph. Add a real
`deno check --no-lock` gate over that graph (at minimum `index.ts` plus the seven imported
`tools/*.ts`), asserting **no new errors** against the documented pre-existing baseline — not a
clean-zero gate, which the AI-SDK type graph cannot meet.

---

---

## §4 · Confirmed live defect — the Analysis tab is broken in production

I verified this one myself, independently of the prior session's report.

`src/components/panel/AnalysisTab.tsx:88` orders `evidence_log` by **`created_at`, a column
that does not exist.** Per `src/integrations/supabase/types.ts`, `evidence_log`'s timestamp
is **`collected_at`** (its other ordering key is `seq`). It is the *only* one of the four
queries with a bad column — `artifacts`, `tool_usage_log` and `threads` all genuinely have
`created_at`.

The blast radius is the whole tab, not one tile: all four queries share a `Promise.all`, and
the `failed.length` check **throws** on any one error, so the 400 lands in `setError` and the
tab renders as a single error state. `AnalysisTab` is mounted at
`src/pages/BrainGlobalPage.tsx:368` under `subTab === "analysis"`.

**Fix is one word:** `.order("collected_at", { ascending: false })`. Frontend only — ships on
Vercel, no Lovable deploy. This should be its own tiny PR and go out first.

---

---

## §5 · Confirmed — a shared address alone can mint a CONFIRMED-band cluster

The prior session reported this as "no cap equivalent to `HANDLE_ONLY_CLUSTER_CAP` for
shared-address merges." I verified it and the real mechanism is worse: **a shared address
doesn't bypass the cap — it disarms it.**

In `src/lib/intel.ts`:

| Step | Line | What happens |
|---|---|---|
| 1 | `:1941` | a matching `meta.address` ≥6 chars emits a **`SHARED_INFRASTRUCTURE`** signal |
| 2 | `:1801` | that signal is worth **+20** confidence |
| 3 | `:2132` | `hasIdentityCorroboration` is true if `addresses.length > 0` **or** `signalsPresent.has("SHARED_INFRASTRUCTURE")` |
| 4 | `:2138` | the **only** cap, `HANDLE_ONLY_CLUSTER_CAP = 60`, applies *only when `!hasIdentityCorroboration`* |

So an address match satisfies the corroboration test **by its own presence**, exempts the
cluster from the sole cap, and walks confidence to 85 — the CONFIRMED band — while every
underlying artifact sits at 65/VERIFY and the report's own Key Findings section says nothing
reached CONFIRMED. The cap's comment at `:1813` states its purpose exactly: cluster
confidence "can't inflate into confirmed/high-confidence territory and contradict the
per-artifact labels." That is precisely what it now fails to prevent.

**Worse, the same signal is emitted for a shared IP (`:1916`) and a shared parent domain
(`:1919`).** That is the identical false-link driver `CLAUDE.md`'s report-layer section
already indicts — shared Vercel hosting used to attribute a domain to a named private
individual. The backend's `detectContradictions` flags shared-infra as a *contradiction*;
the frontend counts it as *corroboration*. **The two layers disagree about what the same
signal means.**

> ⚠️ This is an **evidence-integrity** change (confidence caps), which `CLAUDE.md` says needs
> explicit sign-off. It goes in the plan as a proposal for you, never a drive-by.

---

---

## §6 · Confirmed — the corroboration bar is structurally unreachable for some evidence

`supabase/functions/osint-agent/source-classification.ts`. The tool-slug table resolves
**before** the provenance regex, and the slug table maps the discovery tools to a class that
cannot corroborate:

- `:329` — `if (TOOL_CLASS[slug]) return TOOL_CLASS[slug];` runs first and returns immediately.
- `:168-183` — `minimax_web_search`, `exa_search`, `gemini_vision`, `gemini_deep_dork`,
  `google_dorks`, `osint_navigator_*` all map to **`ai_summary`**.
- `:482` — `ai_summary` is in **`NON_CORROBORATING_CLASSES`**, so `countIndependentClasses`
  (`:496`) drops it.
- `:381` — the regex that would classify `spokeo|whitepages|radaris|intelius|beenverified…`
  as **`public_record`**, the highest tier, is at line 381 and therefore **unreachable for
  anything carrying a tool slug**.

**Consequence:** evidence *surfaced through* a discovery tool contributes **zero** independent
classes no matter how authoritative the underlying source is. Three Spokeo-sourced names
counted for nothing; the run had exactly one class and could not reach the ≥2-class CONFIRMED
path — not because the evidence was weak, but because of resolution order.

Put beside §5, the pair is striking: **shared hosting can manufacture a CONFIRMED-band
cluster, while a public-records hit cannot corroborate one.** Both are the same failure —
a classification decision made one layer below what the analyst reads.

> ⚠️ Also evidence-integrity. Needs your sign-off, not a drive-by.

---

---

## §7 · Branches — **375** GitHub refs; the deletion set must be certified, not inferred

This section took five passes. The first four were wrong in the direction of "just delete
them," and the correction below is the single most important reversal in this audit.

### Branch accounting, normalized to GitHub `refs/heads/*`

An intermediate pass reported **382** refs. That was wrong: it counted local remote-tracking
refs, which include artifacts **my own audit agents created**. Reconciled against
`git ls-remote --heads origin` (GitHub's authoritative `refs/heads/*`):

| Measure | Count |
|---|---|
| **GitHub `refs/heads/*` — the only valid manifest source** | **375** |
| Local remote-tracking refs in this clone | 382 |
| **Local-only artifacts — excluded from every manifest** | **7** (`pr-435`, `pr-491`, `pr-493`, `pr-502`, `pr-512`, `pr-513`, `pr-514`) |
| Present on GitHub but missing locally | 0 |

The manifest must contain **only** actual `refs/heads/*` branch names returned by GitHub — never
`refs/pull/*`, never local `pr-*` refs, never tracking artifacts.

### ⛔ Retracted: an earlier draft said "safe to bulk-delete." That was unsound.

Two independent errors, both yours to have caught:

1. **"The file exists on `main` and `main` has more lines" does not prove a branch's *unique*
   changes landed.** A branch can touch a file main also has, with main far ahead, while a
   specific hunk was never merged. Presence and line-count are proxies, not proof.
2. **Six samples cannot establish a property of 305 branches.** Sampling the six most likely to
   *contain* lost work is a fine way to look for a positive and no way at all to prove a
   negative across the population.

An earlier pass produced a 335 / 14 / 33 split. **Those numbers are superseded** — they were
computed on the contaminated 382-ref base and used commit-subject matching (`(#N)` on `main`) as
proof that a PR landed. **Subject-matching is supporting evidence, not certification.** The
split is being recomputed on the 375-ref base against the four criteria below, and the result
ships as a manifest, not a count.

**What survives from that pass**: a bulk delete would have destroyed roughly 33 branches
carrying content `main` does not have — including the repo's only Playwright suite.

### The decision set, as last measured (subject to recount on the 375-ref base)

- **19 branches whose merge cleanly ADDS content absent from `main`** — 9 docs/handoffs,
  **8 code**, 1 CSS one-liner, 1 set of demo-video scripts. Established with
  `git merge-tree --write-tree origin/main <branch>` compared against `origin/main^{tree}`.
- **14 branches that never had a PR at all** — no `refs/pull/*/head`, so nobody ever opened,
  reviewed, or closed anything for them.

### ⛔ ALL decision branches are QUARANTINED

No decision branch is deleted, merged, or rebased until individually reviewed and explicitly
authorized. **Two require immediate preservation and active investigation:**

**1 · `test/e2e-playwright-smoke`** — preserve, then evaluate **separately against current
`main`**, not merged on sight. The evaluation must establish: stale selectors, fixture drift,
any secrets or credentials it expects, whether it runs at all against today's UI, and whether
it can become a dedicated E2E PR. `CLAUDE.md`'s "there is no `test:e2e` script" is a consequence
of this branch never landing, not a design decision — but a two-month-old smoke suite is a
candidate, not a gift.

**2 · `lovable-sync-1784512454`** (in the **mirror**, not canonical) — **deep-audit before the
combined backend deploy.** 13 commits from 2026-07-20, twelve by `gpt-engineer-app[bot]`,
carrying a hard finalize tool-gate (`isToolAllowedInFinalize`) that is **absent from canonical
`main`**. Determine: its origin, its intended behaviour, whether it has tests, and its
relationship to #502 — which also touches the finalize/recovery path. **Do not merge, delete, or
assume it belongs in canonical.** It touches the finalize window, which owns this project's
worst incidents (see `CLAUDE.md`'s run-termination invariants), so it is a read-and-decide.

### Deletion protocol — when it is eventually authorized

- Delete **only** from an explicit manifest of GitHub `refs/heads/*` names with tip SHAs.
- **No globs, no patterns, no `xargs` over a filter.** Explicit targets only.
- Small batches, with the manifest retained as the record of what was removed and why.
- **Only after JD's approval**, batch by batch.

> **The highest-value single item: `origin/test/e2e-playwright-smoke`** (2026-06-12) —
> `playwright.config.ts` plus a two-spec E2E suite, with **no equivalent anywhere on `main`**
> and no PR ever opened. `CLAUDE.md`'s "there is no `test:e2e` script" is a *consequence of this
> branch never landing*, not a design decision. Worth a look before anything is deleted.

### `CLAUDE.md`'s "leave unless asked" note is stale — Confirmed

It names `claude/upbeat-darwin-y842dl`, `left/beta-p0`, `insight-finder-tier0`. Searching every
ref in this clone: **two do not exist at all**, and the third's likely counterpart `feat/beta-p0`
**landed as PR #174**. The note is stale for any remote/web session and should be replaced with
the 33-branch decision list.

### ⚠️ The mirror holds un-backported Lovable work

`origin/lovable-sync-1784512454` in the mirror — 13 commits from 2026-07-20, twelve by
`gpt-engineer-app[bot]` — carries a **hard finalize tool-gate (`isToolAllowedInFinalize`) that is
absent from canonical `main`.** This is exactly the hazard `CLAUDE.md` warns about, and it is a
live instance, not a historical one. It interacts with the finalize window, which owns this
project's worst incidents — so it needs reading before anyone decides whether to backport it.

### Safe-deletion criteria — a branch qualifies only if **all four** hold

1. Associated with a **merged** PR.
2. Remote tip **equals that PR's final head SHA**.
3. **No commits added after the merge.**
4. Not an open PR, protected branch, deploy ref (`deploy/live`), Lovable branch, or a
   specifically preserved branch.

Closed-unmerged and no-PR branches are **inventoried and reviewed individually**, never bulk
deleted.

> **Method note for `CLAUDE.md`:** in a squash-merge repo, `git branch -r --no-merged` badly
> overstates unshipped work — but "the files are on main" badly *understates* it. The sound test
> is `git merge-tree --write-tree origin/main <branch>` compared against main's tree, per branch.
---

---

## §8 · The deploy gate #514 wants to make mandatory asks the wrong question **and cannot fail**

I read `scripts/record-deploy.mjs` and `scripts/lib/deploy-provenance.mjs` myself rather than
take the agent's word. Both defects are real, and together they are worse than either alone.

> **Correction to my own first reading.** I initially wrote that the gate "reports `differs`
> on every genuine deploy." A second pass with better evidence **refutes that**: 8 of the 10
> ledger rows read `equal`, and the stamp doesn't force a mismatch because the sync copies the
> stamped `build-info.ts` across. Both `differs` rows were caused **entirely by `*_test.ts`
> files, which are never deployed.** The defects below are the ones that survive scrutiny.

**1 · The canonical side is pinned to the LIVE marker, so it is anti-informative pre-deploy.**

```js
// record-deploy.mjs — stampCommit is found by pickaxing for the marker /health RETURNED
const stampCommit = gitOrNull("log","--all","--format=%H","-1",
  "-S", `export const BUILD_MARKER = "${live.build}";`, "--", BUILD_INFO_PATH)
...
sourceTreeDigest: gitOrNull("rev-parse", `${stampCommit}:supabase/functions/osint-agent`)
```

`live.build` is what `/health` reports — the **currently deployed** build. So
`canonicalTreeDigest` is the tree of the build *already running*, never the one you are about
to ship. As a **pre**-deploy gate that is the wrong question by construction: it can only tell
you about the deploy you already did.

**2 · Even if it were right, it cannot block anything.**

```js
if (!record) process.exit(verdict.markerProvenanceOk ? 0 : 1);   // record-deploy.mjs:184
```

In read-only (`verify:deploy`) mode the exit code depends **only** on `markerProvenanceOk`.
`compareSourceTrees` is computed separately and merely *printed* — its `status` never reaches
the exit code. A "HARD precondition" wired to this command is not a gate; it is a log line.
(Reproduced: exit 1 *with the mirror equal*.)

**3 · The command as written in #514 can't even run the check.** Bare
`npm run verify:deploy` prints `mirror tree : (no mirror checkout) -> not_run`. It needs
`-- --mirror <clone>`.

**4 · Its scope includes files that are never deployed.** Both historical `differs` rows were
caused solely by `*_test.ts` files. The mirror has no test suite and tests are not part of the
bundle, so the gate's only two "failures" ever were false alarms.

**5 · A separate, previously unreported bug in the same script (P1).** The stamp commit is
found with `git log -1 -S <marker>`. **`-S` is a pickaxe on occurrence-count *change*, so it
matches the commit that DELETED the marker just as readily as the one that added it** — and
`-1` takes the newest. Once a newer stamp exists, it resolves to the *remover*:

```
$ git log --all --format=%H -1 -S 'export const BUILD_MARKER = "b234550";' -- .../build-info.ts
c6828579…                                    # the commit that stamped cf06cbb
$ git show c682857:.../build-info.ts | grep BUILD_MARKER
export const BUILD_MARKER = "cf06cbb";       # …which holds a DIFFERENT marker
```

So provenance verification of any build that is no longer current silently checks the wrong
commit. Fix: `--reverse … | head -1` (oldest match = the adder), or match on the stamp commit
message instead.

**#514's intent is right and its incident is real** — the Lovable bot really did push 11
unreviewed runtime commits that would have ridden along on the next deploy. But the text
enshrines an instrument that cannot fail, asks the wrong question pre-deploy, and counts
undeployed test files. **The right pre-deploy comparison is the tree you are *shipping*** —
`HEAD:supabase/functions/osint-agent` (or the stamp commit you just made, *not* one derived
from `/health`) against the mirror's, over a file set that excludes `*_test.ts`, **with the
result wired into the exit code.** That is a real fix and a small one; it just isn't the
zero-code docs change #514 claims to be.

---

---

## §9 · #513 and #502 both rewrite the same block — and the obvious resolution won't compile

This overturns my earlier ordering. **#513 must merge before #502**, and the health-handler
conflict has a specific correct shape.

`#502` moves `const admin = createClient(SUPABASE_URL, SERVICE_KEY)` from the top of the
`if (SUPABASE_URL && SERVICE_KEY)` body **down into its throttle's `else` branch**. #502
branched before #511, so its copy of the file has no synthesis block at all. But main's
synthesis block *and* #513's cache-sweep block both reference `admin` at the outer scope.

> **Accepting both sides of that conflict puts `admin` out of scope for two blocks that use
> it — a `deno check` error and a runtime `ReferenceError` inside the health path.** This is
> the resolution a hurried rebase would reach for.

**Correct resolution:** merge #513 first, then rebase #502 and widen
`RECOVERY_SWEEP_MIN_INTERVAL_MS` to gate the *entire* maintenance body — one `admin`
declaration, all three sweeps inside the `else`, and all three checks emitted as `throttled`
on the fast path (which also satisfies §3's `checks.synthesis` trap).

### #513 itself: mergeable, but fix two things first

- **`CACHE_SWEEP_BATCH = 5_000` cannot work.** `.in("id", ids)` renders as a query parameter;
  `tool_call_cache.id` is `uuid` (36 chars) and commas percent-encode to `%2C`, so 5,000 ids
  is a **~195 KB URL**. Every gateway on the Supabase REST path caps far below that. Once
  enabled it would error on every invocation and delete nothing. Set the batch to ~100, or
  chunk the delete.
- **Its containment test asserts source text, not behaviour** — `HEALTH.indexOf("r.ok = gate.ok")`
  vs `HEALTH.indexOf("r.checks.cache_sweep")`. The *claim* is true (I had the agent verify it
  positionally: `r.ok` is assigned once at `health-handler.ts:359`, read at `:497`/`:528`,
  never reassigned; the new block lands at `:411-428`), but this is the **second** violation
  in that directory of `CLAUDE.md`'s rule that a test must drive shipped control flow.

### Production facts, measured against the live DB

pg_cron `installed_version` is **null**, the `cron` schema **does not exist**, and neither
`20260828200000_tool_call_cache_expiry_sweep.sql` nor `20260720031500_pg_cron_health_sweep.sql`
appears in `supabase_migrations.schema_migrations` (newest there: `20260825024640`).
`tool_call_cache` holds **11,120 rows, 11,041 expired**, oldest expiry 2026-06-25.

> ### ⚠️ This invalidates #502's stated rationale for its Fix #1
> #502 argues the recovery sweep must stay unauthenticated because
> `20260720031500_pg_cron_health_sweep.sql` "schedules `?health=1` every 60s with no secret,
> precisely so recovery runs when no browser tab is open." **That cron does not exist and never
> applied.** So production stale-run recovery currently runs *only* when someone has the app
> open and probes `/health`. That is a real gap, it is not what anyone believed, and #502's
> justification comment must be corrected before it merges.

---

---

## §10 · Backend axis — three doc claims are false, and one of them is load-bearing

### ⚠️ `tools/*.ts` is **not** dead code. Seven of those files are on the live runtime path.

`CLAUDE.md` says *"these files are auto-extracted dead code — nothing imports any of them (the
live tool defs are in `tool-registry.ts`)"*. Commit `61905d0`'s revert rationale repeats it
(*"20 of the 21 are in `tools/*.ts`, which nothing imports"*), and #512's JSDoc repeats it a
third time. **All three are false.** Verified:

```
attachment-intake.ts:19  import { runGeminiVision } from "./tools/gemini_vision.ts"
tool-registry.ts:62      ./tools/dns-virtual.ts
tool-registry.ts:88      ./tools/indicia.ts
tool-registry.ts:89      ./tools/peopledatalabs.ts
tool-registry.ts:90      ./tools/gemini_vision.ts
tool-registry.ts:91      ./tools/geoseer.ts
tool-registry.ts:120     ./tools/serus.ts   →  serus_core.ts:19
```

And `index.ts:69` imports `tool-registry.ts`, so the whole chain is live —
**including `serus_core.ts`, the file #512 fixes.**

This is load-bearing because `CLAUDE.md` uses "nothing imports them" to argue that mirror drift
in `tools/` is harmless by construction. It isn't. The 2026-08-29 drift *was* harmless, but for
a much narrower reason: `tool()` is literally `function tool(t) { return t }` in **both**
`npm:ai@6` and `@ai-sdk/provider-utils@4.0.27` — independently verified by importing both and
printing the source. **A future edit to any of those seven files reaches production.** The
`CLAUDE.md` paragraph must name the split explicitly instead of blanket-declaring the directory
dead.

### The one remaining health monitor is broken

`.github/workflows/edge-health.yml` survives as `workflow_dispatch` only (as documented). But
its final gate asserts **`.checks.minimax.ok`** — a key the live payload no longer emits
(`checks` is now `{tools, recovery, synthesis}`). `jq` returns `"null"`, the comparison fails,
and the workflow exits 1 with *"minimax reachability check failed"* **on a perfectly healthy
system.** So the only manual instrument left reports a false failure every time it is run.
Replace the hardcoded name with `jq -e '.ok == true and ([.checks[] | .ok] | all)'` plus an
existence check on `.checks.synthesis`.

### `/health`'s `ok` still gates on `MINIMAX_API_KEY`

`health-handler.ts` computes `const orchestratorOk = has(env.MINIMAX_API_KEY)` and returns
`{ ok: orchestratorOk && coreOk }` — even though the orchestrator is DeepSeek-slot-pinned on
`glm-5.2` via Z.AI with MiniMax only as fallback. **Tidying up the now-secondary MiniMax secret
would flip `/health` to `ok:false` and black out the app.** Worth fixing before anyone audits
the secret list: gate on *any* viable orchestrator credential.

### Good news, both confirmed

- **`mcp` — #453's security-ordering fix IS in the deployed bundle.** The mirror's generated
  `index.ts` awaits the ownership check before the subordinate reads. `CLAUDE.md`'s "shipped
  with no way to confirm it landed" can be retired: it landed. `supabase/functions/mcp/` has
  never existed in canonical (`git log` empty), `src/lib/mcp/` does, and the generated bundle
  corresponds to it — same three tools, schemas, and version.
- **All three unmarked functions are live and fail closed.** Direct probes: `evidence-export`
  and `security-test-lab` both return `{"error":"Unauthorized"}` HTTP 401 on GET and POST, and
  their OPTIONS `access-control-allow-methods: POST, OPTIONS` matches canonical source byte for
  byte. That is a coarse but real instrument where the docs claim there is none — and it is one
  line each to fold into an external uptime monitor.

---

## §11 · Still open, confirmed by re-measurement

| Item | Status | Evidence |
|---|---|---|
| **Dispatch boundary (P1)** | **still open** | `grep -rn isSubjectUnlinked` across `tool-registry.ts`, `index.ts`, `tools/` → **empty** |
| Report layer bypasses integrity engine | still open | no `{{FINDINGS_TABLE}}`-style server expansion present |
| Shared-address → CONFIRMED cluster | **new, §5** | `intel.ts:1941 → :2132 → :2138` |
| Discovery tools can't corroborate | **new, §6** | `source-classification.ts:329` before `:381` |
| `AnalysisTab` 400 | **new, §4** | `evidence_log` has no `created_at` |
| No production health monitoring | worse than documented | the one manual probe is itself broken |
| `subject_unlinked` write/pivot/promote boundaries | **no regression** | `isClusterIneligible` at `report-hygiene.ts:178`, still separate from `isCollisionArtifact`, 5 production call sites; backend twin `isExcluded` at `lib/cluster.ts:141` |

---

## §11a · Production corpus — measured against the live database

All read-only `SELECT`s against project `4ce11bc3-039d-4439-b293-acacca9e1e3a`. Several
headline numbers carried in `CLAUDE.md` and in the open issues are **badly stale**.

| Claim | Source says | **Measured 2026-08-29** |
|---|---|---|
| Quarantined artifacts | 104 across 4 threads (`CLAUDE.md`) | **426 across 19 threads** |
| Same, per issue #489 | 207 flagged, 0 released | **426**, still **0 released** |
| Overlap with `isCollisionArtifact` | zero | **still zero** — shape unchanged, scale 4× |
| Open issues | 30 (#502's body) / 10 | **28** |
| Tool failure rate | 52% (2026-08-26 handoff) | **7.6% aggregate — that run was an outlier** |

### ⚠️ Production stale-run recovery has been dead for twelve days

57 threads carry `recovery_reason = 'stale heartbeat recovered by health sweep'`, running from
2026-07-15 to **2026-08-17 13:10:31Z — and nothing since.** The driver was the GitHub Actions
`Edge Health` cron, which **#483 removed on 2026-08-23** for the billing incident. The pg_cron
schedule everyone believed was the real driver **never existed** (below). So recovery now fires
only when a human has the app open.

**Invariant I-2's real-world incidence: 65 of 186 `finished` threads (35%) carry a
`recovery_reason` and therefore render as Interrupted rather than complete.**

### ⚠️ `supabase/migrations/` is not the mechanism that changes this database

Stronger than the prior session stated: **46 of the 47 files in `supabase/migrations/` have
never been applied.** `supabase_migrations.schema_migrations` holds 41 rows — 33 with an empty
name, 7 bare UUIDs, and exactly one semantic-looking name. pg_cron was therefore never
installed, and the health-sweep schedule PR #502 argues from has never existed.

> **This is a hard blocker for Stage 2.** The account-deletion RPC cannot reach production by
> committing a file to `supabase/migrations/`. The delivery mechanism must be named and the
> result verified in production before #476 is called closed.

### Tool reliability — retarget from aggregate to hotspots

30 days, 4,278 calls: `ok` 3,395 · `skipped` 336 · `failed` 326 · `empty` 221. Hard failure
**7.6%**; worst single thread 21.4%. The handoff's 52% run does **not** generalise, so broad
reliability work is lower priority than the specific hotspots: **`socialfetch_web_read` 39.4%
over 127 calls** and **the `indicia` family 42–88%**.

> Note this independently corroborates §3's ruling on #502's socialfetch timeout hunk: main's
> #511 measurement is the one backed by corpus-scale data.

### #476 is genuinely open and only #502 closes any open issue

#476 *[COMPLIANCE] No self-service account deletion exists* — opened 2026-08-20, still open,
never updated, and GitHub reports **zero** closing-PR links. Of the seven open PRs, **#502 is
the only one that closes any open issue at all**, which is a further argument for splitting its
account-deletion slice out rather than letting it wait on the rebase.


---

## §11b · ⛔ OPERATIONAL P1 — stale-run recovery has no scheduler

**Elevated from "next cycle" on JD's instruction. This is not deferred.**

| Measurement | Value |
|---|---|
| Threads recovered by the health sweep, 2026-07-15 → 2026-08-17 | 57 |
| Threads recovered since **2026-08-17 13:10:31Z** | **0**, for 12 days |
| `finished` threads carrying a `recovery_reason` (present as **Interrupted**) | **65 of 186 — 35%** |

**Why it stopped.** The `Edge Health` GitHub Actions cron was the *only* thing actually driving
the sweep. #483 removed it on 2026-08-23 for the billing incident (a ~10s curl billed as a full
minute at `*/15`, which drained the shared Actions allowance and took CI down for ~70 hours).
The `pg_cron` schedule everyone believed was the real driver — the one **PR #502's Fix-#1
rationale argues from** — **has never existed**: pg_cron is not installed, the `cron` schema
does not exist, and `20260720031500_pg_cron_health_sweep.sql` was never applied (§11a).

**Why it is a P1 and not a nice-to-have.** Recovery currently fires *only when a human opens the
app and the frontend happens to probe `/health`*. A run that dies while nobody is looking stays
dead. **An investigation tool's recovery path cannot depend on someone opening the app.**

> **Propose the scheduler mechanism separately. Do NOT implement it in this cycle.** It touches
> the health path, which #513 and #502 both already modify, and the finalize/recovery machinery,
> which owns this project's worst incidents (`CLAUDE.md`'s run-termination invariants I-1/I-2).
> Options to write up — external uptime monitor, Supabase scheduled function, a restored but
> hourly Actions cron, or actually installing pg_cron — with cost, failure mode, and interaction
> with I-1 for each. **A design document, then authorization, then implementation.**

**Immediate consequence for this cycle:** #502's Fix-#1 justification comment must be corrected
before merge — it argues from a cron that does not exist.


---

## §12 · Your rulings on the five open decisions

Recorded as decided, not proposed.

| Question | Ruling |
|---|---|
| **#491 PII** | **Do not merge as written.** Replace the real name/address with synthetic fixtures and remove it from runtime comments. Separately determine whether the **already-public PR history** needs remediation. Also fix `kind_mismatch` so an expected validation refusal does not disable `google_dorks` for the thread |
| **#435 accounting** | `MAX_PAID_CALLS_PER_RUN` measures **actual provider attempts / spend**. Pre-provider refusals do **not** consume it. Fan-out stays bounded by the existing total- and per-tool-call limits. **Requires an integration test through shipped control flow** — the PR's 9 unit tests do not drive the seam |
| **Shared infrastructure** (§5) | **Approved to fix.** A shared address, IP, or parent domain is a **relationship / lead** signal, not independent identity corroboration. It must not defeat the cap or lift a cluster above 60 without a separate identity signal |
| **Source classification** (§6) | **Diagnosis approved; a blanket regex-order change is not.** Generic search stays discovery-tier unless a **trusted structured URL / provenance field** identifies the underlying source. Data brokers must not be laundered into `public_record` via a model-written label. `user_upload` and `gemini_vision` must also not let the same uploaded evidence count twice |
| **Dead `20260828200000` migration** | Remove **after checking every relevant deployed environment**, not production alone. Document that the bounded health sweep supersedes it |

---

## §13 · The plan — corrected execution order

Optimizing for **clearing the merge backlog** with **#502 rebased whole**. Four hard constraints
drive the order: #513 precedes #502 (§9), #502's `tool-registry.ts` conflict resolves *against*
the PR (§3), **the deploy instruments are repaired before the deploy that depends on them**, and
**breach-data visibility is frozen** (see the standing constraint above).

> **⛔ Nothing below begins without JD's stage-by-stage authorization.** No implementation, no
> merging, no deployment, no migration application, no branch deletion. Each stage stops and
> waits.

### 1 · The `AnalysisTab` fix (frontend, ships alone)

One line: `src/components/panel/AnalysisTab.tsx:88` → `.order("collected_at", { ascending: false })`.

**The test must drive the component**, asserting it actually calls `.order("collected_at")` —
a spy/mock on the query builder. Asserting that the generated type contains the column is
**insufficient**: it would pass with the bug still in place. Merge → Vercel ships. No backend
deploy.

### 2 · Split account deletion out of #502 — with a real delivery path

Carve into its own PR: `20260825000000_delete_my_account.sql` (**renumber above
`20260828200000`**), `.github/ci/delete-my-account-assertions.sql`, the `ci.yml`
**migrations-job hunk only** (not the whole file), `src/pages/Settings.tsx`,
`src/integrations/supabase/types.ts`, `src/test/account-deletion-contract.test.ts`.

> ### ⚠️ Vercel cannot install `delete_my_account`
> An earlier draft called this "no deploy," which is wrong. It is a `SECURITY DEFINER` RPC and
> needs to reach the database. **And `supabase/migrations/` is not the mechanism that changes
> this database** — every migration in `supabase_migrations.schema_migrations` is
> Lovable-authored and UUID-named; the newest is `20260825024640`, and *neither*
> `20260828200000` nor `20260720031500` was ever applied (§9). Two files in that directory are
> already dead letters.
>
> **Measured 2026-08-29: 46 of the 47 files in `supabase/migrations/` have never been applied**
> (§11a). Committing a 47th changes nothing by itself.
>
> **Before this PR is called shipped, name the actual mechanism** — the Lovable project agent
> applying it, or whatever channel genuinely writes this DB — then **verify in production**
> that the migration version is present in `schema_migrations` and that the RPC exists with the
> intended grants (`EXECUTE` to `authenticated` only, revoked from `public`/`anon`).
>
> #476 is the **only** open issue any open PR closes, so this slice is the highest-value merge
> in the queue — and the one most likely to be declared done while silently not shipping.

Complete its security review before merge: it is a destructive, caller-scoped RPC.

### 3 · Prepare (do not merge) the edge cluster, in this order

| # | PR | Required before merge |
|---|---|---|
| 1 | **#493** | Correct the wrong `ransomwarelive_lookup` comment. Record that it is **not** telemetry-only — `tool_health` → `scoreExpectedValue` changes tool *selection* |
| 2 | **#513** | Set `CACHE_SWEEP_BATCH` ≈100 or chunk the delete (5,000 uuids ≈ 195 KB URL). Replace the `indexOf` containment test with one that drives `handleHealthProbe`. Keep both flags **off** |
| 3 | **#502** (rest) | Rebase. **Widen the throttle to gate the whole maintenance body — one `admin` declaration** (§9). Take main's `18_000`. Keep `checks.synthesis` on the throttled path. **Drop** the `circuit.ts` 2-strike override. **Correct the Fix #1 comment — the pg_cron it relies on does not exist** |
| 4 | **#512** | Fix the false JSDoc (`serus_core.ts` **is** live). Fix the vacuous test. **Add a `deno check --no-lock` gate over the live import graph**, asserting no new errors vs the documented baseline |
| 5 | **#491** | Sanitize PII to synthetic fixtures; strip it from runtime comments; fix `kind_mismatch` → circuit-breaker. Assess public PR-history remediation |

### 4 · Repair the deploy instruments — **before** the deploy

Your correction, and it is the right one: do not run the one big backend deploy using an
instrument this audit just proved cannot block incorrect parity.

1. **`record-deploy.mjs`** — `-S` pickaxe matches deletions; resolves the wrong stamp commit
   for any non-current build (§8).
2. **`edge-health.yml`** — asserts `.checks.minimax.ok`, which no longer exists; fails on a
   healthy system (§10).
3. **#514, rewritten** — compare the tree being **shipped**, exclude `*_test.ts`, and **wire
   the result into the exit code** (§8).
4. **`/health` `ok`** — stop gating on `MINIMAX_API_KEY` while the orchestrator is
   DeepSeek-pinned (§10).

### 5 · Run all gates on the actual combined heads

Not on each branch in isolation. Floors: **1611 / 1 skipped / 131** and **1446 / 0 / 5**, plus
typecheck, lint (0 errors), build.

### 6 · Merge only on JD's explicit approval

### 7 · One backend sync + deploy

`CLAUDE.md`'s six-step recipe once. Verify **both** a moved build SHA **and** the presence of
`checks.cache_sweep`.

### 8 · Validate the cache sweep functionally — separately

> `checks.cache_sweep: "disabled"` proves **the new code deployed**. It does **not** prove
> cleanup works.

Ship disabled. Then run **dry-run** and read its output (note it reports the batch cap, not the
backlog — 11,041 rows are expired). Only then, as a **separately authorized** step, enable a
bounded sweep and confirm rows actually delete.

### 9 · Branch hygiene — manifest-driven, batch-authorized

Delete **only** from the certified manifest (§7), in small batches, **each batch authorized by
JD**, with the manifest retained. Explicit branch names and tip SHAs — **no globs**.

All decision branches stay **quarantined** pending individual review. `test/e2e-playwright-smoke`
gets a dedicated compatibility evaluation against current `main`; the mirror's
`lovable-sync-1784512454` gets a deep audit **before** step 7's deploy, since it carries a
finalize tool-gate absent from canonical.

---

## §14 · Deliberately not in this cycle

All confirmed still open, and the right *next* cycle — folding them in now would recreate the
backlog this plan exists to clear:

- **The dispatch boundary (P1)** — `isSubjectUnlinked` absent from the entire dispatch path.
- **The report layer bypass** — no `{{FINDINGS_TABLE}}` expansion exists anywhere; #511's
  synthesis is a different layer.
- **Full SSN in an artifact `value`** (2026-08-26 handoff §3.4) — renders on the board, in the
  report, and in exports. **This one deserves its own decision soon, ahead of the rest.**
- The phantom `+7` phone selector; one fact recorded 3–5× with disagreeing numbers.
- **Tool reliability, retargeted:** the 52% run was an outlier (aggregate is 7.6%). The real
  work is two hotspots — `socialfetch_web_read` at 39.4% over 127 calls and the `indicia`
  family at 42–88% (§11a).
- *(Stale-run recovery was previously listed here. It has been **elevated to an operational
  P1** — see §11b. It is no longer deferred.)*
- `ALWAYS_ALLOW_TOOLS` bypassing both the per-tool timeout and the abort signal
  (`cache.ts:1163-1169`), and `abortSignal` forwarded by only ~16 of ~98 tool definitions.

---

## §15 · Verification

- **Gates:** `npm ci && npx vitest run` (**1611 / 1 skipped / 131**), `npm run test:edge`
  (**1446 / 0 / 5**), `npm run typecheck`, `npm run lint` (0 errors), `npm run build`.
- **Conflicts:** `git merge-tree --write-tree origin/main <head>` — read the real exit code, not
  one masked by `| head`.
- **Frontend:** Vercel `list_deployments` → `target:"production"` **and** the SHA. A preview
  `READY` is not the site.
- **Backend:** `?health=1` → build SHA moved **and** `checks.cache_sweep` present.
- **Database:** `schema_migrations` contains the account-deletion version **and** the RPC exists
  with the intended grants. Migration files alone prove nothing here.
- **Signed-in UI:** `npx vite --config vite.harness.config.ts` →
  `/chat/11111111-2222-4333-8444-555555555555`. Screenshot the Analysis tab before/after.
- **Never** run `deno` without `--no-lock` — it rewrites `deno.lock` and drops three real
  dependency entries. It happened once during this audit.

### Pre-merge checklist — every PR, every time

1. **Breach evidence visible to JD is unchanged.** The test is: **does this hunk reduce what JD
   can see** in the UI or in exports? If yes — **stop and get explicit approval.** Sanitising
   third-party PII from fixtures, protecting secrets, and unrelated log/security redaction are
   *not* covered by the freeze and proceed normally. (#502 needs its masking/hiding hunks split
   out; its SSRF, CSP and log-redaction work proceeds.)
2. Gates green on the **actual combined head**, not the branch in isolation.
3. Conflict state reproduced with a real exit code.
4. Evidence-integrity surfaces (confidence caps, source classification, chain-of-custody,
   minor-safety, audit/coverage) unchanged unless separately signed off.
5. JD's explicit authorization for this specific merge.

### Pre-deploy checklist

1. **Breach-data visibility unchanged** — re-verify at `/health` (`reveal_breach_data`) after
   the deploy, not just before.
2. Deploy instruments repaired and re-verified first (§13 step 4).
3. `lovable-sync-1784512454` deep-audited and dispositioned.
4. Mirror parity checked **per function directory**, and `git log origin/main` read in the
   mirror — a second agent writes there.
5. Build SHA moved **and** `checks.cache_sweep` present.
6. Cache sweep still **disabled**; functional validation is a separate authorized step.

---

## §16 · Resuming this work in a fresh session

Everything needed to execute §13 is in this file. A new session needs four things re-measured
first, because all four are dated:

```bash
# 1. Both deploy axes — never trust the numbers above
curl -s "https://skzqwbyvmwqarfgfvyky.supabase.co/functions/v1/osint-agent?health=1"
#    + Vercel list_deployments → confirm target:"production" AND the SHA

# 2. The clone is SHALLOW at depth 50 in web/remote sessions. Without this,
#    every divergence and conflict measurement in §3/§7/§9 is fabricated.
git fetch --unshallow --filter=blob:none

# 3. Mirror parity — the ONLY meaningful check is per function directory
for fn in osint-agent evidence-export security-test-lab _shared; do
  diff -rq "supabase/functions/$fn" "../seeker-spark-search-5362c57c/supabase/functions/$fn"
done
#    AND read `git log origin/main` in the mirror — a second agent writes there.

# 4. Draft status. A draft PR cannot merge, and that is the whole bottleneck.
#    list_pull_requests → look at `draft`.
```

**Gate floors** (measured 2026-08-29 on `0513782`, clean `npm ci`): frontend
**1611 passed / 1 skipped / 131 files**; edge **1446 passed / 0 failed / 5 ignored**;
typecheck clean; lint 0 errors / 10 pre-existing `react-refresh` warnings; build ✓.

**Two traps that cost this session time:**

- **Never run `deno` without `--no-lock`.** It silently rewrote `deno.lock`, dropping
  `npm:@ai-sdk/google`, `npm:@lovable.dev/cloud-auth-js` and `npm:vaul`. Committing that would
  have been a real regression.
- **`git merge-tree` exit status is masked by `| head`.** #502's conflict reads as exit 0 that
  way. Check the real exit code.

**What is NOT yet done in this audit** (three agents were still running at write time): the
full open-issue inventory with PR cross-references, the `CLAUDE.md`/`AGENTS.md` doc-claim
reconciliation table, and the completeness critic's adjudication. None of them change the
execution order in §13; they add inventory. Re-run them or work without them.
