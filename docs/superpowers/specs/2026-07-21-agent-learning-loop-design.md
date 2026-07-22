# Agent Learning Loop — Design

**Date:** 2026-07-21 (rev. 2, same day)
**Status:** Design, awaiting review
**Scope:** `supabase/functions/osint-agent`, new `optimizer/` harness
**Origin:** Request to "wire DSPy/GEPA for real," redirected mid-design by verified
findings about `agent_memory` (§2.1) and tool efficacy (§2.4).

**Thesis:** the agent has no mechanism for learning from its own outcomes. It fails
to learn in three distinct ways — it cannot retrieve what it remembers (§2.1), it
cannot tell which of its tools are worth calling (§2.4), and **its record of what
happened is itself wrong** (§2.6). The third is new in rev. 2 and is upstream of
the other two: no learning loop can be built on telemetry that labels ~1,078
result-free calls as successes.

> **Revision note.** Rev. 1 asserted "23.6% of tool time wasted" and treated
> `tool_usage_log.outcome` as ground truth. An audit of tool negative paths (§2.6)
> found the outcome field systematically under-reports failure. The corrected
> figure is **35.7%**, and several rev. 1 design decisions — particularly the
> Phase 1 cassette corpus — were invalidated by it. §12 records every changed
> number. Rev. 2 also incorporates an external design review (§10) and a
> production audit performed via Lovable (§11).

---

## 1. Problem

The `osint-agent` orchestrator already implements four of the five stages of a
standard agent loop:

| Stage | Implementation | Status |
|---|---|---|
| Retriever | `tool-registry.ts`, `cache.ts`, `catalog.ts` | built |
| Planner | `planner-guidance.ts`, `orchestrator_select.ts` | built |
| Executor | `index.ts`, `circuit.ts`, `orchestrator-budget.ts` | built |
| Verifier | `validation.ts`, `attribution-check.ts`, `contradictions.ts`, `confidence.ts` | built |
| Reflector | — | **absent** |

`grep -iE "gepa|mipro|dspy|prompt-optimi|self-improv"` across the function returns
nothing. There is no mechanism by which the system improves from its own outcomes,
with one narrow exception: `runtime-policy.ts:78` consumes the `tool_health` view
to steer routing. That single edge proves the pattern works in this codebase.

Three consequences follow, and they are separate problems:

1. **Instructions are hand-tuned and unmeasured.** `system-prompt.ts` is edited by
   hand with no way to know whether an edit helped or hurt.
2. **The long-term memory subsystem is effectively write-only.** See §2.1.
3. **The outcome record is not trustworthy.** See §2.6. This one invalidates
   measurements of the other two, so it is fixed first.

---

## 2. Verified findings

All figures were queried against the production database
(project `4ce11bc3-039d-4439-b293-acacca9e1e3a`) on 2026-07-21, and all code
references were read directly. Nothing here is inferred from a PR body or summary.

### 2.1 Memory is 92.5% write-only

| kind | saved | ever read back | hit rate | lifetime hits |
|---|---|---|---|---|
| `pattern` | 294 | 15 | **5.1%** | 20 |
| `identity` | 225 | 28 | 12.4% | 33 |
| `lesson` | 183 | 11 | **6.0%** | 13 |
| `connection` | 136 | 9 | 6.6% | 11 |
| **total** | **838** | **63** | **7.5%** | **77** |

775 of 838 memories have never been retrieved once, across 351 `memory_save` and
414 `memory_recall` calls spanning 201 of 241 threads.

**The telemetry is trustworthy.** `hit_count` is bumped atomically via the
`bump_memory_hits` RPC at `tool-registry.ts:4857`, on every recall that returns
rows. A low hit rate therefore reflects real misses, not a broken counter. This
was checked specifically because an uninstrumented counter would have made the
whole finding a phantom.

**Corroborated from the call side (rev. 2).** `memory_recall` returns `count: 0`
on **83.9%** of its cached calls — every one logged `outcome='ok'`. Corrected true
empty rate: **82.5%** of 172 calls in 14 days. Two independent measurements — the
store side and the call side — agree.

Sampled payloads also show `_runtime.selector` is the **empty string** on
zero-result recalls. Whether recall is being invoked with no selector at all is an
open question for 3a; if so, part of the 82.5% is a caller bug, not a keying
problem, and the fix is cheaper than §2.2 implies.

### 2.2 Root cause: a category error in retrieval

`tool-registry.ts:4839` — the entire retrieval predicate:

```js
.or(`subject.eq.${subj},related_values.cs.{${subj}}`)
```

Exact string match on `subject`, or array containment in `related_values`. No
semantic search, no retrieval by situation or kind. `guard.ts:123` further caps
recall at 2 calls per 30-second window, with per-step subject de-duplication.

The store holds knowledge with incompatible access patterns (see §10.3 for the
three-way split adopted in rev. 2):

- **Episodic/entity** (`identity`, `connection`) — "this handle belongs to this
  person." Selector-keyed exact match is the *correct* design. 12.4% is close to
  the natural ceiling: only 368 of 7,233 distinct artifact values (5.1%) ever
  appear in more than one thread. This is not broken; investigations genuinely
  rarely overlap.
- **Semantic/procedural** (`pattern`, `lesson`) — "parked domains look like X,"
  "breach DB Y has stale phones." Generalizable knowledge that must be retrieved
  **by situation**. Storing it subject-keyed means retrieving a lesson requires
  already knowing the subject it was learned from, which defeats its purpose.

57% of all memory writes (477 of 838) land in the semantic bucket, where ~94% is
never read again. `system-prompt.ts:107` instructs the model that the store is
"YOUR long-term brain — feed it generously"; it has complied for two months at
200 micro-USD per save.

### 2.3 A replayable corpus exists — but it is biased by construction

`tool_call_cache` is a cassette store:

- 7,211 rows, 86 distinct tools, 151 distinct investigations
- Has both `input_json` and `output_json`, keyed by `input_hash` / `params_hash`
- **0 null outputs**
- 6,827 rows (95%) are past `expires_at` but **physically intact** — expiry is
  logical only
- **No purge risk:** no `DELETE` against the table anywhere in the codebase, and
  `pg_cron` is not installed (`cron.job` does not exist). It is append-only in
  practice.

> **⚠ Corpus bias — invalidates the rev. 1 Phase 1a design.** `cache.ts:1050`
> gates the cache write on `if (ok && isCacheableToolResult(result) && hash && key)`.
> **Only `ok`-classified results are ever cached.** A replay corpus drawn from this
> table therefore contains *no failures and no declared empties* — the agent under
> replay would experience a world in which every tool always works. Any prompt GEPA
> optimizes against it would be tuned for a reality that does not exist, and would
> specifically never learn to recover from a failing tool.
>
> This also means the corpus is **deduplicated**: `tool_call_cache` is written with
> `upsert` on the hash, so N identical calls collapse to one row. Cache row counts
> are not call counts.

Consequences, all of which change Phase 1:

- Cassettes must be reconstructed from a source that retains negatives. See §5,
  Phase 1a — this is now a **blocking design question**, not a coverage question.
- The same `ok &&` gate is what makes §2.6 measurable: because every cached row was
  classified `ok`, a cached row with a negative payload is *by construction* a
  misclassification, not a rate to be compared against something.

Other constraints:

- Cache begins 2026-06-25; threads begin 2026-05-26. The first month of threads
  (~90) has no coverage.
- 86 tools are cached against 106 tools seen in `tool_usage_log` — ~20 tools never
  cache, almost certainly the deliberate no-cache PII/breach paths.

### 2.4 A third of all tool time produces nothing

Over the 14 days to 2026-07-21, on **24,799,391 ms** of logged tool time:

| measure | value |
|---|---|
| declared waste (`outcome IN ('empty','failed')`) | 6,348,592 ms — **25.6%** |
| hidden waste (`ok`-labelled negatives, §2.6) | 2,499,769 ms — **10.1%** |
| **true share of tool time wasted** | **35.7%** |

> The rev. 1 figure of 23.6% was computed over a longer (all-time) window and used
> only the declared channel. On the *same* 14-day window the declared channel reads
> 25.6%, so **the correction contributes +10.1 points**, and the rest of the change
> is the window. Both statements measured the same quantity; only the second one
> counted the calls the log had mislabelled.

**This is likely a mechanism behind the 240s-deadline CPU-kill.** Tool efficacy and
the CPU-kill have been treated as separate problems; a third of the run budget
being spent on calls that return nothing suggests they are the same problem. §11
independently reports 4 of 5 recent runs failing to finalize, which is consistent.

Worst per-tool outcome profiles (≥20 calls, as of rev. 1):

| tool | calls | ok% | empty% | fail% | avg ms | status |
|---|---|---|---|---|---|---|
| `indicia_web_dbs` | 42 | 7 | 17 | 76 | 1,324 | **root-caused and fixed — PR #378 (§2.7)** |
| `hackernews_user` | 24 | 0 | 46 | 38 | 821 | trickling — 5 calls in 14d |
| `ipqualityscore_lookup` | 35 | 0 | 0 | 86 | 698 | already cut — last 2026-07-05 |
| `bosint_phone_lookup` | 53 | 6 | 0 | 81 | **29,047** | already cut — last 2026-06-30 |
| `synapsint_lookup` | 107 | 5 | 0 | 46 | 515 | already cut — last 2026-07-01 |
| `deepfind_ransomware_exposure` | 26 | 0 | 81 | 0 | 897 | already cut — last 2026-07-01 |
| `deepfind_profile_analyzer` | 42 | 2 | 62 | 0 | 733 | already cut — last 2026-07-01 |

**Recency was checked before assigning blame, and it changed the conclusion.** Most
of these were already cut — PR #243's tool removal worked. Reporting the already-cut
tools as live regressions would have been a stale claim.

### 2.5 Why yield cannot currently be learned

`tool_health` feeds `runtime-policy.ts:78` with `p95DurationMs`, `reliability`
(ok_pct), and `healthSampleSize`. That is **health** — did the call succeed. It is
not **yield** — did the call produce anything that mattered. A tool can be 100%
reliable and 100% useless. §2.6 shows several are.

Computing yield requires attributing artifacts to the tool that produced them, and
**that lineage does not exist**:

- `artifacts.source` is a URL/descriptor: 1,840 distinct values against 106 tools.
- `artifacts.metadata->>'discovered_via'` exists on only 1,255 of 8,998 artifacts
  (14%) and is LLM free-text prose — e.g. `"google_dork → perplexity sonar (exa
  keyword fallback)"`. Only a handful match a tool name exactly. It also leaks PII
  into metadata (observed: subject names and emails embedded in the string).
- `tool_usage_log.outcome` is **not reliable** — see §2.6.

### 2.6 ⚠ The outcome field systematically under-reports failure

**This is the finding that gates everything else in this document.**

Because the cache write gate is `ok &&` (§2.3), every row in `tool_call_cache` was
classified a success. Cross-referencing cached payloads against their logged outcome
therefore yields a direct count of misclassifications — not an estimated rate.

Over 14 days. `neg%` = negative-payload rate among `ok`-classified calls;
`est. mis` = `ok × neg%` (the cache is deduplicated, so the rate transfers, not the
count).

| tool | calls | ok | empty | empty% | cached | cached neg | neg% | est. mis | **true empty%** |
|---|---|---|---|---|---|---|---|---|---|
| `socialfetch_web_read` | 582 | 540 | 0 | 0.0 | 471 | 300 | 63.7 | 344 | **59.1** |
| `memory_recall` | 172 | 169 | 0 | 0.0 | 143 | 120 | 83.9 | 142 | **82.5** |
| `jina_reader_scrape` | 979 | 552 | 0 | 0.0 | 466 | 115 | 24.7 | 136 | **13.9** |
| `socialfetch_lookup` | 436 | 321 | 0 | 0.0 | 266 | 99 | 37.2 | 119 | **27.4** |
| `rapidapi_breach_search` | 277 | 246 | 0 | 0.0 | 203 | 61 | 30.0 | 74 | **26.7** |
| `leakcheck_lookup` | 154 | 148 | 0 | 0.0 | 136 | 57 | 41.9 | 62 | **40.3** |
| `oathnet_stealer_search` | 59 | 58 | 0 | 0.0 | 50 | 37 | 74.0 | 43 | **72.7** |
| `gravatar_profile` | 42 | 41 | 0 | 0.0 | 39 | 36 | 92.3 | 38 | **90.1** |
| `exa_search` | 257 | 230 | 0 | 0.0 | 228 | 29 | 12.7 | 29 | **11.4** |
| `github_code_search` | 32 | 32 | 0 | 0.0 | 30 | 16 | 53.3 | 17 | **53.3** |
| `ransomwarelive_lookup` | 18 | 18 | 0 | 0.0 | 15 | 12 | 80.0 | 14 | **80.0** |
| `deepfind_email_breach` | 45 | 35 | 0 | 0.0 | 33 | 12 | 36.4 | 13 | **28.3** |
| `urlscan_search` | 21 | 20 | 1 | 4.8 | 18 | 9 | 50.0 | 10 | **52.4** |
| `detect_contradictions` | 23 | 23 | 0 | 0.0 | 14 | 6 | 42.9 | 10 | **42.9** |
| `gleif_lei_search` | 9 | 9 | 0 | 0.0 | 8 | 7 | 87.5 | 8 | **87.5** |
| `hunter_domain_search` | 20 | 12 | 0 | 0.0 | 12 | 6 | 50.0 | 6 | **30.0** |
| `census_geocode` | 36 | 36 | 0 | 0.0 | 33 | 5 | 15.2 | 5 | **15.2** |
| `oathnet_victims_search` | 11 | 10 | 0 | 0.0 | 10 | 5 | 50.0 | 5 | **45.5** |
| `oathnet_subdomains` | 7 | 7 | 0 | 0.0 | 6 | 2 | 33.3 | 2 | **33.3** |
| `deepfind_reverse_email` | 19 | 2 | 0 | 0.0 | 2 | 1 | 50.0 | 1 | **5.3** |

**≈1,078 calls mislabelled as successes across 20 tools.**

Verified by reading payloads, not inferred from the aggregate:

- `gravatar_profile` → `{"ok": true, "data": {"error": "Profile not found"}, "found": false, "status": 404}`
- `memory_recall` → `{"ok": true, "count": 0, …, "selector": ""}`
- `oathnet_stealer_search` → 37/50 rows carry `count: 0, total: 0` — **and each
  spends `quota_left`**, so a paid quota is being consumed by zero-result calls
  recorded as wins
- `socialfetch_web_read` → `data.markdown.fit` = *"Cookies and Advertising
  Choices…"* — a consent banner. Mean payload **664 characters**.

The mechanism is visible at `tool-registry.ts:1242–1250` for socialfetch:

```js
const found = r.ok && (lookupStatus === "found" || ...);
// A 404 with no error body is a legitimate "no such profile" negative,
// not a tool failure — mark ok so it doesn't inflate the failure rate.
const ok = r.status === 404 && !env?.error ? true : r.ok;
```

The comment's reasoning is defensible — a 404 genuinely is not a *malfunction*. The
error is conflating **"the tool worked"** with **"the tool produced something."**
Those must be separate fields. `found: false` is returned but nothing ever sets
`empty: true`, so the distinction is lost before it reaches the log.

**The counter-evidence that makes this a real finding rather than a detector
artifact:** the `empty` outcome *does* work for correctly-instrumented tools —
`breach_check` reports 54.3% empty, `hackernews_user` 100%, `shodan_internetdb`
60.9%. And those tools show ~0 cache negatives, exactly as predicted, because their
empties are classified `empty` and thus never pass the `ok &&` write gate. The
mechanism is sound; specific tools bypass it.

**Detector caveat, recorded honestly.** The first pass of this audit used JSON path
`data.fit` where the real path is `data.markdown.fit`, which silently measured
serialized object size instead of content length and reported `socialfetch_web_read`
at 42.9% rather than 63.7%. Any re-run of this analysis must validate the detector
against sampled payloads per tool before trusting the aggregate.

### 2.7 Two contract defects found and fixed (PR #378)

Root-caused from telemetry and fixed on `fix/indicia-contract-and-normalization`
(draft, not deployed):

- **`indicia_web_dbs`** — the endpoint requires a non-empty `services` list; the
  schema and catalog both advertised it optional. 31/31 omitting calls returned
  HTTP 400; 10/10 supplying calls succeeded. Now defaults to
  `["leakcheck","snusbase","cloudsint"]`, applied inside `execute()` because
  `exec()` bypasses zod and `services: []` would satisfy `.default()` while still
  400ing.
- **`indicia_phone`** — input forwarded unnormalized, so formatting characters
  reached the API: 33/135 calls returned HTTP 400. Now reduced to digits, accepted
  at 10 digits or 11 with leading `1`, and unusable input is **skipped rather than
  failed** (a malformed selector is not a tool malfunction). The error reports only
  the digit count, never the number.

**Authoritative contract, obtained without credentials.** Indicia's public typed SDK
(`@indiciaosint/sdk@1.2.9`) and its own rendered API reference both give
`SearchWebDatabasesService` as a **closed enum of exactly four**: `cloudsint`,
`intelligencex.identityportal`, `leakcheck`, `snusbase` — with `services` marked
required. The shipped default therefore omits exactly one corpus. Unresolved: the
per-service credit cost (behind `GET /v1/pricing`, 401 without a key). The public
cost table gives Leakcheck 1 cr and CloudSINT 2 cr, so the catalog's "1–2
tokens/call" most likely described a *single-service* call and the 3-service default
may cost ~3–4 credits. **The default was not changed pending that number.**

> **Method lesson worth keeping.** The same SDK marks `city/state/zip` required on
> `search-address` and `type` required on `search-hudson-rock`. Both looked like
> identical contract bugs. Telemetry refuted it: **42/42** address calls omit
> city/state/zip and **49/49** hudsonrock calls omit `type`, yet they return 26 and
> 43 successes respectively with 3 and 2 HTTP 400s. **A `required` flag in the
> vendor SDK does not imply the API rejects the request.** `web-dbs` was special
> because there the correlation was 31/31. Two plausible, useless "fixes" were
> avoided by checking traffic before writing code.

---

## 3. Goals and non-goals

### Goals

- Telemetry that distinguishes *worked* from *produced something* (§2.6).
- A deterministic, offline harness that can replay real historical investigations —
  **including their failures** — against a candidate prompt and score the result.
- A tool-routing layer that learns which tools yield results in which contexts, at
  what cost and latency, and keeps improving as volume grows.
- A memory subsystem whose semantic and procedural knowledge is actually retrievable.
- GEPA-optimized prompt sections, delivered as a reviewable diff.
- Every claim of improvement backed by a measurement on held-out data.

### Non-goals

- **No continual/online learning.** Nothing in this design updates weights or
  prompts at runtime. All optimization is offline and lands via PR.
- **No auto-deploy.** The optimizer emits a diff, never a deployment.
- **No model-authored planner rules.** The model never rewrites its own planning
  logic; see §10.2 for the mandatory approval path.
- **No re-running live OSINT.** No optimization run may touch a paid API or a real
  person's data.
- **No change to evidence-integrity behavior** without explicit sign-off (§8).
- **No change to breach-value masking policy** in any phase of this work.

---

## 4. Architecture

Three processes, two frozen artifacts, one reviewed diff.

```
┌─ OFFLINE (local, Python) ──────────────────────────────┐
│  DSPy + GEPA optimizer  (optimizer/)                   │
│    ├─ proposes candidate prompt-section text           │
│    ├─ scores each candidate via the hybrid metric      │
│    └─ reflects on textual feedback → next candidate    │
└───────────────┬────────────────────────────────────────┘
                │ rollout: (thread_id, candidate prompt)
                ▼
┌─ REPLAY (local Deno, the REAL osint-agent) ────────────┐
│  replay_runner.ts, REPLAY_MODE=1                       │
│    ├─ system prompt injected from candidate            │
│    ├─ tool calls resolve from frozen cassette ONLY     │
│    ├─ cassette REPLAYS FAILURES + EMPTIES, not just ok │
│    └─ cassette miss = hard error, never a live call    │
└───────────────┬────────────────────────────────────────┘
                │ report + artifacts + verifier output
                ▼
┌─ SCORING ──────────────────────────────────────────────┐
│  (a) verifier signals    → score + diagnostics (free)  │
│  (b) groundedness judge  → score + diagnostics (indep.) │
│  (c) novelty / yield     → new entities, corroboration │
│  (d) cost + latency      → per §10.3.2                 │
│  (e) guardrails          → measured, NEVER optimized   │
└────────────────────────────────────────────────────────┘

OUTPUT: PR diff against system-prompt.ts → three-gate verification
```

### 4.1 The rejected alternative

The tempting shortcut is to reimplement the agent loop as a native DSPy program in
Python: faster to build, native GEPA integration. **Rejected.** It optimizes a
replica, and the resulting prompt may not transfer to the real Deno agent. That is
precisely the phantom/mirror-drift failure mode this project has repeatedly hit.
GEPA therefore treats the real `osint-agent` as an opaque program whose only
tunable is injected prompt text.

### 4.2 Why the harness is the durable asset

The optimized prompt depreciates — it goes stale when the model or tool set
changes. The corpus, metric, and replay harness do not. They make *every* future
change to `system-prompt.ts` measurable, which is currently impossible. Even if
GEPA delivers nothing, Phase 1 yields reproducible integration tests over real
investigations.

---

## 5. Phases

Ordering rationale: **Phase 0 is new in rev. 2 and is a hard prerequisite.** Every
number that Phases 1–4 optimize against is currently wrong in the same direction
(§2.6). Optimizing prompt instructions while a third of tool time is wasted, 92.5%
of memory is unreadable, and the success log over-counts by ~1,078 calls would tune
the agent's *reasoning* around three broken subsystems and bake the breakage in.

| # | Phase | Why here |
|---|---|---|
| **0** | **Outcome-truth fix** | **All later measurement depends on it; ~1,078 mislabelled calls today** |
| 1 | Eval harness | The instrument. Nothing after it is verifiable without it. |
| 2 | Tool efficacy | Largest measured waste (35.7%); plausibly fixes a P0 |
| 3 | Memory retrieval | Compounding; §10.1 argues for pulling this earlier |
| 4 | GEPA | Optimizes instructions once the subsystems they describe actually work |

**Each phase gets its own implementation plan.** This document scopes them so the
sequencing rationale is recorded, but they are independently sized and must not be
planned as one unit.

### Phase 0 — Make the outcome record true *(new in rev. 2)*

**0a. Separate "worked" from "produced."** Introduce an explicit distinction at the
tool-result contract level rather than patching individual tools:

- `ok` — the call completed without malfunction (a 404 is `ok`)
- `empty: true` — the call completed and produced nothing usable

`classifyToolOutcome` already routes `empty` correctly; the tools simply never set
it. The fix is per-tool but the *contract* should be documented once and tested
generically.

**0b. Audit every tool's negative path.** The 20 tools in §2.6 are the confirmed
set, but the audit only covers tools that write to `tool_call_cache`. Uncached tools
(~20) have **no** independent check and must be read by hand.

**0c. Sub-threshold content is an empty.** `socialfetch_web_read` (mean 664 chars,
63.7% under 500) and `jina_reader_scrape` (24.7% under 500) return consent banners
and site chrome as successes. Define a per-tool minimum-content threshold; below it,
`empty: true`.

**0d. Regression test.** A generic test asserting that for each tool, a
representative negative fixture produces `outcome='empty'` and not `'ok'`. This is
what prevents the class of bug from recurring.

**Exit criterion:** re-running the §2.6 query yields ≈0 cached rows with negative
payloads. That is a falsifiable, self-verifying check.

> **Do not "fix" this by loosening the cache write gate.** The `ok &&` gate is
> correct and is also the only reason this bug was detectable. Phase 1 needs
> negatives in the corpus, but they must come from a *separate* recording path
> (§5, Phase 1a), not by polluting the cache.

### Phase 1 — Eval harness

**1a. Corpus build — now a design question, not just a coverage question.**

> **Blocking:** cassettes drawn from `tool_call_cache` contain only successes
> (§2.3). A corpus of only-successes teaches the agent a world where tools never
> fail. Three candidate resolutions, to be decided before any corpus is built:
>
> 1. **Reconstruct negatives from `tool_usage_log`.** It retains `outcome`,
>    `status_code`, `error_msg`, and `input_json` for every call including failures
>    — but **not** `output_json`. Sufficient to synthesise a plausible failure
>    cassette; not sufficient to replay the exact payload.
> 2. **Add a dedicated replay-recording path** that captures all outcomes, and
>    build the corpus forward from that date. Cleanest, slowest.
> 3. **Hybrid:** successes from the cache, failures synthesised from the log.
>    Recommended starting point; the fidelity loss is confined to error bodies,
>    which the agent mostly treats as opaque.
>
> Whichever is chosen, **corpus composition must be reported** — a corpus that is
> 95% successes when production is 64% successes is itself a bias.

Coverage remains the second risk. The 151 figure is threads with *at least one*
cache row, not *complete* coverage. A thread is admissible only if every
`tool_usage_log` call it made has a corresponding cassette. Task 1a must report the
honest number; **if it falls below ~60 admissible threads, stop and re-plan.**

Corpus is committed (or LFS) so runs are reproducible. Split: random, stratified by
seed kind, fixed seed, split file committed. Target ~⅔ train / ⅓ held-out.

PII: the corpus contains real investigation data. It stays in-repo only if the repo
is private and the user approves; otherwise it lives in a gitignored local directory
with a committed manifest of hashes. **Resolve before 1a lands.**

**1b. Replay mode.** `REPLAY_MODE=1` in the Deno function:
- tool dispatch resolves from the frozen cassette by `(tool_name, input_hash)`
- **failures and empties replay as failures and empties**
- a cassette miss throws — it must be impossible for a replay to make a network call
- the system prompt is injectable, overriding `SYSTEM_PROMPT_FULL`
- `replay_runner.ts` entrypoint: takes `(thread_id, prompt_override)`, emits JSON

**1c. Metric.** Five channels (three in rev. 1, plus novelty and cost per §10.3):

- **Verifier** (free, structured): signals already produced by `validation.ts`,
  `attribution-check.ts`, `contradictions.ts`, `confidence.ts`.
- **Groundedness judge** (independent): does every claim trace to a real artifact
  with a real source? Runs on a *different model family* from the task model —
  using the task model to judge itself reintroduces the problem the judge exists to
  detect.
- **Novelty/yield** (§10.3.3): new entities, new selectors, new corroborating
  sources, new pivots enabled. This is the channel that measures *investigative
  value* rather than *task completion*.
- **Cost and latency** (§10.3.2): information gained per credit and per second.
- **Guardrails** (measured, never optimized): claim count, distinct artifacts
  cited, distinct independent sources, fraction of claims hedged
  `[LOW]`/`[VERIFY]`, pivots pursued vs. available.

**Why guardrails exist.** Optimizing against a verifier invites Goodharting, and
every degenerate solution available here points the same direction — *say less,
hedge harder, drop the difficult cases*. Specifically: `attribution-check` can be
satisfied by only making trivially-sourceable claims; `contradictions` can be
satisfied by **suppressing** the contradicting finding rather than reconciling it
(actively harmful in OSINT, where a contradiction is usually the signal);
`confidence` can be satisfied by emitting whatever band scores best. The
groundedness judge does not catch this on its own — a report making three
trivially-true claims is perfectly grounded. Guardrails are what make "verifier
score +20%, claim count −40%" visible instead of invisible.

**1d. Cost instrumentation.** Measure the first 10 rollouts, extrapolate, report
before committing to a full run. Rough prior: tens of dollars per optimization run
(~300 rollouts × ~15 LLM turns, DeepSeek task model, stronger judge/reflection
model), dominated by judge and reflection calls since cassettes remove tool cost.
This is an estimate, not a measurement.

**Exit criterion:** the same thread replayed twice with the same prompt produces
identical tool sequences, and the metric produces stable scores across repeat runs.

### Phase 2 — Tool efficacy learning

The largest measurable win (§2.4) and the one that compounds fastest, because every
investigation adds samples.

**2a. Triage on measurable-today signal.** No new infrastructure required.

- `indicia_web_dbs` — **done**, PR #378 (§2.7).
- Per §11.4, prefer **circuit-opening a repeatedly-timing-out tool over raising its
  timeout.** Raising timeouts on a tool that always times out increases CPU-kill
  pressure; it does not increase yield.
- Candidates from §11.4: `reddit_user` (100% failure), `wayback_cdx_search`
  (repeated ~24.7 s timeouts), `crtsh_lookup`/`crtsh_subdomains`,
  `gemini_deep_dork`, `minimax_plan_pivots` (times out at its 12 s ceiling).
- `unknown_tool_ignored` (90 calls) means the model is inventing tool names.
  Alias only clearly-intended names; keep rejecting unknown ones.

**2b. Record tool lineage on artifacts.** Add a structured `produced_by_tool_call`
reference (FK to `tool_usage_log.id`, or tool name + call timestamp) written at
artifact-record time. Small, permanent, and the precondition for everything in 2c.
Retires the free-text `discovered_via`, removing a PII leak into `metadata`.
**Yield is only computable from this change forward** — it cannot be backfilled onto
the existing 8,998 artifacts, so this lands early or the corpus keeps growing
without it.

**2c. Contextual efficacy model.** Replace the single global reliability scalar with
a posterior over yield per **(tool × selector_type)** — a tool useless on emails may
be excellent on domains, and a global average hides that. Required properties:

- **Small-sample safety.** Beta-binomial posterior with credible intervals, so a
  tool is not demoted on three unlucky calls. The existing `healthSampleSize` guard
  gestures at this; this makes it principled rather than a threshold.
- **Exploration.** Thompson sampling over the posterior, retaining a small retry
  probability for demoted tools. **This is the property that makes the system grow
  rather than calcify.** A greedy demote-what-failed rule permanently kills a tool
  that had a bad week during a provider outage and never discovers it recovered.
- **Bounded influence (§10.2.3).** Prior 0.5, learned adjustment capped at **±25%**.
  One noisy week must not be able to reorder the planner.
- **Cost- and latency-aware (§10.3.2).** Rank on yield per credit per second, not
  yield alone.
- **Calibration (§10.4.3).** Track expected vs. observed confirmation rate per tool
  and recalibrate, so a tool that is confidently wrong is penalised distinctly from
  one that is honestly uncertain.

Feeds the existing `runtime-policy.ts` scoring path, which already accepts optional
health signals and degrades to prior behavior when absent — extending a proven
integration point rather than inventing one.

**2d. Fix the call-identity defects (§11.5).** Independent of the learning model and
worth shipping alone:
- `socialfetch_lookup` collapses same-username/different-platform calls into one
  key because `platform` is absent from the identity — include `platform` and mode.
- Parallel `jina_reader_scrape` calls are *rejected* while reporting that they are
  "waiting" — key by URL and queue or allow limited concurrency.

Both produce misleading telemetry today: calls appear skipped while the planner
proceeds as though the URLs were checked. That is the same class of error as §2.6.

**2e. Measure on the Phase 1 harness.** Target metrics: wasted tool-time share
(**corrected baseline 35.7%**), and whether runs reach synthesis more often. If
§2.4's thesis is right, cutting waste should visibly reduce deadline kills — and if
it does not, that falsifies the link, which is worth knowing.

### Phase 3 — Memory retrieval fix

**3a. Quality audit first.** Read 30 `pattern` and `lesson` memories by hand.
Making bad knowledge retrievable is worse than leaving it unretrievable. If they are
largely filler, the fix shifts from *retrieval* to *write discipline*. **This audit
gates 3b.** It must also resolve the empty-`selector` observation from §2.1 — if
recall is being called with no selector, that is a caller bug and cheaper to fix
than any retrieval redesign.

**3b. Split memory three ways (§10.3.1).** Rev. 1 proposed a two-way episodic /
semantic split; rev. 2 adopts three:

| store | holds | retrieval |
|---|---|---|
| **Entity** | people, phones, emails, domains, usernames | exact match on selector — keep as-is, near its ceiling |
| **Episodic** | what happened in prior investigations | thread/case-keyed; supports "have I seen this case shape before" |
| **Procedural** | what *strategy* worked | retrieved by situation, never by subject |

The rev. 1 design conflated entity and episodic, which is why "identity" hit rates
looked like a ceiling rather than a design choice.

Candidate mechanisms for procedural retrieval, cheapest-first: a compact
always-loaded digest of the top-N highest-confidence lessons; retrieval keyed on
`subject_kind` + tool/seed context; embedding similarity over `content`. Try the
digest before embeddings.

**3c. Re-examine the recall rate limit.** `guard.ts:123` caps recall at 2 per 30s.
Determine whether this independently suppresses hits, separate from the keying
problem. Do not change it without measuring first.

**3d. Measure on the Phase 1 harness.** Hit rate is the mechanism, not the outcome —
report quality on held-out threads is the outcome. A hit-rate improvement that does
not move report quality is not a win.

### Phase 4 — GEPA

Optimize the prompt sections in `system-prompt.ts`. The file is already GEPA-shaped:
202 lines, 4 exports (`SYSTEM_PROMPT`, `IDENTITY_CLUSTER_RULES`,
`PERSON_SEARCH_RULES`, `HYPOTHESIS_AND_SOURCE_DISCIPLINE`), ~17 named `##` sections.
These map onto GEPA components with no refactor.

- Task model: DeepSeek (matches pinned production config, so gains transfer).
- Reflection + judge model: a stronger, different-family model.
- Held-out set is never seen during optimization.
- Output: a diff against `system-prompt.ts`.

**Ship gate — human read, not a score.** Ten investigations, before and after, read
by eye on the held-out set, plus the guardrail table. No metric configuration
substitutes for this, and the PR is gated on it rather than on any number.

---

## 6. Testing

- Negative-path regression: per-tool fixture asserting a negative result yields
  `outcome='empty'` (Phase 0d). **This is the highest-value new test in the plan.**
- Replay determinism: same thread + same prompt → identical tool sequence.
- Cassette isolation: an integration test asserting `REPLAY_MODE=1` makes any
  network egress attempt throw.
- Memory retrieval: unit tests for entity/episodic/procedural paths; a regression
  test that entity exact-match behavior is unchanged.
- Existing suites must stay green. **Use the documented command** —
  `npm run test:edge`, i.e. `cd supabase/functions/osint-agent && deno test
  --no-check --allow-net --allow-env --allow-sys --allow-read *_test.ts` — and
  `npx vitest run` from repo root.
  > Running `deno test` from the **repo root** instead of the function directory
  > breaks `npm:ai@6` resolution and causes test files to report **0 tests, 0
  > failures** rather than erroring. That silent pass is how a "18/18 green" claim
  > was produced from a run that executed nothing. Baseline on `origin/main`
  > (f08e696) with the documented command: **795 passed / 0 failed / 7 ignored**.
- `deno check index.ts` has ~12–157 pre-existing type-graph errors; verify the
  change adds none rather than treating it as a gate.

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| **Telemetry under-reports failure** | Phase 0, with a self-verifying exit criterion (§5) |
| **Corpus contains only successes** | Blocking design question in 1a; corpus composition must be reported |
| **Cassette coverage below viability** | Measured first (1a); hard stop below ~60 admissible threads |
| **Goodharting the verifier** | Independent judge + unoptimized guardrails + human read gate |
| **Optimizing a replica instead of the real agent** | GEPA drives the real Deno function; Python reimplementation rejected (§4.1) |
| **Bad memories made retrievable** | Quality audit (3a) gates the retrieval change |
| **Cutting a low-yield but high-value tool** | Judge on yield, not outcome alone — a tool that rarely hits but is decisive when it does (e.g. breach confirmation) must not be pruned on ok% |
| **Efficacy loop calcifies on early data** | Thompson sampling + bounded ±25% influence (2c) |
| **One noisy week reorders the planner** | Bounded influence; prior 0.5 (§10.2.3) |
| **Lineage write touches the artifact path** | Additive column only — but adjacent to integrity code, review as such |
| **Raising timeouts worsens CPU-kill** | Circuit-open repeat-timeout tools instead (§11.4) |
| **Corpus overfitting** | Held-out split, never seen during optimization |
| **PII in the corpus** | Resolve storage policy before 1a lands; replay never touches live APIs |
| **Evidence-integrity drift** | See §8 — requires sign-off |

---

## 8. Evidence-integrity and deploy discipline

**Evidence-integrity sign-off required.** Memory-sourced findings are cited in
reports as `[MEMORY] previously corroborated`, and `system-prompt.ts` instructs
confidence to reflect corroboration strength. Changing what memory surfaces can
therefore change confidence scoring and corroboration counts, which `CLAUDE.md`
designates integrity-critical and sign-off-gated. Phase 3 must not let a memory hit
count as an independent corroborating source without explicit approval.

The same applies to Phase 2: suppressing a tool changes which sources an
investigation reaches, which can change corroboration counts and therefore
confidence. Tool demotion must remain **advisory to the planner**, never a hard
block on a tool an analyst explicitly requested — `runtime-policy.ts` already models
this via `manualOverride`, and that behavior must be preserved.

**Phase 0 has an integrity dimension too.** Reclassifying ~1,078 calls from `ok` to
`empty` will change any downstream statistic derived from outcome, including
`tool_health` and anything an analyst has previously read. It is a *correction*, not
a regression, but it should be announced rather than shipped silently.

**Breach-value masking is off-limits** to every phase of this work.

**Deploy discipline.** Per `CLAUDE.md`: merge to `main` → `npm run stamp:build` →
surgical mirror sync → explicit Lovable deploy → verify the `/health` build SHA
**moved**. A mirror push is not a deploy. Nothing here auto-deploys. Per §11.1,
production is currently on the rollback build `6d76133` (DeepSeek `deepseek-v4-pro`),
and no phase of this work should be bundled with unrelated persistence or
finalization changes.

---

## 9. Open questions

1. Corpus negatives: reconstruct from log, record forward, or hybrid (1a).
2. Admissible-thread count after full cassette-coverage analysis (1a).
3. Corpus storage policy given PII.
4. Which judge/reflection model, priced against the 1d measurement.
5. Whether the ~20 uncached tools force threads out of the corpus, or warrant stubs.
6. Definition of "useful artifact" for yield: recorded at all, survived dedup, cited
   in the report, or survived analyst review. Later definitions are stronger signal
   but sparser. Recommend starting at "survived dedup."
7. Whether efficacy is keyed on `selector_type` alone or also investigation stage.
   Start with `selector_type` only.
8. **Indicia per-service credit cost** — needed to decide whether the 3-service
   default in PR #378 should stand, narrow, or widen to all four (§2.7).
9. Whether `memory_recall`'s empty `selector` is a caller bug (§2.1) — may make
   Phase 3 substantially cheaper.

---

## 10. Incorporated design review

An external review of rev. 1 (2026-07-21) rated it 8.8/10 and is incorporated here.
Its Tier-1 items were already in rev. 1 or are now shipped; its Tier-2 and Tier-3
items changed the design. Recorded so the provenance of each change is traceable.

### 10.1 Sequencing — partially accepted

The review argued prompt optimization should not wait for the full learning stack,
proposing: planner → memory → tool statistics → prompt optimization → self-learning.

**Accepted in part.** Memory moves up in priority. Prompt optimization does *not*
move ahead of Phase 0 — optimizing a prompt against telemetry that over-reports
success by ~1,078 calls would encode the measurement error into the prompt. The
argument that "prompt optimization can improve quality independently" is true only
where the *scoring* is sound, and §2.6 shows it currently is not. Phase 0 is short;
this is a small delay for a large correctness gain.

### 10.2 Governance of learned behavior — accepted in full

**10.2.1 No model-authored planner rules.** The mandated path is:

```
Investigation → Telemetry → Statistics → Offline evaluation → Human approval → Planner update
```

Never `LLM decides its own planner`. Added to §3 non-goals.

**10.2.2 Human approval gate.** Any change to routing weights lands as a reviewed
PR, consistent with this project's existing three-gate verification discipline.

**10.2.3 Bounded influence.** Prior 0.5; learned adjustment capped at **±25%**.
Folded into Phase 2c and §7.

### 10.3 Redesigns — accepted

**10.3.1 Three memory systems**, not two: entity / episodic / procedural. Folded
into Phase 3b. This is a genuine correction — rev. 1 conflated entity and episodic
knowledge, which made the 12.4% `identity` hit rate look like a natural ceiling when
it was partly a design artifact.

**10.3.2 Cost-aware learning.** Optimize *information gained ÷ cost ÷ latency*, not
success rate. A tool that finds one artifact in 18 s is not equal to one that finds
one in 2 s. Directly relevant given §11.4's list of 12–25 s tools and the CPU-kill.
Folded into Phase 2c and the 1c metric.

**10.3.3 Novelty in the reward.** Measure new entities, new selectors, new evidence,
new corroboration, new pivots — not merely "tool succeeded." This is closer to
investigative value and is the natural counter to the §2.6 failure mode, where
"succeeded" and "produced something" had drifted apart. Folded into 1c.

### 10.4 Additions — accepted, sequenced

**10.4.1 Investigation knowledge graph.** Person → phone → email → username →
company → vehicle → address → breach → domain, enabling graph expansion instead of
linear tool chains. **Depends on 2b lineage** and is the natural consumer of it.
Scheduled after Phase 2b; not before, since without lineage the edges cannot be
attributed.

**10.4.2 Evidence entropy.** "How much genuinely new information did this call
add?" rather than "did it return results." Overlaps 10.3.3; implement as the
information-theoretic form of the novelty channel once lineage exists.

**10.4.3 Tool confidence calibration.** Track expected confidence vs. observed
confirmation rate per tool and recalibrate. Folded into Phase 2c. Note the
integrity constraint in §8: calibration output must not silently change confidence
bands without sign-off.

**10.4.4 Cross-provider planning.** Route sub-tasks to different model families by
strength (e.g. DeepSeek planning → MiniMax execution → Gemini correlation) rather
than choosing one provider globally. **Deferred beyond Phase 4** and flagged as
higher-risk than it appears: this project's provider-switching history (MiniMax →
DeepSeek, the `<minimax:tool_call>` leak, the 07-19/20 regression) shows provider
changes are a recurring source of production incidents. Worth doing, but not while
the CPU-kill is open, and never bundled with other changes.

---

## 11. Incorporated production audit (Lovable, 2026-07-21)

Independent audit of the live deployment. Included because several items corroborate
§2 from a different angle, and because two are operational constraints on this work.

**11.1 Production is on the rollback build.** `6d76133`, DeepSeek `deepseek-v4-pro`,
orchestrator and recovery healthy. Later PR work is **not live**. No phase of this
design should assume otherwise, and none should be bundled with the reverted
persistence/finalization batch.

**11.2 The rollback is responsive but does not finalize.** 4 of the 5 most recent
investigations ended with recovery-generated reports rather than a real model final
response; runs lasted ~4–20 minutes using 22–43 tool calls. Artifacts survived;
narrative and recommended pivots were commonly lost. The catastrophic regression is
fixed; the original CPU-kill/finalization problem is not. **This is consistent with
§2.4** — a third of tool time producing nothing is a plausible contributor.

**11.3 Do not restore persistence and orchestrator hardening as one package.** Split
atomic budget reservation + recovery single-winner correctness (lower risk) from
automatic per-tool persistence (a growing SELECT plus an INSERT inside a
CPU-sensitive edge function — the code family whose revert this build *is*). A green
test suite is not sufficient evidence to deploy the latter.

**11.4 Tools consuming budget without yield.** `wayback_cdx_search` (four
consecutive ~24.7 s timeouts in a five-run sample), `minimax_plan_pivots` (times out
at its 12 s ceiling), `minimax_correlate` (succeeds but costs 18–24 s),
`crtsh_lookup`/`crtsh_subdomains`, `gemini_deep_dork`, `reddit_user` (100% failure
over 14 days), and `unknown_tool_ignored` (90 calls — the model inventing tool
names). **Correction adopted into 2a: raising every timeout may worsen CPU-kill
frequency; a tool that times out on every call should be circuit-opened, not
granted more runtime.**

**11.5 Jina and SocialFetch are incorrectly suppressed.** Two keying/concurrency
defects — `socialfetch_lookup` collapsing same-username/different-platform calls
into one key, and parallel `jina_reader_scrape` calls being rejected while reporting
they are "waiting." Adopted as Phase 2d. **Same class of error as §2.6:** the
telemetry says something happened that did not.

**11.6 The agent does not learn tool usefulness.** The audit's independent
conclusion — runtime policy learns latency and technical success, not whether a call
produced a novel artifact, was later confirmed or dismissed, or enabled a productive
pivot. This is §2.5 and §10.3.3 reached from the production side, and it is the
central thesis of this document.

**11.7 Mirror-only frontend drift.** A `BackendVersionBadge` fix committed directly
in the Lovable mirror duplicates the default Supabase URL and anon key and
reimplements health-URL logic instead of using the shared helper. The anon key is
designed to be public, so this is configuration duplication and drift, not secret
exposure. Reconcile through canonical GitHub. Out of scope here; recorded so it is
not lost.

---

## 12. Changelog — rev. 1 → rev. 2

Numbers that changed, and why. Rev. 1 statements should not be quoted without this
table.

| Claim in rev. 1 | Corrected | Cause |
|---|---|---|
| 23.6% of tool time wasted | **35.7%** | Declared channel only, and a longer window. Same-window declared figure is 25.6%; the §2.6 correction adds +10.1 pts |
| `tool_usage_log.outcome` is partial yield signal | **Not reliable** — ~1,078 mislabelled calls across 20 tools (§2.6) | Cache write gate `ok &&` allowed direct measurement |
| Memory 92.5% write-only (store side) | Confirmed, **plus** `memory_recall` 82.5% true-empty (call side) | Second independent measurement |
| `tool_call_cache` is a usable cassette store | **Usable but biased** — successes only; blocks the rev. 1 Phase 1a design | `cache.ts:1050` read directly |
| `indicia_web_dbs` — cut or repair, cause unknown | **Root-caused and fixed**, PR #378 | 31/31 omission→400 correlation |
| Two-way memory split (episodic / semantic) | **Three-way** (entity / episodic / procedural) | Design review §10.3.1 |
| Metric has three channels | **Five** — adds novelty and cost/latency | Design review §10.3.2–3 |
| Phase 1 is first | **Phase 0 is first** | §2.6 gates all measurement |
| Test command `deno test --allow-net --no-check` | Use `npm run test:edge` from the function dir | Root-cwd runs report 0 tests as a pass (§6) |

**Two findings in this revision came from checking a conclusion rather than
reaching one**, and both are recorded in place because the method matters more than
the results: the §2.6 detector initially used the wrong JSON path and understated
`socialfetch_web_read` by 21 points; and the §2.7 SDK-`required` inference was
refuted by traffic before it became two unnecessary code changes.
