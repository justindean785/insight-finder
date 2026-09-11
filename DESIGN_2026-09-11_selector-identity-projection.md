# Selector-level identity — design pass (P0 #1)

**Status: READ-ONLY DESIGN. No file was edited, no schema changed, no production data mutated,
nothing deployed, nothing merged.** Awaiting operator + Codex review before any implementation.

Method: 5 dependency mappers over the live tree, 3 competing architectures (runtime /
persisted / view-hybrid) built independently, then 2 adversarial reviewers (correctness, and
risk+tests) who were told to refute all three. 10 agents, 0 errors, 2.4M tokens, 73 min.
Every claim below carries a `file:line` and is marked CONFIRMED unless stated otherwise.

---

## 0. The headline, before the detail

**Both adversarial reviewers independently converged on the same answer, and both rejected
part of what the architects proposed.**

1. **Ship a TypeScript-only projection. Zero DDL, zero backfill, zero new writer.** Not
   because it is smallest — because the migration pipeline is broken (§9), so no DDL-bearing
   option can reach production at all.
2. **Delete the "restore" discriminator that all three architects independently invented.**
   Its branch is provably unreachable. Proven statically by reviewer 2 and **confirmed
   empirically by a production query run for this document** (§3.2).
3. **The precedence ladder is 5 stages, deny-biased, with RELEASE as its own stage above
   quarantine** — the structural change neither shipped implementation can currently express.
4. **Confidence aggregates by MIN over stored values, never MAX** — and the reason is sharper
   than "be conservative" (§4.3).
5. **The finalize-deferral fix is a separate PR and should land FIRST.**
6. **There is a serious falsifier and it is partly true (§11).** 42% of the duplication is a
   write-path identity bug, not a read-path aggregation problem. A one-line change to
   `artifactDedupKey` would prevent that population from ever being written. It does not
   replace the projection; it should probably ship alongside it.

---

## 1. Current-state dependency map

### 1.1 Two writers, and only one can compute quarantine — CONFIRMED

| | `auto-persist-findings.ts` | `record_artifacts` / `record_artifact` / `record_finding` |
|---|---|---|
| Classifies from | the **tool call** (`toolName` + raw `input`) | model-supplied `(kind, value, confidence, source, metadata)` |
| Can compute quarantine? | **Yes** | **No — structurally impossible** |
| Writes `subject_unlinked`? | **Only module that ever does** | `grep -c subject_unlinked tool-registry.ts` = **0** |
| Dedup key | `checkpointKey` = `canonicalKind:value.toLowerCase()` — **source-free** (`incremental-persist.ts:217`) | `artifactDedupKey` = `[canonicalKind, value, source]` — **source-aware** (`lib/artifact-hygiene.ts:55`) |
| Dedup seeded from | whole thread each pass (`:1711 loadSeenArtifactKeys`, selects only `kind,value`) | `tool-registry.ts:216-280`, which **deliberately never selects `metadata`** |

The tool input is not available to the recording tools, and they do not read the quarantine
state of existing rows for the same selector. **So quarantine is a property of *how a row was
observed*, never of the selector.** Any writer that did not observe the call writes an
unquarantined twin.

> This upgrades the audit's finding from LIKELY to **CONFIRMED**, and corrects its framing:
> this is **not a leak in a gate. No gate exists on the `record_artifacts` path at all.**

### 1.2 The duplication is order-dependent and asymmetric — CONFIRMED

- **A-then-B duplicates.** B's model-authored `source` differs from `oathnet_lookup`, so the
  source-aware key misses and the insert proceeds.
- **B-then-A does not.** auto-persist's source-free key hits.

Row A at 03:34:35 and row B at 03:35:20 is exactly the duplicating order.

**`source` on `record_artifacts` is model-authored free text** — `source: z.string().optional()`
(`tool-registry.ts:4878`), validated against nothing. `source-classification.ts:516` says so
outright: *"An artifact's `source` is a free-text string the orchestrator LLM writes; nothing
validates it."* **1,775 distinct source strings over 11,253 rows.**

So the model controls how many "independent observations" a selector appears to have.

### 1.3 Nothing writes `cluster_id` / `subject_id` at insert — CONFIRMED

Every writer emits `{thread_id,user_id,kind,value,confidence,source,metadata}` only. The
columns are written later, in one place, by `applyClusteringToThread` (`lib/cluster.ts:518-520`),
which reads quarantine through `isExcluded` (`:141-149`) **by regex over the raw metadata
string**. `metadata.cluster_id` is separately set at write time from model input
(`tool-registry.ts:5031`, `:5467`).

**Cluster ids derive from array index and are non-deterministic.** `clusterArtifacts`
(`:294`) runs union-find and derives the id at `:352-354` from `stableHash(selectors.join("|")
|| "root"+root)`. `root` is the row's index for a singleton, and the select at `:467-469` has
**no `.order()`** — so ids vary across runs. `strongTokens` (`:208-242`) returns `[]` for a
plain `kind:"name"` row, because names are deliberately excluded from the merge axis.

**That is precisely why three `TRISTEN UFLAND` rows became three clusters** — three empty
token sets, three singleton components, three index-derived ids. I7 is violated not by the
clusterer but by the fact that it sees N rows where there is one selector.

### 1.4 Eight normalizers, three incompatible keyspaces — CONFIRMED

Verified by transcribing each body into a harness and running the case values.

| Keyspace | Key shape | Where |
|---|---|---|
| **A — runtime dispatch** (de-facto canonical) | `rawKind : circuit.normalizeSelector(kind,value)` | injected at `cache.ts:716`, `:780`; computes `sel` at `cache.ts:994` which then keys the circuit breaker, `callKey` dedup, `loadSelectorEvidence`, `manualOverrideSelector` |
| **B — frontend pivot/quarantine** | `KIND_TO_PIVOT[kind] : normalizeTarget(value)` — canonical kind, **every non-alphanumeric collapsed to a space** | `src/lib/quarantine.ts:141`, `pivot-engine.ts:120`, `analyst-decisions.ts:190` |
| **C — frontend clustering** | `handle:` / `email:` / `phone:` / `address:` / `parent:` via `normalizeHandle` (strips `_ . -` entirely) | `intel.ts:2050`, `:2091` — **different prefix vocabulary again** (`handle:`, not `username:`) |

Keyspace A is canonical because it is the only projection that can stop a paid call.

**An alias gap inside the existing boundary:** `buildRefusedKeys` (`lib/dispatch-quarantine.ts:188,192`)
keys on the **raw** `row.kind`, while its sibling `buildRejectedDispatchKeys`
(`lib/dispatch-rejection.ts:71`) expands through `kindAliases`. **So a quarantined
`ip_address` row does not refuse an `ip`-typed dispatch, though a rejected one does.** The
existing selector projection is already inconsistent with its own sibling — which is the
concrete reason not to copy it unexamined.

### 1.5 The frontend already has an undocumented projection, and it is wrong — CONFIRMED

`dedupeArtifacts` (`src/hooks/useThreadArtifacts.ts:67-103`) is the single gateway for Board,
Table, Clusters, Timeline, Pivots, Graph, Overview, Header and Report. It already collapses
rows by `kind|normalizeValue(kind,value)`:

- **source dropped** (`:71`) → violates **I1, I2**
- **confidence merged with `Math.max`** (`:93`) → violates **I9**
- metadata merged last-wins shallow spread (`:94-99`)

No test pins any of it: `grep -rn "Math.max(prev.confidence" src/test/` is **empty**.

> **So this design does not introduce a projection. It replaces a wrong one that ships today.**

### 1.6 Two corrections to the audit

**Timeline vs Table is NOT two rows rendered separately — REFUTED.** `EvidenceTab.tsx:152`
and `:162` hand both components the **same `items` array** from one shared store
(`EvidenceTab.tsx:43`); by render time rows A and B are one object, and both call the same
`effective` helper (`EvidenceMatrixTab.tsx:177/46`, `intel.ts:924`). They cannot disagree.

The real 45-beside-60 is `ConfidenceExplain.tsx:58` rendering `explainConfidence(...).final`
— **a fifth confidence pipeline that never reads `a.confidence`** (`confidence.ts:128-129`) —
as the popover headline, contradicting its own comment at `:22-27`.

*Both of my earlier explanations for this were wrong. The database evidence was right; the
causal inference from it was not.*

**`artifact_linkage_releases` has NO writer — corrects the audit.** `grep -rn
"artifact_linkage_releases"` over canonical returns **only audit `.md` files; zero `.ts`, zero
`.sql`.** The actual release writer #529 shipped is a per-row metadata UPDATE at
`src/components/ResourcesPanel.tsx:937-944`. So release has **two disconnected
representations**: a `metadata.linkage_confirmed` key every boundary reads but nothing
persists to the table, and a table nothing writes and nothing reads.

**360 production rows carry `metadata.cluster_id` with a NULL `cluster_id` column** (0
disagree where both are set). A view over the column is therefore **not** equivalent to what
metadata-reading consumers see.

---

## 2. Exact root cause

Three independent defects, routinely conflated:

1. **No selector identity.** Row identity is reused as selector, quarantine, cluster and
   display identity. Dispatch projects to `type:normalizedValue`; everything else reasons
   per-row.
2. **Quarantine is unevaluable on the majority write path.** 7,108 of 11,253 rows (63%) come
   from a writer that cannot compute it. Absence of the flag is **UNEVALUATED**, not clear.
3. **Key fragmentation.** Eight normalizers, three keyspaces, plus an alias gap *inside* the
   dispatch boundary itself.

---

## 3. Recommended architecture

### 3.1 The verdict: "C/E PR1 + D's API" — TypeScript only

Both reviewers, independently:

> *"C/E and D are the only proposals whose precedence never restores dispatch authority on a
> clean twin."*

> *"C/E is recommended for its SEQUENCING and its verdict, not for its database object."*

**Do NOT build the PR-2 view.** Option C itself supplied the falsifiable abandon condition;
both reviewers said take the offer.

### 3.2 DELETE the restore discriminator — proven twice

All three architects independently invented a rule of the form *"a clean row from a
quarantine-capable writer restores the selector."* All three are wrong.

**Static proof.** `metadata.auto_persist_source` has exactly one writer
(`auto-persist-findings.ts:1672`, grep-confirmed), and that writer's input is deduped
**first-wins on the source-free `checkpointKey`** at three independent points: within one
extraction (`:1477-1479`), across tools in one step (`:1513-1515`), and thread-wide via
`ctx.seen` seeded by `loadSeenArtifactKeys` (`:1660`, `:1740`). **There is no reachable path
to two `auto_persist_source`-stamped rows for one `(canonicalKind, lowercased value)` in one
thread.**

Also: `auto_persist_source` means *"the extractor wrote this row"*, **not** *"a writer capable
of quarantining declined to quarantine it"* — the gate is evaluated only when
`queryIsNameOnly(toolName, input)` is true (`:866-872`, `:1333`), plus the oathnet co-tenant
branch (`~:1060`) and the bulk-corpus branch (`~:1361`). Every other extractor row carries the
stamp with the linkage question **never asked**.

**Empirical proof — the gate query, run for this document against live production:**

```
duplicated_selectors              714
mixed_quarantine_selectors         33
mixed_with_clean_autopersist_row    0   ← the restore branch, in production
dup_with_single_source            301
```

**Zero.** Static analysis and production agree. Keeping the discriminator means ~60 lines of
dead code that a successor must maintain and reason about — and, in A/B's formulation, an
**I6 violation shipped as a feature**, since it would re-open the #518/#519 boundary on any
selector holding one quarantined row plus one ordinary extractor row.

### 3.3 Module shape (Option D's API, adopted verbatim)

```
lib/selector-key.ts          selectorKey(kind, value, normalize)
                             = canonicalKind(kind,value) + ":" + collapseWs(normalize(...))
                             selectorKeyCandidates(declaredTypes, normalizedValue)
lib/selector-projection.ts   buildSelectorProjection(rows, normalizeValue, opts)
                             withRejection(projection, rejectedRowIds)   ← overlay, not baked in
                             authorityOf() / selectorForRow() / refusedKeys()  ← byte-compatible shim
lib/selector-confidence.ts   min(MIN-over-stored, applyRecordingSourcePolicy(union sources))
src/lib/selector-projection.ts   frontend re-export + projectThread(rows, reviews)
```

`circuit.normalizeSelector` is **wrapped, never edited** — its output keys the breaker,
`callKey`, `deadSelectors`, the dedup cache, `manualOverrideSelector` and telemetry through
`sel` at `cache.ts:994`. Nine call sites already import it.

`collapseWs` is the one repair the value fold needs: `circuit.normalizeSelector` is the only
selector fold in the project that **preserves internal whitespace runs**, and
`validation.ts:377` can persist `name "TRISTEN  UFLAND"` while `auto-persist-findings.ts:331`
cannot — so today a double-spaced quarantined name refuses neither spelling, while
`reviews.normalizeArtifactKey` binds both.

`canonicalKind` and `circuit.normalizeSelector` **are never composed anywhere in the codebase
today. That composition is the entire fix.**

Rejection is an **overlay** because the two loaders have deliberately different lifetimes: a
per-run memo (`cache.ts:700-745`) vs in-flight-only (`cache.ts:768-800`), the latter
documented as deliberate so *"the next sequential dispatch observes the latest decision."*

---

## 4. Precedence semantics — the operator's explicit requirement

**One ladder, five stages, per selector key. Deny-biased. The only thing that clears
quarantine is an explicit, durable analyst release.**

### STAGE 0 — KEY
`selectorKey = canonicalKind(kind,value) + ":" + collapseWs(circuit.normalizeSelector(canonicalKind, value))`

`canonicalKind` on **both** sides closes the `buildRefusedKeys` alias gap (§1.4). Phone
(non-E.164) and URL (WHATWG) divergences are **deferred and pinned as KNOWN**, not fixed.

### STAGE 1 — ADMIT
Exclude `triage_decision`, `cluster_decision` (by kind **and** by `metadata.label`, matching
`isMetaArtifact` at `useThreadArtifacts.ts:60-65`) and `bulk_corpus_harvest` — whose `value`
is a count sentence (`auto-persist-findings.ts:1448`) and whose members survive only inside
`metadata.harvested_identities`. Excluded rows **neither quarantine nor restore**. Empty-key
rows go to an `unkeyed` bucket, **never silently dropped**.

Without this, `triage_seed`'s raw insert (`tool-registry.ts:654-662`, confidence null, no
caps) has its `"triage_decision: … for <selector>"` string read as an observation.

### STAGE 2 — REJECTION (absorbing, outranks everything below)
Any member row in `{dismissed, wrong}` (`reviews.ts:51`) ⇒ `authority = 'rejected'`, ladder
**stops**. No dispatch, no cluster, no promoted confidence. **Rows are not deleted (I8).**

Not a new rule — three shipped implementations already agree: `reviews.ts:226-257`,
`lib/dispatch-rejection.ts:62-77`, `src/lib/analyst-decisions.ts:201-205`.

**Rejection before release** because *"is this real?"* outranks *"whose is this?"* —
`reviews.ts:42-46` records that value-level enforcement is the defence against a re-record
under a new id, which matters precisely because `record_artifacts` mints a new row whenever
the model rewords `source`.

### STAGE 3 — RELEASE (its own stage, ABOVE quarantine)
`released = members where subject_unlinked === true && linkage_confirmed === true`.
A non-empty release set **ends the quarantine question** for the selector.

> **This is the structural change neither shipped implementation can express.**
> `buildRefusedKeys:186-187` and `src/lib/quarantine.ts:56-59` both **fold
> `linkage_confirmed` INTO the quarantine predicate**, so there is nowhere for a release to
> outrank a quarantine stamped later on a different row. Separating the stage creates that
> place.

Free to ship today: **0 rows carry `metadata.linkage_confirmed`**, so PR 1 changes nothing
observable here — it builds the seat that PR 2 sits in.

### STAGE 4 — EFFECTIVE QUARANTINE (union-of-denial)
`activeQ = members where subject_unlinked === true && linkage_confirmed !== true`
— byte-identical to `src/lib/quarantine.ts:56-59` and `reviews.ts:131-135`, the two predicates
already correct.

| | |
|---|---|
| `activeQ = 0` | `clear` |
| `activeQ = all admitted` | `quarantined` |
| otherwise | `quarantined_contested` — **treated as quarantined for enforcement**, surfaced distinctly for disclosure |

**Why this is not the lazy copy the operator warned against.** The only argued case *for*
restore is the `quarantineSets` docstring (`src/lib/quarantine.ts:91-101`): *"the same phone
number can arrive twice: once from a name-only sweep… and once from a provider that matched on
the subject's own email… over-blocking is its own integrity failure, just a quieter one."*
Reviewer 2 tested that scenario against the code and **it cannot occur** — the second
observation would have to come through the one writer whose dedup is source-free and
first-wins. §3.2's production query confirms: 0 occurrences.

### STAGE 5 — AUTHORITY / CLUSTER / CONFIDENCE
Derived from stages 2-4. No implicit restore at any stage, from any row, regardless of writer
provenance.

### 4.3 Confidence — MIN over stored, and why `min(recordedCap)` is not enough

`ceiling = MIN over admitted non-rejected STORED confidence`, then
`final = min(ceiling, recomputed-over-union-of-sources)`. Withheld (`null`) under rejected /
quarantined / contested.

**The decisive detail, and the I9 construction:** `safety.ts:124-127` writes
`row.confidence = Math.min(row.confidence, 25|35)` for minor-safety and **writes no
`confidence_cap_applied`**. So the minor cap exists **only in the stored column**.

- `MIN over stored` catches it — and catches every other unrecorded downgrade, known and future.
- `min(recordedCap)` (Option D's floor) catches it **only** for rows carrying `possible_minor`.

That is why MIN-over-stored, not merely "MAX is unsafe."

---

## 5. Alternatives rejected

| Option | Verdict |
|---|---|
| **A/B — persisted selector table** | **Rejected.** Requires DDL (undeliverable, §9); its `clean_linkage_capable_rows > 0 → 'clear'` rule **allows dispatch** on a clean twin — an I6 violation shipped as a feature; discriminator broken and provably unreachable (§3.2). |
| **C/E PR 2 — database view** | **Rejected for now.** DDL-blocked; `metadata.cluster_id` diverges from the column on 360 rows so a view is not equivalent; C offered its own abandon condition and both reviewers took it. Revisit only if PR 1 measurement demands it. |
| **D as drafted** | **API adopted, confidence rule rejected** (`min(recordedCap)` is a weaker floor, §4.3), and its unswitched deletion of `Math.max` at `cache.ts:564` rejected — that single change alters tool selection on every dispatch via `scoreExpectedValue`'s `selectorConfidence` and the `+18` source-independence bonus. **An unswitched change to run shape is the one thing in D's PR 1 I would not merge**, in a project whose documented failure mode is running out of wall-clock in a worse place. |

---

## 6. PR 1 scope

**"Selector projection: one key, one ladder, dispatch only."** Zero DDL, zero backfill, zero
new writer, zero frontend consumer, one kill switch, derived-on-read.

**STEP 0 — the gate, before any code.** ✅ **Already run for this document (§3.2).** Result:
`mixed_with_clean_autopersist_row = 0`. The restore discriminator **stays deleted**. Had it
been non-zero, the instruction was to stop and re-derive the ladder.

**New** (pure leaf modules, unit-testable in isolation):
1. `lib/selector-key.ts`
2. `lib/selector-projection.ts` — the five-stage ladder, `SelectorRecord.members[]` carrying
   every admitted row's id / source / stored confidence / recorded cap / created_at /
   cluster_id / **verbatim quarantine reason**, plus the three accessors and
   `complete`/`incompleteReason` carried from the reader.
3. `lib/selector-confidence.ts` — cap-chain dependencies **injected**.
4. `src/lib/selector-projection.ts` — frontend re-export. **No production importer in PR 1**;
   it exists so a parity test pins both tiers from day one.

**Modified** (~3 files, ~7 sites):

5. **`cache.ts:705` — widen the reader's select to include `id`.**
   **MANDATORY, AND MISSING FROM ALL THREE PROPOSALS.** Without `id` the rejection overlay
   cannot bind to rows at all. This is reviewer finding F4 and it would have been discovered
   at implementation time as a rewrite.
6. `buildRefusedKeys` / `reasonForKey` (`lib/dispatch-quarantine.ts:179-214`) key via
   `selectorKey`; `dispatchTypeCandidates` (`:88-102`) emits the canonical spelling of every
   declared type. **These must land in ONE commit** — changing the kind component repartitions
   the refused and rejected sets simultaneously, so a partial cutover opens the gap between them.
7. Kill switch: `SELECTOR_PROJECTION_DISABLED`, defaulting to the projection ON but reverting
   to today's `buildRefusedKeys` behaviour when set.

**Explicitly deferred from PR 1:** clustering, the frontend `dedupeArtifacts` replacement,
`Math.max` deletions, write-path consult, the view, and release reachability.

**The quarantine reason string is load-bearing control flow, not prose** —
`isNameOnlyHarvestQuarantine` (`auto-persist-findings.ts:409`) and `isBulkCorpusQuarantine`
(`:398`) regex-match it. The projection must carry it verbatim per member.

---

## 7. Migration and backfill

**None.** Derived-on-read from existing rows. No table, no index, no column, no data rewrite.
This is the whole point of the option chosen, and the only reason it can ship (§9).

---

## 8. Rollback

Single env kill switch (`SELECTOR_PROJECTION_DISABLED`) reverting to today's
`buildRefusedKeys`. No data to un-migrate. `refusedKeys()` ships as a **byte-compatible shim**,
so the fallback path is the current code, not a reimplementation of it.

---

## 9. Why nothing with DDL was eligible

Verified against `pg_indexes` and `pg_proc` on live production **today**:

- Production `artifacts` has exactly 4 indexes; **`artifacts_synthesis_cluster_uniq` is absent**
  despite #547 merging 2026-09-07 with its migration in canonical.
- The cache-expiry sweep routine is absent; there is no sweep function in `pg_proc` at all.
- The mirror sync carries only `supabase/functions/<fn>/`. `supabase/migrations/` is never
  propagated.

**And CI actively asserts otherwise.** `.github/workflows/ci.yml`'s `Migrations (psql
validation)` job applies all 49 migrations to a throwaway `postgres:15` container and runs a
step named **"Synthesis dedup index assertion"** — which **passes**. It validates that the
migration *would* create the index if applied. It reads as *the index is enforced*.

> Same failure shape as *"a mirror merge is not a deploy"*, one layer down:
> **a passing migration assertion is not an applied migration.**

Tracked separately; must not be mixed into this PR. But it is what makes every DDL option
undeliverable today.

---

## 10. Test plan

**Fixture** from `d4873abc`: `Ufland40` ×2, `ufland40@gmail.com` ×2, `50010524` ×2,
`TRISTEN UFLAND` ×3.

Assertions:
- duplicate evidence rows **remain** (I1); `members[]` exposes all source rows (I2)
- selector count < artifact count; each logical selector has exactly one identity
- quarantine state cannot contradict itself (I5); dispatch cannot be refused while the same
  selector is promoted (I6)
- cluster identity cannot contradict itself (I7)
- confidence aggregation cannot bypass any cap — **specifically a minor-safety row whose cap
  exists only in the stored column** (I9)
- a dismissed row rejects the selector without deleting independent supporting rows (I8)
- `linkage_confirmed` releases selector state **without rewriting evidence provenance**
- **backend/frontend parity**: `lib/selector-projection.ts` and `src/lib/selector-projection.ts`
  agree on the fixture — this is why the frontend module ships in PR 1 with no importer
- alias case: a quarantined `ip_address` row **must** refuse an `ip`-typed dispatch (today it
  does not — §1.4)
- double-space case: `"TRISTEN  UFLAND"` and `"TRISTEN UFLAND"` are one key

**Existing tests to extend:** `quarantine_dispatch_test.ts` (note: `grep -cEi
"alias|ip_address|social_account|canonicalKind" quarantine_dispatch_test.ts` = **0**, against
`rejected_dispatch_test.ts:107` which does pin it — the alias gap is untested on the
quarantine side), `rejected_dispatch_test.ts`, `reviews_test.ts`,
`confidence_integrity_recompute_test.ts`.

**Post-implementation corpus audit SQL** (all must read 0):
- selectors with >1 effective cluster
- selectors with contradictory effective quarantine
- evidence row count unchanged
- orphan reviews

---

## 11. What would make this the wrong solution — the honest answer

**Partly true, and it deserves the operator's attention.**

The strongest falsifier: **the duplication is a write-path identity bug, not a read-path
aggregation problem.** If so, a projection makes an avoidable corpus *legible* instead of
stopping it being *produced*.

Evidence, now confirmed empirically:
- `source` — the third component of row identity (`lib/artifact-hygiene.ts:47-60`) — is
  unvalidated model free text. **1,775 distinct strings over 11,253 rows.**
- **301 of the 714 duplicated selectors have only ONE distinct source.** **42% of the
  duplication is not explained by I2 at all.**
- The canonical case is one provider spelled four ways: `oathnet_lookup`,
  `breach_check (oathnet_lookup)`, `breach_check (oathnet_lookup) + serus_darkweb_scan`,
  `oathnet_lookup type:name`. **`artifactDedupKey` correctly saw four keys. There was never a
  dedup bug.**

**The smaller change that would collapse 42% of it at source:** replace the raw `source`
component of `artifactDedupKey` with `classifySource(source)` — the source **class**, which
already exists and is *already the unit independence is counted in*
(`lib/finding-row.ts:78-147`, `countIndependentClasses(sources.map(classifySource))`). One
provider reworded is then one key, and row B is never inserted. **I2 is preserved in the sense
that matters** — a genuinely independent *class* still mints a row.

Reviewer 2 goes further and argues a projection **object** is not yet justified — only key
unification plus consumer unification — since the four live defects are each a local fix:
(a) the `buildRefusedKeys` raw-kind alias gap; (b) two `Math.max` deletions (`cache.ts:564`,
`useThreadArtifacts.ts:93`); (c) four consumers calling `isSubjectUnlinked` where they must
honour `linkage_confirmed` (`lib/cluster.ts:141-149`, `graph.ts:240`, `recovery.ts:120`,
`src/lib/quarantine.ts:54` — only `reviews.ts:134` and `dispatch-quarantine.ts:187` honour it
today); (d) union-find over rows instead of selectors.

**My assessment:** reviewer 2 is right that the *object* is not what closes the contradiction
— the shared **key** and the shared **ladder** are. But PR 1 as scoped is mostly key + ladder
already, with `SelectorRecord` as the carrier for `members[]` provenance, which (c) and the
disclosure requirement both need. **I would ship PR 1 as scoped and add the `classifySource`
dedup change as a sibling PR**, because it is the only change that reduces the corpus rather
than interpreting it.

**This is a genuine fork and it is the operator's call, not mine.**

---

## 12. Risk assessment

| Risk | Severity | Mitigation |
|---|---|---|
| Changing the kind component repartitions refused **and** rejected sets | **High** | Land items 6+7 in one commit; parity test on both sets |
| `refusedKeys()` shim not byte-compatible → silent boundary change | High | Shim pinned by a test asserting set equality against current output on the fixture |
| Incomplete artifact read yields a partial projection | Medium | `complete`/`incompleteReason` carried through; **fail-open preserved** — an incomplete read must not refuse every tool call (existing `loadRefusedArtifacts` contract) |
| Quarantine reason regexes break | Medium | Carry reason verbatim per member; test `isNameOnlyHarvestQuarantine` / `isBulkCorpusQuarantine` against projected members |
| Frontend/backend projection drift | Medium | Parity test from day one; frontend module ships with no importer |
| Phone/URL normalizer divergence | Low (deferred) | Pinned as KNOWN with a test documenting current behaviour |
| Contested state surfaces as a new UI concept | Low | Not surfaced in PR 1 — enforcement only |

**Not a risk, because excluded:** no DDL, no backfill, no RLS change, no write-path change, no
production data mutation.

---

## 13. Should the finalize-deferral fix be a separate PR?

**YES — separate, and it should land FIRST.** Both reviewers, independently and emphatically.

1. **Different invariant family with a worse accident history.** Finalize is governed by I-1
   and I-2 and by the documented termination oscillation (`FORCE_TOOL_CALL_UNTIL_FINALIZE`
   drove self-completion 61%→25%; pure `"auto"` ended runs on unfinished narration), pinned by
   `recovery_test.ts`, `orchestrator_finalize_test.ts`, `intermediate_step_plan_test.ts`, which
   assert their kill switches ship ON. `CLAUDE.md` says outright: **do not add work inside the
   finalize window.** The projection lives under the evidence-integrity family (I1-I11).
2. **A reviewer competent to judge one is not thereby competent to judge the other**, and a
   bisect across a bundled commit cannot separate them.
3. It is small and independent: one bounded deferral counter plus a hard wall-clock floor.

---

## Appendix — what changed during this pass

Findings that arrived after the design brief was written, all folded in above:

1. `record_artifacts` **cannot** compute quarantine — upgraded LIKELY → **CONFIRMED**; no gate
   exists on that path at all.
2. The frontend **already has** a projection (`dedupeArtifacts`) violating I1/I2/I9 today,
   untested. The design **replaces** a wrong projection rather than introducing one.
3. Timeline-vs-Table — **both my earlier explanations refuted**; real cause is
   `ConfidenceExplain.tsx:58`.
4. `artifact_linkage_releases` has **no writer anywhere** — corrects my earlier claim that the
   release plumbing was live and it was merely a caller problem.
5. Migration-pipeline gap makes every DDL option undeliverable, and CI's green assertion
   actively misleads.
6. Cluster ids derive from **array index with no ORDER BY** — non-deterministic across runs.
7. The gate query was run: **restore branch = 0 in production.**
8. **301/714 duplicated selectors have a single source** — the §11 fork.
