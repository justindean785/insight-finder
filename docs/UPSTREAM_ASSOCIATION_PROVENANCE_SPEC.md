# Upstream remediation spec — association provenance in `auto-persist-findings.ts`

**Status:** specification only. Nothing here is implemented. PR #410 is
frontend-only by assignment and must not cross into the edge function.

**Why this exists:** PR #410 stops unlinked rows being *displayed* as the
subject's evidence. It does not stop them being *created*. Those are different
defects and only one of them is fixed.

---

## 1. The defect

A bulk breach / person-search response (OathNet, people-search, breach lookup)
returns a whole **row** of fields about whatever record matched — and often
about records that merely appeared nearby in the response. `tool_return_extractor`
flattens those fields into standalone artifacts.

Evidence from the live 52-artifact `Ronny.doe` dataset (thread
`bf35151d-5ef6-4e3c-97a4-caf2a421f63a`):

- Unrelated names (`Ron Daoust`, `Ronny Beerling van der Doe`, `Ronald Daoust`,
  `John Ferrant`), unrelated corporate emails, an Ontario address, and phones
  from Canada, Ivory Coast, the Netherlands and the US were all persisted in the
  same extraction batch.
- Every one is classified only as `source_category: breach`.
- No field records **which returned record** linked that value to `Ronny.doe`.
- `reason_for_confidence: "single source class: breach"` describes **source
  quality**, not **identity association** — the two are being conflated.
- Breach corpus names (`SoundCloud`, `Twitter`, `Chegg`) are stored as
  standalone breach artifacts rather than as exposure attributes of a specific
  matched identifier.
- `username_sweep` reports 24 "registrations"; account-existence checks do not
  establish common ownership.

**The core error:** the system is expressing calibrated uncertainty about each
individual row while asserting, structurally, that the rows belong in the
subject's case at all. Confidence scoring cannot repair missing association
provenance — a low-confidence row still enters the dossier as *the subject's*
low-confidence row.

> A source being a breach dataset is not evidence that every field it returned
> belongs to the searched person.

---

## 2. Required fields on every extracted record

| Field | Meaning |
|---|---|
| `queried_selector` | The selector actually sent to the provider |
| `normalized_selector` | Its normalized form (the cache/match key) |
| `provider_row_id` | Provider's row/group identifier for the returned record |
| `matched_field` | Which field of that row matched the query (`email`, `username`, …) |
| `match_reason` | Why it is considered a match, in words |
| `relationship` | One of the five values below |
| `association_confidence` | Confidence that this value belongs to the SUBJECT — **distinct from** source/quality confidence |

### `relationship` values

| Value | Meaning | Analysis-eligible? |
|---|---|---|
| `exact_seed_match` | The value IS the queried selector | Yes |
| `linked_attribute` | Same provider row, explicitly linked to the matched field | Yes |
| `corpus_exposure` | Names an exposure of the matched identifier | Attach to the identifier, not standalone |
| `bulk_neighbour` | Present in the response but not linked to the match | **No — quarantine** |
| `unassigned` | Linkage indeterminate | **No — quarantine** |

---

## 3. Required behaviour

1. Persist as analysis-eligible evidence **only** `exact_seed_match` and
   `linked_attribute`.
2. Quarantine neighbouring fields from bulk breach / person-search rows. Retain
   them — they are not deleted — but they must not reach the subject's identity,
   contact, social, network, risk, confidence or pivot surfaces.
3. Attach breach corpus names to the **exact matched identifier** rather than
   emitting them as free-standing identity evidence.
4. Do **not** promote `username_sweep` existence checks into common ownership
   without corroboration.
5. Keep `association_confidence` separate from source confidence at every layer.
   Do not reuse one as the other.

---

## 4. Open upstream blockers (found while doing #410, deliberately NOT fixed)

### 4.1 Selector classification is split-brain — **live**

- Frontend `src/lib/seed.ts` now requires a defensible TLD before calling a
  dotted token a domain, and marks unrecognised suffixes ambiguous.
- Backend `supabase/functions/osint-agent/validation.ts:247` (`detectSeedServer`)
  still matches **any** dotted token, and `query-type-router.ts:44` carries the
  same rule.
- `validation.ts` is what writes `threads.seed_type`.

**Consequence:** for a seed like `Ronny.doe` the *report* now says
`username (ambiguous)` while the *investigation* still routes and selects tools
as though it were a domain. Fixing this changes agent behaviour and requires a
deploy, so it belongs in the backend lane — but until it lands, the frontend
correction must not be read as an end-to-end fix.

### 4.2 The extractor gate itself

`auto-persist-findings.ts:283` — the gate described in §2/§3 above. Sections 1–3
of this document are its specification.

### 4.3 Duplicate breach-corpus canonicalisation

The same fixture shows one breach recorded twice under name variants:
`Twitter` / `Twitter.com (scraping data)`, `SoundCloud` / `Soundcloud.com`,
`Chegg` / `Chegg.com`. `dedupeBreachDatasets` collapses only the conservative
same-source case.

Reported honestly as a defect and captured in the fixture. **Deliberately not
fixed here** — a general canonicalisation pass is the breach-aggregation
project, and the narrow dedup point owned by the report builder cannot resolve
it without touching scoring authority.

### 4.4 `src/lib/audit/report-serializer.ts` — unreached, same weakness

Its `escape()` handles table grammar only, and line 172 interpolates a URL
straight into a markdown link target: `[link](${s.url})`. It is currently
imported by nothing but its own test, so it ships to no one. Hardening it needs
`mdCodeSpan` extracted into a zero-dependency module first, to avoid an import
cycle (`audit/from-artifacts` already imports `intel`). Flagged rather than
fixed, because fixing dead code silently is how it later ships unreviewed.

---

## 4a. Audit: can identity-cluster membership stand in for subject association?

**No.** Asked and answered empirically, not by inspection.

`signalsFor` (intel.ts) emits merge keys for only: `email`, `phone`,
`username`/`handle` (plus `metadata.handle`), `address`, `ip`, `wallet`, and
`metadata.parent`/`parent_seed`/`seed`. Everything else produces **no key**, and
`bucketQualifiesAsCluster` rejects a singleton with `keys.size === 0`.

| Group / kind | Can enter a cluster? | Survives the predicate as a seed-linked singleton? | Verdict |
|---|---|---|---|
| email, phone, address, ip, wallet | yes | yes | clusters normally |
| username / handle / social with `metadata.handle` | yes | yes | clusters normally |
| name / person | no key of its own | yes — `NAME_KINDS` short-circuit | clusters normally |
| **domain / DNS / hosting** | **no** | **no** | would be quarantined |
| **legal / public record** | only via `metadata.parent` | **no** without it | would be quarantined |
| **threat / reputation** | **no** | **no** | would be quarantined |
| **breach / corpus observation** | **no** | **no** | would be quarantined |
| **url / web / archive** | **no** | **no** | would be quarantined |
| **source-conflict rows** | **no** | **no** | would be quarantined |

The failing case is not hypothetical: with seed `example.com`, a `domain`
artifact whose value IS `example.com` produced no merge key, reached no cluster,
and was removed from Network Connections and listed as unassigned — the domain
quarantined out of its own investigation.

**Resolution.** `isSubjectLinked` is now its own exported contract, independent
of clustering, and the graph admits a row by EITHER route:

```
inSubjectGraph(a) = clusteredIds.has(a.id)          // corroboration
                 || isSubjectLinked(a, seedValue)   // association
```

The four concerns stay separate, as they must:

- **association** (`isSubjectLinked`) — is this row tied to the queried selector?
- **corroboration** (cluster membership) — is it backed by a second signal?
- **identity clustering** — which rows are identity CANDIDATES?
- **Unassigned Observations** — retained rows whose association is genuinely
  unresolved.

Pinned by two tests that must both hold: an unrelated bulk neighbour stays out
of the graph, and seed-linked `domain` / `legal_record` / `url` rows stay in.
Mutation-verified — collapsing the gate back to cluster membership fails the
second.

**Wording.** The section states only what is observed: "no recorded link …
association UNRESOLVED — not disproved". Absence of provenance is not proof of
absent relationship, and the earlier phrasing ("neither corroborated nor tied to
the selector") asserted both halves when only one was established.

**Residual limitation, honestly stated:** a genuinely subject-linked row that
carries no recorded link and does not corroborate — an IP discovered for the
subject's domain, say — still lands in Unassigned. That is the upstream
provenance gap (§2) surfacing, not a display bug, and the wording is calibrated
to it.

## 5. What PR #410 does and does not establish

**Does:** analyst-rejected, pipeline-excluded and unlinked single-artifact rows
no longer reach the subject's profile, aliases, identity/registration tables,
breach table, KPIs, average confidence, source counts, risk, radar, pivots,
clusters, evidence matrix, or the exported markdown — and the counts reconcile
as `recorded = analyzed + excluded`.

**Does not:** prevent those rows being created, fix backend selector routing, or
give any row a real association provenance. Every §4 blocker is still open.
