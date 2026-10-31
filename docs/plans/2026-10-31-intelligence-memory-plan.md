# Intelligence + memory plan — corrected and implementation-ready (2026-10-31)

Author: Claude (Fable 5.1), read-only verification session on worktree
`xenodochial-pasteur-314937`, branch `claude/intelligence-memory-plan-audit-3c5c9d`.
Input: the Codex audit JD pasted on 2026-10-31. Every claim below was re-checked against
`origin/main`, GitHub, live `/health`, the M1 worktree and the source files the audit named.
Nothing was edited, committed, pushed, merged, deployed or written to production.

**Revision 2 (2026-10-31 02:20 PDT)** after Codex's review of revision 1: one storage model
(`tool_lessons`, §4.6/§4.8), role-switched RLS assertions (§4.5/§4.6), full SHA-256 structured
attribution records moved out of M1 hardening into PR-E8 (§4.5/§4.11), an explicit `window_key`
uniqueness column (§4.6), a full candidate lifecycle (§4.8), observation-based freshness (§4.5),
the release recipe corrected (§5.2), and the CI statement corrected (§1.2 item 1). Stage 1 is
unchanged and is being implemented by the frontend session; Stages 3–5 are held pending JD.

How this document is organised: §1 facts and corrections, §2 ranked defects, §3 dependency graph
and PR order, §4 one spec per PR (files, acceptance, tests, rollback, proof), §5 verification
matrices, §6 decisions for JD, §7 the single next action. Appendix A maps every audit requirement
to a heading. Appendix B holds the corrected PR body text for #925 / #926.

Channel rule used throughout (CLAUDE.md "Ship in SMALL PRs"): frontend PRs ship on merge via
Vercel; edge PRs do not ship on merge and each needs its own stamp → surgical sync →
`verify:deploy` → Lovable deploy → `/health` proof → ledger cycle; schema changes land first,
applied and verified, and never in the same PR as the code that depends on them. Frontend,
edge, schema and telemetry work are therefore separate PRs everywhere below.

---

## 1. Confirmed facts, corrected claims, assumptions, unknowns

### 1.1 Baseline, re-measured 2026-10-31 ~01:40 PDT

| Item | Audit said | Measured | Status |
|---|---|---|---|
| `origin/main` | `96f6bac6…cc0de7` | `96f6bac6bdd7e247ee465950ab92b7bf15cc0de7` | confirmed |
| Live `osint-agent` build | `cb4c6a27` | `build: cb4c6a27`, 61 `checks.*`, 0 not ok | confirmed |
| `deploy/live` | `cb4c6a27` | `cb4c6a27` | confirmed |
| `reveal_breach_data` | true, preserve | `true` on `/health` | confirmed; no PR here touches it |
| #868 | open, ready, head `caf94694` | OPEN, draft=false, `caf94694…`, MERGEABLE | confirmed |
| #925 | open draft, head `3c24b2f7` | OPEN, draft=true, `3c24b2f7…`, MERGEABLE | confirmed |
| #926 | open draft, head `409cfcd5` | OPEN, draft=true, `409cfcd5…`, MERGEABLE | confirmed |
| #927 | open draft, head `77fe215f` | OPEN, draft=true, `77fe215f…`, MERGEABLE | confirmed |
| M1 worktree / branch | `/Users/dizosint/if-m1-memory-brief`, `feat/m1-run-start-memory-brief` | same; clean tree | confirmed |
| M1 head | `cde3c1d8` following `04c8e827` | `cde3c1d8` ← `04c8e827` ← `9c5c655f` (merge-base with main) | confirmed |
| #721 | memory-as-context safeguards, not M1 | MERGED; `lib/memory-context.ts`, `checks.memory_context` | confirmed |
| Live health `memory_brief` key | absent | absent (memory keys present: `dead_target_memory`, `memory_context`, `memory_authority`, `historical_memory`, `memory_input_normalization`, `next_pivot_brief`) | confirmed |

### 1.2 Corrections to the audit and to the prior plan files

1. **CI is now verified green; this adds verification rather than contradicting the audit**, which
   reported CI as unverified, not failing. Checked today: #868, #925, #926 and #927 all show
   `Frontend (vitest + build)`, `Migrations (psql validation)` and `Edge functions (deno test)` =
   SUCCESS; `Workspace e2e (playwright)` = SKIPPED (by design, PR CI never runs it). The Actions
   budget that was exhausted on 2026-10-30 has been reset.
2. **M1 is not pushed and is 16 commits behind `main`.** `git ls-remote origin 'refs/heads/feat/m1*'`
   returns nothing. The branch is based on `9c5c655f`; `main` has since taken #873, #874, #915–#924,
   #910, #907, #906, #903 (none touch `lib/memory-brief.ts`, but #910 touches intelligence code and
   #923/#924 moved the build marker). A rebase is a precondition of every M1 step, not a step.
3. **The roadmap file names the wrong M1 branch.** `/Users/dizosint/.claude/plans/memory-and-intelligence-roadmap.md`
   says the M1 commits sit on `feat/m2-tool-lesson-reflection`. The worktree is on
   `feat/m1-run-start-memory-brief`. Use the worktree's branch name.
4. **#927's RECALLS tooltip is wrong.** It says a hit is "one call to memory_recall that returned a
   memory". `hit_count` is incremented on two paths: `bump_memory_hits` from `memory_recall`
   (`tool-registry.ts` ~:6578, active rows only) **and** the `ON CONFLICT … DO UPDATE SET
   hit_count = m.hit_count + 1` in `save_agent_memories`
   (`supabase/migrations/20260529145859_…sql`), i.e. every re-save of the same
   `(user, kind, subject, scope)` counts as a hit. The audit's point 3 is confirmed.
5. **#927's AVG CONFIDENCE tooltip asserts a relationship that does not exist.** It says the
   Overview card "is the all-time average and uses the full population". The Overview card
   (`src/pages/Insights.tsx:116`, `totals.avgConfidence`) is `get_insights_summary.avg_confidence`,
   which averages **`public.artifacts.confidence`** (`supabase/migrations/20260708_insights_summary_rpc.sql`).
   The header chip averages **`agent_memory.confidence`** over the 500-row slice
   (`BrainGlobalPage.tsx:233`). 66% vs 49% are two different nouns, not two populations of one noun.
   This is the most severe Stage 1 defect and #927 does not fix it.
6. **"Top sources" ranks artifact volume.** `derived.topSources` is `summary.source_counts`
   (`InsightsDerived.ts:69`): `count(*)` of `public.artifacts` grouped by `source`, top 8. It is not
   a reliability ranking and not a memory metric. The Sources tab already computes reliability
   honestly (successes ÷ real attempts, 30 days, live calls only; `summarizeSourceReliability`).
   The fix is a label and a pointer, not a new metric.
7. **Local hide vs local mute have different effects on the numbers.** `stats` filters out
   `deleted` (the "Hide" action, `localStorage` key `brain_deleted_memories`) but **not**
   `suppressed` ("Mute", `brain_suppressed_memories`). Both are browser-local; neither touches
   stored rows (the page's own governance note says so). So "locally visible" ≠ "fetched slice"
   exactly when something has been hidden, and the hidden count is shown nowhere.
8. **#927's count-failure fallback claims completeness.** `const { count: memTotal } = await …`
   discards `error`; `memoriesTotal` stays `null` while loading and on failure, and the chip then
   renders "All of this user's memories fit in the 500-row display slice". Audit point 2 confirmed.
9. **#927 satisfies audit point 5 for one chip only.** `RECENT · 500 of 1,672` is visible without
   hovering; every other explanation is a `title=` tooltip. Mobile has no hover.
10. **#925 and #926 both say "bundled with" the other.** Both bodies end their test plan with
    "Deploy via `edge-deploy` skill, bundled with …". Neither adds a `/health` key or a kill switch
    of its own (`gh pr diff` shows no `checks.` or `_DISABLED` additions; #925 reuses the existing
    `INPUT_COERCION_DISABLED` switch of `lib/tool-input-coercion.ts`). Both change
    `tool-registry.ts`, so whichever merges second must rebase. Corrected body text: Appendix B.
11. **#868 is not a prerequisite for M1 or M2.** It widens the key aliases
    `lib/memory-input-normalization.ts` accepts on the model-facing `memory_save` input. M1 reads
    rows; a server-side M2 writer uses canonical field names and never goes through the model-facing
    schema. Audit confirmed.
12. **"Dark until M2" cannot be claimed.** `memory_save` defaults `scope='global'` and accepts any
    `subject` string (`tool-registry.ts` ~:6641–6646), and the analyst "Mark false" lesson also
    writes `global` with a 3-argument call (`src/lib/review.ts:597`). Whether `tool:*` rows already
    exist is a measurement (§1.4 U1), not an assumption. The brief must be designed as if the
    population is non-empty on day one.
13. **M1 fetch-window starvation is real.** `index.ts` (M1 hunk) orders by `confidence desc` and
    takes `limit(40)` **before** `buildMemoryBrief` drops unregistered tools. 40 high-confidence rows
    about retired tools would empty the brief. Also no `kind`, freshness or supersession filter.
14. **M1's deadline does not cancel the query.** `loadToolLessons` races a timer against the
    PromiseLike; the losing query keeps running. No `abortSignal()` is used anywhere in the function
    today (grep: zero call sites), so this is a new pattern, not a reuse.
15. **Supersession does not apply to `tool:` lessons.** `lib/memory-supersession.ts` keys on
    selector equality (subject / `related_values` vs analyst-rejected values). A tool name is not a
    selector. What is reusable is the *pattern* (`reviewed` flag + "retain for audit, remove
    authority"), not the module.
16. **The real "memory is not evidence" control is `lib/memory-context.ts` (#721)**, on the write
    path of `record_artifacts`/`record_artifact`: a memory token is removed from the source label,
    disclosed in metadata, and a memory-only row is forced to `needs_review` (cap 50 via class
    `unknown`). M1's header sentence is wording. The plan cites the control, not the wording.
17. **`.github/ci/assert-agent-memory-scope.sql` tests save semantics**, not retrieval isolation:
    scope-aware uniqueness, one `save_agent_memories` overload, upsert bumps `hit_count`. Confirmed.
    The existing wiring tests (`memory_brief_wiring_test.ts`, `next_pivot_wiring_test.ts`) read
    `index.ts` as text and assert substrings. Confirmed.
18. **The prior plan's Round 5 "win rate" is observational**, not causal. Stage 5 below renames it.

### 1.3 Assumptions (stated so they can be falsified)

- A1. The 500-row cap in `BrainGlobalPage.tsx:183` stays. The task is honesty about it, not removing it.
- A2. The orchestrator stays GLM-5.2 primary / Anthropic backup; no change proposed here.
- A3. `RUN_LEASE_DISABLED=true` and `REVEAL_BREACH_DATA=true` are untouched (CLAUDE.md "settled").
- A4. pg_cron + pg_net are available in production (they already drive the health sweep
  `20260720031500_pg_cron_health_sweep.sql` and the cache sweep `20260828200000_…sql`).
- A5. `EdgeRuntime.waitUntil` is the sanctioned background hook in `index.ts` (three call sites today).
- A6. JD applies schema migrations by direct SQL, as for #899 (CLAUDE.md, telemetry design §8).
- A7. The PostgREST `.in()` filter accepts the ~110 registered tool subjects in one query (well under
  URL limits; `username_sweep` style lists are longer).

### 1.4 Unknowns, each with the check that resolves it

| # | Unknown | Resolves by | Who |
|---|---|---|---|
| U1 (resolved 2026-10-31 02:33 PDT) | How many `agent_memory` rows already have `subject LIKE 'tool:%'`, by scope and kind | Read-only counts via the Lovable database connection (JD said "do what's best"; counts only, no row content read): **0** rows with a `tool:` subject. Whole table: 1,703 rows, 16 users, 623 `kind='lesson'`, 1,484 `scope='global'`. So the M1 eligible population is empty **today**; "dark until M2" is true as a measurement, not as a guarantee (§1.2 item 12 still holds: nothing stops a future `memory_save` from writing one). | done |
| U2 | Whether `src/dev/supabase-mock.ts` can drive the Intelligence page's populated states for e2e | it has `agent_memory: []` and a `get_insights_summary` stub whose shape lacks `avg_confidence`/`source_counts`; populated e2e needs fixtures (PR-F1 adds them) | PR-F1 author |
| U3 | p50/p95 of the brief read in production | `memory_brief` log event `ms` after M1 deploys | post-deploy read |
| U4 | Whether supabase-js in `osint-agent` exposes `.abortSignal()` on the chained builder (it does on current `@supabase/postgrest-js`) | `deno check` of the M1 branch after the change | PR-E4 author |
| U5 | Whether #903 PR B (durable telemetry) lands before Stage 5 | JD's sequencing | JD |
| U6 (resolved) | Is there one `streamText` call per request, so one hoisted id can serve both the brief event and the invocation row? | `grep -n "createInvocationTelemetry(\|streamText(" index.ts` → one recorder (`:1198`), one `streamText` (`:1534`), neither in a loop. The Anthropic start-failure fallback (#769) swaps the model, not the call. Plan stands. | done |

Inventory SQL for U1 (read-only; run on 2026-10-31 as counts only, result above; keep for re-measuring
before PR-E4 ships, since a `tool:` row can appear at any time):

```sql
select scope, kind, count(*) as rows, min(created_at) as oldest, max(updated_at) as newest,
       count(*) filter (where confidence >= 75) as hi_conf
from public.agent_memory
where subject like 'tool:%'
group by scope, kind
order by rows desc;

-- which of those name a tool that is still registered? Paste Object.keys(buildTools(...)) as needed.
select substr(subject, 6) as tool_name, scope, count(*) from public.agent_memory
where subject like 'tool:%' group by 1, 2 order by 3 desc limit 50;
```

---

## 2. Severity-ranked verified defects

Severity: S1 = misleads an analyst or breaks a contract today; S2 = wrong once a population exists;
S3 = label/clarity; S4 = hygiene.

| # | Sev | Defect | Where (file:line on `main` unless noted) | Fixed by |
|---|---|---|---|---|
| D1 | S1 | Header "AVG CONFIDENCE" (memory confidence, slice) sits above Overview "Avg confidence" (artifact confidence, all rows); same label, different noun | `src/pages/BrainGlobalPage.tsx:233,310`; `src/pages/Insights.tsx:116`; `src/pages/InsightsDerived.ts:100`; RPC `supabase/migrations/20260708_insights_summary_rpc.sql` | PR-F1 |
| D2 | S1 | `markdown_extract` `.refine()` calls `new URL(u)` unguarded → `safeParse` throws on `<https://…>` (SDK tool-call contract violation, surfaces as a crash) | `supabase/functions/osint-agent/tool-registry.ts` (#926 diff) | #926 |
| D3 | S1 | `breach_check` schema ends in `.refine()` (ZodEffects) so `memoSchema` skips generic coercion; `{value: 6175550100}` rejected | `tool-registry.ts` (#925 diff) | #925 |
| D4 | S2 | M1 fetch window: `order(confidence).limit(40)` before the registry filter → obsolete-tool rows starve eligible lessons | M1 `index.ts` hunk at ~:990–1000 | PR-E4 |
| D5 | S2 | M1 eligibility: no `kind`, freshness, supersession/revocation or provenance filter; ranks by ratcheted `confidence` then `hit_count` | `if-m1-memory-brief/…/lib/memory-brief.ts:96` (`body.sort`) and the `index.ts` query | PR-E4 |
| D6 | S2 | M1 builder trusts the rows it is handed (no row-level re-check of scope/kind/prefix) | `lib/memory-brief.ts` `buildMemoryBrief` | PR-E4 |
| D7 | S2 | M1 deadline does not cancel the query; no `abortSignal` | `lib/memory-brief.ts` `loadToolLessons` | PR-E4 |
| D8 | S2 | M1 events carry counts only: no lesson ids/versions, no invocation id (brief is built at ~:1084, the invocation id is created at ~:1197) | M1 `index.ts`, `telemetry.ts:551` | PR-E5 (invocation id hoist), PR-S2/PR-E8 (durable records); deliberately **not** PR-E4 |
| D9 | S1 | Header "MEMORIES · 500" vs Overview "Memories 1,672" (slice vs stored total) | `BrainGlobalPage.tsx:308`; `useInsightsData.ts:45` | #927 partially; PR-F1 |
| D10 | S1 | Count failure / loading renders "All … fit in the 500-row display slice" | #927 diff (`memoriesTotal == null` branch) | PR-F1 |
| D11 | S3 | "RECALLS" label and tooltip: `hit_count` also increments on re-save | `BrainGlobalPage.tsx:232,309`; RPC `20260529145859` `DO UPDATE SET hit_count = m.hit_count + 1`; `bump_memory_hits` `20260527221436:20` | PR-F1 |
| D12 | S3 | Locally hidden rows change the numbers with no visible count; mute does not | `BrainGlobalPage.tsx:230,246` | PR-F1 |
| D13 | S3 | "Top sources" is artifact volume by `source`; reads as reliability | `Insights.tsx:142`; `InsightsDerived.ts:69` | PR-F1 |
| D14 | S3 | Explanations hover-only (`title=`); mobile has no hover | #927 diff | PR-F1 |
| D15 | S3 | `memory_save` shape failures (7 of 123 in 10 days) on `memories`/`memory_items`/`items`/`notes` | `lib/memory-input-normalization.ts` | #868 |
| D16 | S4 | #925 and #926 bodies promise a bundled deploy; neither adds a proof key | PR bodies | Appendix B; JD edits bodies |
| D17 | S4 | Oversized header / empty gap on the Intelligence page | `BrainGlobalPage.tsx:270–330` | PR-F1 (contained) |
| D18 | S2 | `tool_usage_log` has no `invocation_id`/`call_id`; observations cannot be joined to a run attempt | `20260527101144_…sql:34`, `cache.ts:1077` row writer | PR-S1 |

---

## 3. Dependency graph and recommended PR order

```
Frontend (Vercel on merge)        Edge (one build each)                 Schema (JD applies)
──────────────────────────        ─────────────────────                 ───────────────────
PR-F1  Intelligence honesty       #926 markdown_extract safeParse
  (rework #927; D1,D9–D14,D17)    #925 breach_check coercion  (rebase after #926)
        │                         #868 memory_save aliases    (independent)
        │                               │
        │                         PR-E4 M1 hardening ──────── needs U1 inventory read first
        │                               │ (rebase M1 onto main, then harden, then one deploy)
        │                               │
        │                               │                      PR-S1  invocation_id on tool_usage_log
        │                               │                             + ONE table: tool_lessons
        │                               ▼                             (applied + verified first)
        │                         PR-E5 observation stamping (hoisted invocation id on every log row)
        │                               │
        │                         PR-S1b aggregate_tool_lessons() + pg_cron job (dry-run first)
        │                               │
PR-F2  Lesson review UI ◄───────────────┤  (reads tool_lessons; candidate→approved/rejected, active→revoked)
        │                               │
        │                         PR-E6 M1 reads tool_lessons WHERE status='active' ∪ legacy agent_memory tool:*
        │                               │
        │                               │                      PR-S2  memory_brief jsonb on
        │                               │                             orchestrator_invocations (JD approval)
        │                         PR-E8 exposure attribution ({id, version, sha256} records per invocation)
        │                               │
PR-F3  Learning-loop pane ◄─────────────┘  (observations, candidates, active/expired, exposure, outcomes)
```

Recommended order, with the reason each sits where it does:

1. **PR-F1** (frontend) — fixes S1 label defects visible today; CI green path; no deploy ceremony.
   Rework #927 on its own branch (`lead-project/brain-honest-labels`) rather than opening a new PR.
2. **#926** (edge build 1) — a thrown `TypeError` out of `safeParse` is a contract violation and a
   crash; highest verified severity among the three.
3. **#925** (edge build 2) — valid input rejected; rebase onto main after #926 (both touch
   `tool-registry.ts`).
4. **#868** (edge build 3) — input shape compatibility; already ready for review; lowest severity
   of the three. Its order relative to #925 is JD's call; nothing depends on it.
5. **PR-E4 + M1 deploy** (edge build 4) — only after U1 is read and the hardening in §4.5 is in.
6. **PR-S1** (schema) — `invocation_id` on `tool_usage_log` and the single `tool_lessons` table
   (a candidate is a `tool_lessons` row in status `candidate`; there is no second table). Applied
   and verified in production before PR-E5.
7. **PR-E5** (edge build 5) — stamp `invocation_id` on every `tool_usage_log` row. Observations
   start accumulating; nothing reads them yet.
8. **PR-S1b** (schema) — the aggregator SQL function and its pg_cron schedule (dry-run mode first).
9. **PR-F2** (frontend) — lesson review UI.
10. **PR-E6** (edge build 6) — M1 reads active `tool_lessons`.
11. **PR-S2 → PR-E8 → PR-F3** — attribution, then the learning-loop pane.

Hard rules honoured: at most one edge PR in flight; schema before dependent code; frontend never
mixed with edge; every behaviour-changing edge PR adds a `/health` key or durable log event.

---

## 4. Per-PR specifications

### 4.1 PR-F1 — Intelligence tab: one honest population per number (frontend)

Supersedes #927's approach; reuse its branch `lead-project/brain-honest-labels` and its
`memoriesTotal` fetch.

**Affected files**
- `src/pages/BrainGlobalPage.tsx` (header strip, stats, Memories tab caption)
- `src/pages/Insights.tsx` (Overview tile labels, "Top sources" card title/sub)
- `src/hooks/useInsightsData.ts` (expose `memoryCountError`; no new queries)
- new `src/test/brain-header-populations.test.tsx` (modelled on `src/test/sources-tab-render.test.tsx`)
- `src/dev/supabase-mock.ts` (harness fixtures: ~12 `agent_memory` rows and a
  `get_insights_summary` stub with `avg_confidence`, `source_counts`, `tool_counts`,
  `tool_calls_total`, so the populated page renders in the harness)
- new `e2e/intelligence.spec.ts` (harness; empty and populated states)
- screenshots under `docs/pr-intelligence-screens/` (before/after at 1280 and 375 widths)

**Behaviour (the audit's nine points, corrected)**
1. Three populations, each named on screen: **stored** (exact `head:true` count; the header reads
   it from #927's loader query so it refreshes with the sample on the same realtime channel, while
   the Overview tile keeps its own copy from `useInsightsData` — two reads of one number, on
   purpose), **recent sample** (the 500 newest by `created_at`, the slice the page
   renders), **shown** (sample minus locally hidden). The header group is titled
   `RECENT MEMORY SAMPLE · 500 most recent of 1,672` as text, not a tooltip.
2. Count states: loading → `… of —`; count error → `500 shown · total unavailable` and never the
   phrase "all memories fit"; success → `500 of 1,672`; sample < 500 and count == sample →
   `12 memories (all stored)`.
3. `hit_count` chip label `HITS (recalls + re-saves)` with on-screen micro-copy: "a row's hit
   count rises when `memory_recall` surfaces it and when the same lesson is saved again". No
   claim that hits are recalls.
4. Local hide: show `N hidden locally` beside the sample caption when `deleted.size > 0`
   (intersected with the sample); the micro-copy says hidden rows are excluded from these
   numbers and still exist in the database. Mute stays a view effect with no number change.
5. Population scope is in the caption text (point 1), visible at every width.
6. Overview owns the all-stored summary: the `Memories` tile keeps the exact stored count and gains
   `sub="Stored, all time"`. The `Avg confidence` tile is relabelled `Artifact confidence` with
   `sub="Source score over all artifacts — not memory, not analyst review"`. Memory confidence
   stays in the header as `MEMORY CONFIDENCE (sample)`. No new RPC is required for Stage 1; an
   all-stored memory confidence would need a `get_insights_summary` change (schema channel; §6 Q3).
7. The SocialFetch chip moves out of the memory group into a `CREDITS` group with the same
   value and label; the Credits sub-tab stays the full view.
8. `Top sources` → `Most-recorded sources` with sub `Artifact count by source — volume, not
   reliability. Reliability is on the Sources tab.`
9. Header: drop the decorative subtitle at all widths (it already hides on mobile), tighten
   vertical padding, keep the governance note. Not a redesign; token values untouched (DESIGN.md
   Named Rules win over generic audits).

**Acceptance criteria**
- No two numbers on `/brain` share a label while describing different populations or nouns.
- Every explanation is readable without hover at 375 px width.
- A count error cannot produce a completeness claim.
- Hidden count is shown when non-zero; muting changes no number.

**Tests**
- Render test (stubbed client, real component) for: empty (0 rows, count 0), under-cap (12 rows,
  count 12), over-cap (500 rows, count 1,672), locally hidden (deleted set of 3), count-failure
  (`error` set, `count` null), loading (pending promise), refresh (invoke the captured
  `postgres_changes` callback; assert both sample and total re-query in the same loader).
- Mobile: a vitest DOM assertion that the caption text is present and no element relies on
  `title` for population scope; a Playwright screenshot at 375×812 in the harness.
- Repo-required checks: `npm run typecheck`, `npm run lint`, `npx vitest run`, `npm run build`,
  and by hand `PLAYWRIGHT_CHROMIUM_PATH=… npm run test:e2e` (baseline 95 passed / 13 skipped on
  `main`; re-measure first). `app-shell.spec.ts` already asserts `/brain` navigation; the new spec
  asserts the empty-state caption and, with fixtures, the `of` caption.

**Rollback / proof**: frontend, revert the merge commit; Vercel `target: production` deployment on
`main` is the proof (not a preview). Before/after screenshots in the PR per the visual-delta gate.

### 4.2 #926 — `markdown_extract` safeParse never throws (edge build 1)

Files: `supabase/functions/osint-agent/tool-registry.ts`,
`supabase/tests/osint-agent/markdown_extract_url_refine_test.ts`.
Acceptance: `<https://example.com/doc.pdf>` is a validation failure, not a throw; `ftp:`/`data:`/
`file:` still rejected; plain https validates (PR body's test plan, 9/9).
Review items before ready: body says "bundled with #925" → replace with Appendix B text; no
proof key or kill switch of its own → either accept "moved build SHA" as proof (JD) or add a
one-line probe to an existing self-test (`tool-input-coercion.ts` self-test is the natural home).
Release: stamp → surgical sync → `npm run verify:deploy` (`mirror tree -> equal`) → Lovable
deploy message → `/health` build moved → `record:deploy` ledger PR.

### 4.3 #925 — `breach_check` numeric phone coercion (edge build 2)

Files: `tool-registry.ts`, `supabase/tests/osint-agent/input_coercion_test.ts`.
Acceptance: `{value: 6175550100}` coerces and runs; `{}` and `""` still rejected; model-facing
JSON schema unchanged; `INPUT_COERCION_DISABLED=true` restores strict behaviour (existing switch).
Precondition: rebase onto `main` after #926 merges (shared file). Body correction: Appendix B.
Release: own full cycle.

### 4.4 #868 — `memory_save` entry/content aliases (edge build 3)

Files: `lib/memory-input-normalization.ts`, `supabase/tests/osint-agent/memory_input_normalization_test.ts`.
Acceptance per PR body; existing switch `MEMORY_INPUT_NORMALIZATION_DISABLED`; proof = two new
probes under the existing `checks.memory_input_normalization` + moved build SHA.
Not a prerequisite for anything in Stages 3–5. Release: own full cycle.

### 4.5 PR-E4 — M1 hardening before release (edge build 4)

Precondition: `git rebase origin/main` of `feat/m1-run-start-memory-brief` in
`/Users/dizosint/if-m1-memory-brief`; push; open as draft. Read U1 first.

**Affected files**
- `supabase/functions/osint-agent/lib/memory-brief.ts`
- `supabase/functions/osint-agent/index.ts` (the M1 hunk only)
- `supabase/functions/osint-agent/telemetry.ts` (accept an externally supplied invocation id)
- `supabase/functions/osint-agent/health-handler.ts` (probe extension, same key)
- `supabase/tests/osint-agent/lib/memory_brief_test.ts`
- `supabase/tests/osint-agent/memory_brief_wiring_test.ts`
- new `supabase/tests/osint-agent/lib/memory_brief_isolation_test.ts`
- new `.github/ci/assert-memory-brief-rls.sql` + a step in `.github/workflows/ci.yml` next to
  "Agent memory scope assertion"

**Eligibility rules (explicit, in code and in the doc header)**
| Rule | Enforced where | Why |
|---|---|---|
| `user_id = userId` | query + RLS assertion | owner only |
| `scope = 'global'` | query **and** builder re-check | case rows never cross cases |
| `kind = 'lesson'` | query **and** builder re-check | patterns/connections/identity are selector memory |
| `subject IN (tool:<registered name>…)` | query (`.in()` over the registry's canonical names **plus** the `TOOL_NAME_ALIASES` keys, e.g. `tool:web_search`; the builder maps aliases to canonical) **and** builder re-check | removes starvation (D4) and the post-hoc drop; a legacy row saved under an alias is not silently dropped |
| freshness `created_at >= now() - MEMORY_BRIEF_MAX_AGE_DAYS` (90) for legacy `agent_memory` rows | query | `updated_at` moves on every re-save (the `agent_memory_updated_at` trigger fires on the upsert's `DO UPDATE`), so it does not prove recent supporting evidence; `created_at` is the only date on a legacy row that cannot be refreshed by a duplicate save. For M2 rows freshness is `evidence_through` (the newest observation in the supporting window, §4.6), never a row timestamp |
| not an analyst false-positive marker (`isAnalystFalseLesson`) | builder | those are selector exclusions, not tool lessons |
| provenance | none available on `agent_memory` (no writer column; `memory-provenance.ts` header) | treat all as `unreviewed`; M2's table carries real provenance |

Supersession: not reused (selector-keyed). Revocation for legacy rows = JD deletes or re-scopes
them; for M2 lessons = status change (§4.8).

**Selection**: order `created_at desc, id asc` (deterministic, no `confidence`/`hit_count`/`updated_at`); at most
`MEMORY_BRIEF_PER_TOOL_MAX = 2` rows per tool; newest wins a conflict; keep `MEMORY_BRIEF_MAX_ROWS`
12 and `MEMORY_BRIEF_MAX_CHARS` 1,600; fetch limit = `min(3 × MAX_ROWS, 120)` after the server-side
`.in()` filter.

**Deadline**: `AbortController`; pass `.abortSignal(ctrl.signal)` on the query; on deadline call
`ctrl.abort()`; `loadToolLessons` reports `deadline` and the test asserts the signal is aborted.

**Legacy free-form `tool:*` rows**: included only if they pass every rule above (so `kind='lesson'`,
global, fresh, registered). Everything else is counted in a new `dropped_ineligible` stat. If U1
shows a large eligible legacy population with poor wording, JD may choose to exclude legacy rows
entirely until M2 (switch `MEMORY_BRIEF_LEGACY_ROWS=false`); default include.

**Sanitisation**: unchanged mechanics, header comment corrected: control characters and line
collapsing prevent heading injection into the prompt structure; they are not semantic
prompt-injection protection. The evidence-integrity control is `lib/memory-context.ts` (#721) on
the write path plus the promote/report gates; the brief lives only on `intermediateSystem`, which
the wiring tests pin (`occurrences === 3`, base/finalize/salvage untouched).

**Observability (M1 hardening release only)**: the `memory_brief` event stays count-only and gains
one counter, `dropped_ineligible`, with a `reasons` map (`kind`, `stale`, `unregistered`,
`false_marker`, `scope`). No lesson ids, hashes or invocation id ship in this build: durable
attribution is its own approval unit (§4.11, §6 Q8) and must not ride in under M1 hardening. The
invocation-id hoist (`crypto.randomUUID()` at request setup, passed into
`createInvocationTelemetry` as a new optional field; `telemetry.ts:551` keeps its own uuid as the
fallback) belongs to PR-E5, which needs it for stamping anyway. Verified one `streamText` and one
recorder per request (§1.4 U6), so one id is sufficient when that lands.

**Inventory before "empty"**: the plan refuses the phrase "no eligible population" until U1 is
read; `/health` self-test continues to prove bundle presence only.

**Latency and prompt**: measure from the event (`ms`, `chars`) over the first 50 runs after
deploy; acceptance p95 `ms` ≤ 400 and `chars` ≤ 1,600; if p95 is exceeded the deadline (2,500 ms)
already bounds harm, but the number goes in the ledger PR.

**Tests**
- `memory_brief_test.ts`: eligibility re-checks (scope, kind, prefix, false-marker), deterministic
  order with ties, per-tool cap, no `confidence`/`hit_count` influence (mutation: sorting by
  confidence must fail a test), legacy switch.
- `memory_brief_isolation_test.ts` (behavioural, not string-matching): a fake builder that records
  predicates and serves a fixture of two users × {global, case} × {lesson, pattern, identity} ×
  {fresh, stale} × {registered, retired}; assert exactly the eligible set reaches the model text,
  and that a row slipped past the query (wrong scope/kind) is still dropped by the builder.
- `memory_brief_wiring_test.ts`: keep the three existing pins; add the `.in("subject", …)` and
  `abortSignal` substrings; keep the `occurrences === 3` check.
- `assert-memory-brief-rls.sql`: the CI job runs psql as the `postgres` superuser
  (`ci.yml` `PGUSER: postgres`), which bypasses RLS, so setting `request.jwt.claim.sub` alone proves
  nothing. The assertion must: seed rows for users A and B as superuser; `SET LOCAL ROLE authenticated`
  (created NOLOGIN NOINHERIT by `.github/ci/supabase-platform-shim.sql`); assert
  `current_user = 'authenticated'` and `rolbypassrls = false` for that role (anti-vacuous guard);
  set `request.jwt.claim.sub` to A; assert `select … where subject like 'tool:%'` returns A's rows
  and zero of B's; assert an `UPDATE`/`DELETE` targeting B's row affects 0 rows; `RESET ROLE`; and
  separately assert that `service_role` (BYPASSRLS in the shim, as in production) sees both, so the
  test fails loudly if the shim's role set ever changes. Everything inside a transaction rolled back
  at the end, `--set ON_ERROR_STOP=1`.

**Kill switch / proof / rollback**: `MEMORY_BRIEF_DISABLED=true` (read at call time); new key
`checks.memory_brief` (probe extended with an ineligible-kind row and a stale row); rollback is a
secret flip, no deploy. Preserves cached base, finalize, salvage, evidence authority and terminal
state by construction (nothing in the termination area is touched; `stopWhen`, `toolChoice`,
`REQUIRE_TOOL_CALL_IN_OPENING_PHASE` unchanged).

### 4.6 PR-S1 — schema for observations and lessons (schema, applied first)

One migration file, additive only, applied by JD and verified before PR-E5 merges.

- `ALTER TABLE public.tool_usage_log ADD COLUMN IF NOT EXISTS invocation_id uuid;` plus index
  `(invocation_id)`. Nullable; legacy rows stay null. (Do **not** bundle #613 lineage; it is
  unapplied and larger.)
- `public.tool_lessons` — the **one** table for the whole lifecycle. A candidate, an active lesson
  and an expired one are rows of this table in different `status` values; there is no separate
  candidates table (revision 1 named two and defined one; this is the resolution). Columns:
  `id uuid pk default gen_random_uuid()`, `user_id uuid not null`, `tool_name text not null`,
  `template_key text not null`, `schema_version int not null default 1`, `version int not null default 1`,
  `supersedes_id uuid references tool_lessons(id)`, `window_start timestamptz not null`,
  `window_end timestamptz not null`, **`window_key date not null`** (the UTC calendar day of
  `window_end`, written by the aggregator as `(window_end at time zone 'UTC')::date`; an ordinary
  column so it can carry an ordinary `UNIQUE` constraint, because a `UNIQUE` table constraint cannot
  hold an expression and a bare `::date` cast of a `timestamptz` is timezone-dependent),
  `evidence_through timestamptz not null` (newest supporting observation; the freshness clock),
  `observations int not null`, `distinct_invocations int not null`, `distinct_threads int not null`,
  `outcome_counts jsonb not null` (ok / empty / skipped / failed_transport / failed_credential /
  failed_other / rate_limited), `lesson_text text not null` (template-rendered; immutable once the
  row leaves `candidate`), `lesson_sha256 text not null` (hex, 64 chars, over `lesson_text`),
  `status text not null check (status in ('candidate','withdrawn','approved','rejected','active','expired','revoked','superseded'))`,
  `activated_at`, `expires_at`, `reviewed_at`, `reviewed_by uuid`, `reconsider_after timestamptz`,
  `created_at`, `updated_at`.
  Constraints: `unique (user_id, tool_name, template_key, window_key)`; `check (window_end >
  window_start)`; `check (status <> 'active' or expires_at is not null)`; a partial unique index
  `(user_id, tool_name, template_key) where status in ('candidate','approved','active')` so at most
  one open recommendation exists per key at any time (this is what stops daily overlapping windows
  from piling up duplicates, §4.8).
  RLS copied from `memory_merge_candidates`: service-role writes; authenticated `SELECT` own rows;
  authenticated `UPDATE` own rows, with a `BEFORE UPDATE` trigger that permits only the reviewer
  transitions `candidate→approved`, `candidate→rejected`, `active→revoked`, sets `reviewed_at`/
  `reviewed_by`, and rejects any change to `lesson_text`, `lesson_sha256`, `version`, counts or
  windows from that role. The aggregator (service role) may change `status` only along
  `candidate→withdrawn`, `approved→active`, `active→expired`, `active→superseded`, and may update
  counts/windows/`lesson_text` only while `status = 'candidate'`.
- Why not `save_agent_memories`: it ratchets `confidence = GREATEST(old,new)` and bumps `hit_count`
  on every re-save, which Stage 4 forbids as effectiveness metrics; it also lacks version, expiry,
  status and provenance. `agent_memory` stays untouched.
- CI: `.github/ci/assert-tool-lessons.sql`, run as in §4.5's RLS assertion (`SET LOCAL ROLE`, role
  guards, rollback). It drives: two inserts with the same `(user, tool, template, window_key)` →
  the second fails; same key with a different `window_key` while an open row exists → the partial
  unique index refuses; as `authenticated`, `candidate→approved` succeeds, `candidate→active` is
  refused by the trigger, an `UPDATE` of `lesson_text` is refused, a cross-user `UPDATE` affects 0
  rows; as `service_role`, `approved→active` succeeds and `rejected→candidate` is refused.

### 4.7 PR-E5 — observation stamping (edge build 5)

Files: `cache.ts` (row writer ~:1077 adds `invocation_id` from ctx), `index.ts` (ctx carries the
hoisted invocation id), `health-handler.ts` (`checks.observation_identity`), tests
`supabase/tests/osint-agent/tool_usage_identity_test.ts`.
Deploy-ordering safety like the `outcome` column: if the insert fails on `invocation_id`, retry
without it. Kill switch `OBSERVATION_IDENTITY_DISABLED=true`. Acceptance: every new
`tool_usage_log` row carries the invocation id of the `streamText` call that dispatched it.

### 4.8 PR-S1b — aggregator function and schedule (schema, dry-run first)

`public.aggregate_tool_lessons(p_dry_run boolean default true)` in plpgsql, scheduled by
pg_cron (existing infra; the project's rule on scheduled cost is documented in the cache-sweep
migration) nightly; `pg_try_advisory_lock` for concurrency; stateless over a sliding 14-day window
so recovery is a re-run.

**Observation classification (from existing columns, no `input_json` read)**
| Source fact | Class | Counts toward lesson? |
|---|---|---|
| `cached = true` | cache replay | no (not an attempt) |
| `outcome = 'skipped'` | intentional skip / governance / dispatch refusal | no |
| `outcome = 'empty'` | valid empty = coverage | no; never "absence" or "failure" |
| `outcome = 'ok'` | success | yes (denominator) |
| `outcome = 'failed'` and (`status_code` in 408, 5xx or `error_msg ~* 'timeout|abort|ECONN'`) | transport failure | yes, as one observation |
| `outcome = 'failed'` and (`status_code` in 401, 402, 403, 429 or `error_msg ~* 'plan|quota|credit|balance'`) | credential/plan/rate limitation | yes, separately (a 403 is not a dead credential) |
| invocation `stop_reason in ('finalize_forced','budget_exhausted','length_limit')` | run outcome | not a tool fault; excluded from tool templates |

**Thresholds (initial, JD may tune)**: ≥ 5 real attempts, ≥ 3 distinct invocations, ≥ 2 distinct
threads, failure share ≥ 60 % within 14 days. One timeout is an observation, never a lesson.

**Templates (operational only; no selectors, PII, credentials, provider bodies or narrative)**:
`transport_unreliable`: "tool {name}: {f} of {n} real attempts in the last 14 days failed on
transport (timeouts/5xx). Try an alternative first; one fresh attempt is still fine."
`plan_limited`: "tool {name}: {f} of {n} attempts were refused by the provider's plan or
credential ({codes}). Do not retry within a run." `rate_limited`: analogous. Lesson text is
rendered server-side from counts only; a test asserts no email/phone/URL/selector pattern can appear.

**Lifecycle and idempotency (the state machine the aggregator obeys, per `(user_id, tool_name,
template_key)` on every run)**

```
                 stats ≥ threshold, no open row, not blocked      reviewer         aggregator (expires_at reached)
  (none) ───────────────────────────────────────────► candidate ───► approved ───► active ───► expired
                                                         │   ▲                        │
            stats < threshold on a later run             │   │ stats ≥ threshold      │ reviewer
          ┌──────────────────────────────────────────────┘   │ again after            ▼
          ▼                                                  │ reconsider_after     revoked
       withdrawn ────────────────────────────────────────────┘
                                                         reviewer
                                                 candidate ─────────► rejected  (reconsider_after = reviewed_at + 30 d)
                                                 active   ─────────► superseded (only when its successor is approved)
```

- **Reruns and changed counts.** While a row is `candidate`, the daily run updates its counts,
  windows, `evidence_through`, `window_key`, `lesson_text` and `lesson_sha256` in place: it is
  unreviewed, so refreshing it loses nothing. The partial unique index guarantees there is only one
  such row per key, so overlapping windows cannot create a second recommendation.
- **Reviewed rows are immutable.** Once `approved`, `active`, `rejected`, `revoked`, `expired` or
  `superseded`, the aggregator never updates counts or text on that row; the trigger enforces it.
- **Renewal.** For an `active` row within 7 days of `expires_at` whose key still meets the
  threshold on observations with `created_at > activated_at`, the aggregator inserts a new
  `candidate` with `version + 1` and `supersedes_id` = the active row. The partial unique index
  permits this because the new row's status is `candidate` and the old one is `active`; both are
  "open", so the index is defined over `status in ('candidate','approved','active')` **minus** this
  one case: the index predicate is `status in ('candidate','approved','active') and supersedes_id is
  null` for the first row and a second partial index `(supersedes_id) where status = 'candidate'`
  keeps renewals to one at a time. On approval of the renewal, the aggregator's activation step sets
  the predecessor `superseded` and the successor `active` in one statement. A renewal nobody reviews
  simply expires with its predecessor.
- **Rejection and revocation are sticky.** A `rejected` or `revoked` row sets `reconsider_after`
  (reviewed_at + 30 days; JD tunes). The aggregator creates a new `candidate` for that key only when
  `now() > reconsider_after` **and** the threshold is met using observations with `created_at >
  reviewed_at` alone. It never reactivates a rejected or revoked row and never edits it.
- **Expiry.** `active` rows with `expires_at < now()` become `expired` on the next run (also exposed
  by a view so the UI is correct between runs). Expired is terminal; a fresh `candidate` may follow
  under the normal rule.
- **Withdrawal.** A `candidate` whose key no longer meets the threshold becomes `withdrawn`
  (terminal, kept for audit), so the review queue does not show stale recommendations and nothing is
  deleted.
- **Idempotency.** The function is a pure function of (observations, existing rows, now). Running it
  twice in a day changes nothing the second time; running it after a crash resumes from the table.
  Nothing is delivered anywhere, so duplicate delivery does not arise; the table is the queue.
- **Concurrency.** `pg_try_advisory_lock(hashtext('aggregate_tool_lessons'))`; a second concurrent
  run exits without work.

### 4.9 PR-F2 — candidate review UI (frontend)

Files: new `src/pages/brain/LearningQueue.tsx` (or a sub-tab in `BrainGlobalPage.tsx`),
`src/lib/tool-lessons.ts` (status transition writer with the same shape as
`quarantine-release.ts`: a pure `transitionPatch()` returning exactly the allowed keys or `null`;
the database trigger in §4.6 is the enforcement, this is the convenience). Reads `tool_lessons`:
candidates with counts and window; Approve → `approved` (activation is the aggregator's step),
Reject → `rejected`, Revoke on `active`. Tests like `sources-tab-render.test.tsx`.

### 4.10 PR-E6 — M1 reads active lessons (edge build 6)

Files: `lib/memory-brief.ts` (second read from `tool_lessons where status='active' and
expires_at > now()`, merged with legacy rows under the same caps), `index.ts`, tests, probe
extension. Activation policy: `approved` → `active` happens in the aggregator (status + `expires_at
= now() + 30 days`), never automatically from `candidate`. Automatic activation is proposed **only**
for `plan_limited` with ≥ 10 attempts, 100 % refused, ≥ 3 threads, behind
`TOOL_LESSON_AUTO_ACTIVATE=false` default, and only with JD's explicit approval (§6 Q7).

### 4.11 PR-S2 / PR-E8 — attribution (schema, then edge build 7)

Audit-log change, so JD approval first (§6 Q8). Nothing in PR-E4 pre-empts it (§4.5 Observability).
Minimal durable attribution: a `memory_brief jsonb` column on `orchestrator_invocations` holding
`{"lessons":[{"id":"<uuid>","version":1,"sha256":"<64 hex>","source":"tool_lessons"|"agent_memory"}],
"brief_sha256":"<64 hex over the rendered block>","chars":1234,"built_ms":57,"attached":true}`.
Structured records, one object per lesson, never parallel arrays; the hash is the full SHA-256 of
`lesson_text` (equal to `tool_lessons.lesson_sha256`, so a later text change is detectable), and
legacy `agent_memory` rows carry a SHA-256 over `content` with `version: null`. Written in
`finish()` (today) and in the up-front insert once #903 PR B exists.
Request accepted/failed is already `finish_reason`/`error_message`/`stop_reason` on the same row.
Subsequent tool action and outcome = `tool_usage_log` rows with the same `invocation_id` (PR-E5).
A thread is not one run: everything keys on `invocation_id`, never `thread_id`.
No lesson bodies or selectors in telemetry: ids, versions and full SHA-256 digests only.

### 4.12 PR-F3 — learning-loop pane (frontend)

Reads only: observations collected (rows with `invocation_id`, 14-day window), candidates awaiting
review, active and expired lessons, exposure per lesson (count of invocations whose `memory_brief`
lists it), subsequent observed outcomes (for exposed invocations, that tool's outcome mix).
Labelled "observed outcomes after exposure", never "win rate" or "prevented". Baseline fixture: the
per-tool outcome mix for the 14 days before PR-E5 deploys, saved as `docs/metrics/tool-outcome-baseline-<date>.json`
by JD's read-only SQL; evaluation criterion stated in the pane: a difference is reported with both
denominators and no causal claim.

---

## 5. Verification matrices

### 5.1 Stage 1 (PR-F1) state matrix

| State | Setup in test | Expected header | Expected Overview |
|---|---|---|---|
| empty | 0 rows, count 0 | `0 memories (all stored)`, hits 0, confidence `—` | Memories 0 |
| under-cap | 12 rows, count 12 | `12 memories (all stored)` | Memories 12 |
| over-cap | 500 rows, count 1,672 | `500 most recent of 1,672` | Memories 1,672 |
| locally hidden | over-cap + 3 hidden | `… · 3 hidden locally`; stats over 497 | unchanged |
| count failure | count `error` | `500 shown · total unavailable`; no "all" | Memories tile shows `—` |
| loading | pending | `… of —` skeleton | skeleton |
| refresh | fire channel callback | sample and total both re-fetched in one loader | re-fetched |
| mobile 375 px | Playwright | caption text visible, chips scroll, no overflow | tiles 2-col |

Commands: `npm run typecheck && npm run lint && npx vitest run && npm run build`, then
`PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:e2e` (or the local Chromium),
and `npx vite --config vite.harness.config.ts` for screenshots at `/brain`.

### 5.2 Edge release proof, per build

| Build | Proof key | Switch | Rollback |
|---|---|---|---|
| #926 | moved build SHA (+ optional probe) | none of its own | redeploy previous marker |
| #925 | moved build SHA; `INPUT_COERCION_DISABLED` legacy | existing | secret flip |
| #868 | `checks.memory_input_normalization` probes + SHA | `MEMORY_INPUT_NORMALIZATION_DISABLED` | secret flip |
| PR-E4 | `checks.memory_brief` (new) | `MEMORY_BRIEF_DISABLED` | secret flip |
| PR-E5 | `checks.observation_identity` (new) | `OBSERVATION_IDENTITY_DISABLED` | secret flip |
| PR-E6 | `checks.memory_brief` probe extended | same | secret flip |
| PR-E8 | `checks.brief_attribution` (new) | `BRIEF_ATTRIBUTION_DISABLED` | secret flip |

Each follows the `edge-deploy` skill exactly: (1) merge the code PR; (2) run `npm run stamp:build`
and open the **stamp PR**, which must merge while `main` is the marker commit so that the stamp
commit's parent *is* the marker (`marker_offset_mismatch` before the deploy is expected); (3)
surgical mirror sync, never a blanket overwrite; (4) `npm run verify:deploy` must read
`mirror tree -> equal` **and** `mirror pushed`; (5) explicit Lovable deploy message to project
`4ce11bc3-…`; (6) `/health` `build` moved to the new marker (which is the stamp commit's *parent*,
never the `main` tip); (7) `npm run record:deploy -- --previous <prev> --mirror <path>` and the
**ledger PR**, which has no marker-parent requirement of its own; its only gate is that
`verifyLedgerConsistency` reports no `ledger_ref_divergence` (an unmerged earlier ledger PR must
merge first), then `git push origin HEAD deploy/live`. Revision 1 wrongly attached the
marker-parent rule to the ledger PR; it belongs to the stamp PR.
Baselines to re-measure before blaming a diff: edge 2821/0/6, frontend 2965/1/247, e2e 95/13 (all
on `main` `6596812` as of 2026-10-30; `main` has moved since).

### 5.3 Schema verification

After JD applies PR-S1: `select column_name from information_schema.columns where table_name='tool_usage_log' and column_name='invocation_id'`;
`\d public.tool_lessons` (constraints, both partial unique indexes, the transition trigger); CI
`Migrations (psql validation)` green with the new assertion.

---

## 6. Decisions requiring JD's approval

1. **Q1 Stage 1 relabel of the Overview tile** from `Avg confidence` to `Artifact confidence`
   (D1). Recommended yes; it is a label on a display-only aggregate.
2. **Q2 Edge order**: #926 → #925 → #868 (recommended, by severity) or #868 first (already ready).
3. **Q3** Whether an all-stored *memory* confidence belongs on Overview (needs a
   `get_insights_summary` change, schema channel) or is dropped. Recommended: drop for Stage 1.
4. **Q4** Accept "moved build SHA" as the proof for #926/#925, or require a probe line each.
5. **Q5 — resolved by measurement (U1): there are no legacy `tool:*` rows today.** Keep the
   default "include eligible rows" and the `MEMORY_BRIEF_LEGACY_ROWS` switch, because a model-written
   `tool:` row can appear before PR-E6 and the eligibility rules in §4.5 are what make that safe.
   Re-run the U1 counts immediately before PR-E4 deploys; if the count is still 0, M1's first
   production effect is nil by construction and `checks.memory_brief` plus the count-only event are
   the only observable change.
6. **Q6** PR-S1 shape: `invocation_id` on `tool_usage_log` + the new `tool_lessons` table
   (recommended) versus writing lessons into `agent_memory` (rejected here: ratchet, no lifecycle).
7. **Q7** Automatic activation: none (recommended initially) or the narrow `plan_limited` rule
   behind a default-off switch.
8. **Q8** Attribution column `memory_brief jsonb` on `orchestrator_invocations` (audit-log change).
9. **Q9** Thresholds for candidates (5 attempts / 3 invocations / 2 threads / 60 % / 14 days).
10. **Q10** Sequencing against #903 PR B (durable telemetry): Stage 5 exposure is lost for runs
    that die before `finish()` until B lands; accept initially, or land B first.
11. **Q11 — APPROVED by JD, 2026-10-31 02:25 PDT.** Single-table model `tool_lessons` with
    status-based lifecycle (§4.6/§4.8); revision 1's two-table wording is retired.
12. **Q12 — APPROVED by JD, 2026-10-31 02:25 PDT.** Lifecycle constants: `reconsider_after` = 30
    days after rejection/revocation; renewal window = 7 days before `expires_at`; active lifetime =
    30 days.
13. **Q13 — APPROVED by JD, 2026-10-31 02:25 PDT.** M1 hardening (PR-E4) ships with count-only
    telemetry; every lesson id / hash / invocation id waits for PR-E8 under Q8.

Approval of Q11–Q13 settles the design shape only. It is not a go for any backend, schema or
telemetry implementation: Stages 3–5 remain held until Q1–Q10 are answered and U1 is read.

Open after this revision (not decisions, measurements): U1 was read on 2026-10-31 (0 rows) and must
be re-read right before PR-E4 deploys; U3 (brief latency) is read after PR-E4 deploys and before
PR-E6.

No merge, deploy, secret change, PR status change or production write happens on any of these
without JD's named go.

---

## 7. The single next action

**Rework #927 on its existing branch into PR-F1 (§4.1).** It is frontend-only, CI is green on that
branch, it needs no deploy ceremony and no JD gate other than review, and the current #927 would
ship two wrong statements (the RECALLS tooltip, D11; the AVG CONFIDENCE relationship, D1) and a
completeness claim on count failure (D10). Everything in Stages 2–5 is blocked on a JD decision or a
schema application; this is not.

---

## Appendix A — requirement coverage map

| Audit requirement | Heading |
|---|---|
| Recheck baseline | §1.1 |
| Stage 1 points 1–9 | §4.1 Behaviour 1–9; D1, D9–D14, D17 |
| Stage 1 verification states + repo checks + e2e | §5.1, §4.1 Tests |
| Stage 2: #868 not a prerequisite; #925/#926 independent; correct #925 body; per-PR cycles; order | §1.2 items 10–11, §3, §4.2–4.4, Appendix B, §5.2 |
| Stage 3 files inspected | §1.2 items 13–17, §2 D4–D8 |
| Stage 3 plan items 1–8 | §4.5 (eligibility, selection, deadline, isolation tests, legacy rows, inventory, latency, preservation) |
| Stage 4 identity, timestamps, classes, minimums, idempotency, concurrency/expiry/revocation/supersession, templates, non-blocking, durable processing, storage inspection, schema separation | §4.6–4.10 |
| Stage 5 attribution, UI, no causal "win rate", baseline fixtures | §4.11–4.12 |
| Output 1 facts/corrections/assumptions/unknowns | §1 |
| Output 2 ranked defects with source links | §2 |
| Output 3 dependency graph and order | §3 |
| Output 4 files per PR | §4 each "Affected files" |
| Output 5 acceptance, tests, rollback, proof | §4 each; §5 |
| Output 6 JD decisions | §6 |
| Output 7 single next action | §7 |

## Appendix B — corrected PR body text (for JD to paste; not edited here)

Replace the last test-plan line of **#925** with:

> - [ ] Deploy via `edge-deploy` skill as its own build (stamp → surgical sync → `verify:deploy`
>   → Lovable → `/health` → ledger). Independent of #926; rebase onto `main` after #926 merges
>   because both edit `tool-registry.ts`. Proof of deploy: moved build SHA (no new `/health` key);
>   `INPUT_COERCION_DISABLED=true` restores the old rejection.

Replace the last test-plan line of **#926** with:

> - [ ] Deploy via `edge-deploy` skill as its own build. Independent of #925. Proof of deploy:
>   moved build SHA (no new `/health` key; the behaviour is pinned by
>   `markdown_extract_url_refine_test.ts`). Rollback: redeploy the previous marker.

Also delete from #925's summary the sentence "`markdown_extract` has the same `.refine()` gap";
#926's body shows it is a different defect (an uncaught `TypeError` out of `safeParse`).
