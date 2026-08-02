# Name normalization and subject clustering — design, not yet implemented

Status: **design for review. No code change. Do not merge as a fix.**
Scope: integrity-critical (identity resolution). Sign-off obtained to *prepare*; none to change behaviour.

Reported symptom (Lovable audit of thread `e66255da`): **83 subjects for 94 artifacts**,
"no name-permutation normalisation and no dedupe of identical values".

The mechanical cause is real and small. The proposed remedy is dangerous, and most of
this document is about why.

---

## 1. Why 83 subjects

`selectorsFor()` in `src/lib/entity-graph.ts:117` is the whole of subject clustering. It
emits a selector for:

    email · phone · handle/username/social · ip · address · wallet · parent

**`name` is not in that list.** A `name` artifact therefore produces *zero* selectors, can
never share a selector with anything, and becomes its own single-artifact subject. 83
subjects for 94 artifacts is what that looks like from the outside. There is no clustering
bug; names were never clustered at all.

Two secondary weaknesses in the same function:

- `address` normalises to `v.toLowerCase().replace(/\s+/g, " ")`, so `123 Main St` and
  `123 Main Street` are different subjects.
- `email` normalises to lowercase only — no plus-addressing or provider-specific dot
  handling. That is arguably correct (`a.b@gmail` and `ab@gmail` are the same mailbox but
  NOT provably the same person), and should stay as is.

## 2. The remedy that must not be built

"Add `name:` to `selectorsFor` so names cluster" is a two-line change and it would be a
serious regression. A selector in this graph is an **identity assertion**: sharing one
merges two artifacts into one subject. Making a name a selector means

> any two artifacts bearing the same name are the same person

which is the definition of a same-name collision, and it is the exact failure that produced
the 2026-07-30 incident: a Maracaibo subject merged with a Houston phone and a Puerto Rico
phone, published as one identity, from an OathNet name search the agent had itself called
*"a CLASSIC same-name collision situation… Many of these are clearly different people."*

Adding permutation matching on top — Hispanic double surnames, `Last, First`, dropped middle
names, diacritic folding — does not soften this. It **widens** it: every permutation rule
increases the number of distinct people the graph will assert are one person. Recall goes up
and precision goes down, on the axis where a false positive fabricates a human being.

The user's own note is the correct instinct and this design adopts it as a hard constraint:
**automatic surname-permutation merging is out of scope permanently, not merely deferred.**

## 3. What can be built safely

Three tiers, in increasing risk. I recommend 1 and 2; 3 only with a UI that never
auto-merges.

**Tier 1 — exact-duplicate collapse (safe, lossless).**
Two `name` artifacts whose values are byte-identical after trim + whitespace collapse +
case fold are the same *string*. Collapsing them for DISPLAY removes list noise without
asserting anything about people. This is the only part of the reported symptom that is
unambiguously a defect. It does not reduce the subject count in any meaningful way — it
merges duplicates of one row, not distinct people.

**Tier 2 — a non-merging `name-match` edge.**
Emit a new edge type that is explicitly NOT `identity`. It renders as a dotted/annotated
link, is excluded from cluster membership, and never collapses two subjects into one. The
analyst sees "these two subjects share a name" and decides. `EDGE_PRIORITY` already ranks
`identity: 3, shared-infra: 2, seed-discovery: 1`; a `name-match: 0` slots in below all of
them and must be excluded from `clusterOf`.

**Tier 3 — permutation *candidates*, analyst-confirmed only.**
Normalisation for candidate generation only: NFD diacritic folding, `Last, First` reordering,
particle handling (`de`, `del`, `de la`, `van`, `bin`), and double-surname subset matching.
Each produces a **suggestion** carrying its rule name and a confidence that never exceeds the
weak-lead ceiling. It must be surfaced through the existing review mechanism
(`applyReviewsToArtifacts`) so a merge only exists once a human has affirmed it, with the
verdict recorded in the custody chain. **No automatic merge, at any confidence.**

## 4. Confidence-safety invariants

- A name match, of any tier, **never raises confidence** on either artifact. Names are not
  corroboration; two sources agreeing on a common name is the single weakest signal in the
  system and is how same-name collisions look from the inside.
- A name match **never creates an `identity` edge** and never contributes to `clusterOf`.
- Tier 3 suggestions are capped at the existing weak-lead ceiling and cannot promote an
  artifact out of `needs review`.
- `isConflict()` already routes `breach` artifacts and anything flagged
  `collision`/`false_positive` away from identity edges. Nothing here may weaken that; a
  name match on a collision-flagged artifact must be suppressed entirely.

## 5. Fixtures — failing before, passing after

Not yet written (no implementation). The set must include, at minimum:

1. Two artifacts, same exact name, different verified emails ⇒ **two subjects**, one
   `name-match` edge, zero `identity` edges. *This is the anti-merge test and it is the most
   important one in the file.*
2. The 2026-07-30 shape: one seed subject in Maracaibo, plus a Houston phone and a Puerto
   Rico phone sharing the seed's name ⇒ still three subjects. A regression here reproduces
   the incident.
3. `Juan Carlos Pérez García` vs `Juan Pérez` ⇒ a Tier-3 *suggestion*, never a merge, and
   the suggestion carries its rule name.
4. `PÉREZ GARCÍA, Juan Carlos` vs `Juan Carlos Perez Garcia` ⇒ same suggestion after
   diacritic folding and reordering; still not a merge.
5. Byte-identical duplicate names ⇒ collapsed for display (Tier 1), subject count unchanged.
6. A name match where either side is collision-flagged ⇒ **no edge and no suggestion at all.**
7. Confidence before == confidence after, for every case above.
8. A subject-count regression guard: for a fixed fixture set, the number of `identity` edges
   must not increase when name handling is enabled.

Fixture 8 is the one that would catch the whole class of mistake: if a future change quietly
promotes `name-match` to `identity`, the identity-edge count jumps and the test fails.

## 6. Migration / backfill impact

**None.** Everything here is frontend graph construction (`src/lib/entity-graph.ts`) computed
at render time from artifacts already in the database. No schema change, no migration, no
backfill, and nothing written to `artifacts` or `evidence_log`.

Tier 3 does touch stored state if suggestions are persisted as reviewable items; if so they
must be written as *suggestions* with their own kind, never as artifacts, and must not enter
the evidence chain until a human confirms them.

## 7. Evidence-loss analysis

- Tier 1: **zero loss.** Byte-identical strings collapse for display; both rows remain in
  `artifacts` and on the Evidence board.
- Tier 2: **zero loss.** Adds an edge; removes nothing.
- Tier 3: **zero loss, but a fabrication risk**, which is worse. Every suggestion is an
  assertion that two people might be one. Mitigated only by never auto-applying it and by
  recording the analyst's verdict.

The reported "83 subjects" is not itself evidence loss. A high subject count on a
name-heavy case is the honest rendering of weak identity data. **Driving that number down is
not a goal** — a low subject count achieved by merging strangers is far worse than a high one,
and the metric should not be optimised.

## 8. Recommendation

Ship **Tier 1 + Tier 2** as one small PR with fixtures 1, 2, 5, 6, 7, 8. Hold **Tier 3**
until the analyst-confirmation path is agreed, because it is the only tier that can invent an
identity. Do not treat the 83→N reduction as the success measure; the success measure is that
fixtures 1 and 2 hold.
