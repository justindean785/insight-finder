# Backlog

## TASK-003: Add durable run identity and an options contract
**Priority:** P0 | **Tags:** runtime, data-model, api

Make a run—not a chat response—the durable unit of investigation. Add structured mode, memory, objective, report, and budget options.

**Depends on:** TASK-001

### Plan

- Add an `investigation_runs` schema with status, revision, policy/model versions, timing, cost, and terminal reason.
- Define typed API options for Quick, Standard, and Deep; memory mode; and report behavior.
- Propagate `run_id` and case revision through calls, messages, artifacts, checkpoints, and telemetry.
- Retain a compatibility path for existing threads.

### Done when

- Every new call and artifact is attributable to one run and case revision.
- Invalid or conflicting options fail before paid work begins.

---

## TASK-004: Add explicit memory recall modes
**Priority:** P0 | **Tags:** memory, runtime, ux

Make prior subject-memory recall optional without disabling analyst authority or aggregate strategy intelligence.

**Depends on:** TASK-003

### Plan

- Implement `fresh`, `relevant`, and `continue` semantics behind one initial “Use prior case memory” control.
- Replace model-driven `memory_recall` steps with a bounded server-side prefetch.
- Filter recalled records by user, scope, exact seed/case, confidence, supersession, and rejection.
- Record recall duration, rows, bytes, and context tokens in run telemetry.

### Done when

- A new scan can provably run with previous subject memory excluded.
- Strategy intelligence and current analyst rejection/quarantine remain enforced in every mode.

---

## TASK-005: Split scan lifecycle from report lifecycle
**Priority:** P0 | **Tags:** runtime, report, state-machine

Allow a scan to complete honestly without generating a dossier and prevent report failure from changing scan success.

**Depends on:** TASK-003

### Plan

- Define independent scan and report status machines and transition guards.
- Migrate UI completion/recovery logic to the scan contract.
- Preserve the established no-ghost and durable-report termination invariants.
- Add compatibility derivation for historical threads.

### Done when

- A completed scan with `report_status=not_requested` is not shown as interrupted.
- A failed dossier job leaves the completed scan and evidence accessible.

---

## TASK-007: Add explicit versioned dossier generation
**Priority:** P0 | **Tags:** report, jobs, performance

Generate a full dossier only when the user asks, once per case revision, outside the scan finalization window.

**Depends on:** TASK-005

### Plan

- Add idempotent report jobs keyed by case revision and template version.
- Add deterministic “Summarize now” checkpoints for the active snapshot.
- Cache completed report revisions and mark them stale when evidence changes.
- Add retry and failure states that do not mutate scan completion.

### Done when

- Ordinary pivots never resend or regenerate a full dossier.
- Re-finalizing an unchanged case returns the existing revision.

---

## TASK-008: Server-render authoritative report sections
**Priority:** P0 | **Tags:** report, evidence, integrity

Render findings, confidence, independence, custody, graph, and coverage sections from persisted evidence so model prose cannot overrule the ledger.

**Depends on:** TASK-002, TASK-007, TASK-009, TASK-011

### Plan

- Define safe report slots and deterministic table/appendix renderers.
- Expand markers after narrative generation and make expansion non-fatal.
- Bind print/export to a selected report revision and case snapshot.
- Add mismatch tests for confidence, source classes, quarantine, and analyst rejection.

### Done when

- A model cannot publish confidence or evidence status that differs from persisted truth.
- A narrative-provider outage still yields a usable deterministic report.

---

## TASK-009: Instrument call-to-artifact lineage
**Priority:** P0 | **Tags:** telemetry, evidence, learning

Create a normalized junction from tool calls to the observations and artifacts they produced.

**Depends on:** TASK-003, TASK-010

### Plan

- Add stable call IDs and an `artifact_tool_lineage` relation.
- Link zero, one, or many artifacts to each producing call without storing arrays.
- Backfill only where provenance is unambiguous; label unknown history honestly.
- Add lineage integrity and tenant-isolation tests.

### Done when

- Every new promoted or dismissed artifact traces to its producing calls.
- Calls with no artifacts remain distinguishable from broken persistence.

---

## TASK-018: Persist provider health and circuit state
**Priority:** P0 | **Tags:** runtime, providers, resilience

Carry measured provider/endpoint degradation across runs instead of relearning it in each edge isolate.

**Depends on:** TASK-003, TASK-010

### Plan

- Persist per-provider-family and endpoint-version breaker state with reason and expiry.
- Define thresholds for authentication, quota, rate-limit, timeout, 500, 502, and 504 classes.
- Add cooldown, half-open probes, version invalidation, manual reset, and a kill switch.
- Surface skip reasons in the run timeline and operational dashboard.

### Done when

- A known outage prevents repeated sibling calls according to policy across runs.
- Recovery is automatically and safely detected rather than requiring a deploy.

---

## TASK-019: Add durable cancel, resume, and overlap controls
**Priority:** P0 | **Tags:** runtime, resilience, ux

Replace one fragile long request with bounded resumable work and deterministic overlap handling.

**Depends on:** TASK-003, TASK-005

### Plan

- Add idempotency keys and a one-active-run guard per case.
- Persist cancellation requests and check them between bounded phases/calls.
- Checkpoint planner state, remaining budget, snapshot revision, and pending pivots.
- Resume only idempotent work and explain anything that must be rerun.

### Done when

- Double submit cannot start two paid investigations.
- A Deep run can be cancelled and safely resumed from a durable checkpoint.

---

## TASK-020: Move mutable globals into RequestContext
**Priority:** P0 | **Tags:** backend, concurrency, refactor

Close issue #63 by making request/run state explicit before raising concurrency or adding durable workers.

**Depends on:** TASK-024

### Plan

- Characterize every current module-level mutable value and its lifecycle.
- Introduce typed `RequestContext`/`RunContext` ownership.
- Move state incrementally with concurrency and isolation tests.
- Retain process-wide immutable configuration separately.

### Done when

- Concurrent runs cannot mutate each other’s budget, tool state, evidence, or completion state.
- No request-scoped mutable globals remain.

---

## TASK-021: Bound prompts with structured case snapshots
**Priority:** P0 | **Tags:** context, performance, ai

Stop replaying raw tool payloads and full assistant history. Build each model step from a compact revisioned snapshot.

**Depends on:** TASK-003, TASK-009, TASK-011

### Plan

- Define the minimum snapshot fields for seed, authority, findings, contradictions, open leads, and recent outcomes.
- Add byte/token budgets and truncation telemetry by section.
- Summarize or reference old evidence without losing lineage.
- Add replay tests proving no required decision input is omitted.

### Done when

- Standard-run p95 context meets the benchmark target without reducing validated yield.
- Context growth is bounded as the chat continues.

---

## TASK-023: Run a model replay bakeoff and add routing
**Priority:** P0 | **Tags:** models, benchmark, routing

Compare models only after the run contract and replay corpus can isolate model quality from tool and state variance.

**Depends on:** TASK-001, TASK-003, TASK-009, TASK-010

### Plan

- Benchmark the current GLM-5.2 route against one strong balanced orchestrator and one low-cost structured specialist.
- Measure schema validity, duplicates, accepted yield, validated false positives, unsupported report claims, completion, latency, tokens, and cost.
- Define promotion thresholds and a rollback path.
- Route classification/extraction, contradiction reasoning, and dossier narrative independently when results justify it.

### Done when

- Any model change has a reproducible benchmark win and no precision/completion regression.
- Provider names and versions are visible in run telemetry.

---

## TASK-027: Enforce privacy boundaries for aggregate learning
**Priority:** P0 | **Tags:** privacy, tenancy, learning

Define what strategy data may cross cases and users before building adaptive rollups.

**Depends on:** TASK-003, TASK-009

### Plan

- Separate raw case identifiers from de-identified selector/query/workflow features.
- Document user, tenant, retention, deletion, and minimum-cohort boundaries.
- Add RLS and deletion-propagation tests for lineage and rollups.
- Make cross-user aggregation opt-in or deployment-scoped according to product policy.

### Done when

- No raw subject identifier is stored in aggregate strategy keys.
- Account/case deletion has a tested effect on underlying events and derived aggregates.

---

## TASK-006: Replace transcript tool flood with one run card
**Priority:** P1 | **Tags:** chat, ux, streaming

Represent the active investigation as one updating, collapsed-by-default object instead of one card per pivot or tool cycle.

**Depends on:** TASK-003, TASK-005

### Plan

- Define a phase/event read model from the run rather than assistant parts.
- Render elapsed time, calls/budget, useful findings, review items, and warnings in the collapsed card.
- Add an expandable phase-grouped timeline; keep raw payloads in Tools.
- Coalesce streaming updates and virtualize long event lists.

### Done when

- A long run occupies one stable position in chat.
- Expanding it preserves full operational audit detail without rendering raw JSON in the conversation.

---

## TASK-011: Separate coverage observations from evidence
**Priority:** P1 | **Tags:** evidence, data-model, ux

Store checked-clear and checked-unavailable facts without turning them into subject artifacts or review work.

**Depends on:** TASK-009, TASK-010

### Plan

- Add a typed `coverage_observations` model and migration.
- Route no-record, unavailable, and partial coverage outcomes correctly.
- Update Evidence, report appendix, and counts to distinguish coverage from claims.
- Preserve audit access and source timestamps.

### Done when

- A zero-result breach check does not inflate artifact counts or appear as an exposure.
- Users can still prove what was checked and when.

---

## TASK-012: Fingerprint query templates and workflows
**Priority:** P1 | **Tags:** queries, workflows, learning

Create versioned, privacy-safe identifiers for dorks, Serus keyword forms, source endpoints, and workflow recipes.

**Depends on:** TASK-009, TASK-027

### Plan

- Canonicalize queries by replacing subject values with typed placeholders.
- Version templates, provider endpoints, and workflow recipes.
- Record planner decision reason and phase with each call.
- Add collision tests so materially different strategies cannot share a key.

### Done when

- Cross-case analytics can compare strategies without storing raw subjects in keys.
- Every new call identifies the exact template/workflow version that selected it.

---

## TASK-013: Build strategy rollups and a shadow scorer
**Priority:** P1 | **Tags:** learning, analytics, policy

Compute conservative source/query/workflow utility without changing live execution.

**Depends on:** TASK-009, TASK-010, TASK-011, TASK-012, TASK-027

### Plan

- Aggregate accepted yield, validated false positives, independent gain, duplicates, no-record, latency, cost, and completion contribution.
- Use minimum samples, Wilson bounds, freshness decay, and endpoint/workflow versioning.
- Produce an auditable “would choose / would suppress” decision for every eligible step.
- Compare shadow choices against replay and subsequent analyst verdicts.

### Done when

- The scorer never converts unlabeled, empty, or failed outcomes into false positives.
- Shadow recommendations beat the static baseline without affecting production calls.

---

## TASK-014: Redesign Intelligence around result quality
**Priority:** P1 | **Tags:** intelligence, ux, analytics

Replace raw `ok`-based source rankings and mixed free-text memories with measured Sources, Queries, Workflows, and Lessons views.

**Depends on:** TASK-013

### Plan

- Show accepted yield, validated precision, sample size, latency/cost, coverage, and trend by context.
- Separate case memory from strategy lessons and provider health.
- Display the evidence behind demotion/recommendation decisions and their expiry/version.
- Add filters for seed type, objective, mode, source, template, workflow, and time window.

### Done when

- “Reliable” cannot be inferred from raw HTTP success or intentional skips.
- A user can explain why a source or workflow is favored for a starting query.

---

## TASK-015: Add a high-value analyst review queue
**Priority:** P1 | **Tags:** review, ux, learning

Reduce manual triage by prioritizing decisions that most improve the case or the learner.

**Depends on:** TASK-011, TASK-013

### Plan

- Rank identity collisions, contradictions, pivot-unlocking claims, and high-uncertainty strategy labels.
- Add keyboard actions and one-at-a-time review flow.
- Keep bulk/raw observations available outside the primary queue.
- Measure time to verdict and effect on case/strategy uncertainty.

### Done when

- The default queue contains a small actionable set rather than every observation.
- Every verdict reaches lineage, authority, calibration, and strategy rollups.

---

## TASK-016: Add guarded contextual strategy quarantine
**Priority:** P1 | **Tags:** learning, policy, safety

Suppress repeatedly harmful strategies only within the context supported by validated evidence.

**Depends on:** TASK-013, TASK-015

### Plan

- Implement the 15-independent-scan validated-false-positive threshold and conservative confidence gate.
- Scope decisions by selector, endpoint/version, query template, objective, and workflow.
- Add `shadow`, `recommended`, `quarantined`, and `manual_override` states.
- Add recovery sampling, decay/version reset, audit reason, override, and kill switch.

### Done when

- A 15/15 harmful contextual strategy is skipped in normal plans with an inspectable reason.
- A provider update or recovery sample can safely restore eligibility.

---

## TASK-017: Learn dork and Serus strategy selection
**Priority:** P1 | **Tags:** dorks, serus, workflows, learning

Use measured query-template and workflow outcomes to choose alternatives that produce useful independent intelligence.

**Depends on:** TASK-012, TASK-013, TASK-016

### Plan

- Track returned URLs, relevant URLs, accepted artifacts, linkage survival, duplicates, latency, and cost per template context.
- Define alternative template families and workflow prerequisites.
- Reorder in recommendation mode, then enable guarded production selection.
- Explain every substitution in the policy log.

### Done when

- Repeated no-yield or false-positive templates are contextually demoted, not globally erased.
- Controlled cohorts reduce wasted queries without reducing validated findings.

---

## TASK-022: Replace transcript cache and sweep expired entries
**Priority:** P1 | **Tags:** cache, context, operations

Cache structured snapshots and artifact references instead of full assistant parts, then safely reclaim measured expired data.

**Depends on:** TASK-011, TASK-021

### Plan

- Replace new full-transcript cache writes with versioned snapshot entries.
- Add size limits, observability, and compatibility reads.
- Run the existing cleanup as a dry run with counts, size, backup/rollback, and sampled verification.
- Execute cleanup only after review of the dry-run evidence.

### Done when

- Cache growth is bounded and does not rehydrate megabytes of old assistant parts.
- Expired-row deletion is measured, reviewed, and recoverable.

---

## TASK-025: Modularize orchestration hotspots safely
**Priority:** P2 | **Tags:** refactor, maintainability, testing

Split large mixed-responsibility files after state and behavior contracts are pinned.

**Depends on:** TASK-003, TASK-006, TASK-009, TASK-020, TASK-024

### Plan

- Add characterization tests and dependency maps for ChatWindow, intel, cache, auto-persist, and the edge entrypoint.
- Extract one capability at a time: run lifecycle, policy, lineage, presentation, and reporting.
- Keep public interfaces narrow and prohibit new cross-module mutable state.
- Compare behavioral replay and bundle/runtime metrics after each extraction.

### Done when

- The major capabilities have explicit ownership and stable interfaces.
- Replay/e2e behavior remains unchanged except for separately approved product work.

---

## TASK-026: Add cross-case entity exploration and watchlists
**Priority:** P2 | **Tags:** differentiation, graph, monitoring

After the evidence and learning loop are trustworthy, add differentiated case-to-case discovery and durable change monitoring.

**Depends on:** TASK-014, TASK-016, TASK-019, TASK-027

### Plan

- Define analyst-authorized, linkage-eligible cross-case entity joins.
- Add saved objective templates and an entity explorer with evidence provenance.
- Implement watchlists as bounded durable scheduled jobs with change-only notifications.
- Reuse run, policy, lineage, privacy, and report revision contracts.

### Done when

- Cross-case links never bypass tenant, analyst-authority, or subject-linkage rules.
- Monitoring reports meaningful deltas rather than rerunning and replaying full dossiers.

---
