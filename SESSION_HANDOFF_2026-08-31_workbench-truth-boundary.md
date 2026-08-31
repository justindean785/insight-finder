# Session handoff — 2026-08-31: the Investigation Workbench design, and the truth boundary under it

Supersedes nothing. Reads alongside
`SESSION_HANDOFF_2026-08-26_workspace-pass-and-production-defects.md`, which
remains correct. **Every number here is a dated measurement, not a state** —
re-run the gates rather than trusting the table below.

Design dossier (the approved plan, updated with the operator's decisions):
<https://claude.ai/code/artifact/8e86e02c-5a30-41e1-8c7a-206418d83cb8>

---

## 1 · State, verified 13:35 UTC

| | |
|---|---|
| `main` | `21c3403` — **unchanged this session**, re-fetched twice |
| Working branch | `claude/investigation-workbench-milestone-wqa3vm` (pushed) |
| Last **code** commit | **`3ab9e59`** — the two commits in §3. Everything after it on this branch is docs-only, so the head is always further along. |
| Code ahead of `main` | 2 commits · 22 files · +1554 / −116 · `git diff --shortstat 21c3403...3ab9e59` |
| Whole branch ahead of `main` | more, and growing with each docs commit — resolve it, do not read it from here |
| PR | **NONE OPENED** — operator instruction was push-and-stop |
| Live `/health` build | `dcd51a2` · `glm-5.2` via the DeepSeek slot, `pinned` · `reveal_breach_data: true` |
| Frontend gates on `3ab9e59` | **1695 passed / 1 skipped / 136 files** · typecheck 0 · lint **10 warnings, 0 errors** · build 0 · consumer inventory 0 |

⚠️ **This table deliberately does not name the branch HEAD.** The first version
did, and it was wrong within one second: it recorded `3ab9e59` and then committing
this file moved the head to `3b551f0`, so the handoff's own state table was a
commit behind the branch it described. A second session caught it. Any SHA a
handoff writes about itself is stale the moment it is committed — so read the head
with `git rev-parse --short origin/claude/investigation-workbench-milestone-wqa3vm`
and treat `3ab9e59` as what the gate figures above were measured on. Docs commits
change no code, so those figures stay valid.

**No backend change. No deploy performed, none owed. No migration written or
applied. #516 and #519 untouched** — #519's head `370e6da` exists only on its own
remote branch and is not in this branch's history.

Baselines moved: **1695 / 136 files** (CLAUDE.md's recorded 1611 / 131 is stale;
so is the 1629 / 133 measured at the start of this session, before 66 tests were
added). ⚠️ The second commit message says "137 files" — that is wrong, it is 136.

---

## 2 · What this session was for

The operator asked for an implementation-ready design for an **Investigation
Workbench**, then authorised **PR 1 only**. The design phase produced the dossier
linked above; the implementation phase delivered the *truth boundary* that PR 1
was told to stand on, and **not** the workspace UI. Section 6 is the honest split.

Three findings reframed the milestone. All three are measurements against the
running app at `21c3403`, not readings of documentation.

### 2.1 · The connection engine produces one connection

On the 42-artifact harness case:

```
buildEntityGraph(...) -> {"nodeCount":42,"edgeCount":42,
                          "realEdgeCount":1,"clusterCount":16,"isolatedCount":41}
```

The Graph tab renders "42 entities · 1 real link · 16 clusters" and the Clusters
lens renders **sixteen cards of "1 artifact · 1 tool"**. A cluster of one is not
a cluster.

**The cause is a self-cancelling pair, and it is the single most important thing
in this handoff.** `entity-graph.ts` creates an edge only where two artifacts
share the *same normalized selector string*. `useThreadArtifacts.dedupeArtifacts`
collapses same-kind/same-value rows into one **before the graph ever sees them**.
The hook destroys exactly the duplicates the edge rule needs. What survives is
cross-kind coincidence on `metadata.parent` / `metadata.handle`, which is rare —
hence one edge.

There is also nowhere to put a relationship: no `relationships`, `entities` or
`edges` table exists, so the graph is recomputed client-side every render and
nothing accumulates across pivots. **Do not try to fix the graph by tuning
`entity-graph.ts`.** The fix is a persisted, scored edge model (dossier §8) and it
is PR 3a.

### 2.2 · Five confidence pipelines reached the screen

Not three, as first reported. Measured:

| Pipeline | Rendered by |
|---|---|
| raw `a.confidence` | board figure/rule/peek/drawer/citation, timeline, overview, graph node + meter, cluster and band ranges |
| `adjustedConfidence(a, review)` | EvidenceMatrixTab, unconditionally |
| `review ? adjusted : raw` | `CaseReport.confOf` **and** `buildReportMarkdown` |
| `min(stored, cap)` | `effectiveFindingConfidence`, engine findings only |
| `explainConfidence(a).final` | ConfidenceExplain — a full re-derivation that never reads `a.confidence`, on a popover mounted on **every** board row |

`j.harker@northgate-logistics.com` stored 88 and read **88 on the board, 93 on
the table**, and either in the report depending on review state. Inside one
EvidenceMatrixTab tile the **bar width was raw while the numeral was adjusted**.

### 2.3 · The pivot gate was narrower than every other authority surface

`quarantineSets` classified with `isQuarantined` alone. Every other surface —
clusters, graph, report, confidence dimensions, and the analyst-facing chip in
`authority.ts` — gates on `isClusterIneligible`, which is
`isCollisionArtifact(a) || isQuarantined(...)`. So the **collision family** reached
the pivot list: `excluded_collision` and `metadata.status === "excluded"` (both
written deterministically by `record_artifacts` via `isUnrelatedEntity`), plus
model-written `collision` / `possible_collision`.

On the harness case the ruled-out namesake `j.harker@harker-legal.example` ranked
**#1 at HIGH, score 1412**, while being excluded from every other surface.

The `else` branch made it worse than a miss: an ineligible row landed in
`linked`, and `isInert` treats one linked observation as a *restore* — so a
ruled-out namesake handed full pivot authority back to a value a genuine
`subject_unlinked` row had quarantined.

---

## 3 · What shipped on the branch

### `a3aa5ed` — one pivot boundary, one displayed number

- **Pivot gate**: the denial predicate is now **injected** into `quarantineSets`,
  and `pivot-engine.ts` passes `isClusterIneligible`. Parameter types widened to a
  structural `AuthorityInput`; **no predicate changed what it matches**.
- **`src/lib/display-confidence.ts`** (new): `effective = cap === null ? stored :
  min(stored, cap)`. No bonuses, no review deltas, `=== null` throughout so a
  recorded cap of **0** clamps to 0. This is `effectiveFindingConfidence`
  generalised from findings to every row — a function that was already correct,
  already tested, and had **zero callers**. The two are pinned equal by test.
- **Fixture fidelity**: the harness stored `confidence_cap_applied` at artifact
  top level. It is not a column on `artifacts` and production writes it inside
  `metadata`, so **every fixture cap was invisible** and no screenshot exercised
  the cap path. 20 occurrences moved.

### `3ab9e59` — completing a sweep that `a3aa5ed` overclaimed

`a3aa5ed` said "every surface". It was not true. A tree-wide script found four
more consumers, one of which made an assertion in `a3aa5ed`'s own test file wrong:

1. `buildReportMarkdown` kept the review-dependent expression — a third pipeline
   shipping its inconsistency into an **exported document**.
2. `ConfidenceExplain` rendered `explainConfidence(a).final` as its headline.
3. **`lib/audit/from-artifacts.ts`** — `artifactsToSources` and
   `artifactsToClusterAudit` emitted `a.confidence ?? 0`. `a3aa5ed` claimed these
   models had "no artifact-backed builder" and were dev-only. **Wrong**:
   `CaseReport.tsx:17` imports both, so they reach production and feed the
   confidence linter, whose job is comparing a declared tier against the evidence
   beneath it.
4. The six `review.set(..., { confidence: a.confidence })` contexts, which become
   `analyst_feedback_events.confidence_before` — the model's prediction *at the
   moment of the decision*. Logging raw would have made every calibration band
   measure a figure the product never displayed.

Plus the low-confidence counters in `PivotsTab` and `ThreadSidebar`.

**`scripts/verify-confidence-consumers.sh`** (new) sweeps the tree rather than
checking a list, exits nonzero on any violation, prints no unconditional "clean"
line, and documents its three exemptions. Verified to exit 1 when a raw read is
injected and 0 when removed.

---

## 4 · ⚠️ Traps — every one of these cost time this session

- **`intel.ts` has ZERO executable change. Its entire diff is comments.** Verify
  with `git diff origin/main -- src/lib/intel.ts | grep -E '^[-+]' | grep -v '^[-+]{3}' | grep -vE '^[-+]\s*//'` → empty. **Keep it that way.** The
  first attempt deleted the corroboration bonus and lowered CONFIRMED 85→80 to
  compensate. The arithmetic was right and the change was still wrong: it
  compensated the **one rung that had a test**, while the same +5 also lifted rows
  over the 70 CORRELATED rung and the identity branch's own 70, and the separate
  direct-profile +5 lifted rows over 85 / 65 / 40. Four rungs would have moved
  silently in production, with a green suite. The resolution is the split:
  **classification may weigh source independence; a rendered figure may not
  re-derive it.** `src/test/label-ladder-boundaries.test.ts` pins all of it.

- **Do NOT apply `isClusterIneligible` to the finding-origin guard in
  `pivot-engine.ts`.** It keys on one source row, so it blocks unconditionally and
  discards `isInert`'s per-row restore rule. It cost three green over-suppression
  tests before being reverted. The comment there records why.

- **Do NOT widen `isCollisionArtifact`** (it is also the report's collision-section
  membership test), **do NOT import `report-hygiene` into `quarantine.ts`** (that
  edge is a cycle), and **do NOT stamp metadata** to fake quarantine (it inverts
  for a row carrying both `possible_collision` and `linkage_confirmed`).

- **`CaseReport.tsx` carried a literal NUL byte** at offset 40905 — a Set-key
  separator written as a raw byte, **pre-existing on `main`**. `file` reported the
  file as `data` and **grep skipped it as binary**, so a source-guard sweep could
  not see inside it at all. That is precisely how a consumer hides from an
  inventory. Now a `backslash-u-0000` escape. If you add a sweep, check for NUL first.
  (Writing *this handoff* put a literal NUL back into a repo file on the first
  attempt, which is how the check earned its keep twice in one session.)

- **The shell cwd resets between Bash calls** in this sandbox. `npx vitest` from
  `/home/user` silently resolves the wrong root and reports "no tests".

- **A handoff cannot record its own commit SHA.** §1's first version named the
  branch head, and committing the file moved that head — so the document was one
  commit behind the branch it described, and a second session caught it during
  verification. It is the same shape as the defect this whole session was about:
  a surface asserting a number it is not in a position to know. Name the branch,
  name the last CODE commit, and let the reader resolve the head.

---

## 5 · Corrections to inherited facts

- **The production frontend is `https://insight-finder-sandy.vercel.app`.**
  `https://insight-finder.vercel.app` serves *"ResearchScan — Discover Research
  Gaps"*, a PubMed tool — a different product entirely. CLAUDE.md says "use the
  Vercel URL" and never writes it down, so the guessable one wins. **This
  correction is deliberately not in CLAUDE.md** (operator: no documentation-cleanup
  project); it lives here until someone touches that file for another reason.
- **Production was verified at `21c3403`** by hash comparison: every
  env-independent content-hashed chunk on the deployed site matches a local
  `npm run build` byte-for-byte. Only the entry chunk differs, because
  `VITE_SUPABASE_*` is compiled into it.
- **Frontend baseline is 1695 / 136**, not CLAUDE.md's 1611 / 131.
- **In production the four Anderson Ave co-residents carry NO structural exclusion
  flag.** `queryIsNameOnly` is false for `indicia_address`, the bulk-corpus gate
  needs >15 identity rows, and `CO_TENANT_CTX` is oathnet-only — so their exclusion
  exists **only as prose** inside a separate `kind:"contradiction"` artifact. The
  frontend honours the flag the moment it exists; writing it is backend work, and
  intent must never be inferred from that prose.
- **`possible_collision` is never written by backend code.** It reaches artifacts
  only via model-supplied metadata spread verbatim. The deterministic collision
  writer is `excluded_collision`.

---

## 6 · What was NOT done

The truth boundary is complete. **PR 1's workspace UI is not built.** Still open,
all specified in dossier §4 and §9:

- three-pane resizable shell · virtualized full-bleed register · persistent
  inspector (the current one is a modal `Sheet` that dims the list)
- search, and type/source/tool/date/authority filters — **there is no text search
  anywhere in Evidence today**
- keyset pagination replacing `ARTIFACTS_INITIAL_LIMIT = 1000`
- `lib/case-state.ts`, the single case-state selector — **the tab-disagreement
  defect is untouched**: the same case still reports 12 or 18 tools, 2 or 3
  verified, 0 or 34 leads, 35 or 42 findings depending on the tab
- raw payload in production — `ResourcesPanel.tsx` still gates it behind
  `import.meta.env.DEV`, so on the live site you cannot inspect the evidence
  behind a number

---

## 7 · Next steps, in order

1. **Open the draft PR** for `claude/investigation-workbench-milestone-wqa3vm`
   (read the head; do not reuse a SHA from this file) — or ask for the workspace
   UI on top first, then one PR. Operator's
   call; the branch is green and safe either way. **Correct the "137 files" figure
   in the PR body to 136.**
2. **Build the PR 1 workspace UI** (dossier §9, PR 1). One new dependency:
   `@tanstack/react-virtual`. `react-resizable-panels`, `reactflow`, `cmdk` and
   `useDensity` already exist. Screenshot the signed-in workspace via
   `npx vite --config vite.harness.config.ts` → `/chat/11111111-2222-4333-8444-555555555555`
   before and after; fixture caps now actually bind, so the cap path is visible.
3. **PR 2** — one-click pivots, live scan, and `tool_usage_log.artifact_ids`.
   That column is the highest-value backend change in the plan: without it,
   "what did this tool find" and "what did this pivot add" are unanswerable,
   because `artifacts` has no FK to `tool_usage_log`.
4. **PR 3a / 3b** — the connection engine (dossier §8), split for separate review
   and rollback boundaries.
5. **Carry #519's review forward as its own follow-up.** Fail-open is the correct
   policy; the gap is that it is unobservable outside edge logs. Stamp
   `quarantine_boundary: "degraded"` into `tool_usage_log.input_json.runtime` for
   calls dispatched after an incomplete read. Do not mix it into this branch.
6. **Reusable substrate nobody is using yet**: `analyst_feedback_events` already
   reserves `merge` / `split` / `corrected_entity` / `accept_pivot` /
   `reject_pivot` / `manual_tool_selection`, hash-chained and RLS'd, and
   `src/lib/calibration.ts` already implements Wilson intervals, Brier score and
   reliability buckets — with **zero consumers**. PR 3b needs no new schema.
