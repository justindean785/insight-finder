# Independent-source confidence corroboration — design, not yet implemented

Status: **design for review. No code change. Do not merge as a fix.**
Scope: integrity-critical (confidence). Sign-off obtained to *prepare*; none to change behaviour.

Reported symptom (Lovable audit of thread `e66255da`): *"confidence corroboration does not
compound across independent sources."*

That is not quite right, and the correction matters, because the mechanism it says is
missing already exists and is already hardened. The real gap is narrower and in a different
place.

---

## 1. Corroboration DOES compound — on one path

`computeAxes()` in `confidence.ts:35`:

```ts
const corroBoost = Math.min(20, Math.max(0, input.corroborationCount - 1) * 8);
const artifact  = Math.min(100, src + corroBoost);
```

2 independent classes → +8, 3 → +16, 4+ → +20 (ceiling). It compounds, sub-linearly, with a
deliberate cap.

It is also already hardened against the obvious abuse. `tool-registry.ts:5496`:

```ts
const corroborationCount = countIndependentClasses(i.supporting_sources.map(classifySource));
```

Audit **F06** replaced a model-supplied `corroboration_count` integer — a single
`ai_summary` source could claim `corroboration_count: 5` and drive the artifact axis to 100 —
with a server-side count over **distinct source classes**, filtering `NON_CORROBORATING_CLASSES`
(`unknown`, `web_search`, `ai_summary`, `username_sweep`, `social_profile_passive`,
`social_review`, `infra_shared_host`, `threat_intel`). That is the correct shape and must be
preserved by anything built here.

## 2. The real gap: the artifact paths never compute axes at all

`computeAxes()` has exactly **one** call site — the `record_finding` path.

The artifact paths — `record_artifacts`, `record_artifact` (`tool-registry.ts:4539`, `:4871`)
and `auto-record-integrity.ts:30` — call only `applyEvidenceCaps()`. Caps constrain a
confidence downward; nothing on those paths ever *computes* a corroboration boost. So:

> Two artifacts of the same value, produced by two genuinely independent source classes,
> receive **no corroboration credit whatsoever** unless the model separately files a
> `record_finding`.

That is where the 48 flat-55 breach rows sit, and it is the accurate statement of the defect.

## 3. Why the naive fix is the F06 bug one layer down

The tempting change is "count the artifacts supporting a value and boost accordingly." On the
observed thread that would take the 48 breach rows — **all from one provider, oathnet** — and
read them as 48 corroborations. That is precisely the inflation F06 removed, reintroduced
against a different input.

Three independence traps any implementation must survive:

- **Row count is not source count.** 48 rows from one provider is one source.
- **Tool count is not provider count.** `indicia_email` + `indicia_phone` are two tools and
  one upstream; agreement between them is not independent confirmation.
- **Provider count is not class count.** Two providers reselling the same aggregated breach
  corpus are one origin. `SourceClass` is the right granularity precisely because it is
  coarser than the tool and coarser than the provider.

The unit of independence must remain the **distinct non-corroborating-filtered `SourceClass`**,
identical to the existing `countIndependentClasses`. Nothing weaker.

## 4. Proposal

Reuse the hardened path rather than build a second one.

1. On the artifact write paths, group same-value artifacts by their normalised value **within
   one thread**, map each contributing tool through `classifySource`, and derive the count with
   the existing `countIndependentClasses`.
2. Feed that into the existing `computeAxes` boost. Do not introduce a new boost curve — the
   `min(20, (n-1) * 8)` ceiling is deliberate and should stay the single definition.
3. Apply `applyEvidenceCaps` **after** the boost, unchanged, so every existing cap
   (collision, bio-cross-link name at 30, dead-end, `EXCLUDED_COLLISION_CONFIDENCE` at 15,
   tier-C ceiling) still binds. A corroboration boost must never lift an artifact past a cap
   that exists for an integrity reason.
4. Record the derived count and the contributing classes in `metadata`, so the boost is
   auditable rather than an unexplained number change.

**Forward-only.** No historical artifact is recomputed — see §6.

## 5. Confidence-safety invariants

- The boost ceiling stays **+20**. Corroboration cannot carry an artifact from weak to
  confirmed on its own.
- `NON_CORROBORATING_CLASSES` continues to be filtered. In particular `ai_summary` and
  `web_search` can never corroborate anything.
- A boost is computed **only** from distinct classes; row count, tool count and provider
  count are never used as a proxy.
- `applyEvidenceCaps` runs after and wins on every conflict.
- Collision-flagged and `isUnrelatedEntity` artifacts receive **no** boost, at any count.
- Name agreement never counts as corroboration (see the companion name-normalization design).
- The boost is deterministic and recomputable from stored metadata — no hidden state.

## 6. Migration / backfill impact

**No backfill. This is the point at which this design intersects the instruction not to
inflate historical confidence.**

Recomputing existing artifacts under a new boost would raise stored confidences on evidence
an analyst has already reviewed, silently changing verdicts that were recorded against the
old numbers. It would also write to `artifacts.confidence`, and for any row already mirrored
into `evidence_log` the stored `content_hash` covers `confidence` — so a backfill would
either desynchronise the two or falsify the chain (see `docs/design/evidence-provenance.md` §2).

Therefore: new writes only. Historical rows keep the confidence they were recorded with. The
schema change is metadata-only (the derived count and contributing classes), which is not in
the evidence-chain hash input.

## 7. Evidence-loss analysis

Zero rows lost, zero values altered. The risk here is not loss but **unearned confidence**:
a boost applied on non-independent sources is a false increase in certainty, which in an
evidence system is worse than an artifact scored too low. Every invariant in §5 exists to
bound that direction.

Second-order risk: raising an artifact's confidence can move it across a status threshold
(`deriveStatus`) and out of `needs review`. Fixture 7 below pins that.

## 8. Fixtures — failing before, passing after

1. Two artifacts, same value, two **distinct** independent classes ⇒ +8. *Fails today: the
   artifact path computes no boost at all.*
2. Same value, three distinct classes ⇒ +16. Four or more ⇒ +20, never more.
3. **48 rows, one provider** (the observed shape) ⇒ **+0**. The single most important fixture
   here.
4. `indicia_email` + `indicia_phone` on the same value ⇒ **+0** — same upstream.
5. Any number of `ai_summary` / `web_search` sources ⇒ **+0**.
6. A collision-flagged or `isUnrelatedEntity` artifact with three independent classes ⇒
   **+0**, and confidence still `EXCLUDED_COLLISION_CONFIDENCE`.
7. An artifact one point below a status threshold, boosted ⇒ assert the resulting
   `deriveStatus` explicitly, so a threshold crossing is a deliberate reviewed change and
   never an accident.
8. Every applicable cap still binds after the boost — bio-cross-link name stays ≤ 30,
   tier-C stays capped, dead-end stays capped.
9. Determinism: the same artifact set produces the same boost on repeat runs, and the stored
   metadata reproduces it.

## 9. Recommendation

Implement §4 as one PR carrying fixtures 1–9, with **fixture 3 as the gate** — if 48
same-provider rows produce any boost at all, the change is wrong and must not ship. Do not
touch `computeAxes`'s curve, `NON_CORROBORATING_CLASSES`, or any cap. Do not backfill.
