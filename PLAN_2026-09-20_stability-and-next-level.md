# Insight Finder — stability and next-level plan

> Written 2026-09-20 from production data (live DB via Lovable, `/health`, 14 and 30 day
> windows), not from the handoffs. Every number is a dated measurement. Re-measure before
> acting on one that matters.

---

## 0. The one-paragraph diagnosis

The app is slow, noisy and repetitive for **one structural reason**: an investigation is
modelled as a chain of independent 3-minute edge-function invocations, and every invocation
must end in a **forced finalize that writes a full closing dossier**. So every "run next
pivots" turn re-runs triage, re-uploads the whole transcript, hits the same wall clock,
gets forced to finalize, and prints the whole report again. The tool "storm" is the same
thing seen from the tool side: the model is handed ~85 tools every step with no routing,
fires broadly, and the runtime refuses calls *after* the model has already spent the step
on them. None of this is a bug in one file. It is the run model. Fix the run model and the
symptoms go with it.

---

## 1. What production actually says (measured 2026-09-20)

### Where the time goes (last 14 days)

| Meter | Value |
|---|---|
| Total invocation wall time | 16,827 s |
| Of which tool execution | **6,309 s (37%)** |
| Of which model prefill + generation | **~10,500 s (63%)** |
| Steps | 825 |
| Avg step | 18.6 s (p90 39 s) |
| **Avg input per step** | **59,194 tokens** (~131k chars *after* trimming, and that meter is an undercount) |
| Avg output per step | 727 tokens; text-only (report) steps 2,176 tokens and 37 s |
| Median invocation | 150 s, p90 183 s |
| Median invocations per case | 2 (max 13) |
| Median tool calls per case | 35 (max 136) |

> ⚠️ **CORRECTED in §11 (same day):** the model share is real but it is OUTPUT, not prefill.
> Step time correlates 0.003 with input tokens and 0.798 with output tokens (~13 ms/token).
> Prompt size is a cost lever; generated tokens and step count are the latency levers.

**The single biggest lever is what the model writes per step, and how many steps it takes.**
Roughly 57% of the wall clock is generation at ~77 tok/s, 41% is tools. The tool schemas
(~95–105k chars re-serialised every step) cost money and budget, not seconds.

### How runs end (128 invocations, 14 days)

| stop_reason | n | what it means |
|---|---|---|
| `finalize_forced` | **79 (62%)** | hit the wall-clock/step/tool cap and was forced to write a report |
| `natural_stop` | 22 (17%) | the model chose to stop |
| `stream_error` | 23 (18%) | died, 16 of them at 0 steps (11 s avg: bad request, overlap wedge, 401) |
| `unknown` | 4 | an unwired telemetry parameter (handoff 09-20 §5) |

**62% of runs are cut off by a ceiling and forced to synthesise.** That is why the
transcript is dossier after dossier: each forced finalize prints a full report.

### The "resend the whole dossier" problem, quantified (30 days)

| Meter | Value |
|---|---|
| Assistant messages | 299 |
| Avg persisted size | **55,912 chars** (p90 119k) |
| Report-shaped assistant messages | 111 (37%), long (>6k chars of prose) 188 (63%) |
| User messages that were literally "run next pivots" / "pivot" / a pivot card | ~45 of 284 |
| Request body per turn | the full history, re-uploaded by the client (431 KB p90, 2 MB worst) |

The client transport has no `prepareSendMessagesRequest`, so every turn uploads every prior
message including every prior dossier. The edge then trims it, but the upload, the parse and
the trim all happen on every click.

### Tool outcomes (1,746 calls, 14 days)

| outcome | n | share | notes |
|---|---|---|---|
| ok | 1,325 | 76% | |
| **skipped** | **199** | **11%** | 110 = "finalize window open", ~60 = "provider already has a call in flight", 16 = duplicate |
| empty | 139 | 8% | |
| failed | 83 | 5% | 20 `socialfetch_web_read` aborts, 9 `gemini_deep_dork` 20 s timeouts, 7 `indicia_person` timeouts, 5 `reddit_user` 403, 5 `deepfind_email_breach` 403 |

Two things stand out. First, **the skips are the runtime fighting the model**: the model
keeps trying to work after the finalize window opens, and fires parallel calls at providers
the runtime serialises. The refusals then still burn a reserved slot of the 36-call budget
(`cache.ts` reserves before the circuit and policy gates), which pushes the run *toward* the
forced finalize that caused the skips. Second, **failures are cheap in count and expensive in
time**: 83 failures cost 821 s, ~10 s each, because they are mostly timeouts.

### Where the tool time goes

| tool | calls | share of tool time | failed | skipped |
|---|---|---|---|---|
| `minimax_correlate` | 81 | **23%** (25 s avg) | 1 | 23 |
| `socialfetch_web_read` | 102 | 10% | 22 | 7 |
| `minimax_web_search` | 187 | 10% | 1 | 31 |
| `jina_reader_scrape` | 105 | 7.5% | 9 | 6 |
| `serus_darkweb_scan` | 63 | 7% | 0 | 3 |
| `gemini_deep_dork` | 43 | 6.6% | 9 | 11 |
| `indicia_person` | 16 | 4.4% (17–23 s each) | 7 | 2 |

`minimax_correlate` is a quarter of all tool time and is skipped 23 times for "finalize
window open" — the prompt mandates it before every report, so the model calls it exactly
when the window has closed.

### Live health

`/health` at `4bb19d9`: `ok:true`, provider `deepseek` slot → `glm-5.2`,
`checks.credentials` refusing `deepfind_email_breach`, `reddit_user`, `deepfind_disposable_email`.
`github_code_search` recovered.

### Merge queue

Three green, mergeable draft PRs are waiting on JD: **#602** (streaming freeze, frontend),
**#603** (readiness denominator, frontend), **#604** (prompt budget hard ceiling, edge).
Nothing has merged since 09-15. CLAUDE.md is right that the merge queue, not the deploy, is
the bottleneck.

---

## 2. Target model: an investigation is a session of cycles, not a chain of dossiers

```
seed ──▶ CYCLE 1 ──▶ CYCLE 2 ──▶ … ──▶ [Write report]
          │            │
          ▼            ▼
      delta card   delta card        ← "3 new findings, 2 pivots" — not a dossier
      (persisted)  (persisted)
                                       Report tab is already generated from artifacts,
                                       so the report is a VIEW, produced on demand.
```

Rules of the model:

1. **A cycle ends with a delta, never a dossier.** New findings as compact lines plus the
   next pivots. The Report tab already renders from persisted artifacts
   (`ReportTab.tsx` → `buildReportMarkdown`), so nothing is lost by not printing the report.
2. **The report is an explicit action.** "Write report" runs a tool-free invocation over
   persisted artifacts. One dossier per case unless the analyst asks again.
3. **Continue is a click, and Auto-run is zero clicks.** Auto-run keeps cycling while a
   cycle still records new evidence, stops on saturation, and has a hard cycle ceiling as
   the cost guard.
4. **History lives on the server.** The client sends the new message and the thread id;
   the edge loads history from `messages`. No more 400 KB uploads per click.
5. **The model sees a routed tool set, not the registry.** Per step: the seed kind, what
   already ran, what never yields, and the reliability prior pick ~20–30 tools.

This keeps Supabase, Lovable, Vercel and the deploy recipe exactly as they are. It does not
need a new platform. Section 6 says when a new platform would be worth it.

---

## 3. The ordered plan — small PRs, one behaviour each

Channels: **F** = frontend (ships on merge via Vercel). **E** = edge (needs the full
stamp → sync → gate → Lovable deploy → `/health` cycle; one in flight at a time).
**S** = schema (through Lovable, verified against the live DB, before the code that uses it).

### Track A — cycles instead of dossiers (the UX JD asked for)

| # | PR | Ch | What | Proof |
|---|---|---|---|---|
| A0 | **merge #602, #603, then #604 + deploy** | F,E | drain the queue first; nothing below proceeds on the edge channel until #604 ships | `/health` `checks.prompt_budget_ceiling` |
| A1 | **Run controls: Continue / Auto-run / Write report** — *this branch* | F | one bar above the composer; Auto-run stops on saturation, failure, Stop, or 3 cycles; pure decision logic unit-tested | `src/lib/run-controls.ts`, 11 tests |
| A2 | **`run_mode` on the request: `cycle` \| `report`** | E | `cycle`: the finalize report phase writes a *cycle delta* (a `## Cycle findings` table + `## Next pivots`, which still satisfies `hasReportShape` so invariant I-2 holds). `report`: tools off from step 1, full dossier from persisted artifacts. Default stays today's behaviour. Kill switch `RUN_MODE_DISABLED`. | `/health` `checks.run_mode` |
| A3 | **Cycle delta cards in the transcript** | F | render a cycle-mode message as a compact card ("Cycle 3 · 4 new · 2 pivots", expandable) instead of a wall of prose; Next Steps rail keys off the delta, not the dossier | harness screenshot |
| A4 | **Server-owned history** | E then F | E: if the body carries `historyMode:"server"`, load history from `messages` (bounded, newest first) and ignore client history. F: `prepareSendMessagesRequest` sends only the last message. Kill switch on E. | `/health` `checks.history_mode`; request-body meter (handoff 09-20 §9 step 3) |
| A5 | **`sanitizeModelMessages` positional pairing** | E | the overlap wedge from handoff 09-20 §4; small and pure; needed before Auto-run makes overlapping sends more likely | `orchestrator_invocations` shows no `Tool results are missing` after deploy |

A1 and A2 are the pair that changes what JD sees. A1 alone stops the typing; A2 stops the
dossier. Ship A1 now, A2 as the next edge PR after #604.

### Track B — make every step faster (the 63%)

| # | PR | Ch | What | Proof |
|---|---|---|---|---|
| B1 | **Durable prompt-size meter** | S then E | add the `prompt_size_step` term breakdown to `orchestrator_step_metrics` so the ceiling can be set from data (CLAUDE.md says do not set it from an estimate) | rows carry the terms |
| B2 | **Cut tool descriptions to one line each** | E | `catalog.ts` already carries the when-to-use guidance and is fetched once; the per-tool `description` repeats paragraphs of it on every step. Target: schemas from ~100k chars to ~30k. Behaviour-neutral by construction. | `prompt_size_step` drops |
| B3 | **Routed tool set per step** | E | wire what is built and unreferenced: `shouldAllowToolCall` (no-yield families → suppress), `RouteContext.highYieldTools`, the reliability prior. Give the model 20–30 tools per step, chosen from seed kind + selectors discovered so far (never `seedTypes`, see CLAUDE.md). Kill switch. | tool calls per case ↓, `skipped` share ↓ |
| B4 | **Refusals do not reserve budget** | E | move `reserveToolCall` after the circuit and policy gates in `cache.ts`, so a call the runtime refuses cannot push the run into forced finalize | `finalize_forced` share ↓ |
| B5 | **Timeout budget per provider** | E | `indicia_person` 22 s, `gemini_deep_dork` 20 s, `socialfetch_web_read` aborts at ~10 s: cap slow providers at 8–12 s with a cached retry on the next cycle, rather than letting one call eat a quarter of the wall clock | failed-call seconds ↓ |
| B6 | **Correlate once per cycle, at the boundary** | E | run `minimax_correlate` as a runtime step at the end of a cycle (it is deterministic work over artifacts, not a decision) instead of a model-issued call that gets skipped when the window closes | 23 "finalize window" skips → 0 |

### Track C — stop calling what never works

| # | PR | Ch | What |
|---|---|---|---|
| C1 | **Account-level platform suppression** | S then E | the one open decision in NEXT_SESSION_PROMPT: a "false" mark on a platform suppresses it for the account. JD's answer needed: one mark, or N marks across N cases. |
| C2 | **Tool-lesson recall axis** | E | key tool lessons by `tool:<name>` and recall them every run; 101 lessons are currently unreachable (CLAUDE.md) |
| C3 | **`budgetExhausted` at the `deriveStopReason` call site** | E | one line; makes `stop_reason='unknown'` mean something |
| C4 | **Call-to-artifact lineage** | S then E | `call_id` on `tool_usage_log` + junction table; prerequisite for every "learn which tools produce kept evidence" feature (CLAUDE.md, handoff 09-13 §7) |

### Track D — the deploy confusion

Nothing here is a mystery any more; it is a runbook nobody can hold in their head. Two
changes make it mechanical:

| # | PR | Ch | What |
|---|---|---|---|
| D1 | **`npm run ship:edge`** | scripts | one command that does steps 2–4 of the recipe: stamp, surgical sync of changed function dirs into a mirror clone path, `verify:deploy` hard gate, and prints the exact Lovable message to send. It refuses to proceed on `mirror_tree_differs`. The human steps left are: send the message, curl `/health`, `record:deploy`. |
| D2 | **Session rule: no draft left behind** | docs | an agent session that ends with a green PR in draft has not shipped. The session's last act is to mark ready and post the merge order. JD's only job is to merge in that order. |

### Track E — UI and quality-of-life

| # | Item | Ch | Notes |
|---|---|---|---|
| E1 | Run controls bar | F | **done on this branch** |
| E2 | Run progress: phase strip (TRIAGE → REVIEW → PIVOT → VERIFY → REPORT) + elapsed + calls used / cap | F | `runtime.stage` and the budget already exist in tool-part runtime meta; nothing new server-side |
| E3 | Honest cycle summary in chat | F | chat currently hides failed calls and drops all-skipped cycles (`ChatWindow.tsx` `cycleSummaryBadges`); show `N failed · N gated` with a link to Tools → Health |
| E4 | Case summary strip on Investigate | F | a live 4-line summary from artifacts (confirmed / likely / leads / quarantined) so the analyst never needs the dossier to know where the case stands |
| E5 | Report on demand | F | the Report tab is already artifact-driven; A2's `report` mode gives it a "Generate narrative" button and the print path stays |
| E6 | Overlap indicator | F | "a run is active on this thread" from `last_heartbeat_at`, so a second tab or a reload cannot silently double-run (handoff 09-20 §4) |
| E7 | Mobile composer | F | the controls bar and Next Steps must work at phone width; verify in the harness |

---

## 4. What not to do (each has burned a session already)

- **Do not rewrite the orchestrator or move to a new stack first.** Every symptom above
  has a bounded fix inside the current stack. A rewrite resets the 1,885 edge tests and the
  deploy provenance.
- **Do not raise `MAX_PAID_CALLS`, `MAX_ORCHESTRATOR_STEPS` or the wall clock.** Settled
  (CLAUDE.md). A longer run dies in a worse place. Cycles make the caps *per cycle*, which
  is the honest unit.
- **Do not populate `seedTypes` to shrink the schema.** Pivots derive new selector types
  mid-run. Route on discovered selectors (B3), cut the prose (B2).
- **Do not infer intent from prose** and do not touch `toolChoice` globally. The cycle
  delta in A2 is a *structural* signal (heading + table), which is what invariant I-2 wants.
- **Do not fix `approxPromptChars`.** It routes providers. Add the durable meter beside it (B1).
- **Do not mix frontend and edge in one PR**, and do not put a schema change in the PR
  that uses it.

---

## 5. Answering "should we use a different system?"

Three honest options, in order of when they become worth it.

**Option 1 — keep the stack, change the run model (Tracks A–C).** Recommended now. It
removes the per-turn dossier, the per-turn upload, most skips, and roughly halves per-step
latency once B2/B3 land. Cost: 8–10 small PRs over 2–3 weeks at the current merge cadence.
Risk: low; every PR has a kill switch and a `/health` key.

**Option 2 — a long-running worker for the orchestrator.** The 150 s isolate wall is the
reason `finalize_forced` is 62%. A worker (Fly, Railway, a Vercel background function, or a
Supabase queue consumer) could run a whole case in one process with a 20-minute budget and
stream progress through `messages` + realtime, with the edge function reduced to a thin
authenticated proxy. Worth it **after** Option 1, and only if cycles still feel choppy. It
adds a third deploy channel; do not add it while the two existing ones are still confusing.

**Option 3 — fewer, smarter calls (an "agent that knows the tools") instead of a fan-out.**
This is mostly Option 1's B3 plus C2: a curated tool set per seed kind, a reliability prior
that actually gates, and tool lessons recalled by tool name. It is not a different system.
The one genuinely new piece worth considering is a **planner step** at the start of each
cycle: a cheap model call that reads the case summary and picks the 3–5 pivots and tools
for that cycle, so the expensive model only executes. `minimax_plan_pivots` exists and is
called 4 times in 14 days; it could become the cycle planner.

---

## 6. What this session delivered

- **Measured state** (section 1), so the next decision is made on numbers.
- **A1 — Run controls**, on this branch: `src/lib/run-controls.ts` (pure, 11 tests),
  `src/components/pivots/RunControls.tsx`, wiring in `ChatWindow.tsx`. Continue and Write
  report are one click; Auto-run cycles up to 3 times while each cycle still records new
  evidence and says why it stopped. Nothing bills that did not bill before; each cycle is
  the same invocation a typed "run next pivots" was.
- **A2's exact shape** (section 3) as the next edge PR, sequenced after #604.
- **The ordered plan** (section 3) with channels, kill switches and proof keys.

### Decisions only JD can make (do not guess these)

1. Merge order: #602 → #603 → #604 (+ deploy) → A1. All are green.
2. C1: does one "false" mark suppress a platform for the account, or N marks across N cases?
3. Auto-run ceiling: 3 cycles is the default here. A cycle is ~$0.10–0.30 at current usage.
4. Whether Option 2 (a worker) is on the table at all, or the isolate is a fixed constraint.

---

## 7. Worked example — the `lildee808` run JD screenshotted (2026-09-20, thread `d72fa44a`)

Five screenshots, one case, 18 minutes, $0.91. Everything below is from `orchestrator_invocations`,
`tool_usage_log`, `messages` and `artifacts` for that thread, not from the screenshots.

### The run, invocation by invocation

| # | start | secs | steps | calls | ended by | context in → out (chars) | $ |
|---|---|---|---|---|---|---|---|
| 1 | 11:50 | 147 | 9 | 26 | **Stop pressed** | 44k → — | 0.12 |
| 2 | 11:53 `lildee808_first` | **235** | 10 | 15 | finalize_forced | 100k → 186k | 0.17 |
| 3 | 11:58 "pivot on chicago drill rapper finding" | 167 | 10 | 17 | finalize_forced | 223k → 386k | 0.25 |
| 4 | 12:02 "run next pivots" | 184 | 11 | 18 | finalize_forced | 223k → **1,008,059** | 0.23 |
| 5 | 12:06 pivot card `@deadbandswalking` | 122 | 6 | 9 | **Stop pressed** | 252k → — | 0.15 |

Persisted assistant messages: 96 KB, 114 KB, 49 KB. Every completed run was force-finalized. Run 2
overran the 3-minute wall clock, which is why its Findings table ends in a half-written row
(`**bre`) — the dossier was being written at the edge of the isolate's life and got cut. Run 4's
in-stream context reached one million characters; that is the exact failure #604's hard ceiling
exists for, and the strongest argument for merging it first.

### What the 80 tool calls actually were

| bucket | calls | notes |
|---|---|---|
| useful, ok | 55 | |
| **refused by the runtime** | **17 (21%)** | 11 "finalize window open", 5 "provider already in flight", 1 duplicate |
| failed | 8 | **7 × `socialfetch_web_read` AbortError** (the same YouTube channel, retried across three runs), 1 × `indicia_person` 31 s timeout |
| `minimax_correlate` | 5 called, **1 ran** | the prompt makes it mandatory before the report; the model calls it exactly when the finalize window has closed, so 4 of 5 were skipped |

The YouTube retry is the clearest single defect: the narration itself says "YouTube continues to
time out (3 attempts now)", and the tool log shows seven attempts, because the circuit state is
cleared on every request (`clearRuntime`) and nothing durable says "this target is dead in this
case". A per-thread dead-target list, persisted across invocations, stops that in one small edge PR.

### Scope drift, and one integrity concern

- `gemini_deep_dork` surfaced a name, **Jordan Rhodes**, that the next run spent calls debunking
  ("likely hallucinated or conflated"). Recorded correctly as `excluded_collision` at 15 — the
  integrity layer worked — but the calls were still spent.
- The run then followed the subject's Instagram posts into a **Fuller Park gas-station shooting**
  and recorded a `media_report` at confidence 55 naming the **victim**, a real third party with no
  established link to the subject. Nothing in the taint or quarantine rules keys on "this row is
  about someone else". That is evidence-ranking territory and needs JD's sign-off, but the shape
  of the fix is the same as `subject_unlinked`: a `media_report` whose named person is not the
  subject should carry the quarantine marker, not authority. Auto-run would have kept going down
  that road, which is why its saturation stop and 3-cycle ceiling matter.

### What the analyst saw, and why

- **A full dossier while the status still said Running** (screenshot at 5:00). The finalize window
  had opened; the model was writing the closing report inside the run. With `run_mode: cycle`
  (A2) this becomes a short delta card.
- **"Evidence Record — authoritative: no authoritative finding rows were recorded"** under a
  seven-section dossier. True (`record_finding` is advisory and was never called), and confusing.
  Finding synthesis is built and dark; the plan's C-track and #603 are the honest fixes. Until
  then the dossier should not out-rank the line beneath it.
- **An ASCII-art Network diagram that overflows a phone.** Model-generated. The fix is a prompt
  rule (Network section as a list, never a box drawing) plus the cycle delta, which has no
  Network section at all.
- **After Stop: "Recovery unavailable … a new message would start a separate, billed run."**
  Honest, and useless. With #606 the Continue / Auto-run / Write report bar appears under that
  banner, so Stop is no longer a dead end.

### Additions to the ordered plan from this case

| # | PR | Ch | What |
|---|---|---|---|
| B7 | **Per-thread dead-target memory** | E | after 2 failures on the same `tool + target` in a thread, refuse further calls for that pair for the life of the case; persisted (`tool_usage_log` read at run start, like `run_budget_prior`), so it survives `clearRuntime` |
| B8 | **Correlate at the boundary** (was B6) | E | promote: this run proves the "mandatory before report" rule cannot be honoured by a model-issued call |
| A2′ | **No box drawings** | E (prompt) | ride with A2: Network section is a bullet list; tables ≤ 4 columns |
| C5 | **Third-party `media_report` quarantine** | E | needs sign-off (evidence ranking). Shape: quarantine, not delete |

---

## 8. The Tools tab screenshots — two panels, one minute, two truths

Activity and Health for `lildee808` at 5:00, ~55 rows in `tool_usage_log`
(40 ok · 3 empty · 3 failed `AbortError` · 9 skipped):

| the same rows | Activity says | Health says |
|---|---|---|
| 3 × `socialfetch_web_read` AbortError | **Failed 3** (red) | **Cancelled 3**, "not a provider fault", **Needs attention 0** |
| 1 × "duplicate call" skip | Degraded 1 | Skipped |
| 3 × empty (404 / no record) | folded into Succeeded 43 | No record 3 |
| 9 skips | Skipped 8 | Skipped 12 (9 + the 3 "cancelled") |

Three classifiers, three truths — `classifyActivityRow` (Activity), `classifyDetailedOutcome`
(Health) and `deriveToolTone` (chat cards). **The fix is already written: PR #579 routes Activity
through the canonical taxonomy so the two panels count the same category.** It has been open and
mergeable, not a draft, since 2026-09-11. Add it to the merge order.

**But #579 will make both panels agree on a wrong label.** The three AbortErrors are not the
investigation's time budget cancelling anything. They are `socialfetch_web_read`'s deliberate
6-second YouTube fast-timeout (`SOCIALFETCH_YOUTUBE_FAST_TIMEOUT_MS`), which raises a raw
`AbortError: The signal has been aborted` instead of the `exceeded Nms tool timeout` phrase the
taxonomy knows. So a host the code *already knows is dead* reads as "Cancelled — not a provider
fault" with Needs attention at zero, while the model retried it seven times. One-line edge fix,
riding with B7: have the fast-timeout path return
`socialfetch_web_read exceeded 6000ms fast timeout (youtube host policy)` so it classifies as
`timeout`, and let B7's dead-target memory stop the retries.

Two smaller UI items from the same screenshots (Track E):

| # | Item | Notes |
|---|---|---|
| E8 | Time-and-spend list truncates names to 7 chars at phone width | "socialf…" ×2 and "minimax…" ×2 are indistinguishable; put the full name on its own line below 480px, or use `toolActionLabel` |
| E9 | Health "Needs attention" must count repeated failures on one target | 3 of 3 attempts on one URL is attention-worthy whatever the category; count `tool + target` streaks, not categories |

---

## 9. The exported report (`osint-report-UNVERIFIED-DRAFT-lildee808.md` + PDF)

Checked against the 79 artifact rows for thread `d72fa44a`. The PDF is the browser-print path of
the same report, so the markdown is the authoritative content.

### What the report says vs what the evidence supports

The report presents **28 "Candidate Identity Clusters", 27 of them at a flat 55–60**, and calls
the top "Key Finding" an `excluded_collision` — the Chicago drill rapper who is explicitly *not*
the subject. It never states the one conclusion the artifacts actually support:

> The seed handle is **Likely** (not Confirmed) tied to one person in Hawaii. Chain: a single
> MyFitnessPal breach record carries username `LilDee808` with a second email; that email's
> breach rows carry a full name, two 808-area phones and a Kauai town; public records for the
> same name give Honolulu/Lihue addresses and two more emails. "Dee" + "808" (the Hawaii area
> code) in the handle is consistent. Weakness: the handle-to-email link rests on ONE breach
> record (one source class), and the name has 19 same-name collisions in public records.

Every piece of that chain is in the artifact table. The engine split it into **fifteen
separate clusters** (C003–C015, C026–C028): the email, each phone, each address, each
name fragment ("Dee", "Desiree", "Fleming") is its own "unattributed cluster" at 60.

### Why — built and unwired, again

Both clusterers merge on selector **equality** only (`HANDLE_MATCH`, `EMAIL_MATCH`,
`PHONE_MATCH`, plus address/IP as `SHARED_INFRASTRUCTURE`). A phone persisted *from* an email's
breach record shares no selector with the email row, so it can never join it.

**The report already honours a `parent` merge key** — `src/lib/intel.ts:2235` unions on
`metadata.parent` / `parent_seed` / `seed` as `SHARED_INFRASTRUCTURE`. **Nothing writes it:
14 of 9,269 artifacts in 60 days carry `parent`; 0 in this thread.** `record_artifacts` and the
auto-persist path know the selector each call was made on (it is the dispatch key) and drop it.

**Fix (edge, small, additive, kill switch):** stamp `metadata.parent = <type>:<queried selector>`
on every artifact a call yields — for **durable** selector types only (email, phone, username,
url, domain), never for a name, so a name-only query (the 19-identity harvest) cannot fan a
merge out. Weight stays at `SHARED_INFRASTRUCTURE` (20), the weakest signal: "came from the same
lookup" is co-occurrence, not linkage, and still needs a second class to reach Likely. Rides
naturally with the lineage work (C4), which persists the same fact durably.

`promoteConfidence`'s no-op corroboration branch (CLAUDE.md) is why nothing rises above 60 even
where two classes agree; that one still needs sign-off.

### Six more report-layer defects, in order of harm

| # | Defect | Where | Fix shape |
|---|---|---|---|
| R1 | **Plaintext passwords in an export.** Three breach rows carry `password='…'` / `passwords …` in the artifact VALUE, so they print in the report, the PDF and the Network section | `record_artifacts` value text; `intel.ts:1369` only re-homes them | Mask at **export time** (`report-export-gate`), independent of `REVEAL_BREACH_DATA`, which is settled and stays on in the workbench. Better: never put a password in `value`; carry it in metadata |
| R2 | **A murder victim as an identity cluster.** C020 and the Network "Identity" list name a third party from a news story beside the subject's candidates | cluster builder has no "about someone else" signal | C5 (third-party `media_report` quarantine) — needs sign-off |
| R3 | **"Key Findings" leads with the excluded collision** because it is the only analyst-attested row | `authoritative-findings.ts` ranks attested first regardless of kind | exclude `excluded_collision` from Key Findings; it belongs only in the Collision section it already appears in |
| R4 | **Readiness 3%** on a case with a usable identity chain | denominator counts every weak lead and note | #603, already open |
| R5 | **Name fragments as artifacts** ("Dee", "Fleming", "Terence" = a password reused as a name) | `serus_darkweb_scan` extraction | do not persist single-token names from breach name fields; keep them in the parent row's metadata |
| R6 | **Activity Log labels disagree with the tool log** — `record_artifacts (failed)`, `memory_recall (failed)`, three `exa_search (failed)`; the log says ok / ok / 1 ok + 1 skipped | `intel.ts` message-log section uses a fourth classifier | route it through the canonical taxonomy with #579 |

Also: "Recommended Next Steps" are per-kind templates ("Checking developer profile traces") with
no relation to the case. With `parent` wired, the pivot engine has the chain and can recommend
the one thing that would move this case from Likely to Confirmed: a second, independent source
class tying the handle to the email.

---

## 10. The raw JSON export — the engine already knows, in the metadata

The JSON export of the same case shows the merge gap is narrower than §9 said, and the fix is
smaller. The cross-link union in `intel.ts` (~:2237) already reads `meta.email/emails`,
`meta.phone/phones`, `meta.username` and `meta.address`. It misses this case for three exact
reasons:

| # | Miss | Evidence in the export | Fix |
|---|---|---|---|
| M1 | **Phone keys are not normalised.** The key is `phone:${raw.toLowerCase()}` | the Serus row carries `phones: ["8087838763", …]`; the phone artifacts are `+18087838763`. Same number, different key, no merge | key on digits only, leading `1` stripped, for both the value-based and metadata-based hits |
| M2 | **Plural and `associated_*` handle keys are not read.** Only `meta.username` is | the Serus row has `usernames: [… "LilDee808" …]`; the MyFitnessPal rows have `associated_username: "LilDee808"` and `associated_email` | read `usernames`, `handles`, `associated_username`, `associated_email` in the same loops |
| M3 | `current_address` on the name row and `cities/zips` on breach rows are not read | `Desiree M. Fleming` row: `current_address: "2514 S Beretania …"` | read `current_address` into the address key; leave city/zip alone (too coarse to be a merge signal) |

With M1 + M2 alone, the seed cluster, the second email's cluster and both 808 phones collapse into
one — from fifteen clusters to about four — using **only signals the engine already accepts**
(`PHONE_MATCH`, `HANDLE_MATCH`, `EMAIL_MATCH`). Names stay out of the merge, as the T1-2 §8 rule
requires. Frontend-only, pure, ~20 lines, and this thread is the regression fixture. It should be
its own PR (one behaviour), not folded into #606.

### Three other things the JSON makes explicit

- **The model reached the right conclusion in run 1 and buried it in the wrong row.** The
  exclusion row for the Chicago rapper says, in its `reason`: *"not connected to Desiree Fleming
  or Hawaii"*. That is the case's identity call — stated once, in the metadata of the row about
  someone else, never in a finding. `record_finding` was never called (advisory, §9 R4).
- **A password became a name.** `extracted_password: "terence"` → `extracted_name: "Terence"` →
  a `name` artifact at 55 in the Identity list. §9 R5, now with the exact field.
- **A quarantined harvest can be laundered by re-recording its rows.** The `indicia_person`
  name-only harvest is correctly `subject_unlinked` (19 identities). The model then persisted ten
  of its emails, phones and addresses as separate rows at 60 with no quarantine marker. Here the
  pick was defensible (the harvest contained the breach-chain email), but nothing checked that;
  the engine took the model's word. Evidence-integrity: **needs sign-off**. Shape: a
  `record_artifacts` row whose value appears inside an active `subject_unlinked` harvest on the
  same thread inherits the marker unless it also matches a durable non-name selector already in
  the subject cluster.
- Two small corroborations the engine never used: the TikTok display name is `Dee-Ogge07`, and
  the Serus `names` array carries `"Dee F"`. "Dee" is in the handle. Names are out of the merge by
  rule, but they belong in the narrative, and the narrative is what the report lacks.
- The JSON export carries `passwords: [...]` and `extracted_password` in metadata. It is behind the
  acknowledgement dialog; it should still be masked at export (§9 R1).

---

## 11. The two Lovable audits (2026-09-20), verified claim by claim

Both files were read in full and every quantitative claim was re-run against the live DB and
the code. Verdicts, then the one thing that matters most.

### What Lovable got right, and where it corrects THIS plan

**Latency is output-bound, not input-bound. This overturns §1's "63% prefill" framing.**
Measured over 825 steps: correlation of step wall-time with input tokens is **0.003**; with
output tokens **0.798**. Regression: **13 ms per output token (~77 tok/s) plus a ~9 s
intercept**. Quadrupling the prompt costs seconds; every 1,000 tokens the model writes costs
~13 s. Consequence for the ordered plan: **B2/B3 (schema size, tool routing) are cost and
budget fixes, not latency fixes.** The latency levers are (a) fewer output tokens per step
and (b) fewer steps. That reorders Track B — A2 (cycle delta instead of dossier) is now the
top latency item as well as the top UX item.

**Where the 255 minutes of step time actually went (14 days):**

| bucket | minutes | share |
|---|---|---|
| tool execution inside steps | ~105 | 41% |
| model generation, tool-calling steps (13 ms/token) | ~86 | 34% |
| model generation, the closing report step | **58** | 23% |
| residual (TTFT, the per-step `threads.status` poll, misc) | ~6 | 2% |

Lovable's "75% is the model talking" is overstated (it is ~57%), but the direction is right.

**Every one of the 93 zero-tool steps is the LAST step of its invocation** — the forced
closing report (p50 2,303 output tokens, ~30 s each, 58 min total). There are **zero**
mid-run "essay" steps. So the fix is not "ban prose steps" or "cap every step at 600 tokens"
(that would truncate every report mid-table, which already happens at the wall clock). The fix
is A2: a cycle ends with a ~300-token delta, and the report is rendered in code from persisted
rows with a ≤600-token narrative. Same conclusion as §2, now with the number that proves it.

**The Gemini fallback has never worked.** 14 `gemini-direct` invocations, 14 `stream_error`
at 0 steps, all "Bad Request", in bursts on 09-11 06:40–06:44 and 09-18 21:02–21:06 — exactly
when the primary was unhealthy (the ledger shows an "Insufficient balance" on the Z.AI slot on
09-13). So on a primary outage the product does not fail over, it dies, five times in four
minutes. The recorded error is the bare reason-phrase because `onError` logs
`error.message` and drops the provider body. **Fixed on the edge branch:** `describeStreamError`
carries `statusCode` and a bounded `responseBody`, so the next failure says why (most likely a
tool-schema shape Gemini's OpenAI-compatible endpoint rejects, e.g. `anyOf`). Disabling the
fallback until then, as Lovable suggests, is reasonable and is an env change, not code.

**Confirmed as stated:** `CLASS_CAP` breach/data_broker 60, `ai_summary` 55; `NEVER_HIGH` caps
aggregator-only artifacts at 65 (`confidence.ts:475`); the stored confidence is
`min(rawConfidence ?? 50, cap)` (`:488`), i.e. the model's number under a ceiling. Only the two
page-reading tools produce ≥70. 95.6% of distinct values are single-sourced. Cache 99.3%
expired, ~20 hits. `archive_sha256` null on every `evidence_log` row ever. `input_json` empty
for `record_artifacts` and `triage_seed`. Idle gaps between invocations: p50 56 s, p90 16 min.

### What Lovable got wrong

- **"Analyst feedback rows are written in production but no code in this repo writes them; the
  deployed engine has diverged."** False. `src/lib/analyst-feedback.ts` writes them through the
  `record_analyst_feedback` RPC (migrations `20260717000000`, `20260806000001`,
  `20260810000000`), and `ResourcesPanel.tsx` calls it. No divergence.
- **"162 actions changed a confidence score zero times — feedback is decorative."** The zero
  delta is by design and documented (CLAUDE.md, #534): the review answers "is this real?",
  the confidence answers "how well sourced?", and the two are kept apart on purpose. What a
  verdict DOES bind: dismiss/wrong refuses dispatch (`rejected_dispatch_test.ts`), excludes the
  row from clusters, the graph and the report, and derived rows follow it; confirm/key labels
  the row ATTESTED and lifts it into Key Findings. What is true and worth keeping from the
  claim: a confirm never creates a `record_finding` row, which is why "No authoritative
  finding rows" prints under a confirmed case. That is the finding-synthesis gap (§3 track C,
  built and dark), not a decorative review UI.
- **"12,788 artifacts, 128 at ≥70 — 1.0%."** 12,788 is the ALL-TIME artifact count; 1,231 of
  those are ≥70 (9.6%). Over the last 12 days' threads it is 7.8%. The 3-day figure (4.8%) and
  the lildee808 figure (0 of 79) are right. The direction holds; the headline number does not.
- **"~15 tokens/s"** in the first audit vs **"45–55 tok/s"** in the second. Measured: ~77.

### On the recommendations

| Lovable proposal | Verdict |
|---|---|
| cap narration ~600 tokens/step | **No, not globally** — the 4k-token steps are the closing reports. Replace the dossier with a delta (A2) and render the report in code. A per-step cap outside finalize is worth testing later, but it sits in the termination-oscillation area (CLAUDE.md) and is not a first move |
| cap per-cycle context at 80k chars | context is not the latency lever (corr 0.003). Server-owned history (A4) and #604's ceiling already address size; an 80k cap would drop selectors the run needs |
| tools persist their own artifacts and return a receipt | **Yes** — this is the auto-persist path already in production (21 of 79 rows on the case carried `auto_persist_source`); extend it so `record_artifacts` takes ids, not retyped JSON. Rides with A2 |
| build the report in code | **Yes** — the Report tab already does; A2's `report` mode makes it the only path |
| confidence computed from corroboration | direction right; **integrity-critical, needs sign-off**, and beware: two breach aggregators agreeing are usually the same dump resold (system-prompt "mirrors of one leak") |
| verification stage: aggregator hits confirmed by a page read before the report | **Yes** — the best idea in either file, and consistent with the data (9/14 and 6/10 strong from page reads, 0 elsewhere). New track item C6 |
| background jobs instead of chat turns | §5 Option 2, unchanged: after cycles, not before |
| disable gemini-direct; gate 100%-failing tools; cap correlate; cache sweep | gemini: env change now. Dead tools: `checks.credentials` + dead-target memory (edge branch). Correlate: B8. Cache sweep: **not before the payload store** (handoff 09-20 §10) |
| wire the feedback read path | already wired for dismiss/wrong; for confirm the missing piece is a finding row — synthesis, dark |

### ⛔ The one thing that matters most: do not let Lovable implement any of this "here"

Both audits end with *"should I implement them here?"* "Here" is the mirror. A change the
Lovable agent makes on the mirror ships on the next deploy with **no canonical commit, no
`build-info.ts` change, and no way to see it from this repo** — that is the 2026-08-29
incident exactly (11 commits, 25 runtime files, caught by a hand-read diff). CLAUDE.md's hard
gate exists for this. The answer to Lovable is: **thank you, no — everything lands upstream
first.** The two safe uses of its offer are (1) a paste-ready brief, and (2) the deploy step
itself, as today.
