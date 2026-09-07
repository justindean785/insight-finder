# Session handoff — 2026-09-07 · #551 shipped, #548 closed, and a premise two sessions got wrong

> **Everything here is a dated measurement (2026-09-07T13:05Z), not a state. Re-verify before acting.**
> §5 carries **one open operator ruling** that blocks the next session's largest item. Read it first.

---

## 1 · Exact state at handoff

| Axis | Value | How measured |
|---|---|---|
| `origin/main` | **`a19f0653c8155413dc029797673933cc5b452868`** (#551 squash-merged) | `git rev-parse origin/main` |
| Previous main | `b030afc` *"Create 2026"*, itself on `1c2ceba` | `git log` |
| Live `osint-agent` build | `7b0138d` — **unchanged; nothing was deployed to the edge** | `curl …/osint-agent?health=1` |
| Vercel production | `dpl_7aNx7yjbVAdpAgy1xnzAyuT1biAp`, `READY`, `target: production`, SHA **`a19f065`**, alias `insight-finder-sandy.vercel.app` | `mcp__Vercel__get_deployment` |
| CI on `a19f065` | **all green** — Frontend, Edge (deno), Migrations, **Workspace e2e all `success`** | GitHub check-runs API |
| Gates re-run on merged main | **1918 passed / 1 skipped / 155 files**; tsc clean; eslint 0 errors / 11 pre-existing warnings; build clean; no `harness.local` in `dist/` | run locally on `a19f065` |
| Mirror `HEAD` | `68521e8` *"Fixed chat error handling"* — Lovable-authored, **not synced by this session** | `git log` in the mirror checkout |
| Open PRs | **8 open, all draft** (#502 is non-draft) after #548 closed and #551 merged | GitHub API |

**Frontend-only change. No edge deploy, no mirror sync, no migration.**

⚠️ **`CLAUDE.md` baselines are stale.** It states `1818 / 1 / 149`; measured on `1c2ceba` it was
`1904 / 1 / 154`, and on `a19f065` it is **`1918 / 1 / 155`**. Its handoff index is also stale — it
names `2026-08-31` as newest; `2026-09-03` and this file supersede it. Refreshing both is a
zero-risk task for the next session and the stale-baseline defect has now recurred **three** times.

⚠️ **Stray file on main.** `b030afc` committed the Game Plan to a path literally named
`gameplan9/7/2026` — the slashes in the date became directories. Harmless, but it belongs at
`docs/` with a real filename. Left alone deliberately.

---

## 2 · ✅ RESOLVED — the duplicate PR

Two sessions independently built the #545 remnant fix on 2026-09-07. **They genuinely conflicted** —
`git merge-tree` reported content conflicts in both `ChatWindow.tsx` and
`network-drop-wiring.test.ts`, so only one could land.

| | #548 | **#551** |
|---|---|---|
| Outcome | **CLOSED** as superseded | **MERGED** as `a19f065` |
| Diff | 2 files, +42 / −24 | 3 files, +586 / −19 (461 of those one new test file) |

**Nothing was ported from #548.** Its `clearError()` insight was correct and is preserved in #551.

Why #551 won, on measurement rather than authorship:

1. **It closes the in-flight window #548 leaves open.** #548 deletes `networkDropWhileAlive`
   outright, leaving the render gate true for the whole `await …last_heartbeat_at` round-trip — red
   card plus a Retry that starts a second concurrent run — until `clearError()` fires. Measured
   against the shipped ordering: **card visible during the liveness read = `true`**.
2. **It corrects the false premise instead of entrenching it** (§3).
3. **Evidence level.** #548's mutants are killed by `toContain(...)` source-text assertions, which
   prove text is present, not that behaviour holds. #551 mounts the real `ChatWindow` and kills
   6 mutants behaviourally.
4. **#548's baseline was stale** — `1879 / 1 / 153`, measured against its original base `972131a`.

**Process lesson:** the two were built four hours apart in mutual ignorance. **Run
`list_pull_requests` before starting work, not after.**

---

## 3 · The correction that matters most — the SDK store does **not** survive an unmount

This false premise drove **both** sessions, so state it precisely.

**Claim** (in `ChatWindow.tsx`'s DB-reseed comment, repeated in #548's source, tests and body, and
in the #551 task brief): `useChat` keys a store by `threadId` and that store — messages, status
**and error** — survives a component unmount.

**Measured: false.** On `@ai-sdk/react` **3.0.199** — the version `package-lock.json` pins, so this
is what CI and production actually run — `useChat` constructs its `Chat` inside a `useRef`, so the
store is **per-mount** and dies with the component. There is no module-level store keyed by id.
Verified three ways: the dist source (`const chatRef = useRef(new Chat(...))`); behaviourally
(mount → force `Load failed` → unmount → remount same id → `error` is `undefined`); and against
upstream `vercel/ai`, `packages/react/src/use-chat.ts`.

*Version trap:* `package.json` declares `^3.0.193` and `ai@^6.0.191`; the lockfile resolves
**3.0.199** and **6.0.197**. #548's body cited the ranges as if they were resolved versions. Always
read the lockfile.

**Consequence:** "make the suppression as durable as the surviving error" was a false requirement —
the two already had identical lifetimes. The real defect was the in-flight window. #551 corrects the
comment in place and adds a test that *measures* the lifetime, so an SDK upgrade reintroducing a
shared store fails loudly rather than silently restoring the defect.

---

## 4 · What shipped

**#551, merged and live.** Three behaviours:

- **Synchronous claim before the await** — the suppression and the SDK's error write batch into one
  render, so the card never paints during the liveness read.
- **`clearError()` on a proven-live run** — removes the error from the SDK's own store rather than
  masking it; guarded on identity so a run started during the await is never disturbed.
- **Identity-keyed suppression** (`suppressedDropError === error`) rather than a boolean. This is
  load-bearing: the status-based reset effect can miss a `submitted → error` transition inside one
  React batch, so the derived comparison is what actually expires the exemption. Mutant M6 proves it.

Six mutants, six killed: remove `clearError`; suppress after the read; heartbeat guard fails open;
broaden the drop predicate to swallow `terminated`; drop the not-alive revert; boolean instead of
identity.

**Not done, deliberately:** no edge deploy, no mirror sync; the evidence-authority audit (§5) was
scoped and measured but **not started**; the bare-name pivot guard remains **declined**; `#494`,
`#529` and the `artifactDedupKey` work were not touched.

---

## 5 · ⛔ ONE OPEN OPERATOR RULING — §B, and it blocks the next session's biggest item

`NEXT_SESSION_PROMPT.md` §B (`artifactDedupKey` — make corroboration accumulate) is ranked the
highest-value accuracy item in both the 09-03 handoff and the operator's Game Plan. **It is
currently blocked on one ruling that has not been written down**, and that ambiguity has already
caused confusion across sessions.

### What the record actually shows

The rejection is real but its scope is **not** what a one-line summary suggests. Primary sources:

- **PR #305** (closed unmerged 2026-07-14) carried a dedup migration whose key **ignored selector
  scope**. A production simulation showed it would delete **~120 genuinely distinct rows** (different
  platform / subject / host / breach) and **orphan 53 real analyst reviews**. *That* is the
  "data-loss / review-orphaning failure."
- **PR #307** (closed unmerged 2026-08-20) was the careful fix for it: a selector-scope-aware key
  plus a single canonical `merge_artifact_into(loser, survivor)` that asserts thread + user equality,
  preserves the survivor's `subject_id`/`cluster_id`, **unions** provenance and classes, re-points
  evidence and reviews, and surfaces conflicting analyst verdicts as `recheck` with lineage rather
  than discarding them. Its production simulation: 6,889 → 6,387 artifacts, 502 true duplicates
  consolidated across 376 groups, **0 distinct-platform / subject / selector loss, 53 reviews all
  re-pointed, 0 discarded**.
- #307 derives merged confidence with **`GREATEST`**. That is the likely origin of the
  "minor-safety confidence bypass" concern: if one copy is capped low for minor-safety reasons and
  another is not, taking the maximum bypasses the cap.

So the shape that was rejected is a write-path merge that **(a) keys on a normalized value without
selector scope** and **(b) derives merged confidence by taking the maximum**. #307 already
demonstrated a design that avoids (a) and would need only a rule change for (b).

### What the ruling must say

The operator was offered two options and has **not yet chosen**:

- **(A) Confirmed / declined outright** — §B is declined; do not re-propose a write-path merge
  without new sign-off. The 7.9 % signal problem stays open; display-layer grouping only.
- **(B) Partial** — name exactly what was rejected (candidates, from the record above: taking
  `GREATEST` confidence on merge · backfilling existing rows · value normalization without selector
  scope) and keep §B open in narrowed form.

**Until this is written down, no session may start §B.** `NEXT_SESSION_PROMPT.md` §B has been
marked `AWAITING OPERATOR RULING` with this evidence inline.

### Fresh measurements that should inform the ruling

Corpus, 2026-09-07 via `query_database`:

- **11,079 artifacts; 852 redundant rows (7.7 %) across 138 threads.**
- Causes: **503** same value / different `source` string · **317** identical key
  (**143 of them written inside one sub-2-second batch**) · **32** case-only value difference.
- **46 rows across 15 threads** carry `metadata.sources` with ≥2 entries — proving the merge
  **already fires** — *and* still have a sibling duplicate row. A confirmed **distinct** failure
  mode, and a subset, not the dominant cause.
- Max **6** copies of one value in one thread; **1,559** rows sit inside duplicate groups.

⚠️ These supersede the `840 across 695 selectors` figure in `SESSION_HANDOFF_2026-09-03` §4.3 and
`NEXT_SESSION_PROMPT.md` §B.

**This suggests §B splits in two**, which may make the ruling easier:

- **B1 — a straight bug.** The merge fires into `metadata.sources` while the insert is *not*
  suppressed (46 confirmed rows). Fixing that needs no merge-semantics redesign.
- **B2 — the design question.** Source-set semantics, per-kind value normalization, merged-confidence
  derivation. This is what needs the written sign-off, and it is integrity-critical.

---

## 6 · Queued next priority — the evidence-authority / causal-provenance boundary

**Operator's framing, verbatim:**

> Allow broad discovery, but do not grant subject authority without durable linkage. This is **not**
> the declined bare-name dispatch guard — searches remain permitted. The control belongs at
> **persistence / read authority**, so unlinked results remain visible leads without entering subject
> identity, confidence, graph or report conclusions.

The audit must explain, **using the real production control flow**, why:

1. A `username_sweep` result followed by `jina_reader_scrape` counts as two independent classes and promotes the Linktree artifact to 80.
2. "Not found" / "0 hits" from `oathnet_lookup`, `breach_check` and `serus_darkweb_scan` persist as `breach_exposure` at 55–60 instead of remaining negative tool outcomes.
3. Legal allegations from a common-name search persist with `subject_id`/`cluster_id` at 55–65 without a shared durable selector.
4. "Since 99" becomes a birth-year inference, Spotify listener geography becomes subject geography, and "Queens Ave General" becomes an address artifact.
5. A "No Instagram profile found" artifact survives later positive Instagram retrieval, with `contradictions` still empty.
6. The same Appeal-Democrat claim persists multiple times with different confidences and cluster IDs.
7. Direct TikTok→Instagram→`@9200barloz` references and shared content fail to join the profiles.
8. `confidence`, `promoted_confidence`, `confidence_tier` and `confidence_cap_applied` disagree on one row.
9. An arrest record is classified `law_enforcement_unit`.

### Behavioural fixtures — thread `635eba0e-825f-4541-a713-28af3151bf36` ("Username: Moneybarloz")

| Artifact ID | Shape it demonstrates |
|---|---|
| `bae4bb0a` | Linktree at 80 on derived corroboration (`username_sweep` + a scrape that followed it) |
| `002949f9` / `048a2361` / `98ef9ca5` | null results stored as `breach_exposure` at 55–60 |
| `5cfb3ed7` | `metadata.sources[]` merged **and** a duplicate row persisted |
| `22668cb5` / `55eb72db` | same, plus a case-variant Instagram URL |
| `1637ae03` / `d8792d15` / `3597797c` / `0d88068b` | one Appeal-Democrat claim → four rows, four clusters |
| `743b2e55` | "No Instagram found" vs later positive retrieval; `contradictions` empty |
| `66c7ed4f` / `2825a09d` / `72992f6c` | hypothesis persisted as evidence |
| `d8dbd6bd` | arrest → `law_enforcement_unit`; conf 55 / promoted 40 / tier Weak / cap 55 |
| `dcf2db8c` | audience statistics → `infrastructure` |

Thread `635eba0e`: 66 artifacts, 24 quarantined, ~14 singleton clusters — which is why **62
artifacts produced 0 engine-adjudicated findings**.

---

## 7 · Corrections to standing documents

| Document | Correction |
|---|---|
| `CLAUDE.md` | Frontend baseline `1818 / 1 / 149` → **`1918 / 1 / 155`** on `a19f065` |
| `CLAUDE.md` | Handoff index names `2026-08-31` as newest; `2026-09-03` and this file supersede it |
| `ChatWindow.tsx` | "store SURVIVES an unmount" — false on the installed SDK; **corrected in #551** |
| `NEXT_SESSION_PROMPT.md` §A | Name-pivot guard — **declined by the operator.** Do not implement or propose |
| `NEXT_SESSION_PROMPT.md` §B | **AWAITING OPERATOR RULING** (§5). Numbers stale: `840/695` → `852` / 11,079 |
| `SESSION_HANDOFF_2026-09-03` §4 | Ranked plan superseded by the operator's `Insight_Finder_Game_Plan.md` (2026-09-07) |

---

## 8 · Traps that cost time this session

1. **The brief's premise was false.** Two sessions built against "the SDK store survives unmount."
   Measure the SDK, not the comment about it.
2. **A behavioural test can pass vacuously.** My first version asserted "no failure card" while the
   run never started — `.gt()` was missing from the Supabase chain mock, so `send()` threw before
   `sendMessage`. Two positive signals (transport called, `onError` settled) plus a `send.disabled`
   assertion now make that impossible. **Assert something happened before asserting something didn't.**
3. **The harness cannot exhibit every defect.** Its in-process mock resolves the heartbeat instantly,
   so the in-flight window has ~zero duration there and before/after screenshots are identical. It
   proved the *boundary*, not the fix. Don't manufacture a screenshot that looks like proof.
4. **Two agents, one task.** Check the PR list first.
5. **`package.json` ranges ≠ resolved versions.** Read `package-lock.json`.
6. **`Chat` is not exported from `ai`** — `AbstractChat` is. `UseChatOptions` is a union whose
   `{ chat }` arm has no `onError`, so wrapping `useChat` needs an intersection type.
7. The clone is **shallow**; `git fetch --unshallow --filter=blob:none` before trusting any
   divergence or merge-base measurement.

---

## 9 · Reproduce anything here

```bash
git fetch origin && git rev-parse origin/main          # expect a19f065 or later
curl -s "https://skzqwbyvmwqarfgfvyky.supabase.co/functions/v1/osint-agent?health=1"
npx vitest run                                          # expect 1918 / 1 / 155 on a19f065

# the SDK store lifetime — the premise that misled two sessions
grep -n "chatRef" node_modules/@ai-sdk/react/dist/index.mjs
node -e "console.log(require('./node_modules/@ai-sdk/react/package.json').version)"

# the #551 behavioural suite and its mutation battery
npx vitest run src/test/network-drop-suppression.test.tsx
```

---

## 10 · Suggested order for the next session

1. **Get the §5 ruling written down.** It blocks the largest accuracy item and is already causing
   cross-session confusion.
2. Work the Game Plan's Phase 0 merge queue: **#550 → #549 → #547**, then rule on #502 vs #516 and
   on #529/#519. (#548/#551 is already resolved.)
3. Refresh `CLAUDE.md` baselines and handoff index (§7) — zero risk, and this defect has recurred
   three times.
4. Only on the operator's go-ahead, open the evidence-authority audit (§6).
