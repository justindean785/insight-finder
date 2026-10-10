# Insight Finder — remediation plan (revalidated 2026-10-10)

Prepared for JD from the 2026-10-10 production audit and its evidence bundle. Read-only: no
production change, merge, deploy, migration, paid scan or provider change was made while
preparing this. Labels: **Confirmed** = directly supported by inspected code or retrieved
records; **Likely** = supported but needs reproduction or instrumentation; **Unverified** =
material evidence gap.

## 1. Baseline vs. the audit — what changed

| Surface | Audit baseline (07:07–07:25Z) | Now (re-measured this session) | Label |
|---|---|---|---|
| `main` | `219732c` (#723 ledger) | `811acf3` — five commits later: #724 (E2 guard), #726 stamp, #725 docs slim, #727 ledger, #728 handoff | Confirmed (`git log 219732c..origin/main`) |
| Live `osint-agent` build | `2e5f78c` | **`f9fc281`** — `/health` build moved; `checks.user_supplied_status` present | Confirmed (one health call, 2026-10-10, earlier this session; not repeated) |
| #724 (analyst-supplied-only status) | open, "not yet live" | **merged and live.** Prospective only; the two `7a2968e1` legal-record rows (conf 90, `verified`, no reason) are NOT backfilled | Confirmed |
| Mirror | `c722971` | `296bba5` (mirror PR #109), `verify:deploy` → `mirror tree -> equal` | Confirmed (ledger #727) |
| `artifact_tool_lineage` / synthesis uniq index | absent on live DB | still absent — #613 is still a draft, unapplied | Confirmed (`schema2` query: both null) |
| `messages.run_id`, `tool_usage_log.run_id/call_id` | absent | absent (schema snapshot) | Confirmed |
| Open PR queue | 14 | 13, **all draft** (#703 #702 #701 #700 #699 #698 #695 #667 #666 #613 #612 #593 #516) | Confirmed (`list_pull_requests`) |
| Model / provider | `glm-5.2`, pinned `deepseek` slot | unchanged | Confirmed (health) |

Assumptions that changed: C's "review #724 promptly" is done; the remaining C work is the
dedupe/projection contract (#593) and the historical-row question. Everything else in the audit
stands. Platform isolate logs are still unreachable from here; `prompt_size_*`, `run_budget_prior`
and the `premature_client_cancel` event detail live only in `console.log`.

Measurement discipline carried forward: every number below is from the bundle's window
(`started_at >= 2026-10-03T00:00Z`, 94 invocations / 20 threads / 1,509 tool calls / 710 steps),
spans at least three builds, and cannot be attributed to a release. Any new number must state
its window, n and denominator.

## 2. Prioritized findings

| # | Finding | Sev | Label | Evidence | Impact | Smallest change | Depends on | Acceptance gate |
|---|---|---|---|---|---|---|---|---|
| F1 | **No atomic per-thread admission.** `setupRequest` (auth.ts) verifies ownership and runs stale recovery, then `markRunStarted` (recovery.ts:873) does an **unconditional** `UPDATE threads SET status='active', run_started_at=now()`. Nothing refuses a second run while a heartbeat is live. Frontend `submitRefusal('server_running')` is advisory and per-tab. | P0 | Confirmed (code) + Likely (12 overlapping pairs / 21 of 94 invocations / 9 threads; all three `cfe70631` runs carry `premature_client_cancel`) | `overlap`, `runend`, auth.ts:205–240, recovery.ts:873–893 | duplicate paid work, interleaved persistence, partial transcripts marked ended | Stage S1a below: conditional-update lease on existing columns (no schema) | — | concurrent sends admit one; the loser gets a 409 with a truthful reason |
| F2 | **Persistence can run from the browser's stream cancel while the loop continues** (`lib/run-end.ts` header; `persistFinalMessages` guarded by `finalPersisted`, called from both the response stream and the server-owned branch). | P0 | Confirmed (code, 7 markers) | run-end.ts:1–60, index.ts:1653–1670, 2154, 2196 | invocation row written with a partial transcript; later real end ignored | S1b: fenced terminal transition (generation check) | S1a + schema (S1c) | stale worker cannot write terminal state over a successor |
| F3 | **Invalid tool inputs = 82 of 169 failures (48.5%), 5.4% of calls.** Top: `serus_darkweb_scan` `identifierValue (invalid_type)` ×15 + `reveal` ×3; `google_dorks` `seed, kind (invalid_type)` ×13; `record_artifacts` `(unspecified)` ×9; `oathnet_lookup` `value` ×8; `jina maxChars` ×6; `memory_save entries` ×3; `socialfetch platform,handle` ×3. **The catalog names for serus/dorks/oathnet/socialfetch already match the zod schemas** (checked this session) — so these are not name drift; `invalid_type` on a required string means the model sent a null/number/missing value or wrapped the input. #698 fixes five other drifts and does not touch these. | P1 | Confirmed (counts) / Unverified (what was actually sent: `sentKeys` not in bundle) | `errorssafe`, `failclasses`, catalog.ts vs tool-registry.ts:1522/1856/3885/5408, tools/serus.ts:31 | wasted steps, bad Activity numbers | S2: pull `sentKeys` from `tool_usage_log` for these rows (read-only query, authorized), then table-driven contract fixtures per tool, plus a tolerant `z.preprocess` only where the shape is unambiguous | #698 first | invalid-input rate by build with denominator, after an authorized release |
| F4 | **Frontend dedupe donates authority.** `useThreadArtifacts.dedupeArtifacts` (main) keys on kind+normalized value, takes `Math.max` confidence, spreads later metadata over earlier, ORs `reviewed`, merges sources. | P0 | Confirmed (code read on `main`) | useThreadArtifacts.ts:67–103 | a later low-authority row can relabel/release/confirm an earlier one in Evidence and exports | #593 (draft) already does the right thing: key includes an authority fingerprint, earliest row wins, no merge; 10 tests incl. order reversal and realtime | #593 rebase on main; define the claim-support contract in its body | reversed row order gives identical displayed authority; `linkage_confirmed`/`reviewed`/confidence never migrate |
| F5 | **Historical `verified` rows with no reason** (2 on `7a2968e1`, conf 90, `user_supplied (unicourt.com docket)`). #724 is prospective only. | P1 | Confirmed | `supplied` | report shows VERIFIED for a pasted docket | a documented one-off remediation, through Lovable, logged as an `analyst_feedback_events`-style audit row, never a silent UPDATE | JD decision | the rows read `observed` with `status_reason`, and the change is recorded |
| F6 | **No durable lineage** (no `run_id`/`call_id` on `tool_usage_log`, no `messages.run_id`, no junction). 931/1,263 artifacts lack tool metadata; all 126 rows ≥70 are in that group. | P1 | Confirmed | `schema2`, `schema3`, `integrity` | per-source yield, memory learning and "what did the analyst keep" are all unanswerable | apply #613 schema through Lovable, verify on live DB, then a kill-switched writer | #613 | new artifacts trace to call + invocation; RLS proofs pass in CI |
| F7 | **Unexplained invocation tail** outside steps: p50 5.4s, p95 98.9s (natural_stop p95 102s). Salvage `generateText` (index.ts:1781) has no `abortSignal`, no `providerOptions`, `maxOutputTokens = ORCHESTRATOR_MAX_OUTPUT_TOKENS` (8192). | P1 | Confirmed (code) / Likely (attribution) | `gaps`, `summary`, index.ts:1775–1800 | runs over 180s; 53/94 forced | S4: durable spans (admission, first token, model, tool, persistence, salvage, close) into `orchestrator_invocations`; then bound salvage with the request deadline | schema add (spans jsonb) via Lovable | spans reconcile to `duration_ms` within tolerance; salvage time visible |
| F8 | **Context over target**: 83/710 steps > 220k chars, max 305,488 (thread `7a2968e1`); `capTotalToBudget` can return over budget by design and `reportBudgetCeiling` only warns. Wire bytes unmeasured. | P1 | Confirmed (code+telemetry) / Unverified (wire) | `context`, `badcontext`, orchestrator-budget.ts:495–605 | token cost, latency, provider errors | S4b: measure post-trim serialized bytes durably; reproduce with an oversized tool-input fixture; define bounded fallback that preserves call/result pairing | S4 spans | oversized input → defined bounded behaviour, pairing valid |
| F9 | **`context_chars` in the durable table is the wrong meter** (`approxPromptChars`); the honest `prompt_size_*` is console-only. #612 is console-only too. | P2 | Confirmed (CLAUDE.md measured 09-13, bundle) | — | thresholds set from a floor | fold into S4; decide #612 extend-vs-supersede (recommend: supersede with the durable span row, keep its byte counter) | S4 | — |
| F10 | **Source outcomes conflated.** Oathnet 17×401 + 8 invalid + later successes; Reddit 6×403; Nominatim 3×403; FOFA 200/`820001`; Opsis 402; Wayback 3 timeouts + 3×503. `checks.credentials` is row-capped (floor). | P2 | Confirmed | `failclasses`, `errorssafe`, health.json | wrong "dead provider" calls; permanent disables | S6: outcome taxonomy (`auth`, `entitlement`, `rate_limit`, `transient`, `timeout`, `negative`, `validation`, `cancelled`) on `tool_usage_log.outcome`/`error_class`, bounded recheck, truthful UI wording (#702/#703) | — | each class distinct in telemetry and UI; no permanent disable from one 403/empty |
| F11 | **Memory retrieval axis.** 1,693 rows, 647 lessons, 0 tool-keyed; `memory_recall` filters by `subject`/`related_values` only (pgrest.ts:47; tool-registry.ts:1265, 5841, 6299). | P2 | Confirmed | `memory`, code | tool lessons never resurface | S7 (L2 in the 10-10 handoff): tag tool lessons `tool:<name>` in `related_values` at write; recall that set every run; bounded self-healing backfill; `/health` key | nothing (no schema) — but **after** lineage for yield-driven ranking | tool lessons recalled on a seed they were not learned on |
| F12 | **Cache = only copy of 14,299 expired outputs** (52.8 MiB). Sweep OFF. | P2 | Confirmed | `cache` | deleting destroys history | payload store first (DESIGN_payload-store.md), sweep after | S3 ids | — |

Not findings (audit §12 corrections hold): feedback is not inert (103 events, zero delta by
design); absent archives ≠ no custody (1,348 rows hashed and chained, `archive_attachments=false`);
Socialfetch reader is alive (55/67); shodan after #696 is 4 ok / 3 empty / 0 failed (small n).

## 3. Stages and dependencies

```
S1 run ownership ──┐
S2 tool contracts ─┼── independent of each other; S1 and S2 can start now
S3 lineage (#613) ─┘        │
S4 spans/context ───────────┼── wants S3's run_id/call_id so spans share ids
S5 authority dedupe (#593) ─── independent frontend; ship in parallel
S6 source outcomes ─────────── after S3 (call_id makes rechecks attributable)
S7 memory tool axis ────────── no schema; L2 of the handoff; before S8
S8 payload store + cache ───── after S3 (same identifiers)
```

Rule from CLAUDE.md that governs all of it: one PR = one behaviour + tests + kill switch + one
new `/health` key; never mix frontend and edge; schema first (through Lovable, verified on the
live DB), code second; at most one edge PR in flight.

## 4. Per-PR specification

### S1 — run ownership (P0)

**S1a. Admission lease, no schema change.** Replace the unconditional `markRunStarted` with a
conditional update that is the lease:

```
UPDATE threads SET status='active', run_started_at=now, last_heartbeat_at=now,
                   recovered_at=null, recovery_reason=null
 WHERE id=:thread AND user_id=:user
   AND (status <> 'active' OR last_heartbeat_at IS NULL
        OR last_heartbeat_at < now - STALE_RUN_AFTER_MS)
RETURNING id
```
Zero rows ⇒ respond **409** `RUN_IN_PROGRESS` with `last_heartbeat_at`, before the user message
is inserted (today `setupRequest` inserts it first — move the lease ahead of the insert so a
refused send leaves no orphan message). Kill switch `RUN_LEASE_DISABLED=true` (falls back to the
unconditional write). `/health` key `checks.run_lease`.
Touches: `auth.ts`, `recovery.ts`, `src/lib/submit-guard.ts` wording, a frontend handler for
409. Tests: `recovery_test.ts` driving the real `markRunStarted` against a fake db that
returns 0/1 rows; a `setupRequest` test asserting message insert does not happen on refusal.
Rollback: flag. Release proof: `/health` key + a deliberate double-send on a test thread.
Limit (say it in the PR): this is a time-based lease on the heartbeat, so a worker that stalls
> 75s without pulsing can be superseded while still alive. S1b closes that.

**S1b/c. Fencing (schema).** Add `threads.run_generation bigint default 0`, `threads.run_owner
uuid`. The lease increments `run_generation` and sets `run_owner`; heartbeat, finalize, status
writes and `persistFinalMessages` carry `.eq("run_generation", mine)`. A stale worker's writes
affect 0 rows and log `fenced_write`. `premature_client_cancel` is then also a fenced path: the
browser-cancel branch may persist the transcript but may not set terminal status unless it still
holds the generation. Schema PR first (migration + `.github/ci` RLS/constraint assertions like
#613's), then the code PR. `/health` key `checks.run_fencing`. Distinguish causes in
`stop_reason`-adjacent text (no CHECK change): `analyst_stop`, `client_disconnect`,
`deadline`, `crash`, `completed`.
Acceptance (from the prompt): concurrent submissions admit one owner; reconnect doesn't
duplicate work (409 + the live stream is re-attachable later, S4); old owners cannot finalize a
successor; cancellation leaves coherent messages/evidence/status; stale leases recover without
duplicate paid calls (recovery writes `recovery_reason`, never re-dispatches); errors retain
honest stop reasons. Fixtures: two-request race, refresh mid-run, stop, timeout, crash.
Deliberately NOT a job system: no queue, no worker table.

### S2 — tool contracts (P1)

1. Merge-readiness review of **#698** (5 real drifts, test proves 100+ catalog entries parse).
2. **Authorized read-only query** (not run yet): `SELECT tool_name, error_msg, input_json->'sent_keys' …
   WHERE outcome='failed' AND error_msg LIKE 'input rejected%' AND created_at>='2026-10-03'` — to
   see what the model actually sent for serus/dorks/oathnet/socialfetch/record_artifacts.
3. Table-driven contract test `tool_input_contracts_test.ts`: for each changed tool, N valid
   and N invalid inputs through the REAL schema from `buildTools`, asserting accept/reject and
   that rejection text carries field paths only (no values). Fix shape per tool only after (2):
   e.g. a `z.preprocess` that unwraps `{input:{…}}` or coerces a numeric `maxChars` string is
   fine; coercing a missing `identifierValue` from somewhere else is NOT (identity selector).
4. `/health` key `checks.tool_input_contracts` (count of tools under contract test).
Acceptance: catalog and schema agree (#698 test); fixtures cover the actually-rejected fields;
after a release, invalid-input rate by build with denominator (needs S3's run_id or at least the
build marker on the invocation row).

### S3 — lineage (#613, P1)

Schema as drafted (junction + nullable `run_id`/`call_id` on `tool_usage_log`, no FKs, RLS
proven in CI). Apply through Lovable; verify with `to_regclass('public.artifact_tool_lineage')`
on the live DB; then writer PR behind `ARTIFACT_LINEAGE_DISABLED`, `/health`
`checks.artifact_lineage`. Add `messages.run_id` in the same schema PR (nullable). Retention:
junction cascades on artifact delete; `tool_usage_log` keeps its 3 months. Redaction: selector
TYPE only. Backfill: none possible — historical association stays unknown.

### S4 — durable spans and context (P1)

Schema: `orchestrator_invocations.spans jsonb` (admission, first_token, model_ms, tool_ms,
persist_ms, salvage_ms, close), `build text`, `request_bytes int`, `post_trim_chars int`;
`orchestrator_step_metrics.prompt_terms jsonb` (the #587 breakdown). Code: write them; bound
salvage with `abortSignal` tied to the invocation deadline. #612: supersede (its byte counter
moves into the same row; console path removed). Acceptance: `sum(spans) ≈ duration_ms` within
2s on a run with no cancel; client interruption visible as its own span end; one oversized-input
fixture produces a defined bounded message list.

### S5 — authority-safe dedupe (#593, P0 authority)

Rebase on `main`; add to the PR body the contract: a row's displayed source, confidence,
status, cluster, quarantine and review are **its own row's**; collapsing only identical
authority; analyst decisions (`artifact_reviews`) remain the only review axis. Run
`npm run test:e2e` by hand (frontend change). Acceptance: the ten tests in the PR plus the
export test. Ships on merge via Vercel; no edge deploy.

### S6 — source outcome taxonomy (P2)

Edge: map provider responses to the eight classes; FOFA body `820001` → `entitlement`;
402 → `entitlement`; 401 → `auth`; 403 → `auth` or `rate_limit` by provider; 503/timeout →
`transient`. Bounded recheck: a per-tool, per-isolate `recheck_after` instead of thread-wide
disable. Frontend wording: #702/#703 after verifying current backend codes. LeakCheck probe #701
stays OFF.

### S7 — memory tool axis (P2, no schema)

As designed in the 10-10 handoff §5.2 L2 and started this session (read-only so far): tag
`tool:<name>` into `related_values` at `memory_save`; recall the tagged set every run; bounded
self-healing backfill of untagged lessons (≤20 rows/run, admin client); kill switch
`MEMORY_TOOL_AXIS_DISABLED`; `/health` `checks.memory_tool_axis`. Guardrail: lesson text is
advisory context only; it cannot change evidence authority. Sequence it after S3 so yield-based
ordering has lineage behind it, but the retrieval fix itself has no dependency.

### S8 — payload store, then cache retention (P2)

Per `DESIGN_payload-store.md`: a TABLE keyed by `call_id` (from S3), hashes preserved, then the
cache sweep (already chunked) can be enabled.

## 5. Benchmark corpus (small, fixed)

Six cases, one per seed type, run in FAST and DEEP modes, three runs each, same build:
person (public figure, consented), email (owner's own test inbox), phone (owner's own number),
domain (owner's own domain), username (owner's handle), analyst-supplied docket paste. Capture
per run: TTFT, active wall (sum of invocation durations), elapsed, completion (natural vs
forced), supported findings (rows with ≥2 independent classes), invalid-input count, cost,
and whether the run was interrupted/censored. Report n and censoring. No model switch and no
projected speedups from the historical documents.

## 6. First implementation slice for approval

> **Status 2026-10-10:** S1a shipped as #730 and is live at build `2e0d3ee` (`checks.run_lease`). The review
> of head `a4480fa` added a version clause, fail-closed acquisition and release-on-every-exit; the stated
> limit is a time lease, not fencing. S1b is next and needs the schema PR.

**S1a — the no-schema admission lease** (one edge PR, kill switch, `/health` key, four tests).
It removes the duplicate-admission path with no migration and is fully reversible. S5 (#593
rebase) can go in parallel as a frontend PR. S7 (memory axis) is ready to build the moment JD
says so, also with no schema.

## 7. Evidence gaps that remain

- Platform isolate logs: unreachable; `prompt_size_*`, `run_budget_prior`, and the structured
  `run_end` event bodies are console-only until S4.
- What the model actually sent on the 82 rejected calls: `sent_keys` exists in `tool_usage_log`
  (#697) but is not in the bundle. One read-only query answers it; not run (no DB access here).
- Whether the three `cfe70631` runs overlapped at the provider, or only in recorded intervals.
- Wire bytes per step (S4b).
- Cryptographic validity of the 1,348 chain hashes (presence only was checked).
