# Next-session prompt — Insight Finder, investigation quality

> Paste this whole file as the opening message of a fresh session. It is written to be
> self-contained. **Everything below is a dated measurement (2026-09-03T07:30Z), not a state —
> re-verify before acting.**

> ## ⚠️ Status update 2026-09-07T13:05Z — read before using this file
>
> - **`main` is now `a19f065`** (was `1554911` when this was written). Live `osint-agent` build is
>   still `7b0138d`. Frontend baseline is **1918 / 1 / 155**, not the figure in `CLAUDE.md`.
> - **§A (name-pivot guard) is DECLINED by the operator.** Do not implement it and do not
>   re-propose it. Searches stay permitted; the intended control moved to persistence/read
>   authority — see the evidence-authority audit in
>   `SESSION_HANDOFF_2026-09-07_drop-suppression-and-the-duplicate-pr.md` §6.
> - **§B is AWAITING AN OPERATOR RULING and is BLOCKED.** Do not start it, and do not propose a
>   write-path merge, until the ruling is written down. See §B's own banner below.
> - §B's measurements are stale: `840 across 695 selectors` → **852 redundant rows of 11,079
>   across 138 threads** (2026-09-07).
> - The newest handoff is
>   `SESSION_HANDOFF_2026-09-07_drop-suppression-and-the-duplicate-pr.md`; read it before this file.
> - **Task 0 below is done** — #542 is merged. So are #543, #544, #545, #546 and #551. The current
>   queue is #550, #549, #547, plus rulings on #502 vs #516 and #529/#519.

---

## Start here — orientation, 5 minutes, do this first

```bash
git fetch origin main && git log --oneline -8 origin/main
curl -s "https://skzqwbyvmwqarfgfvyky.supabase.co/functions/v1/osint-agent?health=1"
```

- `main` was `1554911` and the live `osint-agent` build was `7b0138d`. **If either moved, another
  session has worked this repo — read the newest `SESSION_HANDOFF_*.md` before doing anything.**
  That has happened twice; findings in a handoff are sometimes already closed.
- Read `SESSION_HANDOFF_2026-09-03_evidence-board-and-pivot-quality.md` — §1 is the problem, §4 is
  the ranked plan, §6 is the trap list.
- On `/health`, read `detail`, not just `ok`. `cache_sweep` and `synthesis` both report
  `ok:true, detail:"disabled"`. `ok:true` does not mean it ran.
- The local clone is shallow and its remote-tracking refs go stale. Always `git fetch` first.

**Task 0 (2 minutes, do it before anything else): merge PR #542** if it is still open and green.
It is finished, reviewed-by-CI, `mergeable_state: clean`, and its frontend half repairs 26 existing
threads the moment it hits Vercel. It is a draft only because the operator merges.

---

# Objective

Raise the signal-to-noise of a finished investigation from **4.8 actionable artifacts out of 60**
to something an analyst can read top-to-bottom, and make corroboration *raise* confidence instead of
fragmenting it.

# Context

Insight Finder (a.k.a. Swarmbot) is an OSINT investigator: Vite + React + TS frontend on Vercel,
Supabase edge functions (`osint-agent` and three others) deployed **only** via the Lovable mirror.
`CLAUDE.md` is authoritative on deploy topology and on decisions that must not be re-litigated —
**read it before writing code.** One operator, in development, not yet released.

Measured over the 37 threads run in the last 14 days: **2,237 artifacts, 176 actionable
(not quarantined, confidence ≥ 65) = 7.9%. Average 60 artifacts per scan, 4.8 actionable.**

Two upstream causes are diagnosed and evidenced. One is half-fixed (#542, awaiting merge). The other
two are below, in priority order.

# Files to inspect

Paths were correct at `1554911`; **search the repo if they have moved.**

- `supabase/functions/osint-agent/cache.ts` — `wrapToolsWithCache`, the pre-flight dispatch guard (~:880)
- `supabase/functions/osint-agent/auto-persist-findings.ts` — `seedLinksQueriedName`, `queryIsNameOnly`, `CONCRETE_SELECTOR_INPUT_KEYS`, the collapse block
- `supabase/functions/osint-agent/lib/dispatch-quarantine.ts` — `dispatchKey`, `quarantineRefusal`
- `supabase/functions/osint-agent/lib/dispatch-rejection.ts` — `buildRejectedDispatchKeys`
- `supabase/functions/osint-agent/lib/artifact-hygiene.ts` — **`artifactDedupKey`**
- `supabase/functions/osint-agent/lib/kind-alias.ts` — `canonicalKind`
- `supabase/functions/osint-agent/index.ts:341` — where `subjectSeedName` is computed
- `src/lib/report-hygiene.ts`, `src/lib/intel.ts` — frontend authority predicates
- `src/components/ResourcesPanel.tsx` — the Evidence board

---

## §A — ⛔ DECLINED (2026-09-07). Do not implement, do not re-propose.

> The operator declined the name-pivot dispatch guard. Broad discovery stays permitted; the
> intended control moved to **persistence / read authority** — unlinked results remain visible
> leads without entering subject identity, confidence, graph or report conclusions. That work is
> specified as the evidence-authority audit in
> `SESSION_HANDOFF_2026-09-07_drop-suppression-and-the-duplicate-pr.md` §6.
>
> The section is kept below for its diagnosis (the `c599a5bc` trace is still the clearest evidence
> of where the noise comes from), **not as a work item.**

### §A — The name-pivot guard (superseded; retained for its diagnosis)

### Current problem

A run seeded with a **domain** scraped two person names off the site, then called
`oathnet_lookup {type:"name", value:<name>}` on each (calls 39 and 65 of 96 on thread `c599a5bc`).
OathNet on a bare name is a **people-search enumerator** — it returned everyone sharing those names:
15 addresses across 13 US states plus one abroad, 14 phones including a foreign mobile, 12 mailboxes.
**55 artifacts, 48 quarantined, ~20 paid calls**, and the run then recorded two findings labelled
`confirmed` across an identity chain spanning at least three different people.

Neither name had durable linkage to the seed. The write gate correctly quarantined the results —
but only *after* the calls were paid for.

### Implementation requirements

1. Add the guard to the **existing pre-flight block in `cache.ts`** (~:880), beside the
   `subject_unlinked` and analyst-rejection refusals — before budget reservation, circuit breaker,
   cache lookup and the live call. All ~89 tools funnel through that one wrapper.
2. Refuse when **all** of these hold:
   - the tool is a **people-search enumerator** (start with `oathnet_lookup`; audit siblings such as
     `indicia_person` and `leakcheck_lookup` and add only those that enumerate by name), **and**
   - the query is name-only — reuse `queryIsNameOnly`, do not write a second classifier, **and**
   - `seedLinksQueriedName(subjectSeedName, queriedName)` is **false**.
3. `seedLinksQueriedName` already fails closed on an absent or unusable seed. Keep that.
4. **`ctx` does not currently carry the seed.** `index.ts:341` computes `subjectSeedName` and passes
   it to `extractStepFindings`; thread the same value into `wrapToolsWithCache`'s `ctx` as an
   optional field so existing callers and tests are unaffected.
5. The refusal must be **legible as a refusal** — reuse the `quarantineRefusal` shape
   (`ok:false, refused:true, refused_by:<marker>`). Never return `ok:true`; a silent refusal that
   burns a step is how a disabled tool once reached a chain-of-custody record.
6. Key by `type:normalizedValue`, never by value alone. `normalizeTarget` collapses
   non-alphanumerics, so a bare name and a username can otherwise collide.
7. **Kill switch `NAME_PIVOT_GUARD_DISABLED`, defaulting to ENABLED** (mirroring
   `REJECTED_CLUSTER_SWEEP_DISABLED`). Shipping it dark changes nothing, which is the exact failure
   mode the operator is frustrated by. Confirm this choice with the operator before merging.
8. The refusal text should tell the model what to do instead — corroborate the name against a
   concrete selector first — so the run pivots productively rather than stalling.

### Do NOT

- Do not gate ordinary **web search** on a name. That is contextual and usually legitimate; only
  bulk person-record enumerators are the problem.
- Do not touch `toolChoice`, `stopWhen`, the finalize window, or anything in the termination area.
  `CLAUDE.md` documents two production outages from exactly that. Read the oscillation history.
- Do not infer intent from prose. Structural signals only — settled, do not re-litigate.
- Do not let `force` override the guard, consistent with the two refusals beside it.

### Acceptance criteria

- [ ] A name-only enumerator dispatch on a seed-unlinked name is refused before any paid call.
- [ ] The same dispatch on a name that **does** link to the seed proceeds untouched.
- [ ] A concrete-selector query (email / username / phone / domain) is never affected.
- [ ] A web search on a name is never affected.
- [ ] The refusal is visible in `tool_usage_log` as a refusal, not as a success or a silent skip.
- [ ] `NAME_PIVOT_GUARD_DISABLED=true` fully restores today's behaviour.
- [ ] New tests **drive `wrapToolsWithCache`**, not a restatement of the predicate, and at least
      three are negative controls.

---

## §B — `artifactDedupKey`: make corroboration accumulate

> ## ⛔ BLOCKED — AWAITING OPERATOR RULING (as of 2026-09-07T13:05Z)
>
> **Do not start this section. Do not propose a write-path merge.** A prior session recorded that a
> dedup proposal was "rejected", but the *scope* of that rejection was never written down, and the
> ambiguity has already caused cross-session confusion. The ruling must be recorded here before any
> work begins.
>
> **What the primary sources actually show:**
>
> - **PR #305** (closed unmerged 2026-07-14) carried a dedup migration whose key **ignored selector
>   scope**. A production simulation showed it would delete **~120 genuinely distinct rows**
>   (different platform / subject / host / breach) and **orphan 53 real analyst reviews**. That is
>   the "data-loss / review-orphaning failure".
> - **PR #307** (closed unmerged 2026-08-20) was the careful fix: a selector-scope-aware key plus a
>   single canonical `merge_artifact_into(loser, survivor)` that asserts thread + user equality,
>   preserves the survivor's `subject_id`/`cluster_id`, **unions** provenance and classes, re-points
>   evidence and reviews, and surfaces conflicting analyst verdicts as `recheck` with lineage rather
>   than discarding them. Production simulation: 6,889 → 6,387 artifacts, 502 true duplicates across
>   376 groups, **0 distinct-platform / subject / selector loss, 53 reviews re-pointed, 0 discarded.**
> - #307 derives merged confidence with **`GREATEST`** — the likely origin of the "minor-safety
>   confidence bypass" concern: if one copy is capped low for minor-safety reasons and another is
>   not, taking the maximum bypasses the cap.
>
> So the shape that was rejected appears to be a write-path merge that **(a) keys on a normalized
> value without selector scope** and **(b) takes maximum confidence on merge**. #307 already
> demonstrated a design avoiding (a); (b) would need only a rule change. **But that is inference
> from the record, not a ruling. It must be confirmed.**
>
> **The ruling must state one of:**
>
> - **(A) Declined outright** — no write-path merge without new sign-off; the 7.9 % signal problem
>   stays open and is addressed at the display layer only.
> - **(B) Partial** — naming exactly what is rejected (candidates: `GREATEST` confidence on merge ·
>   backfilling existing rows · value normalization without selector scope), keeping §B open in
>   narrowed form.
>
> **Consider splitting it**, which may make the ruling easier — measured 2026-09-07:
>
> - **B1, a straight bug:** the merge *already fires* into `metadata.sources` while the insert is
>   **not** suppressed — **46 rows across 15 threads** carry ≥2 `sources` entries *and* still have a
>   sibling duplicate row. Fixing that needs no merge-semantics redesign.
> - **B2, the design question:** source-set semantics, per-kind value normalization, merged-confidence
>   derivation. Integrity-critical; this is what needs the written sign-off.
>
> **Current corpus (2026-09-07, supersedes the figures below):** 11,079 artifacts; **852 redundant
> rows (7.7 %) across 138 threads** — 503 same value / different `source` string, 317 identical key
> (**143 inside one sub-2-second batch**), 32 case-only. Max 6 copies of one value in one thread.

### Current problem

```ts
// lib/artifact-hygiene.ts
return JSON.stringify([canonicalKind(input.kind, input.value), input.value, (input.source ?? "").trim().toLowerCase()]);
```

Two defects:

1. **`source` is part of the key.** The same email found by five independent tools becomes **five
   artifacts at five different confidences** instead of one artifact whose confidence rises on
   corroboration. Independent corroboration is the most valuable signal the system has, and this
   throws it away — then `record_finding`'s `countIndependentClasses` reads from rows that were
   split apart.
2. **`value` is never normalised** — not lowercased, not trimmed. Production carries
   one real address twice, differing ONLY in letter case — `<STREET> #3203, <CITY>, TX 76006` vs
   `<Street> #3203, <City>, TX 76006` — as separate rows, **one quarantined and one not**.
   (Query production for the live examples; they are not committed here.)

Measured: **840 redundant copies across 695 selectors**; up to 6 copies of one value in one thread
(`[50,45,40]`, `[75,65,60,40]`, `[80,70,65,60]`). This is a large part of why 4,288 artifacts sit at
50–64 and 4,967 below 50.

### This is integrity-critical — stop and get sign-off

`CLAUDE.md` requires explicit approval for changes to evidence ranking, confidence caps and
chain-of-custody. **Do not write code first.** Put a short written proposal to the operator covering:

- What merges: same `canonicalKind` + same normalised value — and what "normalised" means per kind
  (address casing/whitespace vs email vs phone E.164). Get this wrong and you merge two different
  real-world entities.
- What happens to `source`: it must become a **list** on the merged row (`sources[]` with per-source
  first-seen), because provenance and chain-of-custody must not be lost.
- How merged confidence is derived, and its interaction with existing caps and
  `countIndependentClasses`. Corroboration should raise it; mirrors of one leak must not.
- Quarantine on conflict: if one copy is quarantined and another is not, the merged row must **fail
  closed** (quarantined) — never silently promote.
- Whether existing rows are backfilled or only new writes merge. Backfill touches 10,933 production
  rows and needs its own decision.

Only after sign-off: implement behind a flag, with tests that drive the write path.

---

## §C — Verify the report-truth fixes on a real run (cheap, do it early)

#537 shipped six fixes that have **never been verified on a live investigation** — only by tests and
a harness diff. Run one real scan:

1. Seed a handle with a leading `@`. Expect seed kind `username`, not `other`.
2. Dismiss two rows, Confirm one, Key one.
3. Export the report.

Expect: cluster headline **at or below** the strongest member's capped confidence; the confirmed row
rendered **ANALYST-CONFIRMED**, not CONFIRMED; kind-alias twins folded; the Evidence Record carrying
the analyst-decisions line. **If a Dismissed selector is refused at dispatch on a later run, that
closes audit F8**, open and unmeasured since 2026-09-02.

---

## §D — Quality of life, only after §A–§C

- **The tab-disagreement defect** (Overview says 12 tools / 2 verified, the tab says 18 / 3) has been
  carried unmeasured across three handoffs. **Measure it before building anything** — reproduce it in
  the harness, find the two divergent count sites, make them share one selector. Do not start the
  larger workspace rebuild until this is understood; it may be the whole complaint.
- **Render the signed-in workspace before/after any UI change** — a Vercel *preview* is not the site
  and signed-out surfaces are not where analysts live:
  ```bash
  npx vite --config vite.harness.config.ts   # → http://127.0.0.1:5174
  # open /chat/11111111-2222-4333-8444-555555555555
  ```
- **The Evidence board default filter** is `"all"` (`ResourcesPanel.tsx:1158`). Deliberately left
  alone: with #542's grouping the board is scannable, and defaulting to `strong` would hide
  `review`/`conflict` rows the analyst needs. Revisit only if the operator asks.

---

## §E — Operational, low effort, real payoff

- **Cache sweep.** `CACHE_SWEEP_ENABLED` is off by design; 11,475 of 11,646 rows are expired (43 MB).
  **Do not just flip it** — the delete sends up to 5,000 UUIDs in one `.in()` (~185KB URL) and the
  gateway rejects anything over ~24KB (measured: 600 ids = 22.3KB → 200; 700 = 26KB → 400). Chunk at
  **300** like `lib/rejected-cluster-sweep.ts:89` already does, then enable.
  `cache_sweep_test.ts:114` pins the 5,000 constant and will need updating.
- **No production monitoring** since #483 removed the cron for burning Actions minutes. Every
  health-path sweep only runs when something curls `/health`. An external uptime monitor is what
  `CLAUDE.md` already recommends; do not re-add a frequent GitHub cron.
- **PDF export unaudited**, and `evidence-export` has **no build marker**, so a stale deploy cannot be
  ruled out. Needs a machine with poppler.

---

# Verification (run all of these before any push)

```bash
npm ci
npx tsc --noEmit
npx eslint .                 # expect 0 errors + 10 pre-existing react-refresh warnings
npx vitest run               # baseline 1822 passed / 1 skipped / 149 files
npm run build
cd supabase/functions/osint-agent && \
  deno test --no-check --no-lock --allow-net --allow-env --allow-sys --allow-read *_test.ts
                             # baseline 1619 passed / 0 failed / 5 ignored
```

- `--allow-read` is **required**; without it the source-level wiring tests abort with `NotCapable`
  and it reads like a code failure.
- Pass `--no-lock`, and check `git status` for `deno.lock` before staging — `deno test` rewrites it.
- Deno is not preinstalled: `DENO_INSTALL=/usr/local sh -c "$(curl -fsSL https://deno.land/install.sh)" -- -y`
- If ~10 React failures appear, re-measure in an isolated worktree with its own `npm ci` before
  believing them — a shared `node_modules` can fabricate exactly that.

# Do NOT (repo-wide)

- Do not blanket-overwrite the Lovable mirror. Sync only files that actually changed; a second agent
  writes to that repo and its edits are not visible here.
- Do not treat a mirror push as a deploy. **The only proof of deploy is a moved `/health` build SHA.**
- Do not re-litigate the three settled decisions in `CLAUDE.md` (`REVEAL_BREACH_DATA` stays on,
  `MAX_PAID_CALLS` stays bounded, intent is not inferred from prose).
- Do not make a quarantined row disappear. Quarantine is **disclosure, not deletion** — removing
  authority is correct, removing the row is a regression.
- Do not commit real investigated selectors (names, domains, emails, phones) in code, comments or
  tests. Thread IDs are fine; use synthetic fixtures.

# Return

- Changed files and why
- Gate numbers actually run (not inherited)
- What you verified against **production data**, and what you did not
- Remaining risks and anything you deliberately left out
- Before/after screenshots of the signed-in workspace for any UI change
