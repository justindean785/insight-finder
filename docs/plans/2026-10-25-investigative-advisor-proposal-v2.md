# Investigative analyst and advisor workflow — proposal v2

Status: **proposal for JD's review. Nothing here is implemented, merged or deployed.** No score, threshold, weight,
cap, tier, provider/model pin, breach-reveal setting, run-lease behavior, secret or production row is changed by this
document or by anything it proposes before JD signs off the relevant decision (section 12).

Supersedes nothing by itself. It builds on Codex's v1 (`2026-10-25-investigative-advisor-proposal.md`, left untouched on
its own branch) and on `2026-10-20-agentic-upgrade-plan.md`. Section 10 says exactly which parts of each it keeps, defers
or replaces.

Evidence labels used throughout: **[code]** read in the tree at `750e885` (canonical `main`) or on the named PR head;
**[doc]** stated in a repo document, not re-verified; **[inferred]** my reading, not demonstrated; **[unverified]**
needs a live or runtime check this task did not make. Section 13 lists what was not checked.

---

## 1. Recommendation in one page

JD's seven asks point at one product shape: *open a case, approve scope and limits once, press one button, get a bounded
batch of passive pivots whose results are normalized, scored, explained and ready for the next batch.* The code supports
JD's suggested order, with three adjustments:

1. **The first increment is mostly written already.** Three open drafts (#882 shared case queue, #873 explained ranking,
   #874 preview-before-run) cover the "one authoritative case-scoped queue" and most of "show why". The work left in
   Phase 1 is merge sequencing (JD's call) and four small gaps (section 4), not a new build.
2. **Consistency before automation.** The promise "same explanation in chat, Workbench, graph, report and export" is
   currently false in one measured place: the evidence-matrix Markdown export prints the raw stored confidence (80) where
   every on-screen surface prints the capped value (50) **[code: `intel.ts` `buildEvidenceMatrixMarkdown`; found while
   repairing #883]**. Automating more pivots multiplies rows that are shown inconsistently. Parity is therefore Phase 2,
   and it is frontend-only.
3. **Corrections come before batches, and the existing "Wrong" button already over-reaches.** One click on "Wrong"
   writes a user-level memory lesson at confidence 95 that says "Do NOT re-propose this artifact in future
   investigations for the same user" **[code: `analyst-decisions.ts` `buildFalsePositiveLesson`; `review.ts` calls
   `save_agent_memories`]**. That is exactly the "global rule from one weak result" JD ruled out. Batches that run
   unattended must not be built on top of it. Phase 3 makes the scope of a correction explicit (case vs user) and
   defaults to case.

Smallest useful first increment (new work): **Phase 2a — assessment parity**, one frontend PR, no schema, no edge, no
scoring change. Everything after it needs a sign-off in section 12 before code.

Not recommended now: a new scoring engine, a `case_scores` snapshot table, a separate `pivot_queue` table, a second
learning store, or any model-driven tool disabling. Each would duplicate something that exists (section 3).

---

## 2. Trust constraints this design must keep (checked against the code)

| Constraint (JD) | Where it is enforced today | What this proposal does about it |
|---|---|---|
| Evidence authority, quarantine, collision, provenance, caps, chain of custody stay | `display-confidence.ts`, `authority.ts`, `quarantine.ts`, `report-hygiene.ts` `isClusterIneligible`, edge `cache.ts` dispatch guard, `analyst_feedback_events` hash chain **[code]** | No change. Every phase adds read-only projections or additive records; none edits these modules. |
| Do not change thresholds, weights, confirmation semantics, pins, breach reveal, production data, secrets, run lease | CLAUDE.md "SETTLED" and the `RUN_LEASE_DISABLED` note **[doc]** | Out of scope by construction. Phase 4 needs its own fencing and says so (section 7.2); it does not touch the lease. |
| Scores are triage aids, not probabilities | #883 popover now says "Machine assessment · uncalibrated. This score is not a probability of identity." **[code, #883]**; `calibration.ts` reports sample sizes **[doc]** | Phase 2 extends that wording to export/report/graph. |
| Independent sources means independent evidence | `independentSourceClasses` (`intel.ts`) is correct; `tokenizeSourceChain` and the breach row count overstate **[doc: AUDIT 2026-10-24 Finding 4]** | Phase 2 wires surfaces to the honest metrics. The three metrics stay distinct; none is collapsed into another. |
| A username, shared password, common name, image or one matching field never establishes identity | `CO_RECORD_FIELDS` in `intel.ts` deliberately omits every password, IP, address, DOB and name field and says they "must stay absent" **[code]** | Added as an explicit test (section 9): adding any such key to the link map fails CI. |
| Credential material is sensitive evidence only; never a link key; not in prompts or reports unnecessarily | `SECRET_VALUE_RE` keeps secret-bearing values out of pivot chips (`pivot-engine.ts`); `SECRET_KEY_RE` in `report-export-gate.ts` **[code]** | The advisor input projection (Phase 5) is an allow-list that excludes credential fields by default. Password-reuse may yield a *bounded lead* labelled "shared credential — not an identity claim", never a link. |
| Passive collection only | `analyzeWeakLead` blocks auto-pivot on weak leads **[code]**. I did not verify any passive/active classification of the tool catalog. | The Phase 4 tool allow-list is an explicit whitelist that JD approves (decision 5). Anything that contacts a subject or logs in is excluded from batches. |
| Unknown/blocked/malformed is not "absent" | `tool-outcome.ts` distinguishes empty vs failed vs skipped; `useThreadToolHealth` re-derives timeout, rate-limit, `http_denied`, `blocked`, `config_error` **[code]** | Phase 1 and 4 display `unknown` for any selector whose attempts were only blocked/failed/skipped; "no result" is shown only for a real `empty`. Acceptance test in section 9. |
| Machine actions and human decisions distinct, attributable, timestamped, reversible | Review state is separate from machine score; `ATTESTED` rung vs `CONFIRMED` in `labelForArtifact`; `retract` event on reset **[code]** | Phase 3 adds actor kind, reason code and reversal reference to the event record (section 7.3). |
| No hidden paid calls; scope, tools, limits, progress, cancel, durable record visible per run | `runtimeLimits` caps per run; spend shown in the run cockpit **[code]** | Phase 4 makes the approved scope a stored, versioned record shown before and during the batch. |

---

## 3. What exists, what is partial, what is missing

### 3.1 Against JD's seven asks

| # | Ask | Exists **[code unless noted]** | Partial / wrong | Missing |
|---|---|---|---|---|
| 1 | Case-scoped ranked pivot queue | `pivot-engine.ts` `computePivots` (one ranker, pure); `next-step-queue.ts`; Workbench "Next" and PivotsTab | Chat and Workbench can disagree (3 vs 2) until #882; ranking reasons not shown on main (#873) | Observed cost/latency/yield per pivot; bounded-batch concept |
| 2 | Adapt tool choice per case | Edge `scoreExpectedValue` uses per-tool `tool_health` (30-day, global, needs 20 samples) and weak-lead/collision/duplicate penalties; `shouldAllowToolCall` suppresses duplicate and no-yield query families; `useThreadToolHealth` shows per-case outcomes | `tool_health` is global per `tool_name`, not per selector kind or per case | **Any per-case switch/exclude.** The only `disabled_tools` I found is an output of `list_tools`, not a setting. No UI to say "don't use tool X on this case". |
| 3 | Automatic normalization, dedup, provenance, scoring, correlation, one explanation | Edge `finding-row.ts`/`computeAxes`, `applyRecordingSourcePolicy`, `cluster.ts`, synthesis (off behind flags **[doc]**); #883 popover now explains the recorded computation | Matrix Markdown export prints raw 80 vs canonical 50; legacy rows lack `source_category` so "Authority: Verified (≥2 independent classes)" can sit beside "Source classes: Not recorded"; "Analyst confirmed" badge also fires for Key | One projection shared by chat, Workbench, graph, report and export; a parity test across them |
| 4 | Easier-to-understand case | Overview "Needs a decision" queue (`decision-queue.ts`, 5 slots, conflicts first, dataset-stranger rows counted not listed); run cockpit; `AuthorityView` with `underlying`/`basis`; `detectContradictions` | No single "unresolved questions / strongest relationships / likely false positives" summary; "same selector appeared" vs "same person established" wording is not enforced everywhere | Citation block (raw URL, access time, artifact → tool-call) per claim; lineage (#613 is an unapplied draft) |
| 5 | Learn from corrections | `artifact_reviews` (confirm/key/recheck/dismiss/wrong), propagation to pivots, dispatch, clustering, synthesis, report **[doc: ANALYST_DECISIONS_PROPAGATION]**; append-only hash-chained `analyst_feedback_events` with `retract` | Feedback append is best-effort and separate from the review write; `wrong` also writes a user-level memory at confidence 95; reason is free text | Reason codes (namesake, wrong person, duplicate, bad extraction, unrelated account, insufficient evidence); relationship/entity corrections (the `merge`/`split`/`corrected_entity`/`reject_pivot`/`manual_tool_selection` actions are reserved in the enum and, per the milestone doc, had no UI **[doc; not re-checked]**) |
| 6 | Fewer routine clicks, honest labels | Machine score never moved by a review; slot reads "Analyst-confirmed" only for the ATTESTED rung **[code]** | Authority state `verified` merges "corroborated by 2+ classes" and "analyst-confirmed" under one label (hint text, `authority.ts`) | An exception-first review mode with explicit "machine-assessed" vs "analyst-attested" tags and a bulk "accept machine assessment" that records a *machine* decision, never a human one |
| 7 | Optional second-model advisor | Primary/fallback orchestration (GLM-5.2 primary, Anthropic backup) **[doc: CLAUDE.md]** | None | Everything: allow-listed input, budget, untrusted-output channel, disagreement display, evaluation harness |

### 3.2 Ranking-factor inventory (JD's eight factors)

Two independent rankers exist and share no inputs. The browser ranks the *queue the analyst sees*; the edge ranks *calls
inside a run*.

| Factor | Browser queue (`pivot-engine.ts`) | Edge run (`runtime-policy.ts` `scoreExpectedValue`) | Gap |
|---|---|---|---|
| Expected value | No explicit EV. Score = `NEW 1000` + `Key 500` + tier `300/200/100` + `0.6 × confidence` + `0.5 × TYPE_YIELD` + `40 × recency`; `TYPE_YIELD` is hand-set (email 80 … url 25) | Composite 0–100, advisory, "never blocks a call" | Two scalars, no shared definition; browser constants are not measured |
| Selector quality | Source artifact confidence; infra-domain and seed filtering; secret-looking values dropped | `analyzeWeakLead` (9 reasons) → `autoPivotBlocked`; `collisionPenalty` | Browser ignores weak-lead analysis |
| Prior yield | None on `main`. #873 adds "repeated, all successful, one tool" → −60 (priority only) | Query-family no-yield limit (3); `tool_health.ok_pct` prior once ≥20 samples | Yield (new evidence per call by selector kind) is not measurable: no artifact is linked to the call that produced it **[doc: #873 body, #613]** |
| Source coverage | None | `sourceIndependenceBonus`, `corroborationPotential` inputs exist | "Which source classes does this selector still lack?" is computed nowhere I found **[inferred]** |
| Cost | None (#873 shows "unknown") | `ToolCostTier`, `costPenalty`, paid-call budget | UI cannot show expected cost |
| Latency | None | p95 buckets (<1s, 1–5s, 5–15s, >15s), neutral below 20 samples | Not shown |
| Duplication risk | `searched` status via queried targets; recommendation de-dupe | `isDuplicateQuery`; family no-yield | Browser keys on selector; Codex v1 notes it is coarser than selector + action/tool family **[doc; not re-verified]** |
| Still useful | Status only (`new`/`searched`); auto-run stops a *cycle* when no new evidence appeared | Family no-yield suppression | No per-pivot diminishing-returns estimate |

**Consequence:** do not build a third ranker. Add one *read-only projection* that lists, per queue candidate, the factors
that already drive its rank (browser constants, #873's two terms) and the *observed* per-tool figures that already exist
(`ok_pct`, p95, sample size, shown with the sample size and "insufficient data" below 20). Ordering stays exactly as it is.
Any change to the ranking terms or weights would need its own sign-off and is not proposed here.

### 3.3 Existing automation that the batch design must not ignore

- **Auto-run** is a browser loop: after a run finishes it sends a continuation prompt up to `AUTO_RUN_MAX_CYCLES = 3`
  times, stopping on `disabled | run_failed | run_not_finished | max_cycles | no_new_evidence` **[code: `run-controls.ts`
  `decideAutoContinue`]**. The *model* chooses what to pivot on; no queue item is selected, so nothing in it is a
  "recommended pivot batch".
- **Bulk queue is deliberately disabled**: `BULK_QUEUE_UNAVAILABLE` (`pivot-schema.ts`) states there is no server-side run
  ID or idempotency contract **[code]**. This is the correct reason to postpone batch execution, and Phase 4's
  prerequisites come straight from it.
- **Per-run caps are global constants**, env-overridable: `MAX_TOTAL_CALLS=30`, `MAX_PAID_CALLS=12`,
  `MAX_CONCURRENT_CALLS=3`, `MAX_SAME_TOOL_CALLS=16` **[code: `runtimeLimits`]**. They are not per case and not
  per batch. "Review limits once" therefore needs a stored per-case policy, not a UI over these constants.
- **The exception-review surface exists**: Overview "Needs a decision" (5 slots, conflicts before quarantine, held-back
  dataset strangers counted) and the cockpit's `pendingDecisions` **[code]**. Exception-only review should extend it, not
  add a parallel inbox.

---

## 4. Phase 1 — one authoritative case queue (mostly written; gaps listed)

**Already drafted (not mine, not touched):** #882 (one `CasePivotQueueProvider`; Chat and Workbench read the same
validated list), #873 (read-only "why this rank", prior attempts from `tool_usage_log`, two priority-only terms),
#874 (every pivot opens its review before it can run; resolves AUDIT 2026-10-24 Finding 1). All three are open drafts.
#874 is stacked on #873. #882 and #873 both edit `ChatWindow.tsx` and `WorkbenchNext.tsx`, so a rebase between them is
likely **[inferred from the PR file lists; I did not attempt the merge]**.

**Decision for JD, not for me:** merge order and whether to merge at all. If merged, the order that minimizes rework is
#882 → #873 (rebase) → #874 (rebase).

**Gaps after those three land (each a separate small frontend PR):**

| Gap | Change | Not changed |
|---|---|---|
| G1-1 Cost/latency/reliability shown as "unknown" | Display per-tool `ok_pct`, p95, sample size from the existing `tool_health` view (read-only), with "insufficient data (n<20)" below the floor | Any ordering, any threshold |
| G1-2 Duplicate risk coarse | Show *which* tool+action already ran on the selector (from #873's attempts hook) rather than only "searched" | Dispatch guard |
| G1-3 Legacy sentence suggestions | Explicit selector/type repair form with preview (Codex v1); never auto-dispatch an extracted token | Validation rules |
| G1-4 Failed history/review fetch | Visible "queue unavailable" and disabled launch (Codex v1 gate) | — |

**Acceptance (measurable):** zero count/target mismatches between mounted chat and Workbench across: late Workbench
open, two consecutive completed runs, reconnect, rejected/skipped candidates, case switch, reload; at 390/891/1440 px.
No change to the order produced by `computePivots` on the existing fixture set (snapshot test on 10+ synthetic cases).

---

## 5. Phase 2 — assessment parity and honest labels (frontend only)

Goal: every surface renders the same number and the same reasons for the same case revision.

**2a — recorded-assessment parity (recommended first increment).**
- `buildEvidenceMatrixMarkdown` and any export/report path that prints `a.confidence` switch to
  `displayConfidence(a).effective`, and print "Machine assessment (uncalibrated)" in the legend. One PR, one behavior.
  #883 deliberately added no parity test for this, because it would have passed while the table still printed 80.
- A surface-parity test: build one synthetic case snapshot, render the number from the evidence row, popover, graph node,
  report and matrix export, assert they are equal.
- Replace the count in `CaseReport.tsx` that overstates (breach rows) and the `tokenizeSourceChain` use in the per-artifact
  path with the honest metrics, as AUDIT 2026-10-24 Finding 4 already recommends **[doc]**.

**2b — legacy-row wording (needs decision 2).** When `source_category` is absent the popover says "Not recorded", while
`authority.ts` can still say "Verified: corroborated by 2+ independent source classes" from a provider-string fallback.
Options: (i) leave it and label the fallback "estimated from provider names"; (ii) downgrade the authority wording for rows
without recorded classes. Option (ii) changes what a row is *called*, which is an evidence-ranking presentation change
and needs JD's sign-off. I recommend (i) first because it adds disclosure without lowering any state.

**2c — machine vs analyst tags.** Split the `verified` authority label's display into "Machine-corroborated" and
"Analyst-confirmed" using the data `AuthorityView` already carries (`underlying`, `basis`); fix the "Analyst confirmed"
badge that also fires for Key **[code, #883 found-not-fixed 3]**. No state, cap or label *ladder* change.

**Acceptance:** parity test green; matrix export prints the capped value; no fixture row's authority state changes
(snapshot of `authorityFor` over the fixture corpus is byte-identical); axe/keyboard checks unchanged.

---

## 6. Phase 3 — corrections with an audit trail (schema first)

Reuse what exists; add the minimum.

**Case-local correction already works for artifacts.** `artifact_reviews` is keyed by artifact (which belongs to one
case); `dismissed`/`wrong` already remove the row from the working set, pivots, dispatch, clustering, synthesis and report
**[doc: ANALYST_DECISIONS_PROPAGATION]**. So "apply immediately to the case's effective view" exists for artifacts. What is
missing is the *reason*, relationship/selector corrections, atomic audit, and an explicit scope.

**Proposed schema (one migration PR, applied and verified before any code PR):**

| Change | Detail |
|---|---|
| `analyst_feedback_events` + `reason_code` | CHECK in (`namesake`, `wrong_person`, `duplicate`, `bad_extraction`, `unrelated_account`, `insufficient_evidence`); nullable for legacy rows. Free-text `reason` stays. |
| `analyst_feedback_events` + `scope` | `'case'` (default) or `'user'`. A `'user'`-scope correction is the only thing that may feed cross-case memory. |
| `analyst_feedback_events` + `reverses_event_id` | Undo appends a reversal event pointing at the one it reverses; nothing is updated or deleted (the table already blocks UPDATE/DELETE/TRUNCATE **[doc]**). |
| `analyst_feedback_events` + `actor_kind` | `'human'` or `'machine'`; for `'human'` the server derives `analyst_id = auth.uid()` as today. |
| RPC `apply_artifact_review(...)` | One transaction: upsert `artifact_reviews`, append the event with a retry-safe key. Replaces today's `void recordAnalystFeedback(...)` best-effort pairing. Idempotent on the key. |

**Frontend/edge behavior (separate PRs):**
- Reason picker on Dismiss/Wrong (optional, one click, remembered per session); failed write rolls back visibly (this
  already exists for review writes; extend to the event).
- `buildFalsePositiveLesson` becomes opt-in "also remember across my investigations" instead of automatic; default is
  case-local. This changes the existing "Wrong (teach agent)" semantics, so it is **decision 3**.
- Correction propagates to: queue (already, via reviews), Workbench, graph, report, export, and the *next* batch (the
  batch snapshot re-checks reviews before every dispatch; section 7.2).
- **Global learning** (any rule that changes behavior for future cases) stays out of scope until Phase 6-style
  measurement exists: `calibration.ts` metrics over `v_analyst_feedback_clean` with sample sizes and intervals, a reviewable
  proposal, a kill switch and an undo. Milestone doc already lists the sequence **[doc]**; this proposal adds no shortcut.

**Acceptance:** correction + undo change every view and the next queue immediately and survive reload; duplicate request
appends one effective transition; cross-case and cross-tenant access fails (RLS test); original artifact hash unchanged;
a single `wrong` creates no user-scope rule unless the box is ticked.

---

## 7. Phase 4 — case tool policy and bounded passive batches

This is the only phase that touches the run path. It needs a written server contract and JD's approval before any code
(decision 4). It is *not* the browser auto-run loop.

### 7.1 Case tool policy (the "review once" step)

One versioned record per case, compare-and-swap on `version`:

```
case_tool_policy {
  case_id, version, set_by (server-derived), set_at,
  enabled_tools[], excluded_tools[] (+ reason per exclusion),
  limits { max_total_micro_usd, max_calls, max_paid_calls, deadline_seconds, max_cycles },
  scope { purpose, subject_class, restricted_classes[] }   -- ties to the 10-20 scope gate
}
```

Shown before a batch starts, shown while it runs, and frozen into the batch record. "Switch/exclude a tool" writes a new
policy version; nothing is disabled silently. A tool that is unavailable (credential missing, circuit open) is shown as
*configured but unavailable*, distinct from *excluded by you* and *unproductive on this case* (display only; never
auto-excluded).

### 7.2 Execution contract (what `BULK_QUEUE_UNAVAILABLE` says is missing)

```
run_batches { id, case_id, policy_version, candidate_snapshot[], limits, state, generation,
              idempotency_key (unique per user), reserved_micro_usd, spent_micro_usd, created_by }
run_batch_items { batch_id, seq, selector_key, tool_hint, call_id, state, outcome, artifact_ids[] }
states: proposed → approved → running ⇄ paused → completed | cancelled | stopped_budget | stopped_no_yield | failed
```

- **Fencing is the batch's own `generation` compare-and-swap.** It must not depend on, re-enable or change the run lease
  (`RUN_LEASE_DISABLED=true` stays). A controller that loses the compare-and-swap does nothing.
- **Serial first.** One item at a time; each item runs under the existing per-run admission (`runtimeLimits`, dispatch
  guards in `cache.ts`, quarantine taint) **plus** batch-wide totals (dollars including orchestrator model cost, calls,
  paid calls, wall-clock, retries). A tool with no defensible cost bound is excluded from a hard-budget batch.
- **Recheck before every dispatch:** current reviews/exclusions, policy version, remaining limits, cancel flag.
- **Cancellation:** a cancel request is acknowledged with a timestamp; no new call is admitted afterwards; an in-flight call
  is marked `uncertain` if it cannot be proven finished.
- **New discoveries prepare the next batch**; they never silently extend this one.
- **Termination safety:** each item is a normal bounded run that ends through the existing finalize path. The controller
  lives outside the finalize window and adds no work inside it (CLAUDE.md invariants I-1/I-2 and the termination
  oscillation note apply; no `toolChoice` or `stopWhen` change).
- **Lineage prerequisite:** `call_id → artifact_ids` must be exact. #613 (unapplied draft) is the candidate. Historical
  rows are labelled `unknown lineage`; nothing is back-filled by timestamp matching and called exact.

### 7.3 Two ways to execute an item (decision 4)

| | A. Reuse a scoped run per item (recommended) | B. Controller calls tools directly |
|---|---|---|
| How | Send the pivot's scoped prompt to the existing run endpoint | Dispatch the tool from a deterministic controller, then record through `record_artifacts` |
| Cost/latency | Includes model tokens and finalize (the 10-20 baseline: ~$0.20/run, 51.9% forced-finalize **[doc, dated 2026-10-20]**) | Much cheaper and faster for pure lookups |
| Safety reuse | Inherits cache.ts guards, quarantine taint, circuit breakers, kind aliasing for free | Must re-implement or wrap every guard; highest risk of a bypass |
| Normalization | Model-assisted, as today | Needs deterministic extractors per tool |
| Recommendation | Start here; measure per-item cost; consider B only for a short whitelist of cheap deterministic tools later | — |

### 7.4 UI

One "Run recommended pivots" button opens **the policy + batch preview** (selected candidates with reason codes, tools,
limits, estimated cost range or "unknown", exclusions). **Start** is the only dispatch (consistent with #874). Progress
shows per-item state and cost; Pause/Stop always visible; the batch record persists after closing the browser.

**Acceptance:** fault-injection suite — double click, two tabs, retry, crash mid-item, reconnect, cancel race — produces
no duplicate admitted run and no call admitted after cancel is acknowledged; limits enforced across the whole batch;
every call ends `succeeded | failed | empty | blocked | skipped | uncertain`, none left ambiguous; batch resumable after
browser close; edge deploy follows the `edge-deploy` recipe with one new `/health` proof key.

---

## 8. Phase 5 — optional advisor experiment (default off)

Compare, on identical sanitized held-out cases: **A** current deterministic pipeline with Phase 2 explanations,
**B** improved primary-model context/structured output, **C** a second reviewer. Evidence that C beats A/B is required
before any provider decision. Different vendor is not evidence of independent reasoning or independent sources.

- **Input:** a versioned allow-list projection (selector kinds, source classes, recorded caps, contradictions, counts) with
  a redaction manifest. Excluded by default: credential fields, raw breach rows, free-text bios, names of private
  individuals, minors-flagged rows.
- **Output:** an *untrusted critique* record (unsupported claims, missing alternatives, uncertainty). It cannot dispatch,
  promote, change a score, set a review state, release quarantine, or override a safeguard. Disagreement with the
  pipeline is shown as "advice pending your disposition"; the analyst's disposition is a separate, attributed event.
- **Budget:** one call after a completed batch, never per artifact, never inside finalize; Codex v1's suggested ceiling
  (10 s, 2,000 input / 500 output tokens) is a starting point for review; the dollar cap counts toward the batch total.
- **Gate:** blinded review of ≥50 diverse sanitized cases reporting unsupported-claim detection, false-challenge rate,
  reviewer time, cost and p95 latency versus A and B, with sample sizes and intervals; zero authority mutations and zero
  prohibited-data disclosures. A usefulness threshold is set by JD *before* the run.

---

## 9. Verification plan and measurable gates

**Fixtures:** synthetic only (no subject data, no real thread ids). Adversarial set: aliases/mirrors, shared
infrastructure, namesakes, active/released/rejected quarantine, a reused-credential case, negative vs blocked vs malformed
tool results, nested metadata, unknown lineage, out-of-order events, reversals, two tenants.

**Per-PR gates (existing):** `npm run typecheck`, `npm run lint` (0 errors), `npx vitest run`, `npm run build`,
`npm run test:e2e` by hand for any `src/` change; edge PRs add `npm run test:edge`; schema PRs add PostgreSQL migration
validation, RLS and transactional-concurrency tests. Same-base baselines at the time of writing: vitest 2894 passed / 1
skipped (242 files) per #882, 2907 on #883; e2e 95 passed / 13 skipped same-base (104 on #883). Re-measure before
blaming a diff.

**Named tests to add (each must fail before its change):**
1. Surface parity (Phase 2a): same revision → equal number across row, popover, graph, report, export.
2. Link-key guard: no password/IP/address/DOB/name field may appear in `CO_RECORD_FIELDS`; no credential value in any
   advisor/projection fixture.
3. 48 repeated records from one provider add no independent class.
4. Blocked/malformed/unavailable responses never render as "not found".
5. Quarantined and rejected-derived rows never enter subject claims or batch candidates.
6. One `wrong` click creates no user-scope memory by default.
7. Batch fault-injection suite (section 7.2).

**Product metrics to track against a recorded baseline** (definitions fixed before measuring): count-mismatch rate;
stale-queue duration after reconciliation; new eligible evidence per paid dollar; blocked/empty/error mix per tool;
manual review actions per case; corrections repeated within a case; false identity-link rate (analyst-labelled);
lineage coverage; forced-finalize and natural-stop rates must not regress from the 10-20 baseline **[doc]**.

---

## 10. Reconciliation with earlier plans

| Item | 2026-10-20 plan | Codex v1 | This proposal |
|---|---|---|---|
| Queue first | Phase 2 `pivot_queue` table + `propose_pivots` tool | Derived case queue (#882) | **Derived queue, no table.** The queue is a pure function of artifacts, reviews and attempts; a table would add a second copy that can drift. |
| Scoring | Phase 1 `scoreCase()` + `case_scores` snapshots | Read-only explanation projection first | **Parity first.** A snapshot table only if parity shows the browser projection cannot be made consistent; needs sign-off. |
| Autonomy L0/L1/L2 | Budgeted autonomy levels | Bounded batches | **Map levels onto `case_tool_policy.limits`** (L0 = no batch, L1 = approve each batch, L2 = approve policy once). Default L1. |
| Scope gate (subject class, restricted classes) | Decided 2026-10-20 | Keep | **Keep unchanged** and store it in the policy record. |
| Memory v2, correlation v2, command-center UI, evals | Phases 3–6 | Later | **Unchanged and out of this proposal.** Correction feedback (Phase 3 here) feeds the Phase 6 calibration work; it does not pre-empt it. |

---

## 11. Risk register

| Risk | Where | Mitigation |
|---|---|---|
| Automation amplifies a bad pivot or a wrong identity | Phase 4 | Corrections and case-local exclusion land first; re-check reviews before each dispatch; serial execution; batch stops on no-yield |
| Termination regression | Phase 4 | Controller outside finalize; per-item normal runs; no `toolChoice`/`stopWhen` change; baseline gate |
| Duplicate or runaway spend | Phase 4 | Idempotency key, generation fencing, batch-wide reserved vs spent, hard stop on any unbounded-cost tool |
| Presentation change read as score change | Phase 2 | Snapshot test proving `authorityFor` and stored/capped numbers are byte-identical over fixtures |
| One weak result becomes a global rule | Phase 3 | Default scope = case; user-scope opt-in; global rules only via measured, reviewable, undoable process |
| Credential material leaks into prompts, reports, advisor input | Phases 2, 5 | Allow-list projections; tests 2 above; existing export gate unchanged |
| Draft PR sprawl and conflicts (#882/#873/#874/#593/#613) | Phase 1 | JD sets merge order; small PRs; rebase after each merge |
| Schema and code mixed in one PR | Phases 3–4 | Schema PR applied and verified first (repo rule) |
| Selection bias in calibration labels | Phase 3/6 | Report sample sizes and intervals; Key is priority, not ground truth |
| Over-trusting the advisor | Phase 5 | Untrusted channel, no write authority, disagreement preserved, A/B/C comparison before any adoption |

---

## 12. Decisions that need JD's sign-off before implementation

| # | Decision | My recommendation | Blocks |
|---|---|---|---|
| 1 | Merge order and approval of #882 / #873 / #874 (and #881) | #882 → #873 → #874, each reviewed separately | Phase 1 gaps |
| 2 | Parity scope: approve printing capped values in exports; choose legacy-row wording option (i) or (ii); approve splitting "Verified" into machine vs analyst display | Approve parity; choose (i); approve the display split. No state/cap/tier/source-class/cluster change | Phase 2 |
| 3 | Correction contract: reason taxonomy; case-vs-user scope; making "also remember across investigations" opt-in (changes today's Wrong→memory behavior) | Approve taxonomy; default scope = case; opt-in memory | Phase 3 schema + UI |
| 4 | Execution contract: durable IDs and fencing (own `generation`, not the lease); run-per-item (A) vs direct dispatch (B); per-item cost accounting incl. model tokens | A first; serial; lineage via #613 before any batch | Phase 4 |
| 5 | Batch policy: which passive tools are allowed in batches; dollar/call/time ceilings; which exceptions need a human; confirm "passive" is not a scope exemption (victim/minor/private-individual rules still apply) | Start with a short whitelist of cheap, deterministic, no-contact tools; ceilings set by JD per case class | Phase 4 |
| 6 | Advisor pilot: whether A/B evidence justifies C; provider, data minimization, retention, caps, success threshold | No pilot until Phase 2 explanations exist to give A a fair baseline | Phase 5 |
| 7 | Whether the two open confidence-engine integrity items (G1 numeric-tier independence gate, G2 `meta.reviewed` laundering) are still open and wanted now | Re-check status first; both are sign-off items per CLAUDE.md | Any change to tiers or labels |

---

## 13. What this proposal did not verify

- No production database, live `/health`, deployed frontend SHA, or real per-tool yield was read. Whether migrations such
  as the analyst-feedback table are installed in production is unverified.
- #873, #874 and #882 were read from their PR bodies and file lists, not merged or rebased onto each other; conflicts
  between them are inferred.
- Whether `merge`/`split`/`corrected_entity`/`reject_pivot`/`manual_tool_selection` events were wired after the milestone
  document is unchecked.
- G1/G2 in `CONFIDENCE_ENGINE.md` are dated 2026-07-17/08-15 and were not re-run.
- The edge EV scorer's call sites and the inputs each passes were listed (`index.ts`, `tool-registry.ts`, `guard.ts`
  import `runtime-policy`) but not traced.
- Draft #883 (the popover repair) had its Frontend CI job still running at last check; its local gates were measured
  separately.
