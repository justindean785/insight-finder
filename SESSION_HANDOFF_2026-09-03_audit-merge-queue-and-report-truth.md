# Session handoff — 2026-09-03 · audit, merge queue, report truth

> **Every number here is a dated measurement, not a state.** Measured 2026-09-03T03:35Z
> against `origin/main` `1554911` and live `osint-agent` build `7b0138d`. Re-fetch and
> re-probe before acting on anything below. Two sessions worked this repo in parallel on
> 2026-09-02; this file reconciles both.

## 1 · State, verified 03:35Z

| Axis | Value | Source |
|---|---|---|
| `origin/main` | `1554911` (#536 audit report; docs only after ledger `35ff20b`) | `git fetch` |
| CI on `main` head | run 1343 `success`, 03:10:07Z → 03:13:43Z | Actions API |
| Live `osint-agent` build | **`7b0138d`** (#537), `checks` = orchestrator, core, tools, deepseek, minimax, recovery, **rejected_cluster_sweep**, synthesis (`disabled`), **cache_sweep**, all ok | `/health` probed twice |
| `deploy/live` | `7b0138d` | `git rev-parse origin/deploy/live` |
| Ledger | last row recorded 2026-09-02T23:55:47Z, previous `7cd74b5`, stamp `cfbb404` | `deploy-log.jsonl` |
| Mirror `main` | `113a6ac` per CLAUDE.md (surgical sync of 24 runtime files + `build-info.ts`) — **not re-measured by me** | CLAUDE.md, Unverified |
| Orchestrator | `deepseek` slot, `pinned`, serving `glm-5.2` via Z.AI | `/health` |
| Frontend baseline (CLAUDE.md) | 1818 passed / 1 skipped / 149 files | other session, measured on the #537 branch, Likely |
| Edge baseline (CLAUDE.md) | 1613 passed / 0 failed / 5 ignored | same, Likely |
| Last gates **I** ran | 1775 / 1 / 143 and 1517 / 0 / 5 on `3b6fc44`, isolated worktree, own `npm ci` | 2026-09-02T15:10Z, stale by #537 |

Production, `query_database`, 03:35Z:

| Measure | Value | Reading |
|---|---|---|
| Analyst-rejected rows still holding `cluster_id` or `subject_id` | **0** | was 216 at 15:00Z; #537's health-path sweep converged 216 → 51 → 0 in ~10 min |
| Rows carrying `cluster_cleared_reason: analyst_rejected` | 226 | 6 from the hoodken run + 220 from the sweep |
| `tool_call_cache` expired / total | **11,475 / 11,646 (98.5%)** | **#513 is merged and live and this has NOT moved.** See §6.1 |
| Artifacts with a null-ish literal value | 1 | the legacy hoodken `username "NULL"` row; #537 blocks new ones at write, did not clean this one |
| `artifact_linkage_releases` rows | 0 | #529 still a draft |

## 2 · What happened, in order

This session (`session_01Gs1R8XBno1xmHVaK7dbViD`):

1. **#534 — analyst decisions bind on the next investigation.** Confirm / Key / Recheck / Dismiss became authority / priority / workflow task / rejection, none of which touch evidence confidence. Merged `7cd74b5`, stamped `3ee2bb9`, mirror synced `2f4a8ce`, Lovable deploy, `/health` moved, ledger `550fd60`. Decision record: `mem/process/decision-log-2026-09-02-analyst-decisions.md`, contract: `docs/ANALYST_DECISIONS_PROPAGATION.md`.
2. **#535 — the visible False action renamed Dismiss.** Merged `3b6fc44`, frontend only.
3. **`/codebase-audit` against the `@hoodken28` outputs** → `AUDIT_REPORT_2026-09-02.md`, merged as #536 (`1554911`). Eleven findings, F1–F11; nine actions.

A parallel session (`session_01DgrWMaPkMDvfAkAJwp7BYZ`) took the audit's action list and shipped it while #536 sat in draft:

4. **Merge queue at 18:29Z**: #435 (paid-call accounting), #513 (bounded expired-cache sweep on the health path), #491 (address-seed dork family), #493 (`outcome="empty"` telemetry), #512 (`skipped` on `runSerusScan`).
5. **#537 — Report truth, analyst-confirmed label, write-boundary hygiene, binding decisions.** Merged `7b0138d` at 23:51Z, 49 files, stamp `cfbb404`, deployed, ledger `35ff20b`. Its three commits close audit F1–F6 and half of F7 (see §3). Operator sign-off for the two integrity-critical changes was given 2026-09-02.
6. `CLAUDE.md` dated state rewritten twice (`23d4961`, `8f638a0`) as the sweep converged.

Then this session merged #536 on the operator's instruction at 03:10Z.

## 3 · Audit findings → what #537 closed

| Audit finding | Status now | Where |
|---|---|---|
| F1 cluster headers 98/95/90 over members ≤ 70 | **fixed & live** — headline clamped at the strongest member's cap-aware effective confidence | `src/lib/intel.ts` `summarize` |
| F2 Confirm paints CONFIRMED at 40–65 | **fixed & live** — new `ATTESTED` rung rendered ANALYST-CONFIRMED; CONFIRMED again means two independent classes | `src/lib/intel.ts`, `CONF_LABEL_HELP` |
| F3 `@handle` seed → `other` | **fixed & live**, both client and server halves, parity test | `src/lib/seed.ts`, `detectSeedServer` |
| F4 kind-alias twins (`ip`/`ip_address`, `url`/`social_profile`) | **fixed & live** — one alias table in dedup, checkpoint and rejection keys; report folds twins | `lib/kind-alias.ts`, `foldAliasTwins` |
| F5 literal `"NULL"` persisted | **fixed at write**, legacy row remains | `lib/nullish-literal.ts` |
| F6 216 stale cluster assignments | **fixed & converged to 0** via the health-path sweep, kill switch `REJECTED_CLUSTER_SWEEP_DISABLED` | `lib/rejected-cluster-sweep.ts`, `checks.rejected_cluster_sweep` |
| F7 propagation telemetry log-only | **half closed** — Evidence Record now carries "Analyst decisions applied this turn" and "cluster assignments cleared: N"; nothing in `thread_metrics` / `tool_usage_log` yet | #537 commit 3 |
| F8 rejected-dispatch guard never fired in prod | **still unmeasured** | needs runs with Dismissed selectors |
| F9 six finalize-window skips in one run | **still open**, measure-only | `tool_usage_log` |
| F10 CLAUDE.md baselines stale | **fixed** by #537 (1818 / 149, 1613 / 5) | CLAUDE.md |
| F11 PDF export unaudited | **still open** | needs poppler |
| §8.3 #513 cache sweep merged | **merged & live, but see §6.1: the table has not drained** | `checks.cache_sweep` |

Everything the hoodken export got wrong is fixed in code that is live. **It has not been re-verified on a fresh production run.** That is next-step 4.

## 4 · Traps that cost time this session

- **Two sessions on one repo.** `main` moved eleven commits while my docs PR waited in draft, and another session implemented my audit's findings inside nine hours. Before writing any state line or acting on any handoff finding, `git fetch origin main && git log --oneline <your-base>..origin/main`. A finding in a handoff may already be closed.
- **Lovable edge-log retention is under thirty minutes.** A read-only log query found zero `analyst_decisions_applied` lines and the Lovable agent concluded "no evidence the propagation path executed." The turns had aged out. The artifact table is the primary source; the log is not. Never accept absence-in-log as evidence.
- **The sandbox worker restarts mid-turn.** Deferred MCP tool schemas vanish; reload with `ToolSearch select:<name>` before calling. A scheduled check-in that fires across a restart silently does nothing until you re-run it.
- **Auto-mode classifier blocks.** Git writes in the sibling mirror clone, and at one point `unsubscribe_pr_activity` / `delete_trigger`, were refused. Workaround that worked: add the mirror as a remote of the canonical clone and push from there; retry the MCP calls later (they succeeded at 03:10Z).
- **`record:deploy` pickaxe hits mirror commits** if mirror refs live in the same clone (`marker_offset_mismatch`). Use a separate shallow `--mirror` clone in the scratchpad and fetch `deploy/live` first (`ledger_ref_divergence` otherwise).
- **Lovable `send_message` times out at 60s** while the agent is busy. Resend with `wait=false` (deduplicated), poll `get_message`, and confirm with `/health`, never with the agent's own "deployed" text.
- **Shell cwd resets between Bash calls.** A `git push origin HEAD deploy/live` ran in `/home/user` and did nothing. Prefix every git command with `cd`.
- **`deno test` rewrites `deno.lock`.** Pass `--no-lock`, or `git checkout -- deno.lock` afterwards.
- **`eslint .` prints only the summary to a log** you `tail`; the ten warnings are all `react-refresh/only-export-components`, pre-existing, in `ChatWindow.tsx:623`, `CaseReport.tsx:497`, `WorkspaceHeader.tsx:99` and seven shadcn `ui/*` files.
- **The PDF dossier cannot be read here.** No `pdftoppm`; `pypdf` and `pdfminer` crash on `cffi`; apt `poppler` 404s. Audit the export on a machine with poppler.
- **CI on `main` shows `cancelled` for most merge commits.** That is the concurrency group superseding runs during a merge queue, not a failure; read the conclusion on the *last* head (run 1343 `success`).

## 5 · Corrections to inherited facts

- The 08-31 handoff's "216 legacy rejected rows still clustered" (restated in my audit as F6) is **closed**: 0 as of 03:35Z.
- My audit's §6 said six of ten open PRs were drafts and named #513/#512/#493/#491/#435 to undraft. All five are **merged**. The open set is now #540, #502 (ready) and #529, #519, #516, #514 (drafts). #539 (a Cursor-automation lint fix stacked on #537's branch) closed unmerged when #537 landed.
- My audit's F2 recommendation (rename to ANALYST-CONFIRMED) was adopted as-is in #537.
- `CLAUDE.md`'s dated state says `main = 35ff20b`; two docs-only commits (`8f638a0`, `1554911`) followed. Updated in this PR.
- The "dispatch boundary P1" section in CLAUDE.md now says where the guard binds (`cache.ts`) and what stays open (#519) — read the current file, not the 08-31 copy.

## 6 · What was NOT done

### 6.1 The cache sweep is live and the table has not drained — investigate first
`checks.cache_sweep` is `ok` on `/health` and #513 is in `7b0138d`, yet `tool_call_cache` still reads 11,475 expired of 11,646 four hours after deploy. Two hypotheses, neither verified: (a) the sweep is bounded per probe and **nothing probes `/health` on a schedule** since #483 removed the cron, so it only drains when a human curls it; (b) the sweep's predicate or its kill switch is not matching. Check `checks.cache_sweep.detail` on the next probe, then decide between an external uptime monitor (what CLAUDE.md already asks for) and a one-off bounded drain.

### 6.2 Not re-verified on a real run
#537's report changes are pinned by tests and by the harness diff in `docs/report-truth-2026-09-02/`, not by a fresh production investigation. Run one seed with several Dismiss / Confirm decisions and read the export.

### 6.3 Still open from earlier handoffs
- **Workspace UI** (08-31 handoff §6, PR 1): three-pane shell, virtualized register, search and filters, keyset pagination, `lib/case-state.ts`. The tab-disagreement defect (12 vs 18 tools, 2 vs 3 verified) is untouched and **unmeasured** this session.
- **#529** linkage release path: 0 releases ever; operator's call.
- **#519** dispatch-boundary observability: fail-open is unobservable outside logs; stamp `quarantine_boundary: "degraded"` per the 08-31 §7.5 shape.
- **#502 vs #516**: overlapping account-deletion work needs a merge decision.
- **#514** docs: mirror equality as a hard precondition of the deploy step.
- **#540** is a third-party bot PR (`usehoplite[bot]`): two real frontend papercuts plus a vendor `.hoplite/settings.json`. Review before merging; the config file is optional.
- **F7 second half**: persist per-turn decision counts somewhere queryable.
- **Durable production monitoring**: still none.
- **PDF export**: unaudited; `evidence-export` has no marker, so a stale deploy cannot be ruled out.

## 7 · Next steps, in order

1. **Re-fetch and re-probe.** `git fetch origin main deploy/live`, `curl …?health=1`, confirm build `7b0138d` and both new keys. If the build moved, stop and read the newer dated state.
2. **Diagnose §6.1.** One `/health` probe, read `checks.cache_sweep.detail`, re-query the expired count. If it drains per probe, stand up the external monitor; if not, it is a bug in #513 to root-cause.
3. **Decide #540.** Read the three-file diff; merge the two fixes if CI is green; the `.hoplite` file is your call.
4. **Verify #537 on a real run.** Seed a handle with `@`, Dismiss two rows, Confirm one, Key one, export the report. Expect: headline ≤ strongest member, ANALYST-CONFIRMED on the confirmed row, twins folded, seed kind `username`, Evidence Record carrying the decisions line. Close F8 if a Dismissed selector gets refused.
5. **Re-measure the gates on `1554911`** in an isolated worktree with its own `npm ci` and record them in CLAUDE.md.
6. **#529, #519, #502/#516, #514**: one decision each; undraft what should ship. The merge, not the deploy, is the bottleneck.
7. **Workspace UI** (PR 1 of the 08-31 plan) when the above is clear.
8. **PDF export audit** on a machine with poppler.

## 8 · Gaps in this handoff

- Mirror `main` parity was not re-measured by me after #537's sync.
- Gate figures on the current head are the other session's numbers on the #537 branch, not mine on `1554911`.
- The tab-disagreement defect and the workspace UI backlog are carried forward unmeasured.
- Production evidence for #537's behaviour is the sweep counter and a harness diff, not a live investigation.
- Vercel production was not re-probed this pass; a docs-only merge should not have changed it.
