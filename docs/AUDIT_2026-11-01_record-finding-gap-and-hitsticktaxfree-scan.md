# Audit — 2026-11-01: the `record_finding` gap, and why the `@hitsticktaxfree` scan does not correlate

Read-only session. No code changed, no tests run (nothing to test), no deploy, no secret touched.
Every number below was measured this session against production; re-measure before trusting it.

State at audit: `main` `13fa3f8e`, live `osint-agent` build `979f199`, orchestrator `glm-5.3-flash`
on `api.z.ai`, `/health` 62 checks / 0 not ok. The 11-01 deploy (#938/#939/#940) was not redone.
Audited thread: `4c2df3b6-5558-43f1-ae04-ffcc88e0cd39` (seed `@hitsticktaxfree`, username).

---

## 1. The headline correction: `{{FINDINGS_TABLE}}` is already shipped — the gap is rows, not rendering

The handoff (and CLAUDE.md's "report layer bypasses the integrity engine" section, written 2026-08-11)
prescribe expanding a `{{FINDINGS_TABLE}}` marker server-side from persisted rows before the message is
stored. **That mechanism exists and is live**, under a different name:

| Layer | Module | PR | What it does |
|---|---|---|---|
| Stored message | `supabase/functions/osint-agent/lib/evidence-record.ts` + `lib/evidence-record-persist.ts` | #479 | Renders every `kind='finding'` row (confidence = `min(confidence, metadata.confidence_cap_applied)`, 90/75/55/35 ladder) into an "Evidence Record — authoritative" block, composed into the stored assistant message with reserved byte budget so a long narrative cannot truncate it. Pure, total, zero imports, inside the finalize window by construction cannot throw. |
| Report tab | `src/lib/authoritative-findings.ts` → `intel.ts:buildReportMarkdown` and `CaseReport.tsx` | #499 | "Engine-adjudicated findings" section rendered from the same rows; "Key Findings — leads (not engine-adjudicated)" labelled honestly. |
| Chat | `ChatWindow.tsx:1313/1335` | — | "Model-adjudicated findings this run: 0 — the model did not call record_finding…" banner. |

Every report in the audited thread already carries that block, and it reads *"No authoritative
finding rows were recorded for this run"* on all nine runs. **Building a `{{FINDINGS_TABLE}}` marker
would print the same sentence on ~98% of runs.** It is not the fix. Do not build it.

## 2. Re-measured: `record_finding` call rate

Source: `orchestrator_invocations` joined to `tool_usage_log` on `thread_id` within each run's
`started_at..finished_at` window, last 14 days.

| Model | Runs | Runs with ≥1 `record_finding` | Rate |
|---|---|---|---|
| `glm-5.2 (api.z.ai)` | 158 | 3 | 1.9 % |
| `glm-5.3-flash (api.z.ai)` | 10 | 0 | 0 % |
| **Combined** | **168** | **3** | **1.8 %** |

Lifetime: 29 `kind='finding'` rows across 19 threads; 30 `record_finding` log rows; **0 rows of
synthesis origin** (`metadata.synthesis_cluster_id` never set). The handoff's "2 of 60 (3%)" is
confirmed in direction and refined: on a longer window it is lower.

The 4 finding rows written in the last 14 days (all glm-5.2, all from the REPORT stage):

| Model label | Engine status | Engine confidence | Cap |
|---|---|---|---|
| confirmed | contradicted | 34 | 80 |
| corroborated | contradicted | 47 | 60 |
| corroborated | contradicted | 37 | 80 |
| confirmed | needs_corroboration | 22 | 80 |

When the engine is called it is honest and strict. The defect is purely that it is not called.

## 3. Why the model skips the call — three structural causes, no prompt wording will fix the first

1. **`record_finding` is unreachable in the finalize state machine.**
   `orchestrator-finalize.ts:54-57`: `FINALIZE_PERSIST_ACTIVE_TOOLS = ["record_artifacts", "finalize_no_findings"]`,
   `FINALIZE_MEMORY_ACTIVE_TOOLS = ["memory_save", "finalize_skip_memory"]`, `FINALIZE_REPORT_ACTIVE_TOOLS = []`.
   The only phase that *forces* a persistence decision (`toolChoice: "required"`) cannot select it,
   and `countFinalizeProgress` (`:237-263`) does not count it. The report directive then says
   "Do not call record_artifacts, memory_save, or any other tool".
2. **The system prompt conflates artifact and finding.** `system-prompt.ts:143,166`: *"a finding
   only exists once it is in `record_artifacts`"*, *"the closing table just renders what is already
   persisted"* (via `record_artifacts`). `workflow_prompt.ts:34` mentions `record_finding` once, as
   advisory ("may run"). The Recording section names `record_artifacts` ~10 times and `record_finding`
   never. The model does exactly what it is told: it records artifacts and writes the table itself.
3. **`finalize_no_findings` means "no more artifacts", but reads as "no findings".** The audited
   thread called it with reason `all_supported_findings_already_persisted` — the model believed
   `record_artifacts` had already done the finding writer's job.
4. On this thread, 6 of 9 runs ended `natural_stop` with `finalize_started=false`: the model wrote the
   closing report on an ordinary intermediate step (`toolChoice: "auto"`) where the per-cycle directive
   says "compact only, pivot". There is no step at which anything asks for a finding decision.

## 4. The enforcement path that already exists, and is dark

`finding-synthesis.ts` + `finding-synthesis-sweep.ts` derive `kind='finding'` rows deterministically from
persisted artifacts (≥2 independent source classes per cluster), scored by **the same**
`lib/finding-row.ts` chain `record_finding` uses (`finding_row_equivalence_test.ts` pins it). It runs in
the health **maintenance** sweep — a separate request from any run, structurally unable to fail finalize.

Measured this session:

- `/health?maintenance=1` → `checks.synthesis = {ok:true, detail:"disabled"}` on build `979f199`.
  (A plain `?health=1` skips the maintenance block entirely; `checks.synthesis` is absent there.)
- `FINDING_SYNTHESIS_ENABLED`, `FINDING_SYNTHESIS_BACKFILL_ENABLED`, `FINDING_SYNTHESIS_DRY_RUN` all unset.
- **Precondition NOT met:** `pg_indexes` has no `artifacts_synthesis_cluster_uniq`. Migration
  `supabase/migrations/20260907000000_synthesis_finding_cluster_unique.sql` is in the repo and
  **not applied in production**. Migrations never travel the mirror. Without it, two overlapping
  60-second sweeps can double-write one cluster's finding (the sweep's level-2 read-then-write race).

On the audited thread, by the ≥2-independent-class rule read off the stored `source_category` values,
one cluster should clear the bar: the main handle cluster (`clus_a393bfe7`) carries `independent_public`
+ `breach`; every name row is a one-class singleton. That is a prediction from the class list, not a
run — dry-run is the instrument. One finding, scored honestly, would be the correct output for this evidence.

## 5. The scan audit — why "nothing connects"

JD's read: *not correlating, not matching findings, no agentic connections, quarantine bug*. Each is a
real, named defect. None is the model being lazy; each is a place where linkage exists only in prose
and the engines read only structured fields.

### 5.1 Linkage is recorded as prose; the clusterer reads keys the model is never told about
`lib/cluster.ts:strongTokens` unions on `email:`, `phone:`, `handle:`, `domain:`, `acct:` tokens and on
metadata keys `associated_handle`, `seed_association`, `instagram`, `handle`, `github`. Names are
excluded by design (same-name collision). So the only way a `name` row joins the handle cluster is a
structured key asserting the handle.

The row that proves name↔handle — `Victor Tabarez`, source `socialfetch_web_read (myspace.com/hitsticktaxfree)`,
conf 70, note *"page title + og:title 'Victor Tabarez (hitsticktaxfree) on Myspace'"* — carries the handle
only in `source` and `metadata.note`. Neither is read. **`associated_handle` / `seed_association` appear
nowhere in the edge function outside `lib/cluster.ts`** — not in any prompt, tool description, catalog
entry, playbook or planner guidance (grepped the whole `supabase/functions/osint-agent` tree, tests
excluded). The model has no documented way to
assert the link it found, so it writes it in English and the engine files the name as a singleton.

Consequences visible in the DB for this thread:
- `Victor Tabarez` persisted twice (export, socialfetch) as **two different singleton clusters**
  (`clus_104caefe`, `clus_19e28e6a`) — same value, no shared strong token.
- Spotify artist URL persisted twice as two singleton clusters (`clus_104caef9`, `clus_104caefa`).
- `Sacramento, CA` persisted three times with three prose values ("(city-level)", "— location claim
  for Hitsticktaxfree", "95832") → three clusters; the report prints C003/C004/C005 "unattributed
  cluster (CA)" for one city.
- The Opsis Linktree registration (*hard platform linkage email↔handle*) persisted as `kind: other`,
  linkage in the value string.
- `hitsticktaxfree@gmail.com` breach exposure persisted **8 times** (rapidapi ×2, breach_check ×2, serus,
  oathnet ×2, opsis/XposedOrNot) for the same two upstream leaks — 8 "needs verification" rows for 1 effective source,
  which is most of the "39 need verification" figure and drags report readiness to 50%.

### 5.2 Two clusterers, two answers; the analyst reads the frontend one
Backend `applyClusteringToThread` (end of run) left `Victor Gavia` a singleton (`clus_19e28e6d`).
Frontend `intel.ts:buildIdentityClusters` merged it into C002 via `SHARED_INFRASTRUCTURE: parent:hitsticktaxfree@gmail.com`
(the model set `metadata.parent` on the Gavia row but not on the Tabarez row) and then **named the
subject's cluster "Victor Gavia"** — the breach-row name — while the Sheet header says the subject is
"Victor Tabarez · Analyst-confirmed". Same case, two subject names, one screen.

### 5.3 "1 established connection · 62 unlinked candidates" — a URL-shaped profile row contributes no selector to the entity graph
`src/lib/entity-graph.ts:137-167 selectorsFor`: a `handle:` selector is emitted only when `kind` is
`username` / `handle` / `social`, or when `metadata.handle` is set. A `social_profile` or `music_profile`
row whose value is `https://www.instagram.com/hitsticktaxfree/` yields **no selector at all** — the handle
is never extracted from the URL. (The backend clusterer does extract URL path segments, under
`urlHandleTokensEnabled`; the frontend graph does not.) A row with no selector gets no `identity`
edge and falls through to the "seed-discovery fallback" (`:417-428`, *"Discovered while investigating
…"*), which `realEdgeCount` excludes. That is the 62. The one "established connection" is the
`social_footprint` row, which the analyst was shown as the link.

So on a handle-seeded case the panel can never show the handle-sharing profiles as connected, however
many there are. This is a concrete frontend defect with a concrete fix (derive `handle:` from a profile
URL's path, or from `metadata.handle`, in `selectorsFor`), not settled design — the panel's own copy
("Clustering groups candidates by shared signal") describes a signal the graph is not reading.

### 5.4 The quarantine "bug": every name pivot from a non-person seed is quarantined forever
`index.ts:481`: `subjectSeedName` is the seed's normalized name **only when the seed kind is `person`**;
otherwise `""`. `auto-persist-findings.ts:654 seedLinksQueriedName("", "victor tabarez")` fails closed.
So on a username/email/phone seed, **no name-only query can ever keep subject authority**, even after
the analyst marks the name row Verified and even when the pivot was launched as "Target: Victor
Tabarez, Type: name" from the Workbench. `seedValueRaw` (`index.ts:466`) is the **first user message
of the thread** (`@hitsticktaxfree`), never the current pivot message, so neither the analyst verdict on
the name artifact nor the pivot target feeds `subjectSeedName`. The 5 "Needs your call" rows
(`69.6.157.102`, the OathNet name-search summaries, the Tabarez breach-corpus row) are all this.

Settled-design check: CLAUDE.md's write-boundary (#433) says gate on **durable linkage, never name
equality**. An analyst's `confirmed` verdict on the name row, or an active `linkage_confirmed` release,
*is* durable linkage; the seed text is just the narrowest possible proxy for it. This is a gap in the
predicate's inputs, not in its rule. **Not changed here** — integrity-critical, needs JD's sign-off.

### 5.5 Smaller defects on the same thread
- Negative lookups (Wayback 0 captures, Indicia no record) recorded as `weak_lead` at confidence 60,
  labelled FAILED, then analyst-rejected. `lib/negative-lookup.ts` exists for this; the model does not use it.
- `excluded_collision` used for engine notes ("minimax_correlate: all artifacts share exact handle…",
  "unrun corroboration pivot…" with `source: runtime`). Kind misuse inflates the Collision section.
- The surname conflict (Tabarez vs Gavia) was recorded as a `weak_lead` with `source: analysis` — model
  prose — instead of through `detect_contradictions` / `record_finding`, so the engine never scored it.
- Run 2 (11:50Z): `exa_search` and `indicia_person` refused at 102 s with "finalize window open" on a
  139 s run; the engine's own "unrun corroboration pivot" row is that refusal. Expected under
  `FINALIZE_RESERVE_MS = 90_000`; noted because the next run spent its budget redoing it.
- 3 of 9 runs on this thread went to salvage (27.9 s / 37.4 s / 27.7 s). The handoff's "no salvage on
  5.3-flash" was n=1 and does not hold.
- `indicia_web_dbs` schema gap from the handoff (`snusbaseType is required`) did not appear on this
  thread; still untracked.

## 6. What to do, in order — and what not to do

1. **Apply migration `20260907000000_synthesis_finding_cluster_unique.sql` in production** (schema
   first, verified by `pg_indexes`, *then* anything that depends on it). JD's named go.
2. **Enable synthesis dark-measured**: set `FINDING_SYNTHESIS_ENABLED=true` and
   `FINDING_SYNTHESIS_DRY_RUN=true`, read `checks.synthesis` on a `?maintenance=1` probe for a day
   (proposed count and 0/1/2+ distribution), then drop dry-run on JD's go. Zero code, two new secrets.
   Backfill (`FINDING_SYNTHESIS_BACKFILL_ENABLED`) stays off — it writes into closed cases.
3. **Edge PR (one behaviour, kill switch, new `/health` key): fix the artifact/finding conflation in the
   prompt** — Recording section names `record_finding` as the finding writer, the closing-table rule
   points at finding rows, `finalize_no_findings` renamed or re-described as "no further *artifacts*".
   Label it honestly: this may raise the call rate; it is not enforcement. CLAUDE.md: a prompt rule is
   not enforcement.
4. **Edge PR: document the structured linkage keys to the model** — `record_artifacts` description and
   the Recording section name `metadata.associated_handle` / `parent` as the way to assert
   "this row belongs to handle X / was found under selector Y". Closes §5.1 without touching the
   clusterer. Behavioural, measurable on the next handle-seeded case (singleton count).
5. **Design decision for JD (integrity-critical, not a drive-by):** should `subjectSeedName` admit an
   analyst-confirmed `name` artifact (or an active `linkage_confirmed` release) as durable linkage for
   the name-only quarantine gate? §5.4.
6. **Frontend PR (can ride with 7, frontend-only):** `entity-graph.ts:selectorsFor` derives a `handle:`
   selector from a profile URL's path segment (same whitelist discipline as the backend clusterer's
   `foldWords`), so handle-sharing profile rows become `identity` edges instead of "discovered while
   investigating" (§5.3). Measurable: `realEdgeCount` on this thread goes from 1 to the profile count.
7. **Frontend:** one subject name per case — cluster headline must not out-vote the
   analyst-confirmed subject (§5.2).

**Do not:** build `{{FINDINGS_TABLE}}`; add `record_finding` to any finalize phase (work inside the
finalize window owns this project's worst incidents); change `confidence.ts`, `record_finding`,
`lib/finding-row.ts`, or the clusterer's name exclusion; widen quarantine as a drive-by.

## 6a. Actions taken after JD's go ("Migration + dry-run", 2026-11-01 ~12:55Z)

- **Applied** `20260907000000_synthesis_finding_cluster_unique.sql` in production via the Lovable
  `query_database` tool (`create unique index if not exists …`). Pre-checks: 0 synthesis-origin
  finding rows, 0 duplicate `(thread_id, synthesis_cluster_id)` groups, so the index was built over an
  empty set and could reject nothing. Verified after: `pg_indexes` lists
  `artifacts_synthesis_cluster_uniq`, `pg_index.indisvalid = true`, definition byte-identical to the
  migration. **No `supabase/migrations` bookkeeping table was touched** — this project applies
  migrations by hand (none travel the mirror); record it in the next handoff.
- **Found while doing it: `pg_cron` is not installed in this project** (`cron.job` does not exist,
  `pg_extension` has neither `pg_cron` nor `pg_net`). The sweep's module comment ("pg_cron fires the
  health probe every 60 seconds") and the migration's rationale are wrong about the host. The only
  callers of the maintenance block are the frontend sweep (`ChatWindow.tsx:2799`,
  `?health=1&maintenance=1`, on thread open and every 30 s while a run is loading, plus trailing sweeps)
  and anyone curling `?maintenance=1`. So the dry-run distribution accrues only while an analyst has a
  recently-active case open, or on demand. A forward-window thread (finished < 24 h ago) with no open
  tab is swept only if some other tab's sweep picks it up (limit 5 per probe). This is also why the
  index's race (two overlapping 60 s probes) is rarer than the comment claims — and still possible,
  since two open tabs sweep independently.
- **Secrets set** (JD's go: "Use Lovable agent", ~13:00Z): `FINDING_SYNTHESIS_ENABLED=true` and
  `FINDING_SYNTHESIS_DRY_RUN=true`, created new via the Lovable agent's secrets tool (0.3 credits).
  The agent reported neither existed before, no files edited, no deploy, and
  `FINDING_SYNTHESIS_BACKFILL_ENABLED` still unset. Independently checked: the mirror's newest commit
  is still `efb2eea4` (the #938/#939 sync) — the agent wrote nothing to the repo.
- **First dry-run reading**, one `?maintenance=1` probe immediately after, no redeploy needed
  (flags are read at call time; build still `979f199`):

      forward: DRY RUN — nothing written; 4 proposed over 5 thread(s) (0:1 1:4 2+:0)

  Four of the five most-recently-finished threads clear the ≥2-independent-class bar for exactly one
  cluster each; one clears it for none; none for two. **Instrument limit:** the sweep reads at most 5
  threads per probe from the 24-hour forward window, and in dry-run nothing is written, so every
  probe re-reads the same 5 until newer threads finish. This number is the recent tail, not a
  distribution over the corpus. Backfill stays off.
  The five threads it scanned (replicating the sweep's selection in SQL: `status='finished'`,
  `updated_at` in the last 24 h, no model-origin finding, newest first): the audited
  `@hitsticktaxfree` thread (username, 66 artifacts, 19 backend clusters), then a person seed (18
  artifacts), a url seed (32), a phone seed (161) and an email seed (26). The dry run does not say
  which of the five proposed nothing.

## 7. Limitations
- Call-rate join is by time window on `thread_id`; `tool_usage_log` has no `invocation_id`. Two
  overlapping runs on one thread could mis-attribute a call. 14-day window, not lifetime.
- `checks.synthesis` was read on one maintenance probe; the flag state is as of 2026-11-01 ~12:35Z.
- I did not read the Myspace export or any raw tool output; the scan audit is from `artifacts`,
  `tool_usage_log`, `orchestrator_invocations` and the pasted reports only.
- No tests run: no code changed. Baselines in CLAUDE.md (`main` `6596812`) are stale by six merges;
  re-measure before any PR.
