# Session handoff — 2026-09-12: promotion quarantine, and auditing by measurement

**Read this one first.** It supersedes `SESSION_HANDOFF_2026-09-08_queue-drain-and-dispatch-deploy.md`.
Take the dated state from the top of `CLAUDE.md`, not from §1 here — this file
will be overtaken too.

---

## 1. State at hand-off

| Axis | Value |
| --- | --- |
| canonical `main` | `2864860` (#581 squash-merged) + the #582 stamp |
| stamp | `BUILD_MARKER` `7c7888f` → `2864860` (PR #582) |
| mirror `main` | `0b559cf` — surgical sync of 17 `osint-agent/` files |
| `diff -rq` | **empty** for all four: `osint-agent`, `evidence-export`, `security-test-lab`, `_shared` |
| edge suite | **1802** passed / 0 failed / 5 ignored |
| frontend suite | **2087** passed / 1 skipped / 171 files |
| e2e | **52** passed / 2 skipped (run BY HAND — see §3) |
| live `/health` build | **`2864860`** — deployed and verified this session (was `7c7888f`) |

Baselines were re-measured in a clean `git worktree` off `origin/main`.
CLAUDE.md's previous figures (1634 edge, 1957/159 frontend) were stale *before*
this session and are corrected there.

---

## 2. The headline change: `subject_unlinked` is now a PROMOTION gate

Operator decision, after the concern was raised and reaffirmed. This reverses
the dispatch half of #518/#519 and relaxes #436. **Write (#433) and promote
(#448) are untouched, and #448 is now load-bearing for dispatch too.**

| Boundary | Before | Now |
| --- | --- | --- |
| write (#433) | query-shape quarantine stamps | unchanged |
| pivot (#436) | quarantined pivot BLOCKED | **warning**, runs |
| promote (#448) | no cluster/graph/report/CONFIRMED | unchanged |
| dispatch (#518/#519) | quarantined selector REFUSED | **allowed + tainted** |
| dispatch — analyst rejection | refused | **still refused** |

### Why it changed

The dispatch gate closed a real hole. Its cost, measured on the 2026-09-11
person-seed run `d4873abc`: it refused `username_sweep` on `ufland40` and
refused breach lookups on the emails harvested beside it, so the run was
**structurally forbidden from proving or disproving the very link it was
investigating**, and then reported "no authoritative findings". Refusing to
look is not the same as looking and finding nothing, and the case file could
not tell them apart.

### ⛔ The invariant that makes it safe — read before touching any of this

**Authority is not inherited.** A call against a selector whose linkage is
unproven yields findings whose linkage is unproven, so every one is stamped
`subject_unlinked` naming the parent. `lib/unproven-linkage.ts`.

This is the safety case, not provenance decoration. The write-path stamp keys
on **query shape**, and `username_sweep` on a harvested username is *not* a
name-only query — so without the taint a stranger's profiles persist at FULL
subject authority, join identity clusters and reach the report. That is exactly
the hole #433 closed, re-opened from a different direction.
`unproven_linkage_test.ts` fails three ways if the stamp is removed; verified
by reverting it.

Two design choices not to undo:

- **The stamp reuses the existing `subject_unlinked` vocabulary** rather than a
  new flag, so `isExcluded` (lib/cluster.ts), `isClusterIneligible` (frontend),
  the dispatch guard and the report's collision section all honour it with no
  new plumbing. A new key would need teaching to six readers, and the one that
  was missed would be the leak.
- **The taint rides `runtimeMetaBase`**, which every return path in the wrapper
  spreads — live, cache hit, stale replay, selector reuse, timeout stub. Attach
  it only to the live path and a cached replay of the same quarantined selector
  comes back clean and promotes.

### Kill switch

`PROMOTION_QUARANTINE_DISABLED=true`, read at **call time**, so it reverts on
the running build with no deploy. Kept because this reverses five merged PRs
and its blast radius is every paid tool in the registry.

### The paging tests got MORE important, not less

Their failure mode inverted and got worse. An incomplete read of the refused
keys used to mean "failed to refuse"; it now means "**failed to taint**" — the
result comes back clean and promotes. `quarantine_dispatch_test.ts` was
rewritten, not deleted, and #519's skip-shaped-reason hardening was preserved
on the kill-switch path rather than retired with the boundary.

---

## 3. Trap list — instruments that lied this session

**1. PR CI does not run the e2e suite, and CLAUDE.md said the script did not exist.**
Both wrong. `npm run test:e2e` exists (54 specs). The `e2e` job is
`if: github.event_name == 'push'` — a deliberate cost call after #483 — so it
guards `main` only. The workflow header states the trade plainly: a PR can go
green and merge while breaking the tab contract.

**This bit this session.** vitest, typecheck, lint, build *and* the full edge
suite were green while `case-integrity.spec.ts → next steps › 9` was red.
Run it by hand before merging anything touching `src/`:

```bash
PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome npm run test:e2e
```

Baseline **52 passed / 2 skipped**.

**2. A grep for `loadReviewsForThread` in `planner-guidance.ts` / `system-prompt.ts` returns nothing — and that proves nothing.**
Those are static text builders. The `ANALYST DECISIONS` block is composed in
`index.ts:748` and appended to the system prompt. Two diagnostic reports
concluded "verdicts are recorded but not bound" from this kind of signal, and
ranked it their #1 item. It is substantially shipped (see §4).

**3. `deno check` errors do not match `grep -c "error"`.**
Deno prints `TS2345 [ERROR]`, not `error TS`. A wrong pattern reported 0
baseline errors and nearly hid whether a change added any. Count with
`grep -cE "^TS[0-9]+ |\[ERROR\]"` and always compare against a stashed baseline.

**4. A test that hand-rolls a reset drifts from the shipped one.**
`correlate_freshness_wrapper_test.ts` had its own copy of `resetCorrelateRun`'s
body. When the per-run correlate budget was added, the copy did not clear it,
cases starved each other, and the failure read as a freshness-gate bug. Fixed
to call the real reset.

---

## 4. Report claims that did NOT survive verification

Recorded so they are not re-commissioned. Both 2026-09-11/12 diagnostic reports
are worth reading, but these five were checked against the code and are wrong:

- **"Analyst verdicts are recorded but not bound"** (ranked #1 in both) —
  substantially **shipped**. `index.ts:748` loads reviews every turn and appends
  a four-part block (confirmed/key/recheck/rejected), emitting the very
  `analyst_decisions_applied` event report 1 asks to add. Dispatch, clustering,
  salvage, cache replay, **memory recall**, graph and report all consult
  reviews. **The residual leak is the model-written NARRATIVE** — CLAUDE.md's
  "report layer bypasses the integrity engine" section, with a prescribed fix
  (server-side `{{FINDINGS_TABLE}}` expansion). Different, smaller work.
- **"gemini_vision MIME fix written but not deployed"** — shipped in #569 and
  live. (`tools/gemini_vision.ts` IS live-imported; CLAUDE.md's "tools/*.ts are
  dead code" generalization does not hold for it.)
- **"markdown_extract fix written but not deployed"** — was **not written at
  all**, in canonical or mirror. Fixed this session.
- **"Circuit-break providers after 2 failures per run"** — mostly already
  shipped, and stricter than asked, but **not uniformly**. Corrected after a
  review caught me overstating it:
  - **Provider-level** suppression for the whole investigation on the FIRST
    occurrence: `http_500` (any other 5xx), `401`/`403`, `402`, `429`, and
    `timeout` (immediately for a single-upstream provider; second timeout for
    oathnet; third for a `GENERAL_MULTI_ORIGIN_TOOLS` fan-out tool).
  - **Tool-level only:** `502`/`504` set `b.disabledReason` for the thread and
    never call `suppressProvider`. **Sibling tools on the same provider keep
    running after a gateway error** — so for grouped providers (OathNet's
    five tools, DeepFind) part of the proposed work is genuinely NOT shipped.
  - **The larger gap stands:** the breaker is per-thread and in-memory, so it
    never carries ACROSS runs. A provider 500ing for three days is retried
    fresh in every new investigation. That needs a persisted table.
- **`ip_address` + `ip` as two rows** — `source` is in `artifactDedupKey` by
  design (four corpora agreeing is four coverage facts) and the report folds the
  twins.

---

## 5. Deliberately NOT done, with reasons

- **The 20s `minimax_correlate` timeout** both reports ask for. Measured average
  **23.2s**, max **46.2s** against a 60s cap — a 20s cap aborts the majority of
  calls that currently succeed. That is precisely the regression
  `cache.ts:100-107` records for Indicia ("the cap was destroying real data →
  raised"). The per-run **budget** removes the 387s without discarding work.
  Same for cutting indicia to 12s: its failures are HTTP 500s, not timeouts, so
  a shorter cap converts 500s into timeouts and loses the two successes.
- **Context pruning to ≤80k** (report 2 §4) and **incremental per-cycle
  persistence** — the two highest-value remaining items, both in the
  finalize/termination blast radius CLAUDE.md flags as owning this project's
  worst incidents. Scoped deliberately, not rushed.
- **Cross-run provider health.** The genuinely missing piece behind the
  "low-yield paid tools" item. Needs a persisted table; the in-memory
  per-thread breaker cannot express it.
- **Provider-level suppression on 502/504.** Today they disable only the
  calling tool for the thread, so a grouped provider's sibling tools keep
  being scheduled after a gateway error. A one-line change in `circuit.ts`
  (call `suppressProvider` in that case arm, as 500 already does) — but it is
  a real behaviour change to the breaker and belongs in its own PR with its
  own test, not bolted onto this one.
- **The Next-steps repair-card rail.** An attempt to drop malformed report lines
  reversed a documented, e2e-tested decision and was backed out. Four options
  and a recommendation in `docs/next-steps-repair-cards.md`. **Product call.**

---

## 6. Ordered plan for the next session

1. **Verify the deploy landed.** `/health` `build` must read the #582 stamp's
   parent. A mirror push is not a deploy.
2. **Watch the first real person-seed run under promotion quarantine.** The
   thing to check is not that pivots fire — it is that everything they yield
   carries `subject_unlinked` with an `unproven_linkage_parent`. If a
   tainted-parent row reaches an identity cluster or the report, flip
   `PROMOTION_QUARANTINE_DISABLED=true` immediately and re-open the invariant.
3. **Cache sweep.** `CACHE_SWEEP_ENABLED=true` is an env var on the live build —
   no deploy. `CACHE_SWEEP_DRY_RUN=true` measures first. 12,012 of 12,194 rows
   were expired.
4. **The narrative leak** (§4, first bullet) — the real residual of the
   "decisions don't bind" complaint.
5. Context pruning / incremental persistence, together, carefully.

---

## 7. Operator actions outstanding

- Rotate `GITHUB_API_TOKEN` (invalid; the tool now degrades to unauthenticated
  instead of losing the call, but the key is still dead).
- `indicia_person` is 500ing upstream — provider-side.
- Decide the repair-card rail (`docs/next-steps-repair-cards.md`).
