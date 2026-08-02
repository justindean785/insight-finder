# Evidence-log provenance and archival coverage — design, not yet implemented

Status: **design for review. No code change. Do not merge as a fix.**
Scope: integrity-critical (`evidence_log` chain of custody). Sign-off obtained to *prepare*; none to change behaviour.

Production measurement (thread `e66255da`, 94 rows): **94% NULL `source_url`, 0 archives,
100% `soft`, free-text `tool_name`.**

Writing this up before writing code, because the investigation turned up two facts that
change what the fix can be — one of which means part of the problem is **permanently
unfixable**, and one of which is a separate and more serious defect than the one I was
asked to fix.

---

## 1. Where the four symptoms actually come from

Both `evidence_log` write sites are in `tool-registry.ts` (`record_artifacts` ~4797,
`record_evidence` ~5006). Every provenance field they write comes from the **model**, never
from the runtime:

```ts
const sourceUrl = meta.source_url || meta.url || meta.profile_url || meta.archived_url || null;
const evToolName = llmAsserted ? LLM_ASSERTED_PROVENANCE : ((r.source as string) ?? "agent");
```

| Symptom | Cause | Independent? |
|---|---|---|
| 94% NULL `source_url` | Populated only if the model put a URL in `metadata`. The runtime knows the URL it fetched; it is never threaded in. | root cause |
| 0 archives | `archiveAttachment` is gated on `typeof sourceUrl === "string"`. NULL URL ⇒ archiving is structurally impossible. | **derivative of the above — not a separate bug** |
| free-text `tool_name` | `_tool_name: source`, a model-authored string. Two rows from one tool can carry different labels. | root cause |
| 100% `soft` | `classification` is `hard` only at `confidence >= 85`; the confidence caps hold nearly everything below that. | **by design — see §4** |

So this is one root cause (model-asserted provenance) with one derivative, plus one thing
that is not a defect at all.

## 2. Historical rows cannot be backfilled. Ever.

`append_evidence` (migration `20260528050804`) hashes the provenance fields into the row:

```sql
_content := encode(digest(
  coalesce(_tool_name,'') ||'|'|| coalesce(_source,'') ||'|'|| coalesce(_source_url,'') ||'|'||
  _classification ||'|'|| coalesce(_confidence::text,'') ||'|'|| coalesce(_kind,'') ||'|'||
  coalesce(_value,'') ||'|'|| coalesce(_content_snapshot,'') ||'|'|| coalesce(_metadata::text,'{}'),
'sha256'),'hex');
```

`tool_name`, `source`, `source_url`, `classification`, `confidence`, `metadata` are **inside
the hash**. `archive_*` are not — which is why the post-insert archive UPDATE is legitimate
and the analogous UPDATE for `source_url` would not be.

**Consequence: any backfill of `source_url` or `tool_name` on existing rows falsifies
`content_hash` for those rows.** The 94% of rows already written with NULL `source_url` are
permanently, correctly, un-provenanced. That is the chain doing its job: we cannot
retroactively improve the record of what we knew at collection time. The fix is
**forward-only**, and the historical gap must be *disclosed*, not repaired.

*(Whether a disclosure banner belongs on threads whose custody predates the fix is a UI
question I have not answered here.)*

## 3. The larger finding: `verify_evidence_chain` does not verify content

This came out of §2 and is **not** what I was asked to look at, but it materially changes
what the custody UI is entitled to claim.

```sql
FOR r IN SELECT seq, content_hash, prev_hash, chain_hash ... LOOP
  _expected := encode(digest(_prev || r.content_hash,'sha256'),'hex');
  IF r.prev_hash <> _prev OR r.chain_hash <> _expected THEN ... 
```

The verifier recomputes **linkage only** — `chain_hash = H(prev_hash ‖ content_hash)`. It
never recomputes `content_hash` from the row's actual field values.

**Therefore: editing `value`, `source_url`, `tool_name`, `confidence` or `metadata` on an
existing row leaves `content_hash` untouched, and the chain still verifies clean.** The
Custody panel would report *"Chain integrity 100% · No broken links · N events anchored"*
over tampered evidence. The UI's own copy — *"evidence after this point may be tampered"* —
promises a guarantee the verifier does not provide.

The fix is one line in the verifier (recompute `content_hash` from the fields and compare),
but it is **not free**: any row whose fields have already drifted from its stored
`content_hash` for benign reasons would start reporting as broken. That needs a survey of
production before it can ship, and it is a distinct PR. **Flagging, not fixing.**

## 4. What must NOT change

- **No confidence inflation.** `100% soft` is the confidence caps working. `hard` at `>= 85`
  is the existing contract; moving that threshold to make the custody panel look healthier
  would be inventing certainty. Out of scope, permanently.
- **No rewriting existing evidence** (§2 — mathematically prevented, and correct).
- **No widening of `LLM_ASSERTED_PROVENANCE`.** The existing guard that refuses to launder an
  LLM-asserted domain into the authoritative tool/source label is the single best thing in
  this code path and must survive any refactor.

## 5. The hard part, and why there is no code in this PR

The obvious fix — "thread the real tool name and URL in from the runtime" — does not work as
stated, because **at `record_artifacts` time the runtime does not know which tool produced
each row.** `record_artifacts` is itself the tool being executed; the producing tool ran
some earlier step. Per-artifact tool attribution exists only on the auto-persist extractor
path (`auto_persist_source`), not on the model-recorded path.

So real provenance requires one of:

**(a) Per-artifact runtime attribution.** Track, per tool result, which selectors/values it
returned, and match at record time. Most correct, most invasive, and couples to the
`run_id` work already queued.

**(b) A required `source_url` argument on the record tools, refused when absent.** Cheap, but
it makes provenance a model-compliance problem again — and a model that must supply a URL
will supply *a* URL. Risks manufacturing provenance, which is worse than NULL.

**(c) Record what we actually know, honestly.** Add a non-hashed `provenance_origin` column
(`'model' | 'runtime' | 'absent'`) so the panel can distinguish "no URL" from "URL the model
asserted" from "URL the runtime observed", and count archival coverage against only the rows
where a URL was genuinely available. Smallest, ships alone, adds no false precision — but
improves *disclosure*, not *coverage*.

I recommend **(c) now, (a) with the `run_id` work, never (b)**. A NULL `source_url` that is
labelled as such is honest. A model-supplied URL recorded as though the runtime saw it is
the same class of defect as every other one fixed this week: a system reporting a
confidence in its own output that it has not earned.

## 6. Fixtures — what a fix would have to prove

Not yet written (no implementation to test). The failing-before/passing-after set must cover:

1. A record with no URL anywhere ⇒ row is written, `source_url` NULL, origin `absent` — **and
   archival coverage does not count it as a miss.**
2. A record whose URL came from the model ⇒ origin `model`, never `runtime`.
3. A record whose URL the runtime observed ⇒ origin `runtime`.
4. An LLM-asserted row ⇒ `tool_name` is still `LLM_ASSERTED_PROVENANCE`; origin never
   upgrades it.
5. `append_evidence` hash composition unchanged for the existing fields ⇒ a row written
   before and after the change produces the same `content_hash` for the same inputs
   (otherwise §2 breaks for everyone).
6. `verify_evidence_chain` still returns `ok` across a mixed pre/post-change thread.

Item 5 is the one that would catch the worst possible mistake here: silently changing the
hash composition, which would not break verification (§3) and so would fail **silently**.

## 7. Migration / backfill impact

- **New column only, outside the hash input.** Same pattern as `archive_*`.
- **No `UPDATE` of any hashed column, on any row, under any circumstances.**
- No data migration. Historical rows keep NULL `source_url` and gain `provenance_origin =
  'absent'` **as a column default**, which is a statement about what we know, not a claim
  about what happened.
- Reversible: dropping the column loses only disclosure, no evidence.

## 8. Evidence-loss analysis

Under proposal (c), **zero**. No existing row is read differently, no value is dropped,
re-ranked, or re-labelled; one nullable column is added. The only user-visible change is
that the custody panel stops reporting 0% archival coverage as though 94 rows had failed to
archive, when in truth ~88 of them never had a URL to archive.

Under (a) or (b), evidence loss is still zero, but (b) risks evidence *fabrication*, which is
worse than loss and is why it is rejected.
