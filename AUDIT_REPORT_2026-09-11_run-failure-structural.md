# Insight Finder — full audit, 2026-09-11

**Scope:** the `d4873abc` person-seed run failure, the three external reports about it
(Lovable audit, Lovable full diagnostic, Codex), and the live state of canonical `main`.

**Method:** every number below was re-measured this session against a primary source —
the live `/health` endpoint, the production database, and both test suites run locally.
Claims from `CLAUDE.md`, the handoff series, commit messages, code comments and the three
external reports were treated as **leads** and re-checked. Where a report's number is
confirmed, it says so. Where it is wrong, it says that too.

**Nothing was changed.** This is read-only.

---

## 1. Headline

**The run is context-bound, not tool-bound. All three external reports optimise the wrong
6.7% of the bill.**

| | Measured |
|---|---|
| Thread total cost | **$1.847** |
| — model tokens | **$1.554 (84.1%)** |
| — tool calls | **$0.124 (6.7%)** |
| — remainder | $0.169 (9.2%) |
| Steps | 63 |
| **Input tokens** | **4,655,848** |
| **Output tokens** | **45,361** |
| **Input:output ratio** | **103 : 1** |
| Peak single-step input | 98,946 tokens |
| Serialised context, first → last invocation | 44,307 → 300,438 chars |
| Peak final context | **1,149,246 chars** |
| Total step wall time | 1,242.0s |
| — of which in tools | 425.6s (34%) |
| — of which model latency | **~816s (66%)** |

`minimax_correlate` — the #1 fix in every external report — is 205.5s of 1,242s of step
time (**16.5%**) and roughly 3% of the spend. Capping it is worth doing and it is not the
problem.

**The second headline: there is no selector-level identity.** The same selector exists in
the database simultaneously quarantined and promoted, in different clusters, at different
confidences. That single defect produces the cluster fragmentation, the duplicate rows, the
confidence disagreement between UI surfaces, and the appearance that quarantine both is and
is not blocking a pivot. No external report found it.

---

## 2. Deploy state — current, not stale

| Axis | Value |
|---|---|
| Live `/health` build | `235f540` |
| Canonical `main` functional tip | `235f540` |
| Stamp commit | `05830b7` |
| Ledger commit | `86a7a2f` (= `main` HEAD) |
| Vercel production | READY on `86a7a2f` |
| Mirror `origin/main` | `1a5663b` |
| Mirror drift vs last sync | **1 runtime file** — `tools/gemini_vision.ts` (+60/−11) |

`/health` carries `checks.synthesis` and `checks.rejected_cluster_sweep`, so the deployed
bundle provably contains post-`cf06cbb` code. Provider `deepseek` / `glm-5.2`, pinned.

> **REFUTES Lovable:** *"Deployed build is 3 days old."* True by date, misleading in
> substance. Live equals canonical's functional tip — **there is no undeployed canonical
> work.** The only unshipped changes are the two mirror-side fixes. This is not a deploy lag.

**Confirms Codex:** canonical `main` is `86a7a2f` and has not advanced.

---

## 3. Gates — both green, which is the point

| Suite | Result | Duration |
|---|---|---|
| Frontend (`npx vitest run`) | **162 files, 1969 passed, 1 skipped** | 45.3s |
| Edge (`deno test --no-check --no-lock …`) | **1709 passed, 0 failed, 5 ignored** | 65s |

Deno 2.9.6, clean `npm ci`, isolated. Both figures are **above** the `CLAUDE.md` baselines
(1957/159 frontend, 1634 edge) — update them.

**Every defect in this report ships past a fully green suite.** That is the standing lesson
from handoff II §2.1 and it held again: not one of these was caught by a test.

---

## 4. Production corpus — 11,253 artifacts, 223 threads

### 4.1 The quarantine release path has never once been used

| Measure | Value |
|---|---|
| Quarantined artifacts (`subject_unlinked = true`) | **791** |
| Threads containing quarantined rows | 36 |
| Artifacts ever carrying `linkage_confirmed` | **0** |
| Rows in `artifact_linkage_releases` | **0** |

`#529` shipped `src/lib/quarantine-release.ts` as the sanctioned escape from quarantine.
In production it has been exercised **zero times against 791 quarantined rows.** Whether
that is because the control is unreachable, undiscoverable, or simply unused, the effect is
identical: **quarantine is a one-way trapdoor.** `CLAUDE.md` describes release as the
answer to the person-seed dead-end; the data says the answer has never been available in
practice.

### 4.2 Analyst verdicts — 910 stored, and they do not bind

| State | Count |
|---|---|
| confirmed | 407 |
| dismissed | 282 |
| key | 166 |
| wrong | 35 |
| recheck | 20 |
| **Total** | **910** |

> **CONFIRMS Lovable** exactly on the per-state counts. (Its summary said "890"; the sum is
> 910.)

The live contradiction: the run rendered *"Analyst decisions applied this turn: 16 confirmed,
1 key, 0 recheck, 3 dismissed"* and, in the same assistant message, opened with *"Good —
breach data confirmed fresh from OathNet"* — where *"No breach hits for chubz900…"* was one
of the three rows the analyst had **dismissed**. The decisions reach the rendered string and
the database. They do not reach the model's context.

### 4.3 Run outcomes — ~30% of runs do not finish cleanly

| `status` / `recovery_reason` | Threads |
|---|---|
| finished, clean | 141 (63%) |
| **finished, "stale heartbeat recovered by health sweep"** | **59 (26%)** |
| stopped | 10 |
| **finished, `stream_error: Tool result is missing for tool call …`** | **4** |
| finished, `stream_error: Bad Request` | 3 |
| finished, "incomplete: run ended without a durable report" | 2 |
| finished, `recovered_report_refreshed` | 2 |
| active | 2 |

> **CONFIRMS Lovable's static analyzer**, which claimed runs die from *"a message-format
> fault after parallel tool calls."* Production carries four threads whose recovery reason is
> literally `Tool result is missing for tool call call_ec12bcfd…`. That is a malformed
> assistant/tool message sequence — a tool call emitted with no matching result — and it is
> a **real, named, reproducible root cause**, not a hypothesis. It deserves priority over
> the AbortController fix, which treats the downstream symptom.

### 4.4 Cache is inert — because a migration never landed, not because a flag is off

| Measure | Value |
|---|---|
| `tool_call_cache` rows | 11,886 |
| expired | **11,822 (99.5%)** |
| `/health` `cache_sweep` | **disabled** |

> **CONFIRMS Lovable's numbers exactly.** (It is `tool_call_cache`; the separate
> `investigation_cache` table holds 209 rows, 97.1% expired.)
>
> **But REFUTES its fix.** Lovable recommends "turn cache sweeping back on (nightly)". It is
> not switched off. `supabase/migrations/20260828200000_tool_call_cache_expiry_sweep.sql`
> exists in canonical and **was never applied to production** — there is no sweep routine in
> `pg_proc` at all. See §4.6. Different problem, different fix.

### 4.6 Canonical migrations never reach production — a pipeline gap

Surfaced by the prior session's dossier (Finding 4) and **re-verified here against
`pg_indexes` and `pg_proc`.**

The mirror sync carries only `supabase/functions/<fn>/`. `supabase/migrations/` is never
propagated to the Lovable-owned Supabase project. 49 migration files exist in canonical.

| Expected object | Source | In production? |
|---|---|---|
| `artifacts_synthesis_cluster_uniq` | `20260907000000_synthesis_finding_cluster_unique.sql` (#547, merged 2026-09-07) | **NO** |
| cache-expiry sweep routine | `20260828200000_tool_call_cache_expiry_sweep.sql` | **NO** |

Production `artifacts` carries exactly four indexes: `artifacts_pkey`,
`artifacts_thread_created_idx`, `idx_artifacts_subject`, `idx_artifacts_thread`.

**So #547 "enforces" a dedup key that is unenforced in production.** A merged migration is
not an applied migration, and this project currently has no instrument that distinguishes
them — the same class of gap as "a mirror merge is not a deploy".

**This is a hard constraint on the selector-identity work (§6):** every architecture option
that requires DDL — a new table, a materialized projection, or a view — **cannot reach
production today**. Only a runtime projection inside the edge function ships through the
function-sync path that demonstrably works. That is not a preference for the smallest change;
it is the only currently-deliverable option.

Two facts that survive for later, both verified:
- `cluster_id` and `subject_id` are **real columns** on `artifacts` (text), not metadata
  keys — so a view is feasible on the cluster axis once migrations can land.
- `artifact_linkage_release_validate` **already exists as a deployed RPC**, and
  `artifact_linkage_releases` exists as a table. The release path's database plumbing is
  live; zero rows means nothing calls it. "Make release reachable" is therefore a caller/UI
  problem, not a schema problem — a materially smaller PR than assumed.

### 4.5 Refusal sinks — and the invisible one

| `outcome` | `ok` | Calls | Charged |
|---|---|---|---|
| ok | true | 11,500 | 6,772 |
| **skipped** | **true** | **1,265** | 0 |
| failed | false | 1,081 | — |
| empty | true | 745 | 9 |
| skipped | false | 4 | 0 |
| empty | false | 3 | 0 |

Of the 1,265 `ok:true / skipped` rows, 354 are *"finalize window open; live lookup skipped"*
and 28 are *"duplicate call … already in flight"*.

**The dispatch quarantine refusal does not appear in `tool_usage_log` at all.** Zero rows
match `quarantin*`, `refus*`, or `unproven`. The refusal is a `console.warn` and nothing
else. So when the run declined to check `ufland40`, **no durable record of that decision
exists on the thread** — not in the audit tab, not in chain of custody, not in the report.
The analyst cannot discover that the system chose not to look.

This is the open P1 `CLAUDE.md` describes as "durable runtime stamping — unbuilt." Confirmed
unbuilt.

---

## 5. The `d4873abc` run

### 5.1 Invocation telemetry — confirms Codex exactly

9 invocations, **7 forced into finalization**, 2 natural stop.

| # | Secs | Steps | Tools | Stop reason | init chars | final chars |
|---|---|---|---|---|---|---|
| 1 | **226.2** | 10 | 23 | finalize_forced | 44,307 | 90,999 |
| 2 | 176.7 | 7 | 19 | finalize_forced | 157,194 | 247,423 |
| 3 | 156.4 | 10 | 10 | finalize_forced | 246,380 | 350,333 |
| 4 | 80.0 | 6 | 5 | natural_stop | 259,843 | 407,708 |
| 5 | 146.6 | 6 | 5 | finalize_forced | 256,588 | 498,816 |
| 6 | **223.1** | 9 | 13 | finalize_forced | 264,212 | 571,286 |
| 7 | 99.3 | 4 | 5 | finalize_forced | 285,025 | 616,436 |
| 8 | 71.8 | 5 | 5 | natural_stop | 285,103 | **1,118,068** |
| 9 | 103.7 | 6 | 16 | finalize_forced | 300,438 | **1,149,246** |

Two invocations exceeded the ~180s envelope (226.2s, 223.1s). `init_chars` plateaus near
300k while `final_chars` reaches 1.15M — so each invocation inflates its own context roughly
4× and the next one restarts from ~300k. **Something truncates between invocations and
nothing restrains growth within one.**

### 5.2 Confidence caps — the mechanism is misattributed

| Cap | Rows | of which quarantined | of which single-source-class |
|---|---|---|---|
| 55 | 30 | 0 | 30 |
| **60** | **19** | **5** | **19** |
| 40 | 10 | 0 | 10 |
| 70 | 7 | 0 | 7 |
| 50 | 7 | 0 | 7 |
| others | 15 | 0 | 12 |

87 of 88 artifacts carry a cap. Only **5** are quarantined.

> **REFUTES Lovable and Codex both.** Lovable: *"Name-only confidence cap at 60 means person
> seeds mathematically cannot produce high-confidence output. Run 1: 19 artifacts pinned at
> 60."* Codex: *"Nineteen artifacts in this run carried the 60-confidence cap."* The count
> is right; **the cause is wrong.** All 19 are capped by the **single-source-class**
> ceiling, not by the name-only quarantine — only 5 rows were quarantined at all.
>
> This matters for the fix. Lifting the quarantine cap changes 5 rows. The thing actually
> holding 87 of 88 artifacts down is that almost nothing reached two independent source
> classes. That is a **corroboration** problem, not a quarantine problem, and the two need
> different fixes.

---

## 6. ROOT CAUSE — there is no selector-level identity

### 6.1 The evidence

Three selectors exist **twice each** on this thread, 45 seconds apart:

| Value | Created | Source | `subject_unlinked` | Conf | Cluster |
|---|---|---|---|---|---|
| `Ufland40` | 03:34:35 | `oathnet_lookup` | **true** | **45** | **null** |
| `ufland40` | 03:35:20 | `breach_check (oathnet_lookup) + serus_darkweb_scan` | *(none)* | **60** | `clus_bea7bdbc` |
| `ufland40@gmail.com` | 03:34:35 | `oathnet_lookup` | **true** | 45 | null |
| `ufland40@gmail.com` | 03:35:20 | `breach_check … + serus_darkweb_scan` | *(none)* | 60 | `clus_bea7bdbc` |
| `50010524` | 03:34:35 | `oathnet_lookup` | **true** | 45 | null |
| `50010524` | 03:35:20 | `breach_check (oathnet_lookup)` | *(none)* | 60 | `clus_a6f581bc` |

And `TRISTEN UFLAND` exists **three times**, in **three different clusters**, at confidence
40, 60 and 50.

### 6.2 What this explains, all at once

1. **The quarantine is not binding what it appears to bind.** The dispatch guard refuses
   `username:ufland40` — keyed by `type:normalizedValue`, i.e. **selector-level** — while an
   **unquarantined row** for the same selector sits promoted in `clus_bea7bdbc` at confidence
   60, feeding the clusters and the report. The system simultaneously refuses to investigate
   a selector and publishes it as evidence.
2. **Cluster fragmentation.** Each duplicate row receives its own `cluster_id`. Three
   `TRISTEN UFLAND` rows → three subjects. That is the mechanism behind "44 subjects for 88
   artifacts" — not, as all three reports concluded, merely weak merge rules. Better merge
   rules would help; they are treating a symptom.
3. **The Timeline vs Table confidence discrepancy** I spotted in the UI screenshots
   (`Ufland40` at 45% in Timeline, 60 in Table). *Correcting my own earlier hypothesis:* it
   is **not** one surface applying a quarantine haircut. **They are rendering two different
   rows.** Both surfaces are correct. The data is duplicated.
4. **Inflated artifact counts** — 88 rows, fewer real selectors.

### 6.3 Corpus-wide

| Measure | Value |
|---|---|
| Duplicated `(thread, kind, value)` selectors | **714** |
| Redundant rows | **860** (7.6% of 11,253) |
| **Duplicated selectors split across >1 cluster** | **253** |
| **Duplicated selectors with divergent quarantine state** | **33** |

> **Wording correction.** An earlier draft called those 33 "contradictory". Measured
> correctly, described imprecisely — see §6.5. They are one **evaluated** row and one
> **unevaluated** row, which is a materially different thing and changes the fix.

### 6.5 Why the twin is unflagged: the quarantine classifier runs on only ONE write path

| Write path | Rows | `subject_unlinked` key PRESENT | Quarantined |
|---|---|---|---|
| `tool_return_extractor` (auto-persist) | 4,145 | 791 | **791 (19.1%)** |
| `record_artifacts` (model-recorded) | **7,108** | **0** | **0 (0.0%)** |

The key is not `false` on the model path — it is **absent**. In the entire production
history `record_artifacts` has never quarantined a single row, and it writes **63% of all
artifacts**.

The control that proves this is specific to quarantine rather than a general metadata gap:
`confidence_cap_applied` **is** present on 6,585 of those 7,108 model-recorded rows. Capping
runs on both paths. Only the quarantine classifier is missing from one.

**Consequences:**

1. **The quarantine boundary has a complete bypass, and it is the majority path.** `ufland40`
   row B — unquarantined, confidence 60, clustered — was model-recorded 45 seconds after the
   auto-persisted row A was quarantined.
2. **Absence is not clearance.** On a `record_artifacts` row, a missing `subject_unlinked` is
   **UNEVALUATED**, not **NOT-QUARANTINED**. The unflagged twin carries no information about
   linkage. Any projection that treats absence as clear reproduces this bug with extra steps.
   The quarantine axis therefore needs three states, not a boolean:
   `EVALUATED-QUARANTINED` / `EVALUATED-CLEAR` / `UNEVALUATED`, with `UNEVALUATED` unable to
   outvote `EVALUATED-QUARANTINED`.
3. There is a candidate fix **smaller** than the projection — run the same classifier on the
   `record_artifacts` path. It does not fix clustering, display, or the 7,108 existing rows,
   so it does not replace the projection, but it must be evaluated as a genuine alternative
   rather than assumed away.

### 6.4 The code — and why the obvious fix is wrong

Two dedup keys, deliberately different:

`incremental-persist.ts:218` — auto-persist path:
```ts
export function checkpointKey(kind: string, value: string): string {
  return `${canonicalKind(kind, value)}:${value.trim().toLowerCase()}`;
}
```
Source-independent, normalised.

`lib/artifact-hygiene.ts:47` — `record_artifacts` path:
```ts
return JSON.stringify([
  canonicalKind(input.kind, input.value),
  input.value,                              // whole and UNPARSED
  (input.source ?? "").trim().toLowerCase(), // source IS part of identity
]);
```
Source-dependent, un-normalised.

So `oathnet_lookup` and `breach_check (oathnet_lookup) + serus_darkweb_scan` are different
identities, and `TRISTEN UFLAND` ≠ `Tristen Ufland`.

**Do not "fix" this by normalising the key.** The header above it is explicit and the
reasoning is sound:

> *"`source` is part of the identity ON PURPOSE … four corpora returning the same answer is
> four coverage facts, and collapsing them erases breadth … ⚠️ THE VALUE IS IN THE KEY,
> WHOLE AND UNPARSED … `violations_total 670`, `676` and `28` are three different values …
> They are a CONTRADICTION, not a duplicate … Any future change that normalises, rounds or
> fuzzy-matches the value here would convert a visible disagreement into a silent merge. Do
> not."*

That is correct for **evidence**. The defect is that the same per-row granularity is then
used for **identity, quarantine, clustering and display**, where it is wrong.

**Fix shape:** keep multi-row evidence exactly as it is; add a **selector projection** —
`canonicalKind + normalizeTarget(value)` — that owns cluster assignment, quarantine state and
displayed confidence. Quarantine becomes a property of the *selector*, not of a row, so it
cannot be defeated by a second tool recording the same value under a different source string.
This aligns the row layer with the dispatch guard, which is already selector-keyed.

---

## 7. Live P0 — unbounded finalize deferral

`index.ts:918`:
```ts
const correlatePending = shouldDeferFinalizeForCorrelate(correlateDue(), guard.lastCorrelateOutcome);
if (finalizeStarted || capReached || (shouldForceFinalize(elapsedMsNow, stepNumber ?? 0) && !correlatePending)) {
```
`orchestrator-finalize.ts:262-267`:
```ts
/** True when correlate is due but has not been attempted this cycle — finalize may defer once. */
export function shouldDeferFinalizeForCorrelate(correlateDue, lastCorrelateOutcome) {
  return correlateDue && lastCorrelateOutcome === null;
}
```
`guard.ts:43` — `correlateDue()` is `artifactsSinceCorrelate >= 8`.

**There is no "once."** `lastCorrelateOutcome` becomes non-null only when a correlate call
actually dispatches. On a run where the model never issues one — and `bumpAutoPersistedArtifacts`
means auto-persisted rows alone can push the counter past 8 — the predicate stays true for the
whole run and the wall-clock forced finalize is negated on **every** step. The only surviving
route to a report is the hard tool-call cap.

This did **not** cause the `d4873abc` failure (correlate ran 7 times there, so
`lastCorrelateOutcome` was non-null). It is a **live latent P0** on a different population:
runs where the model never correlates. `CLAUDE.md`'s standing rule — *do not add work inside
the finalize window* — was violated by the change that introduced it.

**Fix:** bound it. One deferral per run, tracked by an explicit counter, with a hard
wall-clock floor past which finalize fires regardless.

---

## 8. Correlate — Codex's diagnosis is the right one

`#561`'s freshness gate works **within** an invocation (one dispatch per applicable
invocation). But freshness state is **per-run**, and every user continuation creates a fresh
invocation, so the state resets and the same investigation re-pays the correlation tax. 7
calls × ~29s = 205.5s on one thread.

> **Codex is correct and is the only one of the three to identify this.** The fix is a
> **thread-level correlation checkpoint keyed to an evidence-set hash**, not a lower timeout
> or a bigger budget.

Corpus-wide `minimax_correlate`: 318 calls, 44 failed, $0.808 charged all-time.

---

## 9. Attachment ingestion — analyst evidence silently dropped

The analyst attached a 41,842-byte OSINT Industries export containing 14 module cards
(7 names, 4 IDs, 2 usernames, 1 location). **None of the card detail entered the run.**

| Stage | Behaviour |
|---|---|
| `gemini_vision` document mode | Forced `application/pdf` on non-PDF/non-image → Gemini `HTTP 400 "The document has no pages."` even though the agent passed `mime_type: "text/markdown"` |
| `jina_reader_scrape` | `HTTP 422` on signed storage URLs |
| `markdown_extract` | Hard-slices at **12,000 chars** (`tool-registry.ts:2632`) → ~29% of the file |
| `gemini_vision` return | `MAX_RETURN_TEXT` **8,000 chars** |

> **Corrects Lovable's own writeup.** It first wrote that the markdown converter *"did read
> it successfully (3,485 tokens), so the content was available."* A 200 response is not a
> complete read: 3,485 tokens is roughly a third of a 41,842-byte file. Lovable subsequently
> verified and agreed.
>
> **The mime patch does not fix this.** It stops the 400s. Even patched, the reader caps its
> own `extracted_text` at 8,000 chars, so the tail is re-lost on the way out. **Two separate
> defects.** If the mime fix lands and the attachment problem is declared closed, you will
> believe you hold data you do not hold — and this attachment is plausibly where the
> `chubz900` ↔ `Tristen Ufland` bridge was.

**Worst property: nothing tells anyone.** No signal to the analyst or the model that
analyst-supplied evidence was truncated.

---

## 10. Corrections to the three reports

| # | Claim | Source | Verdict |
|---|---|---|---|
| 1 | "Deployed build is 3 days old" | Lovable | **Misleading.** Live = canonical tip; no undeployed canonical work |
| 2 | "19 artifacts pinned at 60" by the name-only cap | Lovable, Codex | **Count right, cause wrong.** All 19 are single-source-class; only 5 quarantined |
| 3 | "RapidAPI is 403-dead — 42 calls, all wasted" | Lovable | **Overstated.** 426 calls all-time, 15 failed, 9 × 403 (2%). The key works |
| 4 | "$0.1240" for run 1 | Lovable | **Tool cost only.** Total is $1.847; model tokens are 84% |
| 5 | "$1.847" for run 1 | first audit | Correct, but no report noticed tools are 6.7% of it |
| 6 | Cache 11,886 rows / 11,822 expired / 99.5% | Lovable | **Confirmed exactly** |
| 7 | 407/166/282/35/20 analyst verdicts | Lovable | **Confirmed exactly** (sum 910, not 890) |
| 8 | Stream dies from a message-format fault after parallel tool calls | Lovable analyzer | **Confirmed in production** — 4 threads, `Tool result is missing for tool call …` |
| 9 | Correlate freshness resets per invocation | Codex | **Confirmed — and only Codex found it** |
| 10 | 9 invocations, 7 forced, ~44k→300k chars, ~99k peak tokens | Codex | **Confirmed exactly** |
| 11 | "Raise the paid-call cap from 12" | Lovable | **Re-litigates a settled decision.** `CLAUDE.md`: `MAX_PAID_CALLS` stays bounded; an unbounded run dies on wall-clock instead, in a worse place |
| 12 | "Re-enable synthesis" | Lovable | **Ships dark deliberately** behind two independently-defaulted-OFF flags. Not a config flip |
| 13 | "Quarantine promotion, not dispatch" | Lovable | **Too broad** — see §11 |
| 14 | Timeline 45% vs Table 60% is a display haircut | *my own earlier hypothesis* | **Wrong — self-corrected.** They are two different rows (§6.2) |

---

## 11. On the quarantine recommendation

Lovable's fix #1 is *"let the pivot run; gate promotion instead."* That removes a guard
`#518`/`#519` added because quarantined selectors were reaching live tool calls, and `#519`
additionally closed a path where a refusal was regex-matched into an `ok:true` skip.

**Codex's framing is the correct one:** keep quarantined evidence excluded from promotion
and report authority, while allowing a **narrow, purpose-bounded verification pivot** whose
only job is to prove or disprove linkage.

To which §6 adds the precondition nobody stated: **fix the selector-level identity first.**
Today the guard refuses `ufland40` while an unquarantined `ufland40` row is already promoted
at confidence 60. Loosening dispatch on top of that inconsistency would produce a boundary
that is neither closed nor open, and it would be very hard to reason about afterwards.

Order matters: **selector identity → release path reachable → narrow verification pivot.**

---

## 12. Ranked, with the reasoning

### P0 — correctness
1. **Selector-level identity projection** (§6). Unblocks clustering, quarantine consistency,
   display agreement and dedup in one change. Nothing else should be built on top of the
   current inconsistency.
2. **Bound the finalize deferral** (§7). Live latent P0; one counter and a wall-clock floor.
3. **Fix the malformed tool-result message sequence** (§4.3). Named root cause, 4 production
   threads. Fix before the salvage AbortController, which is downstream.
4. **Bind analyst verdicts to the model's context** (§4.2). 910 verdicts, zero influence on
   reasoning.
5. **Make the quarantine release path reachable** (§4.1). 791 quarantined rows, 0 releases,
   ever.

### P1 — cost and latency
6. **Context growth control** (§1, §5.1). 84% of spend and 66% of step time. Nothing else
   comes close. Measured, not hypothesised.
7. **Thread-level correlate checkpoint keyed to an evidence-set hash** (§8) — Codex's fix,
   not a timeout change.
8. **Durable record of every refusal** (§4.5). A run that declined to look must say so on the
   thread.
9. **Attachment ingestion: mime sniffing + chunked extraction** (§9). Land the mime patch on
   canonical `main`; the truncation fix is separate and still unwritten.

### P2 — evidence quality
10. Weighted cross-selector clustering — **after** #1, or it is treating a symptom.
11. Corroboration, not the quarantine cap, is what holds 87/88 artifacts down (§5.2).
12. Route negatives, downgrade notes and bare `url` rows out of Evidence (131 `url` rows at
    avg confidence 30 corpus-wide — Lovable's finding, confirmed).

### Deploy hygiene
13. Land `gemini_vision` mime sniffing on canonical `main` → `npm run stamp:build` →
    surgical sync → `verify:deploy` must print `mirror tree -> equal` → **then** deploy.
    **Do not deploy the mirror directly** (Codex agrees).

---

## 13. Blind spots

- `orchestrator_invocations` / `orchestrator_step_metrics` contain **only this one thread**
  (9 and 63 rows). The telemetry landed with `#560` on 2026-09-08, so the context-growth and
  forced-finalize numbers are **n=1**. Directionally strong, statistically thin. Re-measure
  after a few more runs before treating the 84% figure as a constant.
- A code-level fan-out across 9 dimensions was launched and **was killed mid-run** at
  04:21:34 by a session interrupt; it returned nothing. Every finding in this report is from
  my own direct measurement against `/health`, the production database, the two test suites
  and the source tree. Nothing here is inherited from that pass.
- `record_artifacts`'s 7,108 rows were measured for the **presence** of the
  `subject_unlinked` key, not for whether a classifier ran and deliberately declined. I found
  no evidence of an `EVALUATED-CLEAR` state on that path, but I did not exhaustively trace
  every branch of the recording tool — treat "the classifier never runs there" as **LIKELY**,
  not CONFIRMED, until the design pass's write-path mapping lands.
- I did not reproduce the `d4873abc` artifact set through the clustering path in a fixture.
- `deployed_bytes_verified` remains `false`, as always — the marker proves provenance, not
  byte identity.
