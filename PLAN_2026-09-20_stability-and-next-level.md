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

**The single biggest lever is the prompt size per step, not the tools.** Nearly two thirds
of the wall clock is the model re-reading ~60k tokens on every one of ~8 steps per run. The
tool schemas alone are ~95–105k chars and are re-serialised every step (CLAUDE.md).

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
