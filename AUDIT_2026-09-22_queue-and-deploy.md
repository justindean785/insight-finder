# Insight Finder — Queue & Deploy Audit

**2026-09-22** · read-only · every value re-measured against a primary source

> **The queue is not the problem. `main` is.** Seventeen open PRs, all green, none merging. The
> blocker is upstream of every one of them: the change already on `main` carries two unrepaired
> defects, and because every open branch was cut from it, it ships with whatever goes out next.

## ⛔ Verdict — do not deploy current `main` for #604

Both post-merge review findings are **real, unrepaired, and on by default**. No repair commit
exists; no open PR touches `orchestrator-budget.ts`. The review landed **6 minutes 16 seconds
after the squash merge** — the merge outran its own review.

Verified three ways: direct source reading, an independent audit agent, and an adversarial
verifier tasked with refuting it. The verifier *strengthened* the finding.

---

## A. Source of truth

| Surface | Verified state | SHA / build |
|---|---|---|
| GitHub `main` | tip | **`74e98ad`** (#604) |
| Live `osint-agent` | **5 merges behind** | **`4bb19d9`** (2026-09-14) |
| `deploy/live` ref | consistent | `4bb19d9` |
| Vercel production | **current**, #602/#603/#606 live | `74e98ad` |
| Mirror | clean sync, no Lovable drift | `898a3a3` |

| Production fact | State | Evidence |
|---|---|---|
| `checks.prompt_budget_ceiling` on live `/health` | **absent** | #604 undeployed; key exists at `health-handler.ts:359` |
| Canonical ↔ mirror divergence | exactly **5** files | `env` · `health-handler` · `index` · `orchestrator-budget` · its test |
| `artifact_tool_lineage` table | **absent** | `information_schema.tables` |
| `tool_usage_log.call_id` / `run_id` | **absent** (0 of 2) | `information_schema.columns` |
| `artifacts_synthesis_cluster_uniq` | **not applied** | `to_regclass` → null |
| `pg_cron` | **not installed** | `pg_extension` → 0 rows |

**The migration ledger is evidence of nothing.** 24 committed migrations have no ledger row (most
applied anyway), and 15 ledger rows have no file in git. Object existence — `to_regclass`,
`information_schema`, `pg_index` — is the only acceptable proof that a schema change is applied.

---

## B. The #604 deploy gate

### Is current `main` safe to deploy for #604? **NO.**

#### Finding A — prompt compaction destroys unconsumed evidence · CONFIRMED

Pass 2's loop is `for (let i = cutoff; i < out.length; i++)` — bounded by `out.length`, with no
tail guard, and the budget check breaks per *message* rather than per *part*. In `prepareStep` the
final element is the just-completed `role:"tool"` message the model has not yet read.

The replacement is a bare string promising *"full result persisted in the artifact store, retrieve
via `memory_recall`"*. But `memory_recall` reads only `agent_memory`, and
`grep tool_call_cache tool-registry.ts` returns **zero hits** — no tool in the registry can
retrieve a raw tool result. The reference carries a tool name and a byte count. No id, no key, no
recovery.

The production trigger is subtler than a large fan-out: `elideMessageParts` transforms only
`tool-result` and `text` parts, so assistant **tool-call inputs are a non-elidable floor** that
nothing trims. Driving the real unmodified module with production-shaped parameters — 130 calls,
2,000-char inputs, a two-way fan-out of fresh results — destroyed **2 of 2** fresh results and
still ended at **343,307** chars against a 220,000 budget. Evidence lost *and* the ceiling unmet.

> `orchestrator-budget.ts:434` · `:301` · `elideMessageParts :346-366` · `env.ts:110` (default ON)

#### Finding B — the ceiling measures an array that is never sent · CONFIRMED

At both call sites the ceiling is measured *before* sanitization, and sanitization **adds
messages**: pass 3 pushes a whole new `{role:"tool"}` message for every unpaired assistant
tool-call (measured 123 → 292 chars for one orphan). What is actually handed to the model is
`stepMessagesOut`, not the array that was measured.

So `prompt_budget_ceiling_unmet` describes something that was never put on the wire — another
instrument reporting other than what it observed.

> `index.ts:314 → :326` · `index.ts:964 → :965` · sent at `:1088` / `:1126` / `:1148` ·
> `message-sanitize.ts:250-252`

#### The eight gate questions

| Question | Answer |
|---|---|
| Were the findings confirmed? | **Yes, both.** |
| Were they repaired? | **No.** |
| Which commit repaired them? | **None exists.** No open PR touches `orchestrator-budget.ts`. |
| Is the repair on `main`? | The *defects* are on main, verbatim. |
| Regression tests present? | For the *feature*, yes — with a real negative control. For either finding, **none**. |
| Do negative controls catch the old behaviour? | Two tests read as if they cover Finding A. Instrumented: **pass 2 never executes in either**. Neither would change result if a tail guard were added or removed. |
| Review threads resolved? | **No** — one P1, one P2, neither outdated (anchored lines byte-identical on main). |
| Does main preserve both invariants? | **Neither.** |

#### Three ways forward

- **A — Fix first.** Two small edge PRs, sequenced against #608 which rewrites the same sanitizer
  pass. Ship each with a test that fails on today's `main` — the discrimination the current suite
  lacks.
- **B — Flag-off deploy.** Set `PROMPT_BUDGET_HARD_CEILING_DISABLED=true` in Supabase settings
  *before* deploying; read at call time, so pass 2 never runs. Honest and reversible — but it buys
  the `/health` key and no behaviour change, Finding B still misreports, and the probe reads
  `ok:false`.
- **C — Revert #604.** Only if the edge queue will not clear soon.

---

## C. Edge deployment order

There are **no true code dependencies** among the four edge changes, and all six orderings merge
clean. #611 does not depend on #604 — proven by a clean cherry-pick onto the live build. **#604 is
step 1 by construction, not by dependency**: every open branch was cut from its merge commit, so
their trees physically contain it. You cannot sync any of them without carrying #604.

| Step | Change | Proof of deploy |
|---|---|---|
| — | `4bb19d9` — live now | baseline |
| **0** | **Prerequisites** — resolve #604 (§B) · rule on the #502-vs-#608 duplicate pairing fix · backport mirror PR #41 rather than merging it on the mirror | blocking |
| 1 | **#604** — prompt budget ceiling. Already merged; stamp, sync 6 files, hard gate, deploy | `checks.prompt_budget_ceiling` ✅ **real key** |
| 2 | **#607** — dead-target memory. Held: selector keys diverge; would not have refused a single call in the incident that motivated it | `checks.dead_target_memory` ✅ **real key** |
| 3 | **#608** — positional tool pairing. Correct fix, wrong story; repro doesn't throw under the real SDK rule; #502 patches the same file under an incompatible rule | ❌ **none usable** |
| 4 | **#611** — `budget_exhausted` reachability. Premise refuted: would relabel **zero** of 134 recorded invocations | ❌ **none** — baseline 0 such rows ever |

> **⚠️ The hard gate can hand you a false green.** A checkout whose `HEAD` has drifted below
> `origin/main` reports `diff -rq` **empty** for every function directory. Comparing
> `origin/main`'s blobs against the mirror gives the true answer: exactly five files differ. Run
> `verify:deploy` from a tree actually at `origin/main`, and re-run it immediately before the
> Lovable message, not once at session start.

> **⚠️ Two of four steps cannot be proven deployed.** #608's log event fires only on the rare shape
> it repairs; its proposed durable negative is vacuous (two such rows exist, ever). #611's only
> signal has a baseline of zero rows in production history. Both violate the one-new-key-per-build
> rule — that is a finding, not a detail.

---

## D. Frontend order

Frontend PRs go live the moment they merge and run in parallel with the entire edge lane. The
ordering that matters is **#579 before #610** — they share a function contract #610's description
does not mention.

**#610 does not fix the defect it names.** Measured over **1,591** production `ok:false` tool
parts: `main` labels all 1,591 "failed"; **#610 still labels 1,162 (73%)**, and **620** of those
are non-faults by the project's own canonical classifier. The two tools named in its own title
still read FAILED — one puts its 403/429 in `output.status`, the other puts an object in
`output.error` which #610 stringifies to `"[object Object]"`. With #579's rewrite underneath, the
wrongly-failed residual drops **620 → 80**.

**#609 is sound code with an overstated description.** It gates exactly one of three producers of
`parent:` merge keys — the one derived from `queried_selector`. The
`meta.parent ?? meta.parent_seed ?? meta.seed` chain is untouched and not even shape-gated. The
observed C001 cluster merge was reproduced *unchanged* on #609's head. Measured live effect of the
gate: **zero** — all 319 rows already name their selector. Nothing here says the C001 merge is
false; a shared parent phone can be legitimate corroboration. The established fact is only that
#609 does not change it.

**#612 is clean code with a payoff that does not exist.** Genuinely frontend-only, telemetry-only,
privacy-clean — and it measures the *real* serialized body rather than a reconstruction. But its
output reaches only a `console.info` nothing collects, plus an error-conditional breadcrumb into a
table with nothing written since 2026-09-14 — on a phone, where a console line is unreadable.

**Do not lose #593.** Artifact dedupe donating authority between rows is the highest-value item in
the older queue. The defect is verified live, it trial-merges clean, and #606 did not subsume it.
Evidence-integrity work with no human review — the single item most at risk of being swept away
with the stale PRs.

---

## E. #613 — merge ≠ apply ≠ verify

The schema design is sound: a genuine junction table, unique on the pair, no arrays, no jsonb,
four joins indexed, RLS enabled. The anti-vacuous guard is real and fires — a database built with
the migration deliberately skipped aborts before any denial assertion runs. The problem is the
word *proven*.

**The RLS proof encodes a privilege model production does not have.** An agent rebuilt Postgres,
applied the shim plus all 51 migrations in CI's exact order, and ran the PR's own assertion script
unmodified — it passed, reproducing CI. Rebuilding with one line added, mirroring production's
*measured* default ACL, made **the PR's own script fail**: an unauthenticated caller could read
lineage. In CI, anon is stopped at the GRANT layer before RLS is ever consulted. Worse: widening
the policy from `FOR SELECT` to `FOR ALL` — the obvious future change — **passes CI green**.

`selector_type` is unconstrained text bounded only at 64 characters. A real email and a
three-selector PII string were both *inserted successfully* — so the privacy boundary the PR calls
load-bearing rests on an unwritten writer's convention, in the one table designed to be read
across cases.

Three fixes belong in the PR before it moves: mirror the table default ACL into the CI shim and
assert zero *rows*; add the project's own RESTRICTIVE deny policies (production runs them on five
tables including the one #613 extends, and they appear in **zero** repo migrations); constrain
`selector_type` structurally while the table is still empty. Then verify against production by
object existence, never the ledger.

---

## F. The queue

Two populations. The seven new PRs are all branched from current `main`, CI-green after the merge
that moved it, no reviews, no threads — their green *is* evidence. The ten older ones are 16–135
commits behind and **every one of their greens predates that jump**.

| PR | Lane | Depends on | Recommended action |
|---|---|---|---|
| **604** | edge · merged | — | **Do not deploy** — §B |
| 613 | schema | — | Fix RLS shim + `selector_type` before apply |
| 612 | frontend | none | Merge once the measurement has a durable home |
| 611 | edge | none *(proven)* | Merge; deploy last |
| 610 | frontend | **#579** | Rework on top of #579 |
| 609 | frontend | none | Merge after correcting the body |
| 608 | edge | #502 ruling | Hold — reproduction is circular |
| 607 | edge | #604 deploy | Hold — key mismatch, near-zero measured value |
| 593 | frontend | — | **Still required** — owner sign-off |
| 579 | frontend | — | **Prerequisite for #610**; re-run tests first |
| 574 | tooling | — | Still required — cheapest correct merge |
| 516 | schema + fe | — | Supersedes #502's deletion work |
| 502 | mixed | — | Retire into small PRs — conflicts on 7 files |
| 586 | docs | — | Governance decision, not a roadmap |
| 564 | docs | — | **Acute** — see below |
| 570 | docs | — | Salvage one hunk; discard the baselines |
| 567 | docs | — | Stale claims; adds new files only |
| 541 | docs | — | Stale; its open question is answered |

> **⚠️ #564 is the one to watch.** It is **not a draft**, and its `CLAUDE.md` hunk would replace the
> dated state with a 2026-09-08 state plus a standing *"Do not deploy current main"* instruction —
> three deploys stale. Its merge conflict is the only thing currently preventing that.
> Separately, **#586 is not inert**: it installs a third-party agent contract into `CLAUDE.md`,
> `AGENTS.md` and `.cursorrules`, and auto-merges cleanly because it appends at end of file.

Five unresolved review threads exist across four PRs. In every case the last comment is the bot's,
never the author's — nobody has replied to any of them. There is no Claude Approvals check on this
repository, and the e2e job is skipped on all fifteen PRs where it exists, so **no PR in this queue
carries e2e evidence**.

---

## G. Instruments that were lying

### The 1-in-1000 chain-of-custody reading is not a measurement

The numerator is structurally pinned at **1**. Every one of the eight `append_evidence` call sites
hardcodes `_artifact_id: null`, so `evidence_log.artifact_id` is NULL in **11,540 of 11,540** rows
— and the UI builds the numerator as a `Set` of that column, which collapses to the single null
element. It will read 1 for any account with at least one evidence row, forever.

The denominator is an unfiltered row count of the newest artifacts page, quarantined and
analyst-rejected rows included, with no intersection against the numerator set. Its exact value of
1000 is **UNVERIFIED** — the code asks for 5,000, consistent with a gateway row clamp this codebase
already documents as unreadable from SQL.

True coverage by the only available surrogate join: **9,753 / 12,859 = 75.8%**. Custody records
exist for three quarters of artifacts and the interface is structurally unable to see them. The
product is under-reporting its own evidence integrity by roughly 76 points.

### Numbers to correct in the project record

| Figure | Documented | Measured today |
|---|---|---|
| `metadata.tool` lineage proxy | 38% | **34.0%** (4,373 / 12,859) |
| Same-thread invocation overlap | 12.2% | **18.7%** (25 of 134) |
| `tool_usage_log` | 15,136 | **16,068 rows** |
| `tool_call_cache` | 47 MB / 12,701 / 129 unexpired | **48 MB / 12,780 / 43 unexpired** |
| `agent_memory` lessons | 517 | **545 · 0 tool-keyed** (539 distinct subjects) |

Also corrected: the `bfa55610` failure names **two distinct** tool-call ids sharing an 8-char
prefix, not one repeated id — the duplicate-id story behind #608 is unevidenced in the durable
store. And `github_code_search` has **recovered**; the project file's claim that JD's token fix
"did NOT take" is now out of date.

### A leak that outranks #607

The path that genuinely writes raw provider bodies to durable storage is untouched by #607: a
300-character body slice is spliced into the tool result, lifted into
`tool_usage_log.error_msg`, and rendered into the analyst's copy-to-ticket diagnostic — whose own
header **explicitly forbids including investigation targets**. Live rows hold investigated domains
verbatim. Cheaper to fix than anything in the queue, and higher priority.

---

## H. Decisions that are genuinely yours

Everything else in this audit was answerable from source or production, and is answered.

1. **The #604 path** — fix first, flag-off and deploy, or revert. Each is defensible; they trade
   differently between queue velocity and shipping a feature switched off.
2. **#593** — evidence-integrity merge that changes a user-visible artifact count. Needs sign-off,
   not a silent merge.
3. **#502 vs #608** — two incompatible tool-pairing rules in the same file. They do not conflict
   textually, so both could land together silently. Someone must rule.
4. **#586** — a third-party agent contract entering the project's own instruction files is
   governance, not a roadmap item.
5. **#613's three fixes** — whether the CI shim, the RESTRICTIVE policies and the `selector_type`
   constraint are required before apply, or accepted as-is.

---

*Read-only audit. Nothing created, merged, closed, pushed, deployed or applied; no database writes;
breach-reveal posture and auto-run adjudication untouched. Sixteen agents across twelve independent
audits and four adversarial verifications; every claim re-measured against git, the live `/health`
endpoint, the production database, or the rebuilt schema. Subject selectors from live
investigations have been omitted throughout — they carry no engineering meaning here.*
