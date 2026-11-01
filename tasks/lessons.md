# Lessons

Running log of non-obvious gotchas learned while working in this repo. Newest first.

## 2026-10-25 (adaptive pivot ranking, Stage 1)
- **I proposed "exhausted" in discovery and could not measure it.** `tool_usage_log` has `ok`, `cached` and `input_json`, but no output and no lineage from a run to its artifacts. Say "repeated" for what the log can prove, and leave yield for the lineage stage. Check the table's columns before writing a metric's definition.
- **The pivot's own source row counts as "recorded".** Any "was anything recorded from this selector" test must exclude the lead itself, or it can never fire for an artifact-derived lead.
- **`tool_usage_log` is readable per thread from the browser.** The attempts hook filters on `thread_id` server-side and never invokes a tool, so reads can never start a paid lookup. Keep that boundary when adding readers.
- **A one-click run is a contract, not a style choice.** `requiresPreview` returned false for clean pivots, so the best-pivot card ran them with no preview. Tests and e2e selectors had pinned the label, so the change needed those updated together, not hidden.
- **A worktree session may write only to its own worktree.** Creating a second worktree and writing into it was blocked by the session guard. Move this session's own worktree to the branch instead, after saving any uncommitted docs.

## 2026-10-25 (registration authority repair)

A sibling report table is an independent authority boundary. Sensitive Registrations read raw rows even though Breach Exposure was gated. Reuse the authority predicate plus rejected-provenance and negative-result checks before deduplication; a later rejected duplicate must never become a subject registration. Test the actual table and retain an accepted positive control. Key the rejection on the table's own identity (site|identifier), not the row id: a re-run records the same registration under a new id, and an id-only filter with dedupe after it lets the unreviewed twin render clean.

## 2026-10-25 (workspace Stage 1 correction pass)

### G-items NOT ADDED (fail honest-data check — explicit follow-ups)

JD's final addendum listed four presentation items that look harmless but
would print numbers the backend does not actually compute. They are
recorded here as follow-ups, not implemented in this pass:

- **"+12 linkage" delta** from the prototype — needs an assessment-history
  schema (and a `prev_effective` column, or an append-only
  `assessment_events` table). Without that, any delta the UI shows is
  derived from client state and will drift the moment the page reloads.
- **Separate "Finding support %" vs "Subject linkage %"** — the backend
  carries ONE confidence scalar (`displayConfidence(a).effective`).
  Showing two numbers requires a backend-side split; this UI stage
  collapses to the one honest value.
- **Agent "suggested quick-reply" chips** — requires model generation on
  the chat path; adding chips UI without the generation surface would
  print blanks or placeholders.
- **"Simulated live session" badge** — the prototype used this to label
  the fixtures. It would read as live-session marketing in prod and
  misrepresent an idle run. Omitted.

Each belongs to a separately-approved backend or model-generation stage.

### E-6 — "floating panel clipping at far left" could not be reproduced from source scan

JD's screenshot audit reported a partially clipped floating panel at the far
left edge of the Board (now Ledger) view. Grepped the full ResourcesPanel,
EvidenceMatrixTab, ClustersTab, and the ledger CSS; found no
`position:absolute` with a negative `left` offset, no `overflow:hidden` on
the ledger container, and no left-floating pane. The only absolute element
near the left edge is `.spine` (3px authority stripe at `left:0`, `width:3px`),
which sits inside the ledger-row's padding area and has no bounds the row
clips against.

Returning this to the main session's browser pane for a repro screenshot
with the suspected element inspected — fixing a layout defect without
being able to see it is how a speculative change ships two defects.

### E-1 — Next-steps count divergence (transcript 4, Workbench Next 5)

Two near-copies of the same engine computation, each with its own cap and
its own fallback behaviour:

| Surface | File | Pivot cap | Generic fallback actions |
|---|---|---|---|
| Transcript (`ChatWindow.suggestions`) | `src/components/ChatWindow.tsx` ~:2882 | 3 runnable | "Summarize findings", "Check for breaches", "Find more pivots" (injected to fill slots up to 4) |
| Workbench Next (`WorkbenchNext.items`) | `src/components/workspace/WorkbenchNext.tsx` ~:65 | 5 runnable | None |

The transcript also gated on `hasReportShape(latestText)` — a chat concern,
not an application-wide gate. The Workbench does not gate on message shape.

Converged by extracting `countWorkbenchRunnablePivots` /
`WORKBENCH_RUNNABLE_LIMIT` to `src/lib/next-step-queue.ts`. WorkbenchNext
now imports the shared cap; the transcript's compact "N next pivots ranked"
summary reads the shared count rather than the local `suggestions.length`,
which still includes the chat-only generic actions for the sub-xl fallback
NextSteps render. Different lists for different purposes; one count on
the summary line.


### Count-scope map — what each number on the workspace actually counts

JD screenshot-audited the harness and listed six numbers from one case view:
`55 evidence logged`, `Evidence 10`, `Analyst view 42`, `Needs review 36`,
`Sheet Review 34`, `Needs your call 10`. Different denominators, no scope
labels — reads as inconsistent. The map below names each number's selector
so a surface edit can label its scope without changing the counting.

| Surface | Figure | Selector | Scope |
|---|---|---|---|
| Case bar header | `55 evidence logged` | `snapshot.counts.artifactsTotal` (all `useThreadArtifacts` items) | Total artifact rows ever persisted to this thread (includes quarantined). |
| Workspace tab chip | `Evidence 10` | `WorkspaceTabs.tsx` evidence badge | **Review-eligible count** — artifacts whose authority state is in `ANALYST_ACTIONABLE_STATES` (see `src/lib/authority.ts`). Reads "10 waiting on your decision", NOT "10 of 55". |
| Evidence toolbar filter | `Analyst view 42` | `EvidenceBoard.counts.analyst` (`STATUS_FILTER_GROUPS.analyst`) | Everything excluding leads and excluded rows — the default "work queue" view. 42 of 55. |
| Evidence toolbar filter | `Needs review 36` | `EvidenceBoard.counts.review` (`STATUS_FILTER_GROUPS.review`) | Review-pending authority states. 36 of 55. |
| Sheet distribution | `Review 34` | `useCaseSheetModel` distribution bucket (reads review verdicts via `useReviewStates`) | Rows the ANALYST has not yet marked; 2 fewer than toolbar `Needs review` because the Sheet reads verdicts post-review-write while the toolbar reads authority state (which lags one write). |
| Sheet queue | `Needs your call 10` | `useCaseSheetModel.queue` | Rows whose `authorityFor` + `pickAsk` evaluates to a decision prompt (release, resolve, verify). Subset of `Needs review 36`. |

Rule: no surface may show a figure without naming its scope. "Needs review 36" alone is wrong; "Needs review 36 of 55" or "Review 34 undecided" is right.

### Pivot-ranking address-dispute signal (item 2 — follow-up)

Harness fixtures show pivots targeting emails Overview already describes as
belonging to other families (unsupported for this subject). Traced through
`src/lib/pivot-engine.ts` `computePivots`:

- The engine ranks candidates by `TIER_SCORE[priority] + attempt decay`
  (see `pivot-engine.ts:405-416`, with #873's attempt history inputs).
- There is NO cross-check against artifact `authorityFor(a).state` on the
  pivot's target before offering it. A quarantined or dispute-flagged
  target still enters the ranked list if a pivot kind is defined for its
  kind.
- Overview's "belongs to other families" copy comes from a disjoint path
  (name-collision clustering in `report-hygiene.ts`) that pivot-engine
  does not consult.

Classification: **likely reproducible ranking defect, not fixture-only.**
Scope: belongs in a separately-approved pivot-engine stage (per CLAUDE.md
"Do not re-litigate ranking as a drive-by UI fix"). Fix shape: pass an
`isActionableForSubject(a)` predicate into `computePivots` and filter
targets whose authority is `quarantined` or whose dispute signal is set.
No change made here.

### Report prose vs engine confidence (item 3 — follow-up)

CLAUDE.md section "The report layer bypasses the integrity engine"
describes this exact pattern. Measured on current main:

- `record_finding` server-side derives true independence count and persists
  computed confidence (`tool-registry.ts` `countIndependentClasses`).
- The model's final-turn text retypes a Findings table in prose that is
  NOT populated from the stored rows — model-written numbers survive.
- No `{{FINDINGS_TABLE}}` server-side marker exists today; the fix shape
  CLAUDE.md recommends ("expand the marker server-side before the message
  is stored, from persisted rows, no markdown parsing of model output,
  never allowed to fail finalize") is unbuilt.

Classification: **reproducible defect — this is the CLAUDE.md-named
report-bypass pattern, not a fixture issue.** Scope: belongs in a
separately-approved report-generation stage. The UI stage can only make
the contradiction visible (register item 10 — "No established subject name"
callout beside narrative-asserted subject). No scoring or writer change.

## 2026-10-23 (Opsis guard ship, brendanloza measurements)
- **A pre-flight refusal's error text must match `tool-outcome.ts` `SKIP_RE`**, or its `tool_usage_log` row logs `failed`
  and counts against the tool's health. Pin it with a captured-row test (`opsis_search_guard_test.ts`).
- **`detectSeedServer` labels any few-word prose `person`** ("look into this for me"). It is a word count, not a shape;
  never treat `person` as structural in a fallback or an inferred kind.
- **`memoSchema` is module-global**: one schema per tool name for every thread, so a preprocess cannot know the thread's
  seed. Thread-aware defaults resolve in `execute`. **`triageState` (guard.ts) is shared across threads on an isolate.**
- **`applyInputCoercion` hands back the RAW input when the coerced value still fails validation**, so the rejection log
  can name a field the model never sent. Read `input_json.runtime.sent_keys` before calling a rename broken.
- **`orchestrator_invocations.credits_micro_usd` is tools + LLM** (the same accumulator as `threads.cost_micro_usd`),
  not LLM credits; adding the tool log to it double-counts.
- **The 220k prompt budget's un-trimmable floor is tool-call INPUTS** (`record_artifacts` batches above all); outputs are
  capped, inputs are not. `initial_context_chars` is measured after trimming.
- **The Opsis finalize collect phase cannot fire at the wall-clock trigger** (its own comment); the money fix is on the
  SEARCH side (#833), never more work inside the finalize window.

## 2026-10-13
- **A read-only DB trace beats inference.** Two separate corrections came only from queries: the thread holds THREE runs (not two), and the three cache hits in run 1 came from a different thread started 15s earlier. Ask for the data path before reasoning about it.
- **`agent_memory` has no writer or provenance column, and the browser's analyst lesson and the model's `memory_save` use the same `save_agent_memories` RPC.** Analyst authorship can only be inferred from wording; never claim it. The upsert overwrites `source_thread_id`, ratchets confidence, keeps the longer content and bumps `hit_count`/`last_used_at`, so those columns are not recall evidence.
- **`tool_usage_log` stores no tool output**, so which memory rows were recalled cannot be reconstructed from it.
- **The orchestrator's budget elision cuts assistant text to 200 chars** (`elideAssistantText`); a prefix label longer than that is silently destroyed. Test any prompt prefix through the real `capTotalToBudget`, not just `truncateStr`.
- **Frontend suites import `system-prompt.ts`**, so anything it imports must not touch `Deno` directly (use the `globalThis.Deno` pattern in `lib/memory-context.ts`); `npm run typecheck` catches it, `deno test` does not.
- **`/health?health=1` is a GET with side effects.** `health-handler.ts` runs `recoverStaleActiveThreads` (DB writes), the rejected-cluster sweep,
  finding synthesis and live provider pings. Use `deploy-log.jsonl`, `deploy/live` and the mirror git log instead.
- **A footer is not a control.** The Evidence Record already says "No authoritative finding rows ... nothing in the narrative above was adjudicated",
  while the stored narrative keeps its `[CONFIRMED]` tags (14 in one case). `narrativeIsUnadjudicated` only shows a notice.
- **Two breach tools are one source.** `breach_check` and `oathnet_stealer_search` classify to the same `breach` class (count 1), so "4 independent
  stealer-log sources" is not a count the engine would produce.
- **Do not trust a code-review subagent's single-tree answer.** It reported `/timing` and the sidebar RPC "not reproduced" because it read only canonical;
  both exist in the Lovable mirror's frontend. Check both trees before classifying a Lovable warning.
- **When calling a helper in a repro, read its signature.** `shapeJinaBody(url, text, maxChars)` was first called as `(body, 200)` and threw; the Jina
  error format is anchored (`URL Source:` then `Warning: Target URL returned error N`). A repro that does not match the real input shape proves nothing.
- **Activity "Succeeded" = Health "Succeeded" + "No record"** (26 = 24+2, 47 = 41+6). The header's "N evidence" is `evidence_log` custody entries, not artifacts.
- **`deno test` rewrites `deno.lock`** even with `--no-lock` passed through `npm run`; `git checkout deno.lock` afterwards.


## 2026-10-10 (audit revalidation)
- **Implemented, deployed and enabled are three states; documents must say which.** S1a is the first two. A PR body that read "not started" outlived
  the work by hours, and a handoff saying "unbuilt" would have sent a fresh session to rebuild it. Update the status line in the same PR that changes it.
- **A `.git/handoffs/` note is local to one clone.** Fresh cloud sessions clone anew and never see it. Durable handoffs live in the repo root as
  `SESSION_HANDOFF_<date>_<slug>.md` and are linked from `CLAUDE.md`.
- **Never replace a checklist file without archiving it.** `tasks/todo.md` was overwritten; the old content (20 unchecked items) now lives in
  `docs/archive/TODO_2026-06_workspace-ui-plan.md`.
- **Audit every CLIENT writer of a server liveness column before gating on it.** S1a's lease read
  `last_heartbeat_at < 75 s` as "a run is live". `ChatWindow.beginInvestigation` had stamped
  `status:"active"` + a fresh heartbeat before every send since long before the lease, so every send
  refused itself with 409 on 2026-10-10 (one captured refusal carried `last heartbeat 09:36:34Z`) until
  `RUN_LEASE_DISABLED=true` was set. The recovery module's own comment described that client stamp and I read past it. Rule: grep
  `src/` for every write to a column the edge is about to treat as a signal, and say in the PR which
  writers exist. The wiring test checked server-side ORDER and could never have caught a client write.
- **The kill switch earned its keep.** Rollback was one secret write through the Lovable agent and
  `/health` showed `LEGACY` within a minute, with no deploy. Every behaviour-changing edge PR keeps one.
- **`/health` is also the fastest honest instrument for an incident**, and the live DB is readable
  through the Lovable project's `query_database` (SELECT only): the two threads' rows, the empty
  `tool_usage_log` and the empty `orchestrator_invocations` window proved "no run was live" in three
  queries. Use it before theorising.

- **A lease without cleanup on every exit is a ghost-run factory.** S1a's first cut released only on the two
  402 exits; a thrown setup error after acquisition would have stranded a heartbeat-less marker for the stale
  sweep to reap as an "interrupted run". Hold startup-only state at the handler top, release it in the outer
  catch, and clear it at the real handoff so a genuine interruption marker is never erased.
- **A rollback snapshot is only trustworthy if the UPDATE proves it.** Reading the row and then updating it
  lets the row change in between (a run finishing), and restoring the stale read resurrects it. Add the read
  values to the UPDATE's WHERE (`IS NOT DISTINCT FROM`), retry once from a fresh read, and never admit on a
  persistent mismatch.
- **CI's Frontend job lints `supabase/functions/` too.** A Deno lint comment does not satisfy
  `@typescript-eslint/no-explicit-any`; type the structural db chain instead and cast supabase-js at the call
  site, as `reviews.ts` does for `ReviewDb`.
- **`threads.status` is NOT NULL.** A fixture row with `status NULL` fails the insert in the Migrations job; the
  `status IS NULL` branch of a predicate is unreachable on this schema.
- **The Lovable `send_message` MCP call can time out client-side at 60 s while the message never landed.**
  Check `list_messages` before resending; use `wait=false` and poll `get_message`, and treat `/health` as the
  only proof either way.

- **An audit baseline is a dated measurement, not a state.** The 2026-10-10 audit's baseline (`main`
  `219732c`, live `2e5f78c`, "#724 not live") was overtaken within hours: `main` is `811acf3`, live is
  `f9fc281`, #724 is merged and live. Re-measure `git log` and `/health` (once) before acting on any
  audit number.
- **`invalid_type` on a required string is not catalog name drift.** The catalog entries for
  `serus_darkweb_scan`, `google_dorks`, `oathnet_lookup` and `socialfetch_lookup` already name the real
  zod fields; the 82 rejected calls sent the wrong *shape or type*. #698's five drifts are a different
  set. Read `tool_usage_log.input_json.sent_keys` (#697) before designing a fix.
- **`markRunStarted` is unconditional** (`recovery.ts:873`): it is a marker, not a lease. The frontend
  `server_running` refusal is per-tab and advisory. Overlapping invocations (21 of 94 in the window) are
  therefore expected, not anomalous, until an atomic conditional update lands.
- **`persistFinalMessages` runs from the browser's stream cancel too** (`lib/run-end.ts` header). The
  `premature_client_cancel` marker is the measurement; it is not a mobile-backgrounding diagnosis.
- **#593 (dedupe) is the correct fix shape and is still a draft**; `main`'s `dedupeArtifacts` still
  takes max confidence and spreads later metadata. Do not re-implement it; rebase it.
- **The lineage table is absent on the live DB** regardless of what any ledger says (`schema2` query
  returned null). A deployment ledger records a deploy, not a migration.

## 2026-06-27
- **Two `<think>`-strip paths existed, only one was wired.** `ChatWindow.tsx` strips
  `<think>` for *rendered* chat text (line ~828) but the **Next Steps** cards parse the
  *raw* assistant message via `extractRecommendedPivots` (`recommended-pivots.ts`), which
  had no sanitization — so reasoning leaked only into the cards, not the chat. Lesson: when
  the same backend text feeds two surfaces, sanitize at the shared source, not per-surface.
- **PR target remote is `origin` (`justindean785/insight-finder`).** `mirror` points to the
  Lovable backend repo `seeker-spark-search-5362c57c` — never open frontend PRs there.
- **The local dev server hits the LIVE backend.** `src/integrations/supabase/client.ts` bakes
  in the prod Supabase URL + anon key (`skzqwbyvmwqarfgfvyky`), so `npm run dev` authenticates
  against real data. With the user's login you can drive the actual authenticated workspace
  (real cases, real Next Steps) locally — full browser QA IS possible here, contrary to prior
  passes' assumption. (Auth is Supabase email/pw, shared across the Vercel + Lovable frontends.)
- **Worktrees share the parent checkout's `node_modules`.** A worktree off `main` whose
  `package.json` lists `@vercel/speed-insights` will fail `build`/`typecheck` if the parent's
  shared `node_modules` was installed for a branch lacking it. Fix locally with
  `npm install --no-save <pkg>` from the parent — don't touch the lockfile.
- **Scope corrections are not implementation decisions.** A prior Stage 1 report
  described the compact Evidence ledger as "deferred" when the corrected brief
  had explicitly listed it as included. Mis-reading the brief then shipping
  half of it reads as covert descoping. If a sub-scope seems large, name it in
  the pre-edit discrepancy report, not after.
- **`git diff main..HEAD` on a stale local-main branch overstates the PR size.**
  Local `main` can be far behind `origin/main`, so the diff includes commits
  that have already landed on origin's main. Always `git fetch origin main`
  and diff against `origin/main` before quoting a file count or line delta.
  The fast check: `git log main..origin/main --oneline | wc -l` — if non-zero,
  diff against origin/main.
- **A vitest delta is only meaningful against a baseline measured today on the
  same machine from `origin/main`.** CLAUDE.md baselines drift between PRs and
  across machines. Measure the baseline, measure the branch, quote both — never
  quote a delta against a static baseline from a note file.
- **An inline `# comment` inside a `bash`-tagged code block can reach `git` as a
  bare argument** when the host surface runs the block through a route that
  does not evaluate shell syntax. For user-facing blocks with a Run button,
  put commands on their own lines and keep comments outside the fence.

## 2026-11-01
- **A code review is not read until its BODY is read.** Graphify posts a review *body*
  carrying its substantive findings and, separately, inline threads carrying only
  deterministic coupling notes. On #935 the body named two of the three defects
  ("Previous user's run data stays on screen after the user changes or logs out",
  "Step-token read uses .limit(2000) above PostgREST's 1,000-row cap") at 02:48Z. I read only
  the inline threads via `get_review_comments`, saw three resolved coupling notes, judged the
  review clear, and merged at 03:07Z — nineteen minutes later. The defects reached production
  and needed a second PR (#937) to remove. **`get_review_comments` returns threads only; the
  findings can live in `get_reviews`.** Read both, on every PR, before merging. Resolving every
  thread is not clearance.
- **"Verified the production path" requires tracing the render guard, not just the state
  owner.** I reported the #935 user-switch defect to JD as a live production bug because
  `useAuth` nulls `user` in place on SIGNED_OUT. It is not: `BrainGlobalPage.tsx:320` is
  `if (!user) return <Navigate to="/auth" replace />`, so the tabs unmount before stale
  figures or a stuck `loading` can be seen. The fix is worth keeping as hardening, but it was
  described with more severity than the evidence carried. Before calling a UI defect
  reachable, follow the data to the component that actually renders it and check what guards
  the mount.
- **A bot's attribution can be right when my own reading was incomplete.** I told JD an audit
  had misattributed findings to Graphify that "Graphify did not make". The audit was correct;
  I had only read the threads. Check the primary source again before accusing a secondary one
  of fabricating — the cheaper error is re-reading, and the expensive one is a confident
  correction in the wrong direction.
- **Severity-ordered classification must not interleave an authoritative signal with a
  heuristic one.** `classifyFailure` ORed an HTTP status test against a regex per branch, in
  severity order, so a lower-priority code lost to a higher-priority regex: HTTP 500 with
  "upstream quota service unavailable" matched `quota` and read as a credential refusal —
  reporting a dead key for a provider that was merely down. Authoritative signal first,
  heuristic strictly as a fallback, and keep an explicit escape for unrecognized codes
  (FOFA answers HTTP 200 with an error body). I first judged this a preference and had to
  reverse; the repro that settled it took one minute.
