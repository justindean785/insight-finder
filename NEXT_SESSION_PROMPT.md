# Next-session prompt — Insight Finder

> **Target agent:** Claude Code (fresh context, remote/web sandbox). Paste the fenced block below as the opening message, as-is.
> **Written 2026-11-04.** Replaces the 2026-10-14 prompt (its queue drained by 2026-11-03). Every number is a dated measurement, not a state — re-verify.
> **Audit basis (2026-11-04, ~11:00Z):** canonical repo `justindean785/insight-finder` cloned at `e872203`; `/health` read once; `deploy-log.jsonl`; the 11-01 and 11-02 handoffs; four live-app captures and one report export from JD's attachment-seeded run of 2026-11-04 10:09Z. Channel: edge (one build).

## State at hand-off (2026-11-04, after the C9 session)

The prompt below was executed once. What is true now (details: `SESSION_HANDOFF_2026-11-04_findings-table-expansion.md`):

- **PR #974** (edge, READY, branch `claude/findings-table-expansion`, commit `3d399fff`) implements the objective. It is not merged, not stamped, not deployed. Merge and deploy are JD's named go.
- `main` = `e8722038`; live build `c67f90d` (eight edge PRs bundled; rollback point `979f199`); `/health` 67 checks, 0 not ok, `glm-5.3-flash`.
- The prompt's premise was partly stale: a server-authored Evidence Record (`lib/evidence-record.ts`, #479) already existed. #974 sits beside it and replaces the *model's* table, not that block.
- Do **not** re-run this prompt. Start from the handoff's §3 and §7. The queue at the bottom of the prompt is still open and still JD's to name.

```
# Objective

One edge PR this session: make the scoring engine the author of the closing report's Findings table. The orchestrator writes a literal `{{FINDINGS_TABLE}}` line where the table goes; the server expands it from this run's persisted artifact rows (their persisted confidence, label and source class) inside `persistFinalMessages`, before the message is stored. Kill switch ON by default, one new `/health` proof key, tests first. Build it, prove it, open the PR READY when CI is green, and stop: JD merges, JD authorises the deploy. Nothing else ships this session.

Address the user as JD. Engineering only — the scans contain real people; never investigate anyone who appears in a run, never put a handle, name, ID, credential or storage URL from a run into code, tests, commits, PR text or docs.

# Session hygiene (CLAUDE.md, JD 2026-10-19)

Report one line, unprompted, after any compaction, when a PR merges, and before starting a new task: `Session check: STAY — <reason>` or `Session check: START FRESH — <reason>` (with the handoff path and the opening prompt). Second compaction ⇒ START FRESH.

# Standing rules (do not re-litigate; all are in CLAUDE.md → SETTLED or in the handoffs)

- `REVEAL_BREACH_DATA` stays ON. `RUN_LEASE_DISABLED=true` stays. `MAX_PAID_CALLS` stays bounded. Intent is NOT inferred from prose.
- Orchestrator: GLM primary in the deepseek slot (live model `glm-5.3-flash`), Anthropic (`claude-sonnet-5`) is the start-failure backup. Do not re-pin.
- Frontend ships on merge to `main` (Vercel). Edge does NOT ship on merge: stamp → surgical mirror sync → `npm run verify:deploy` hard gate (`mirror tree -> equal` + `mirror pushed`) → Lovable deploy message → `/health` build moved → `npm run record:deploy` → ledger PR. The recipe is the `edge-deploy` skill (`.claude/skills/edge-deploy/SKILL.md`). Never `supabase functions deploy`. **This session does not deploy.**
- One PR = one behaviour change + its tests + its kill switch. Never mix frontend and edge. Never mix schema with the code that uses it. At most one edge PR in flight. Every behaviour-changing edge PR adds one `/health` key or durable log event.
- Squash merges only; never delete branches; merge `main` into a branch (a squash-merged branch is restarted from `origin/main` with `push --force-with-lease=<branch>:<old head>` — that is the documented case, nothing else is force-pushed).
- Frontend PRs: merge-when-green is JD's standing decision (11-02 handoff §2). **Edge PRs wait for JD's named go** — for the merge and again for the deploy. Ask before any merge, Lovable message, secret/flag change, schema, closing a PR, or billing action. Never answer a Lovable tool-approval pause yourself.
- Evidence ranking, confidence caps (`confidence.ts`), `record_finding`, chain-of-custody, credential masking and minor-safety detection are integrity-critical: no change without JD's written sign-off. This PR READS persisted values; it computes none.
- Do not use Opus or any top-tier model for subagents; prefer direct tool calls.
- Scan every file, log or transcript you read for live keys; flag, never echo.

# Context — measured 2026-11-04 (dated measurements, not state; re-measure first)

**Repo.** `origin/main` = `e872203` (#972, ledger row for build `c67f90d`). Clone is shallow — run `git fetch --unshallow --filter=blob:none` before any divergence measurement. Package manager is npm. God-files today: `supabase/functions/osint-agent/tool-registry.ts` 7,027 lines, `index.ts` 2,705, `src/components/ChatWindow.tsx` 3,674, `src/lib/intel.ts` 3,289 — touch surgically.

**Live edge.** `/health` (one read, 2026-11-04): `build: c67f90d` (committed 2026-11-02T19:59-08:00), 67 checks, 0 not ok, `selected_provider: deepseek`, `selected_model: glm-5.3-flash`, `orchestrator_reason: pinned`, `checks.orchestrator_fallback` → anthropic, `checks.run_lease` → LEGACY, `reveal_breach_data: true`, `checks.client_cancel_isolation.mode: server_branch_only`. Ledger last row 2026-11-03T04:19Z: canonical `c67f90d`, stamp `e57d3dd` (#971), mirror `e8a626c`, `mirror_tree_equality: equal`, `mirror_push_status: pushed`, previous build `979f199`. `git diff e57d3dd origin/main -- supabase/functions` is empty: nothing is waiting to be deployed, so your PR will be the next build.

**Risk carried from the last deploy.** Build `c67f90d` bundled eight edge PRs in one stamp (#969 planning adaptation, #928 lesson brief, #868 memory_save aliases, #943 record_artifacts prompt, #925 breach_check phone coercion, #912 record_artifacts linkage, #801 media_leads, #799 Jina 403). A regression in it cannot be bisected by `/health`; the rollback point is `979f199`. Keep this PR to one change so the next build is bisectable.

**What shipped since the 2026-11-02 handoff** (all on `main`): #957 docs; #958/#959 the two frontend polish items from that handoff §7.3; #960 Jina test wording (the "edge CI red on main" item — re-measure, the file now says `401 unauthorized`); #961/#962 `cluster_adjudications` migration (`supabase/migrations/20261102120000_cluster_adjudications.sql`, service_role write only) — **schema only, zero code references in `src/` or `supabase/functions/`**; #964/#965 WCAG; #966 case title from seed when a pasted provider export became the title; #967 auto-correlate subject evidence; #968 outcome lessons on /brain; #970 Investigate touch controls; #971/#972 the stamp and ledger above.

**Baselines (re-measure before blaming a diff).** Frontend vitest 3220 passed / 1 skipped / 272 files at `bc036d3` (11-02); e2e 125 passed / 10 skipped at `85c5f9b`; edge 2828 passed / 0 failed / 6 ignored at `a753f56` (11-01, pre-#960 and pre-c67f90d — stale). Lint 0 errors / 10 pre-existing warnings. `deno check index.ts` carries pre-existing AI-SDK/Supabase type-graph errors and is not a gate; verify your change adds none.

**PR board.** NOT measured by this audit. Last known (11-02 handoff §3): #929 edge, English-only orchestrator, READY, waiting on JD; drafts owed triage: #883, #882, #821, #804, #800, #793, #763, #701, #613, #593, #516 (#868/#799/#801 have since merged). Codex had no review credits on 11-02. Measure with `list_pull_requests` and look at `draft` — the merge queue, not the deploy, is this project's bottleneck.

**Today's live run (JD's, 2026-11-04 10:09Z, build c67f90d, attachment-seeded; from four captures and the report export).** 73 tool calls: 52 succeeded, 12 no-record, 1 faulted, 3 degraded, 5 skipped; $1.41; hash chain valid 92/92. The tool breakdown contains **`record_artifacts` ×16 and `record_finding` ×0**. The Investigate tab shows the AI narrative labelled "claims need evidence review · Unscored" with model-typed tiers and percentages ("Likely (65)", "Possible (55)") in its own prose, followed by the authoritative block "No authoritative finding rows were recorded for this run. 76 artifacts were collected; nothing in the narrative above was adjudicated by the scoring engine." The report export says the same ("The scoring engine adjudicated no findings on this case") and prints its own Artifact table from persisted rows, with a readiness score of 45% (report-safe needs 60%). So #943 (deployed in `c67f90d`) did not move the `record_finding` rate on this run; the disclosure layer is working; the model's closing table is still the model's own writing in the stored message. The same run also reproduced the known `indicia_web_dbs` fault (`HTTP 400: snusbaseType is required when snusbase is selected`) and two Jina 403 degraded calls — queued below, not this session.

# Current Problem

`record_finding` is called in ~3% of runs (11-01 handoff §2: 2 of 60 runs on glm-5.2; 0 on the first glm-5.3-flash run; 0 of 73 calls on today's run after the #943 prompt change). The closing report's Findings table is therefore the model retyping tiers and percentages that no engine computed — CLAUDE.md "The report layer bypasses the integrity engine". The frontend now labels that narrative Unscored and appends the engine's authoritative block, which is the right disclosure, but the **stored message** still carries the model's table: it is what Copy copies, what `[HISTORICAL MODEL OUTPUT]` replays into the next cycle's context (the model re-reads its own fabricated figures as history), and a large share of the 44k–124k-character salvage output measured on 11-01.

CLAUDE.md prescribes the fix shape and this session builds exactly that: expand a `{{FINDINGS_TABLE}}` marker server-side from persisted rows before the message is stored. No markdown parsing of model output. It must never be able to fail finalize. `confidence.ts` and `record_finding` already compute the right values; nothing carries them to the stored report. Build the carrier.

# Files to Inspect (search the repo if paths differ)

- `CLAUDE.md` → "The report layer bypasses the integrity engine" (fix shape, the four counting systems from PR #871, the DO NOTs) and "Run-termination invariants" (what you must not touch).
- `SESSION_HANDOFF_2026-11-01_glm-5.3-deploy-and-the-record-finding-gap.md` §2 (the measured gap) and §4 (salvage size).
- `docs/claude-md/built-and-unwired-and-measured-traps.md` — grep for `FINDINGS_TABLE` and for any earlier findings-table attempt before writing a line (`grep -rn FINDINGS_TABLE supabase src` returned nothing on `e872203`).
- `supabase/functions/osint-agent/index.ts`: `persistFinalMessages` (~:2082–2400; the single artifact fetch it already makes, `salvageArts` / `artifactRetrieval` with `ARTIFACT_FETCH_LIMIT` and the `ceiling_hit` case; the `messages` insert ~:2382), the `onFinish` wiring ~:2635 and the client-cancel guard ~:2682 (`lib/client-cancel.ts`) — your expansion runs inside the server-owned branch only.
- `supabase/functions/osint-agent/tool-registry.ts`: `record_finding` (~:6970; writes `artifacts`), `countIndependentClasses(i.supporting_sources.map(classifySource))` (~:5513 per CLAUDE.md — re-measure) — read how adjudicated rows are marked so the renderer can tell a `record_finding` row from a `record_artifacts` row.
- `src/lib/intel.ts` `authoritySection` (~:1375) and `keyFindingsFraming` (~:1528): the frontend's wording and its predicate for "engine-adjudicated". Port the predicate; do not invent a second one. Keep the two in step the way `isClusterIneligible` / `isExcluded` are.
- `supabase/functions/osint-agent/lib/cluster.ts` `isExcluded` — quarantined (`subject_unlinked`) rows get no authority in the table.
- `supabase/functions/osint-agent/system-prompt.ts` :148–:173 (recording rules; :172 per-cycle tier words; :173 the closing-report contract that currently demands "(1) a Findings table") and `lib/finding-prompt.ts` (keeps `finalize_no_findings`'s wire contract).
- `supabase/functions/osint-agent/env.ts` :89–:123 — the call-time kill-switch pattern (`PROMOTION_QUARANTINE_DISABLED`, `RECORD_ARTIFACTS_INPUT_COMPACT_DISABLED`); `health-handler.ts` :546 (`record_name_quarantine`) and :718 (`outcome_lessons` self-test) — the proof-key pattern.
- `supabase/tests/osint-agent/` (tests live here, never under `supabase/functions/`; `src/test/edge-deploy-bundle.test.ts` fails the build if the function folder exceeds 4,300,000 bytes); `reviews_wiring_test.ts` for the source-reading wiring-test pattern; `recovery_test.ts` / `orchestrator_finalize_test.ts` for the "kill switch ships ON" assertion pattern.
- `lib/tool-cache-version.ts` — read it to confirm this change is not a tool interpretation and needs no bump; say so in the PR.
- `src/components/ChatWindow.tsx` :1355 (read-only): the frontend's zero-adjudication line. Your zero-row output must not double-print it.

# Implementation Requirements (in order; stop and ask JD at every outward step)

0. **Orient, read-only.**
       git fetch origin main && git log --oneline -8 origin/main
       git fetch origin refs/heads/deploy/live:refs/heads/deploy/live
       git fetch --unshallow --filter=blob:none
       curl -s "https://skzqwbyvmwqarfgfvyky.supabase.co/functions/v1/osint-agent?health=1"
   Expect `main` ≥ `e872203`, build `c67f90d`, `glm-5.3-flash`, 67 checks / 0 not ok, `deploy/live` == `c67f90d`. If anything moved, another session worked here: read the newest `SESSION_HANDOFF_*.md` and the ledger before acting. Then `list_pull_requests` (save to a file and parse with python; 20+ results overflow the tool result) and report the board: open edge PRs, drafts, anything red. Read `.claude/skills/edge-deploy/SKILL.md` once so the PR you open is deployable later.

1. **Measure the gap post-#943, read-only** (Lovable MCP `query_database`, SELECT only, counts only — never select message text or artifact values): over runs started after the `c67f90d` deploy (ledger `recorded_at` 2026-11-03T04:19:57Z), how many runs made ≥1 `record_finding` call vs. total finished runs, and the `record_artifacts` count beside it. Report the two numbers with the exact SQL. If the rate is already materially above 3%, say so before building — the design below still stands, but JD should hear it.

2. **Design in the PR body before coding** (one paragraph each, decisions logged, not asked): marker contract; row source (the fetch `persistFinalMessages` already makes — no second query; `ceiling_hit` → footer "first N of M"); the adjudicated predicate ported from `intel.ts`; column set; tier mapping (reuse the edge's existing tier helper if one exists — grep `Unverified`; else the per-cycle scale at `system-prompt.ts:172`, stated in the PR); quarantine handling; zero-row behaviour; missing-marker behaviour; failure behaviour; kill switch; proof key; what the prompt change says.

3. **Build it test-first, on branch `claude/findings-table-expansion`** (restart from `origin/main`). Red → green per piece:
   - `lib/findings-table.ts` (new, small): a **pure** renderer `renderFindingsTable(rows, opts) → string` producing one GitHub-flavoured markdown table from persisted rows: finding/value (as persisted, no rewrite), kind, source tool, persisted label, persisted confidence, persisted source-class count where present, and a one-line footer stating the row basis ("N rows from this run's evidence record; M engine-adjudicated (`record_finding`); K quarantined rows withheld"). Deterministic ordering (adjudicated first, then confidence desc, then first-seen). Escape `|`, newlines and markdown in cell text. Quarantined rows are counted in the footer and never listed with a figure. Zero adjudicated rows: the footer carries the honest count; it must not reproduce `ChatWindow.tsx:1355`'s sentence verbatim or the UI double-prints.
   - `expandFindingsTable(content, rows, opts) → { content, event }`: replaces every occurrence of the literal `{{FINDINGS_TABLE}}` line (tolerate surrounding whitespace and a trailing colon; nothing else — no regex over model prose). Marker absent → content unchanged, `marker_found:false`. Any thrown error → content unchanged, event `findings_table_expansion_failed` with the error name only. Bounded: cap rows rendered at the existing `ARTIFACT_FETCH_LIMIT` and cell text at a fixed length with `…`.
   - Wiring in `persistFinalMessages`, server-owned branch only, after the artifact fetch and before the `messages` insert: wrap in try/catch; emit one durable `console.log(JSON.stringify({ event: "findings_table_expanded", thread_id, marker_found, rows, adjudicated, withheld, replaced }))`; apply on the clean-finalize path and the salvage path alike; never on the `onError` / stale-recovery paths. A source-reading wiring test asserts the call site exists in `index.ts` (pattern: `reviews_wiring_test.ts`).
   - Kill switch `FINDINGS_TABLE_EXPANSION_DISABLED=true` in `env.ts`, read at call time, restoring raw passthrough with no deploy; a test asserts it ships ON.
   - `/health` key `checks.findings_table`: `{ ok, enabled, detail }` from a self-test that renders a fixed synthetic fixture and compares to an expected string (fixture rows are synthetic — invented values, no real selectors).
   - Prompt: at `system-prompt.ts:173` the closing report's "(1) a Findings table" becomes "(1) the single line `{{FINDINGS_TABLE}}` where the Findings table goes — the server renders it from the evidence record; do not write the table yourself". Leave :172 (per-cycle lines), :148–:163 (recording and confidence rules) and `finding-prompt.ts`'s wire contract untouched. One prompt test pins the new sentence and that no other closing-report requirement changed. This is NOT a termination change: no `toolChoice`, no `stopWhen`, no phase gate, no finalize gating.
   - Exports: confirm `evidence-export` reads `messages.content` as stored (it will now carry the expanded table) and needs no change; say so in the PR.

4. **Prove it.** All commands in Verification green; the edge suite run from `supabase/tests/osint-agent`; `src/test/edge-deploy-bundle.test.ts` green (function folder stays under 4,300,000 bytes — report the byte count); `npx eslint` on every new edge file (CI's Frontend job lints `supabase/functions/` too). Then open the PR **READY** (not draft — drafts are where this project's work goes to die) with: the design paragraphs, the measurement from step 1, before/after of one synthetic final message (fixture), the proof-key name, the kill-switch name, the byte count, and the statement that frontend, schema, confidence math and `record_finding` are untouched. Subscribe to it and arm one `send_later` check-in (~50 min). Do not merge.

5. **Docs, separately** (its own PR, no code): replace `NEXT_SESSION_PROMPT.md` with this prompt's text plus a dated "state at hand-off" block; refresh CLAUDE.md's "Last verified" line to today's measurements (build `c67f90d`, `glm-5.3-flash`, 67 checks, ledger 2026-11-03T04:19Z, the eight-PR bundle risk, `cluster_adjudications` schema-only); write `SESSION_HANDOFF_2026-11-04_findings-table-expansion.md` (§0 rules, §1 state, §2 JD's decisions, §3 open, §4 traps, §5 verify, §6 subscriptions with trigger ids, §7 next, opening prompt). Add both file names to CLAUDE.md's reading list. Open READY; do not merge.

6. **Stop.** Give JD: the board, the step-1 numbers, the PR links, and the exact go/no-go question for each (merge; then deploy per the `edge-deploy` skill, with `npm run verify:deploy -- --previous c67f90d --mirror ../seeker-spark-search-5362c57c` as the hard gate and `checks.findings_table` as the moved-build proof). If JD gives the deploy go in this session, follow the skill exactly and stop at each of its outward steps.

# OSINT / Analyst Requirements

- The table carries persisted values only: the row's stored label, stored confidence, stored source-class count. No recomputation, no uplift, no "Confirmed" word that the stored label does not justify. Where the engine stored nothing, the cell says so ("—"), it does not estimate.
- Confirmed evidence stays separate from AI inference: adjudicated rows are marked as such; everything else is listed as evidence-record rows, never as findings the engine endorsed. A zero-hit lookup is a coverage observation, not corroboration and not proof of absence — render its stored label, do not relabel it.
- Quarantined (`subject_unlinked`) and analyst-rejected rows never gain authority through this table: withheld from the listing, counted in the footer, provenance untouched.
- Do not collapse the three counting systems (source classes / effective sources / distinct breach names — CLAUDE.md, PR #871) into one column. Show the one the row persisted and name it.
- Synthetic fixtures only. Nothing from JD's runs — no handles, names, IDs, URLs or credential strings — appears in tests, fixtures, PR text, logs or docs.

# Do Not

- Do NOT change `confidence.ts`, `record_finding`, `record_artifacts`, `lib/cluster.ts`, credential masking, minor-safety detection, or any confidence cap.
- Do NOT gate finalize on evidence completeness, add a model call or a new DB query inside the finalize window, or touch `toolChoice`, `stopWhen`, `REQUIRE_TOOL_CALL_IN_OPENING_PHASE`, `detectSeedServer` or anything in the termination area.
- Do NOT parse or regex the model's markdown; the only recognised input is the literal marker.
- Do NOT touch `src/`, `supabase/migrations/`, `.env*`, secrets, `REVEAL_BREACH_DATA`, `RUN_LEASE_DISABLED`, `ORCHESTRATOR_PROVIDER`, `MAX_PAID_CALLS`, or `cluster_adjudications`.
- Do NOT merge, stamp, push to the mirror, send a Lovable deploy message, apply schema, close a PR, enable Codex credits or touch billing without JD's explicit, named go for that step. Do NOT blanket-overwrite the mirror, click Lovable's "Try to fix", merge the mirror's own PRs, or type a SHA by hand.
- Do NOT put a test file under `supabase/functions/`; do NOT "simplify" `npm run test:edge` back to a glob.
- Do NOT start any item from the queue below unless JD names it.
- Do NOT suppress an error, loosen a validation or add a blanket catch to make a test pass; the one catch in this change is the expansion's own fail-safe, and it logs.

# Acceptance Criteria

- [ ] Orientation numbers re-measured and compared with the Context block; drift reported before acting; PR board reported (open edge PRs, drafts, red CI).
- [ ] Step-1 measurement reported with its SQL: runs with ≥1 `record_finding` call / finished runs since 2026-11-03T04:19:57Z, and `record_artifacts` beside it.
- [ ] `lib/findings-table.ts` renderer + expansion are pure, bounded, escaped, deterministic; unit tests cover: mixed labels and confidences, adjudicated vs. evidence-record rows, quarantined rows withheld and counted, zero rows, marker absent, marker twice, marker with trailing colon, `ceiling_hit` footer, a thrown render error leaving content unchanged with the failure event.
- [ ] Wiring test proves the call site in `persistFinalMessages` (server-owned branch; clean finalize and salvage paths; not `onError` / stale recovery).
- [ ] Kill switch `FINDINGS_TABLE_EXPANSION_DISABLED` read at call time; a test asserts it ships ON.
- [ ] `/health` key `checks.findings_table` present with `enabled` and a self-test `ok`.
- [ ] Prompt line at `system-prompt.ts:173` changed to the marker contract; a test pins it; no other prompt line changed; `finding-prompt.ts` untouched.
- [ ] `src/`, migrations, confidence math, `record_finding`, termination code: zero diff (`git diff --stat origin/main -- src supabase/migrations supabase/functions/osint-agent/confidence.ts` is empty).
- [ ] Function folder byte count reported and < 4,300,000; `edge-deploy-bundle.test.ts` green.
- [ ] Full suites green on the branch with real counts; one edge PR READY with the body described in step 4; one docs PR READY; nothing merged, nothing deployed, no secret or flag changed; `reveal_breach_data` still `true`.
- [ ] Handoff written with subscriptions and trigger ids; `Session check` line given.

# Verification

    npm ci
    npm run typecheck && npm run lint && npx vitest run && npm run build && grep -rl harness.local dist/   # last prints nothing
    # Deno is NOT preinstalled in the sandbox:
    DENO_INSTALL=/usr/local sh <(curl -fsSL https://deno.land/install.sh) -y
    cd supabase/tests/osint-agent && deno test --config=../../functions/osint-agent/deno.json --no-check --no-lock --allow-net --allow-env --allow-sys --allow-read . ../evidence-export
    cd ../../.. && du -sb supabase/functions/osint-agent
    npx eslint supabase/functions/osint-agent/lib/findings-table.ts
    PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:e2e > e2e.log 2>&1; echo "playwright exit: $?"   # src/ is untouched; run it anyway and report, CI's PR run skips it
    npm run verify:deploy -- --previous c67f90d --mirror ../seeker-spark-search-5362c57c   # read-only; expect marker_offset_mismatch BEFORE a deploy — the hard gate is only for the deploy step

Run the PR in its own worktree with its own real `node_modules` (a symlinked `node_modules` shares `.vite` and makes e2e flake — 11-02 handoff §4). Never bare `tsc`.

# Return

- Changed files with full paths; the new file's line count; the function folder's byte count.
- Summary of what changed and why, per file.
- Step-1 numbers with the SQL; the PR board as measured.
- Tests and commands run with the real counts (frontend / edge / e2e) on `main` and on the branch; red → green output per piece.
- `/health` proof-key name and the self-test's expected string.
- What you did NOT do and why; remaining risks; anything you could not verify.
- Both PR links; the subscription and check-in trigger ids; the handoff path.
- The exact questions for JD (merge? deploy?). If an approach fails, stop and re-plan; do not patch forward.

# Queue after this session — do not start unless JD names it (one PR each; measured 2026-11-04 on `e872203`)

Frontend (merge-when-green, their own session — do not mix into this one):
1. **Attachment-seeded cases have no subject.** When the first message is only an attachment, the stored title is the raw attachment markdown ("Attached files: - [file](https://…storage…)"), the seed kind is `url` on a signed storage URL, and the identity-cluster engine has nothing to link to: every ledger row reads Unresolved ("N tied to the seed only by discovery"), the Workbench says "No name holds for the subject yet", the export says "Detected subject: attached files -". #966 (`src/lib/case-name.ts`, `src/lib/seed.ts`) fixed the pasted-export title but not this. Fix shape: title from the attachment's file name (`src/lib/attachments.ts` parses the block); an analyst-driven "Set as subject" on an evidence row (never automatic, audited); seed kind `attachment`, not `url`. Needs JD's design call on where "Set as subject" lives (context menu/inspector, no new toolbar button).
2. **Quarantine basis text duplicates**: the ledger's Evidence-basis column renders "Shared infrastructure · Shared infrastructure · not ownership proof" — the status label and `evidence-status.ts:270`'s basis string are both printed. One-line fix plus a test.
3. **Harness fixture** has no row linked to the subject beyond the seed (11-02 handoff §3) — only the unit test exercises "Connections identified". Sanitised synthetic row.

Edge (one build each, JD's go):
4. **`indicia_web_dbs` schema gap** — reproduced live today: `HTTP 400: snusbaseType is required when snusbase is selected`. No PR, no code reference to `snusbaseType` anywhere. Schema `refine` in `tool-registry.ts` so the pair is required together; a test; proof key.
5. **Heartbeat fix** (11-01 glm-5.3 handoff §5): `recovery.ts:879` `startRunHeartbeat` still sets `inFlight` before the write and clears it only in `.finally()`, no timeout bound, predicate `.eq("id").eq("status","active")` lacks `run_started_at`. Bounded write timeout + clear in `finally` + `run_started_at` in the predicate. Offline-testable. Separate from (6).
6. **Durable admission row** — #903 is a docs proposal; its four decisions are JD's.
7. **GLM pricing** — `index.ts:1975` meters every GLM model at flat `[0.3, 1.2]` (fallback `[0.3, 2.5]`) micro-USD/token; `glm-5.3-flash` is overcharged ~2×, `glm-5.2` was undercharged ~4×; GLM salvage tokens are not metered at all. Per-model table in the shape of `costs.ts:272` `ANTHROPIC_RATES_MICRO_USD_PER_TOKEN` with a pessimistic unknown-model fallback and `pricing_known`; do NOT add a second `onCost` feed.
8. **Claude adjudicator** for ambiguous / name-collision clusters — `cluster_adjudications` table exists (#961/#962), zero code references; spends the Anthropic key; design first, JD's go.
9. **Operator Directives panel** via `agent_memory` `kind='lesson'` (`lib/memory-brief.ts:269` already reads them; /brain has `OutcomeLessonsPanel` from #968) — grep before building.
10. **Board triage** owed to JD: #929 READY (edge, English-only orchestrator); drafts #883, #882, #821, #804, #800, #793, #763, #701, #613, #593, #516. Codex review credits: JD's call.
11. **Security observation** (11-01 audit §0): `anon`/`authenticated` hold default privileges incl. TRUNCATE on `orchestrator_invocations` / `orchestrator_step_metrics` in production (RLS does not cover TRUNCATE; #962 fixed the same shape for `cluster_adjudications` only). Chase or leave — JD's call.
```
