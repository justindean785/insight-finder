# Session handoff — 2026-09-08, queue drain and the dispatch-boundary deploy

> **Every number here is a dated measurement, not a state. Re-verify before acting.**
> Written 2026-09-08T07:10Z. Supersedes `SESSION_HANDOFF_2026-09-07_drop-suppression-and-the-duplicate-pr.md`.

---

## 0 · Start here — 60 seconds

```bash
git fetch origin main && git log --oneline -3 origin/main
curl -s "https://skzqwbyvmwqarfgfvyky.supabase.co/functions/v1/osint-agent?health=1"
git fetch origin refs/heads/deploy/live:refs/heads/deploy/live   # else the gate reads blind
node scripts/record-deploy.mjs --mirror ../seeker-spark-search-5362c57c
```

**Expect live `/health` build = `e50db9e`.** If it moved, another session has been here — read
the newest `SESSION_HANDOFF_*.md` first. That has now happened four times.

**Then, before writing any code: `list_pull_requests`.** On 2026-09-07 two sessions built the
same fix four hours apart and produced conflicting PRs (#548 / #551) because one skipped this.

---

## 1 · Verified state (2026-09-08T07:05Z)

| Axis | Value |
|---|---|
| `origin/main` | `4a5eb1c` (+ the ledger/docs commits this handoff ships with) |
| Live `osint-agent` build | **`e50db9e`** — deployed 2026-09-08T07:0xZ, VERIFIED against `/health` |
| `deploy/live` | `e50db9e`, local **and** remote |
| Mirror `main` | `571cb9e`, tree `e854a98f4110` — **equal** to canonical |
| Frontend suite | **1957 passed / 1 skipped / 159 files**, 0 failures |
| Edge suite | **1634 passed / 0 failed / 5 ignored** |
| Typecheck / lint | clean / 0 errors (11 pre-existing `react-refresh` warnings) |
| Open PRs | **3** — #541, #516 (draft), #502 (non-draft) |

`main` and the live edge build are **in sync. Nothing is undeployed.**

---

## 2 · What shipped

Two deploys and nine merges. The queue that had been stuck in draft is drained.

### Deploy 1 — `eab3668` → `4e6888a`

| PR | What it fixes |
|---|---|
| **#550** | The "verified" count disagreed across Overview / Evidence / Report on identical data — and the Report tab's own header disagreed with its own body. Worse: a `possible_collision` row (a *different, unrelated person* sharing only a name) rendered in **Confirmed Findings** with its own caveat text inside the confirmed section. That is the #448 authority defect at a call site #448 never reached. Frontend; live on Vercel production. |
| **#547** | Partial unique index so two overlapping health probes cannot both write the same synthesis finding. **Merged and CI-validated but NOT applied** — see §4. |
| **#549** | A joined source label containing a breach slug anywhere resolved wholly to `breach` and discarded every other class the same label named, producing a false *"needs second independent class of evidence"* on rows that already had two. Recovery is narrow: fires only when the whole label resolves to `breach`, leaving the shared-host anti-dilution guard untouched. |

### Deploy 2 — `4e6888a` → `e50db9e`

| PR | What it fixes |
|---|---|
| **#519** | Two **silent** reopenings of the `subject_unlinked` dispatch boundary. (1) The refused-key read issued one unbounded select; PostgREST answers with at most `db-max-rows` rows and **no error**, so past the cap every quarantined selector dispatched normally. It now advances by rows *actually returned* and ends only on an empty page or the true `count`. (2) The refusal text interpolated the classifier-written reason and the target-controlled selector into `error`, which `isIntentionalSkip` regex-matches *before* `deriveOk` reads `ok` — a selector like `gated.com` flipped a refusal to `ok:true` and deleted it from the failure metric. The message is now a constant. |
| **#529** | `linkage_confirmed` was the documented escape from quarantine and every boundary read it, but nothing could **write** it. Harmless until #518 made quarantine dispatch-blocking — then a row auto-quarantined in error could never be pivoted on again, by anyone. Frontend; needed no deploy. |

Also merged: #553 / #556 (build stamps), #554 (ledger), #555 (doc re-measurement).

---

## 3 · Traps this session paid for — read before diagnosing anything

1. **Three instruments reported something other than what they named.** This is the theme of the
   session and the most useful thing in this document.
   - The **`mirror_tree_digest` gap** was documented as a permanent "known cosmetic gap" from
     canonical-only test files. That left the one gate protecting deploys *permanently yellow*,
     so it could not distinguish the known gap from real drift — exactly what it exists to catch.
     Closed by syncing test files. **Keep syncing them.**
   - **`ledger_ref_divergence`** was not divergence: a fresh sandbox clone never fetches the
     `deploy/live` ref, so the gate read blind on that axis. One `git fetch` restores it.
   - **The stop hook's "unpushed commits"** fires for any squash-merged branch, because it
     compares the branch to `main` rather than to its upstream. A squash-merged tip can never
     become an ancestor of `main`. Nothing was ever unpushed.
2. **`marker_offset_mismatch` between stamping and deploying is expected.** Live still reports
   the old marker while the newest stamp names the new one, so the gate says NOT VERIFIED. The
   hard-gate condition to read at that moment is `mirror tree -> equal`, nothing else.
3. **The `deno.lock` corruption trap in `CLAUDE.md` blames the wrong command.** `deno test
   --no-lock` behaved correctly. It was the **Deno installer** that rewrote the root lockfile and
   dropped `@ai-sdk/google`, `@lovable.dev/cloud-auth-js` and `vaul`. Check `git status` after
   *installing* Deno, not after testing.
4. **A Lovable `send_message` MCP timeout does not mean the deploy failed.** The call timed out
   client-side at 60s; the agent had already deployed. **Check `/health` before retrying** — a
   blind retry would have been a second deploy.
5. **The coverage-artifact file count is not the suite figure.** CI prints `there will be 141
   files uploaded` right after the suite. The suite figure is 159.
6. **Two merges in a row needed the real full SHA.** `expectedHeadSha` cannot be reconstructed by
   padding a short SHA; `git rev-parse` it.

---

## 4 · The honest not-done list

- **#547's index is merged but NOT applied.** `artifacts_synthesis_cluster_uniq` still does not
  exist in the Lovable-owned database. Merging a migration does not apply it; that is a separate
  explicit step. Safe to defer while both synthesis flags are OFF, but it is **not done**.
- **#519 did NOT close the observability gap, despite what `CLAUDE.md` used to claim.** That file
  said #519 "stamps that into `tool_usage_log.input_json.runtime`". It does not. What it added is
  a structured `console.warn` named `quarantine_dispatch_read_incomplete` — a real improvement
  over a silent prefix, but not durable. The rejected-dispatch loader still fails open with a
  plain warn. **Durable runtime stamping is unbuilt.** (Corrected in `CLAUDE.md` this session.)
- **Neither deploy has behavioural proof.** #549 and #519 add no `/health` key, so unlike
  `checks.synthesis` or `checks.rejected_cluster_sweep` the only evidence is the marker — a
  static string the running code echoes about itself. **Add a behavioural key next time
  something touches confidence or the dispatch boundary.**
- **#529's own test suite does not validate its writer.** Its 212 lines drive the *pure*
  `quarantine-release` module. The writer's safety comes from `releasePatch` failing closed, not
  from those tests. If you harden anything there, add a test that drives the write path.

---

## 5 · Open, and who decides

| Item | Status |
|---|---|
| **#502 vs #516** | **Operator decision — do not keep both.** #516 is the account-deletion slice split out of #502; #502 is the 39-file original and currently conflicts. Rule first, then rebase whichever survives. |
| **#502** | Conflicts with `main`. Do not rebase — merge `main` in (it is another session's branch). |
| **#541** | The 2026-09-03 handoff doc, superseded twice over. Close or merge; it carries no code. |
| Durable dispatch-boundary telemetry | Unbuilt — see §4. |
| Applying `artifacts_synthesis_cluster_uniq` | Unbuilt — see §4. |

---

## 6 · Settled — do not re-litigate

Unchanged from `CLAUDE.md`, repeated because each has been re-opened by a well-meaning audit at
least once: `REVEAL_BREACH_DATA` stays ON; `MAX_PAID_CALLS` stays bounded; intent is never
inferred from prose; never touch `toolChoice` / `stopWhen` / the finalize window; quarantine is
disclosure, not deletion; the `artifactDedupKey` ruling in `NEXT_SESSION_PROMPT.md` §2 stands;
the bare-name pivot guard is declined.

Two more, added by this session:

- **Release is not a review verdict.** `linkage_confirmed` answers "whose is this?"; the review
  control answers "is this real?". `intel.ts` requires release to be explicit and durable
  *because* the review control inverts on quarantined rows. Do not merge the two.
- **The evidence drawer has no general metadata writer, on purpose.** #534 removed `updateMeta`
  because its caller wrote a second `false_positive` signal the agent never read. #529's writer
  is single-purpose and can only ever apply `releasePatch`. Do not widen it.

---

## 7 · The process lesson, stated once

The bottleneck was never the deploy. On 2026-09-07 three finished, green, reviewed PRs sat in
**draft** while the operator asked why upgrades never changed the app. A draft PR does not merge,
and an unmerged PR cannot ship no matter how correct it is.

The corollary this session added: **a merged PR is not a deployed PR either.** #547 is merged and
its index does not exist in production. #542's backend half sat merged-but-undeployed for days.
Before concluding a fix is live, check the artefact that proves it — a moved `/health` SHA for the
edge function, `target: production` for Vercel, and for a migration, the database itself.
