# Audit report — Insight Finder, post #534 / #535

> **Measured 2026-09-02T15:20Z against `origin/main` `3b6fc44` (live `osint-agent` build `7cd74b5`). Re-verify before acting.**
> Scope: the state of the repo, the deploy and the production corpus after today's #534 (analyst-decision propagation) and #535 (Dismiss relabel) merges and the `7cd74b5` backend deploy, measured against the `@hoodken28` investigation outputs supplied by the operator (`osintreport_hoodken28.md`, the `Hoodken.md` artifact dump, and the PDF dossier export).

## 1 · Executive summary

Every gate is green on an isolated checkout of `3b6fc44`, the live backend is the build the ledger says it is, and the one deploy lag (`main` is four commits past the health SHA) is a split-channel artifact, not a stale function. The analyst-decision propagation shipped in #534 is **live and binding**: on the `@hoodken28` thread, which started at 14:31Z, after the deploy, every one of the 7 analyst-rejected artifacts is unclustered, 6 carry `cluster_cleared_reason: analyst_rejected`, and the exported report lists them as FAILED and keeps them out of Network Connections. That is a database measurement, not a log claim.

The headline risk is unchanged in shape from the 08-11 finding that "every integrity control sits one layer below what the analyst reads." The hoodken export publishes cluster headers at 98 / 95 / 90 over members whose recorded confidence never exceeds 70, because the frontend cluster formula adds merge-signal bonuses on top of the average and is bounded only by 100. In the same export, rows the analyst pressed Confirm on are labelled CONFIRMED at recorded confidences of 40–65, while the report's own legend defines CONFIRMED as two independent source classes. Both are frontend display-layer behaviours; neither changes a persisted number, and both are integrity-critical to change, so they need sign-off rather than a drive-by.

The top unresolved question is observability. The Lovable edge-log window retained only the last minute of the hoodken run, and the read-only log check found zero `analyst_decisions_applied` lines. That is a retention artifact (the event fires at turn start, and every turn start had aged out), but it means the only durable proof that decisions bind is the artifact table. Nothing in `thread_metrics` or `tool_usage_log` records that a turn ran with decisions applied.

## 2 · Method & what could NOT be verified

| Source | Reached | Reliability | Notes |
|---|---|---|---|
| Test gates, run by me | Yes | High, primary | Isolated worktree of `origin/main` `3b6fc44` with its own `npm ci`; Deno 2 for the edge suite. Durations in §3. |
| Live health endpoint | Yes | High, primary | `osint-agent?health=1`, probed twice during the audit. |
| Production database | Yes | High, primary | `mcp__Lovable__query_database`, full-corpus counts and per-thread reads. |
| CI run records | Yes | High | GitHub Actions API: run 1318 on `3b6fc44`, `success`, 14:23:10Z → 14:26:59Z (3m49s). |
| PR state | Yes | High | GitHub API, head SHAs and draft flags in §6. |
| Vercel production | Measured earlier this session, not re-probed in this pass | Likely | READY on `3b6fc44` at 14:3xZ. Treat as Likely, not Confirmed. |
| Lovable edge logs | Partially | Low | Read-only agent query. Retention exposed only ~15:00Z onward; the 14:31–14:59 turns had aged out. Absence in this window proves nothing. |
| Prior docs (`CLAUDE.md`, handoff 08-31, `docs/ANALYST_DECISIONS_PROPAGATION.md`) | Yes | Medium, leads only | Every claim re-measured below. |
| `osintreport_hoodken28.md`, `Hoodken.md` | Read in full | High for what the analyst saw | 95 artifact rows; the export is the frontend's markdown, so it measures the display layer. |
| `Insight_Finder___OSINT_Investigator_7.pdf` | **No** | Blind spot | No `pdftoppm` in the sandbox, `pypdf` and `pdfminer` crash on `cffi`, apt `poppler` 404s. The PDF path (`evidence-export`) is **unaudited**, and that function has no health marker, so a stale deployed export cannot be ruled out. |

## 3 · Measured gates

All runs on `3b6fc44` in `scratchpad/audit-wt` (own `node_modules`).

| Gate | Result | Duration | CLAUDE.md baseline | Verdict |
|---|---|---|---|---|
| `npx vitest run` | **1775 passed / 1 skipped / 143 files** | 1m15s | 1695 / 1 / 136 (2026-08-31) | Baseline stale by +80 tests / +7 files (#534, #535). No failures, no duplicate-React artifact. |
| `deno test` (edge, `--no-lock --no-check --allow-net --allow-env --allow-sys --allow-read`) | **1517 passed / 0 failed / 5 ignored** | 1m12s | 1461 / 0 / 5 (2026-08-31) | Baseline stale by +56. |
| `npm run typecheck` | clean | 26s | clean | Agrees. |
| `npm run lint` | 0 errors / **10 warnings** | 17s | not stated | All ten are `react-refresh/only-export-components` in `ChatWindow.tsx:623`, `CaseReport.tsx:497`, `WorkspaceHeader.tsx:99` and seven shadcn `ui/*` files. Pre-existing, cosmetic. |
| `npm run build` | ok | 19.8s | ok | Agrees. |
| CI on `main` (`3b6fc44`) | run 1318 `success` | 3m49s | — | Real runner durations; agrees with local. |

`deno.lock` was left untouched (`--no-lock`).

## 4 · Deploy & live state

Health readout at 15:1xZ:

| Field | Value |
|---|---|
| `ok` | true |
| `build` | `7cd74b5` |
| `selected_provider` / `orchestrator_reason` | `deepseek` / `pinned` (the slot serves `glm-5.2` via Z.AI) |
| `checks` | orchestrator, core, tools, deepseek, minimax, recovery, synthesis all `ok` |
| `checks.synthesis.detail` | `disabled` (correct: both flags default OFF) |
| `reveal_breach_data` | true (settled, see CLAUDE.md) |
| tool APIs | 17 of 20 keys present (measured earlier this pass) |

Reconciliation of `main` against the live SHA. Commits after `7cd74b5`: `3ee2bb9` (build-marker stamp), `550fd60` (ledger row), `ae21cf5` (CLAUDE.md dated state), `3b6fc44` (#535, frontend labels only). **None touches `supabase/functions/`**, so the four-commit gap is the documented split-channel offset, not a stale deploy. `deploy/live` points at `7cd74b5` and the ledger row is consistent (`verifyLedgerConsistency` passed at record time). As always, `deployed_bytes_verified` is false; the marker proves provenance, not byte identity.

Mirror parity (measured on mirror `d0ab1a6` earlier today): `diff -rq` empty for every `osint-agent` runtime file and for `evidence-export`, `security-test-lab`, `_shared`. Five canonical-only test files are unsynced by design.

Behavioural proof of deploy beyond the marker: the artifact-table effects in §5 (`cluster_cleared_reason`, unclustered rejected rows) exist only in code at or after `7cd74b5`.

## 5 · Production measurements

### 5.1 The `@hoodken28` thread `e79ad0b5` (post-deploy, the operator's test case)

| Measure | Value |
|---|---|
| Thread created / first user turn / finished | 14:31:11Z / 14:32:35Z / 15:00:49Z, `status = finished` |
| User turns / messages | 10 / 19 |
| Artifacts | 95 (matches `Hoodken.md`) |
| Analyst reviews | 16: 9 confirmed, 4 dismissed, 3 wrong (written 14:37–14:59Z) |
| Rejected rows now holding `cluster_id` or `subject_id` | **0 of 7** |
| Rows carrying `cluster_cleared_reason: analyst_rejected` | **6** (the 7th, `username "NULL"`, was never clustered, so there was nothing to clear) |
| Last clustering pass (edge log, 15:00:54Z) | `updated 99, subjects 43, merges 20, cleared 0` |
| Finalize-window tool skips in this run | 6 |
| Rejected-dispatch refusals | 0 |

The `cleared 0` on the final pass is consistent with the six cleared rows: ten user turns ran between 14:32 and 14:58, each finalize runs clustering, and the reviews landed between turns, so the clears happened on earlier passes whose log lines have expired. The Lovable agent's conclusion that "there is no log evidence the propagation path executed" is a retention artifact and is contradicted by the table. The database is the primary source here.

Report-layer readings from `osintreport_hoodken28.md` (display layer, frontend-generated):

- Network Connections excludes all 7 rejected rows; the Findings table shows them as FAILED. Correct.
- Cluster headers read **98, 95, 90** while no member in `Hoodken.md` has recorded confidence above **70**. See F1.
- Nine analyst-confirmed rows read **CONFIRMED** at recorded confidences of **40–65**, beside a legend that defines CONFIRMED as two independent source classes. See F2.
- The seed `@hoodken28` was classified as kind `other`. See F3.
- `47.153.219.212` appears as both `ip_address` (40) and `ip` (70); `t.me/hoodken28` and `hackerrank.com/hoodken28` each appear as both `url` and `social_profile`. See F4.
- One persisted artifact is `username` = the literal string `"NULL"` at confidence 45 (created 14:51:29Z). See F5.

### 5.2 Corpus-wide

| Measure | Value | Reading |
|---|---|---|
| Artifacts with review state dismissed/wrong/false_positive that still hold a `cluster_id` | **216**, all in threads not re-run since the deploy | The clear is lazy: it runs on the next clustering pass of that thread. Legacy rows stay clustered until then. F6. |
| `artifact_linkage_releases` rows | **0** | No release path exists in production; #529 is still a draft. |
| `tool_call_cache` expired / total | **11,369 / 11,563 (98%)** | #513's sweep is still a draft. |
| `investigation_cache` rows stamped `cache_version: 2` | 7, 2 written today | The versioned write path is live. |
| Synthesis findings | 0 | Disabled by flags, expected. |
| Artifacts with a null-ish literal value (`NULL`, `null`, `undefined`, `None`, empty) | **1** (the hoodken row) | Not systemic yet, but the write layer accepted it. |
| Threads touched since the deploy | 2 (`@hoodken28`, `@notrwd`) | Small post-deploy corpus; every "since deploy" number above is a two-thread sample. |

## 6 · PR & issue reconciliation

CI on `main` head `3b6fc44`: run 1318 `success`, 3m49s. Ten open PRs:

| PR | Head | Draft | Title (abridged) | Risk in one line |
|---|---|---|---|---|
| #529 | `48cf3ef` | draft | `linkage_confirmed` analyst-operable release path | Untouched, as instructed. Without it there is no way to release a quarantined row; 0 releases ever. |
| #519 | `370e6da` | draft | page the dispatch-boundary read; refusal text inert to skip classifier | The quarantine dispatch guard's fail-open remains unobservable outside edge logs. |
| #516 | `918fe2f` | draft | self-service account deletion (#476), shipped dark | Split out of #502; blocked on #502's fate. |
| #514 | `ae04cc2` | draft | mirror equality as a hard precondition of the Lovable deploy step | Docs only; would have been satisfied by today's deploy. |
| #513 | `a140310` | draft | bounded expired-cache sweep on the health path | 98% of `tool_call_cache` is expired while this sits in draft. |
| #512 | `aa4d653` | draft | declare `skipped` on `runSerusScan` return type | One-line type fix backported from the mirror. |
| #502 | `0896e00` | ready | audit remediation, run-wedge fix, #476 deletion | Large, overlaps #516; needs a merge decision. |
| #493 | `d6ba36f` | ready | log proven negative lookups as `outcome="empty"` | Telemetry; unblocks calibration views. |
| #491 | `9bdfeb9` | ready | address seeds get a real dork query family | Contained fix. |
| #435 | `90474c5` | ready | charge paid-call budget on real provider attempts | Oldest open PR; touches the paid-cap accounting. |

Six of ten are drafts. Per the 08-28 diagnosis, the draft flag, not the deploy, is the bottleneck. Check durations and conflicts on each before undrafting; none were re-run in this audit.

Cited PRs re-verified: #534 merged as `7cd74b5` and live (Confirmed, health + DB). #535 merged as `3b6fc44`, CI green, Vercel READY (Likely, measured earlier this session).

## 7 · Findings & action-list delta

### 7.1 Prior findings and action-list items

| Item | Status | Confidence | Primary source |
|---|---|---|---|
| Analyst decisions propagate to prompt, cache, clustering, synthesis, recovery, pivots (#534) | **fixed & live** | Confirmed | DB §5.1: 0/7 rejected rows clustered, 6 cleared; export excludes them |
| Rename False → Dismiss (#535) | **fixed & live** (frontend) | Likely | CI green on `3b6fc44`; Vercel READY measured earlier |
| Backend deploy recorded (ledger, `deploy/live`) | **fixed & live** | Confirmed | `/health` build `7cd74b5`; `deploy/live` = `7cd74b5` |
| Quarantine dispatch boundary P1 (CLAUDE.md "STILL OPEN") | **still open** at the observability layer | Confirmed | #519 draft; guard fails open with a log-only warning |
| `linkage_confirmed` release path (#529) | **still open** | Confirmed | 0 rows in `artifact_linkage_releases`; PR draft |
| Expired-cache sweep (#513) | **still open** | Confirmed | 11,369 / 11,563 expired |
| Report layer bypasses the integrity engine (`{{FINDINGS_TABLE}}` fix shape) | **still open**, and F1/F2 below are the same shape one layer up | Likely | hoodken export §5.1 |
| Workspace UI (handoff §6, PR 1) | **still open** | Confirmed | no PR exists for it |
| Tab-disagreement defect (handoff §6) | **still open** | Unverified | not re-measured this pass |
| CLAUDE.md gate baselines (1695/136, 1461) | **stale** | Confirmed | §3 |
| Mirror `tools/*.ts` brace drift | **fixed**, stays closed | Confirmed | `diff -rq` empty on runtime files |

### 7.2 Newly found this pass

**F1 · Cluster header confidence is unbounded by the members' caps.** Confirmed. `src/lib/intel.ts:2190-2194` adds `MERGE_SIGNAL_WEIGHT` (EMAIL_MATCH 35, PHONE_MATCH 35, HANDLE_MATCH 25, SHARED_INFRASTRUCTURE 20) plus a handle-reinforcement bonus to the average member confidence, bounded only by `Math.min(100, …)`. `HANDLE_ONLY_CLUSTER_CAP = 60` (`:1884`, `:2229`) applies only when there is no identity corroboration. The hoodken export shows 98 / 95 / 90 headers over members that never exceed 70, and `confidence_cap_applied` on members is not consulted. The analyst reads the header as the confidence of the identity. Integrity-critical to change.

**F2 · Analyst Confirm paints CONFIRMED on rows the evidence ladder puts at VERIFY.** Confirmed. `src/lib/intel.ts:507-508` short-circuits `labelForArtifact` to CONFIRMED for `confirmed` / `key` / `meta.reviewed` (minor-safety and quarantine excepted). `CONF_LABEL_HELP` at `:590` says "or reviewed by analyst", but the exported report's legend, `system-prompt.ts` (two independent classes, ≥80), and the #534 contract ("a decision never changes evidence confidence") all say otherwise. The number stays 40–65 while the label says CONFIRMED, so the two disagree in the same row. This is a semantics decision, not a bug hunt: either the label gets its own name (ANALYST-CONFIRMED) or the legend changes. Integrity-critical.

**F3 · `@handle` seeds classify as `other`.** Confirmed in code, Likely in effect. `src/lib/seed.ts:21` `USERNAME_RE = /^[a-z0-9_.-]{2,40}$/i` has no leading-`@` allowance, so `@hoodken28` is `other`, which is what the hoodken thread recorded. Downstream, `REQUIRE_TOOL_CALL_IN_OPENING_PHASE` keys on "parses as a seed", so an `other` seed may lose the opening-phase tool forcing. One-line fix plus a test; the normalized value must strip the `@`.

**F4 · Kind aliases are honoured at dispatch but not at write.** Confirmed. `lib/dispatch-rejection.ts` folds `ip_address→ip`, `social→username` and friends for the refusal key, but `auto-persist-findings.ts` persists both spellings, so one selector shows twice with different confidences (`47.153.219.212` at 40 and 70; two `url` / `social_profile` pairs). Each half can be reviewed independently, so a Dismiss on one leaves the twin authoritative. The rejection key is `kind|value`, and the alias table lives only on the dispatch side.

**F5 · The write layer accepted a literal `"NULL"` username at confidence 45.** Confirmed, one row corpus-wide. A tool returned a null-shaped value and `auto-persist-findings` stored it as a real selector; the analyst had to Dismiss it by hand. Add a null-literal reject at the write boundary with a test.

**F6 · 216 legacy rejected rows remain clustered until their thread is re-run.** Confirmed. The clear in `lib/cluster.ts:463-480` runs inside `applyClusteringToThread`, which fires at finalize. Threads the analyst reviewed but never re-ran keep the stale `cluster_id` on every surface that keys on the persisted column. Either a one-off idempotent backfill pass or clearing on the review write itself.

**F7 · Propagation is unobservable outside a sub-hour log window.** Confirmed. `analyst_decisions_applied` (`index.ts:752`) and `cluster_assignment_cleared` (`lib/cluster.ts:479`) go only to `console.log`; the Lovable log API retained less than 30 minutes. Nothing durable records that a turn ran with N decisions applied. Stamp the counts into `thread_metrics` or the turn's `tool_usage_log.input_json.runtime`, the same fix shape handoff §7.5 proposes for the quarantine guard.

**F8 · The rejected-dispatch guard has never fired in production.** Confirmed (0 refusals since deploy). The unit tests drive it, but there is no production evidence either way; the two-thread post-deploy corpus is too small to claim it works or that it is dead code. Measure again after more analyst-rejected runs.

**F9 · Six finalize-window skips in a single run.** Likely. Tool calls dropped inside the finalize window on the hoodken run; whether leads were lost depends on which tools were skipped, which this pass did not enumerate. Measure-only until then; do not add work inside the finalize window (settled).

**F10 · Gate baselines in `CLAUDE.md` are stale** (1695/136 → 1775/143; 1461 → 1517). Confirmed. Doc fix.

**F11 · The PDF export path is unaudited.** Gap. See §2 and §9.

## 8 · Recommended next actions, in priority order

1. **Decide the CONFIRMED label semantics (F2)** before touching code: keep the attested short-circuit and rename it, or drop it and let the legend stand. Integrity-critical; needs the operator's sign-off. Cost: a small PR either way, mostly tests.
2. **Bound cluster header confidence (F1)**: cap at the maximum member effective confidence (after `confidence_cap_applied`) or at the strongest member's label rung. Integrity-critical; sign-off. Cost: one function plus fixtures; the harness at `/chat/1111…` shows the cap path.
3. **Backfill the 216 legacy stale cluster assignments (F6)** with an idempotent pass that reuses `dropRejectedArtifacts` + the clear loop, and add clearing on the review write so the next 216 never accrue. Cost: one edge-side maintenance path plus a test that drives it.
4. **Normalize kind aliases and reject null literals at the write boundary (F4, F5)**: share the alias table between `dispatch-rejection.ts` and `auto-persist-findings.ts`; refuse `NULL`/`null`/`undefined`/empty values. Cost: small, with failure-first tests.
5. **Accept a leading `@` in `USERNAME_RE` (F3)** and strip it in `normalized`. Cost: one line and one test.
6. **Make propagation durable (F7)**: persist `analyst_decisions_applied` counts and `cluster_assignment_cleared` counts per turn. Cost: one column write on an existing table; the same PR can carry #519's `quarantine_boundary: "degraded"` stamp.
7. **Undraft and merge in this order, after re-running CI on each**: #513 (cache sweep, 98% expired), #512 (one-line type), #493 (telemetry), #491, #435, then decide #502 vs #516. #529 stays parked until told otherwise.
8. **Refresh the `CLAUDE.md` baselines (F10)** to 1775 / 1 / 143 and 1517 / 0 / 5, dated today.
9. **Audit the PDF export on a machine with poppler (F11)**, and suspect a stale deployed `evidence-export` first if the dossier disagrees with the markdown.

Standing constraints: no auto-merge, no auto-deploy; the operator authorizes each. A mirror merge is not a deploy; only a moved `/health` build SHA is. `REVEAL_BREACH_DATA`, `MAX_PAID_CALLS` and prose-intent inference are settled. Nothing was merged, synced or deployed by this audit; the only write is this file on its own branch.

## 9 · Gaps in this audit

- The PDF dossier was not read. The `evidence-export` function has no marker, so the deployed export bytes are unverified in both directions.
- Vercel production state on `3b6fc44` was measured earlier in the session, not in this pass. Label it Likely.
- Edge-log evidence covers roughly the last minute of the hoodken run. Every "the log shows zero X" statement above is bounded by that window.
- Post-deploy production evidence is two threads. F8 in particular cannot be resolved on that sample.
- The tab-disagreement defect and the workspace UI backlog were carried from the 08-31 handoff without re-measurement.
- CI durations for the ten open PR heads were not re-checked; only `main`'s run 1318 was.
- The mirror parity line is from earlier today (`d0ab1a6`); the mirror is writable by a second agent, so re-run `git log origin/main` there before the next deploy.
