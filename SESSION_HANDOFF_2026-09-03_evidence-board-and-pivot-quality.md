# Session handoff — 2026-09-03 · evidence-board signal-to-noise and the pivot that causes it

> **Every number here is a dated measurement, not a state.** Measured 2026-09-03T04:00–07:30Z
> against `origin/main` `1554911` and live `osint-agent` build `7b0138d`. Re-fetch and re-probe
> before acting on anything below. Read `SESSION_HANDOFF_2026-09-03_audit-merge-queue-and-report-truth.md`
> (PR #541) first for the deploy/merge state; this file is about **investigation quality**.

## 1 · The one number that matters

Across the **37 threads run in the last 14 days**:

| Measure | Value |
|---|---|
| Artifacts produced | 2,237 |
| **Actionable** (not quarantined, confidence ≥ 65) | **176 (7.9%)** |
| Average artifacts per scan | **60** |
| **Average actionable per scan** | **4.8** |

An analyst opens a finished case and scrolls 60 cards to reach fewer than five worth acting on.
That is the whole of "we do all these upgrades and it still feels like junk". Everything in §4 is
ranked by how much it moves this number.

Corpus-wide, for context (10,933 artifacts): 469 at ≥80, 1,131 at 65–79, 4,288 at 50–64,
**4,967 below 50**, 757 quarantined. 1,600 actionable = 14.6%.

## 2 · What shipped this session

**PR #542** — `claude/cache-sweep-diagnosis-dr2zpd`, head `0f6cf48`, **draft, CI green, mergeable
clean**. (The branch name is a leftover from the session's original task; the work is the
evidence-board audit.)

Two complementary changes to one defect:

- **Backend** `auto-persist-findings.ts` — new runs collapse a name-only harvest at write time.
- **Frontend** `src/lib/bulk-corpus-display.ts` — **existing** threads group on the board, with no
  edge deploy at all.

**Root cause, exactly.** A name-only lookup already quarantines every row it returns; that part was
never broken. But the name-only gate stamps `subject_unlinked` on every row, and the bulk-corpus
collapse builds its candidate set as `subject_unlinked !== true`. Quarantining first emptied the
collapse's input, so nothing collapsed. On thread `c599a5bc`: 57 corpus-identity rows, 48 already
quarantined, leaving 9 — under `BULK_HARVEST_IDENTITY_CAP = 15`, so no collapse fired. **Two correct
mechanisms cancelling each other.**

Measured retroactive effect (654 harvest rows across **26 threads**):

| Scan | Cards before | Cards after |
|---|---|---|
| Breach search seed | 160 | 113 |
| Phone seed | 131 | 85 |
| Domain seed `c599a5bc` | 123 | 77 |
| Address seed | 82 | 47 |
| Username seed | 117 | 94 |

Gates on `0f6cf48`: edge **1619 / 0 / 5** (baseline 1613), frontend **1822 / 1 skipped / 149 files**
(baseline 1818), tsc clean, eslint 0 errors + the same 10 pre-existing `react-refresh` warnings,
build clean. CI green on the PR head.

## 3 · The pivot that produces the noise — diagnosed, NOT fixed

Reading the full 96-call chain of thread `c599a5bc` (a domain seed):

- Calls **1–38** are genuinely good domain OSINT — DNS, crt.sh, WHOIS, HTTP fingerprint, ip_intel,
  VirusTotal, Shodan, then a scrape of the site's About page.
- The scrape yields two **person names**.
- **Call 39** — `oathnet_lookup {type:"name", value:"<name A>"}`
- **Call 65** — `oathnet_lookup {type:"name", value:"<name B>"}`

OathNet on a bare name is a **people-search enumerator**: it returned everyone in its corpus sharing
those names — 15 addresses across 13 US states plus one abroad, 14 phones including a foreign mobile,
12 mailboxes. 55 artifacts, 48 of them quarantined, and roughly 20 paid calls.

Neither name had any durable linkage to the seed. The run then recorded **two `record_finding` calls
labelled `confirmed`** across an identity chain spanning at least three different people, and the
operator corrected it at call 95.

**#542 stops this flooding the board. It does not stop the calls.** That is the next change and it is
specced in `NEXT_SESSION_PROMPT.md` §A.

## 4 · Ranked: what actually stands between this and a proven tool

Ordered by effect on §1's number per unit of risk.

1. **Merge #542.** Frontend half ships on merge to Vercel and repairs 26 existing threads with no
   deploy. Zero further work.
2. **The name-pivot guard** (`NEXT_SESSION_PROMPT.md` §A). Stops the generation, not just the
   display, and reclaims ~20 paid calls per affected run. Medium risk — changes run behaviour, needs
   a kill switch.
3. **`artifactDedupKey`** (§B). *The one that corrupts the logic rather than the view.* It puts
   `source` **in** the key and never normalises `value`, so the same selector found by five
   independent tools becomes five artifacts at five different confidences instead of one artifact
   whose confidence **rises** on corroboration. 840 redundant copies over 695 selectors; up to 6
   copies of one value in a single thread; one production address persisted twice, differing only
   in letter case (`... RIDGE LN #3203, ARLINGTON, TX` vs `... Ridge Ln #3203, Arlington, TX`) —
   and one copy was quarantined while the other was not. This is also why so much of the corpus sits at
   50–64: corroboration is being thrown away. **Integrity-critical — needs the operator's sign-off on
   merge semantics before anyone writes code.**
4. **Verify #537's report-truth fixes on a real run** (§C). They are pinned by tests and a harness
   diff, never by a live investigation. Cheap, and it closes audit F8 at the same time.
5. **Run completion.** Interrupted-run rate by cohort: older 35%, 15–30 days ago 41%, **last 14 days
   11%** (4 of 38). The termination work demonstrably fixed most of this — do **not** treat the
   cumulative 34% as current. 11% is still ~1 in 9 and worth attention, but it is no longer the
   headline. 59 of the 69 historical cases are `stale heartbeat recovered by health sweep`, nearly
   all pre-dating the fixes.
6. **Quality-of-life / UI** (§D) — the tab-disagreement defect is still **unmeasured** across three
   handoffs. Measure before building.
7. **Operational gaps.** No production monitoring since #483. `CACHE_SWEEP_ENABLED` is off by design
   so 11,475 expired rows persist (§5). `evidence-export` has no build marker, so a stale deploy
   cannot be ruled out and the PDF export is still unaudited.

## 5 · Correction to the previous handoff (§6.1)

The 09-03 audit handoff lists the cache sweep as "merged & live but the table has not drained" with
two unverified hypotheses. **Resolved: neither. It is not a bug.**

`/health` reports `cache_sweep: {"ok": true, "detail": "disabled"}`. `CACHE_SWEEP_ENABLED` defaults
**OFF** on purpose — `cache-sweep.ts:96-98`, and the module header at `:48-53` says so: *"This
deletes production data; it does not get to start doing that because a deploy landed."* Reading
`ok: true` as "running" is the trap; read `detail`.

**Before flipping it, fix this** — measured, not inferred. The sweep deletes with a single
`.in("id", ids)` carrying up to `CACHE_SWEEP_BATCH = 5_000` UUIDs. I probed the project's own
PostgREST with throwaway UUIDs and a `select` (no writes):

| ids | URL length | HTTP |
|---|---|---|
| 300 | 11,182 | 200 |
| 600 | 22,282 | 200 |
| **700** | **25,982** | **400** |
| 5,000 | 185,082 | no response |

The gateway cliff is ~24KB. So on the day the flag is set, the delete is rejected at the gateway,
`errors` increments, `/health` flips to `cache_sweep.ok: false`, and **nothing drains, every probe**.
The sibling `lib/rejected-cluster-sweep.ts:55` already carries a `chunk` helper and chunks its
`.in("id", ids)` at **300** (`:89`) — and that is the sweep that actually converged 216 → 0 in
production. Chunk the cache sweep the same way, then enable.

`cache_sweep_test.ts:114` asserts `CACHE_SWEEP_BATCH === 5_000` against a structural fake DB that
cannot model a transport limit — it re-describes the constant instead of driving the path.

## 6 · Traps that cost time this session

- **`ok: true` is not "it ran".** Both `synthesis` and `cache_sweep` report `ok:true, detail:"disabled"`.
  Always read `detail`.
- **The local clone is stale AND shallow.** `origin/main` read as a commit ~3 days old until an
  explicit `git fetch origin main`; remote-tracking refs for branches that don't exist on origin
  still resolve to stale local values. Fetch before trusting any ref.
- **`deno test` rewrites `deno.lock`** even when other commands pass `--no-lock`. It was staged
  before I caught it. `git checkout -- deno.lock` and re-stage.
- **Negative controls earn their keep.** My first collapse threshold was 5, reasoning about *people*
  while the code counted *rows* — two people produce ~7 rows, so a 2-person return collapsed. The
  negative control caught it; the cap is 12 rows (≈3–4 people). Write the negative control first.
- **SQL three-valued logic silently dropped 75 of 123 rows** from a breakdown query: `metadata->>'x'`
  is NULL for most rows, so `not (x = 'true')` is NULL and the row lands in neither bucket. Wrap in
  `coalesce(..., false)`. I published a wrong "0 usable" figure for about a minute because of it.
- **Don't put real investigated selectors in committed code.** Real domains/names went into comments
  on the first draft and were stripped before commit. Thread IDs are fine; selectors are not.
- **#541 edits `CLAUDE.md`'s dated-state and handoff-series blocks.** This branch deliberately does
  not touch them, to avoid a conflict. After both merge, someone must update those two blocks.

## 7 · Exact state at handoff

| Axis | Value |
|---|---|
| `origin/main` | `1554911` |
| This branch | `claude/cache-sweep-diagnosis-dr2zpd` @ `0f6cf48`, pushed, working tree clean |
| PR #542 | open, **draft**, CI green, `mergeable_state: clean`, 1 comment (Vercel bot) |
| Live `osint-agent` build | `7b0138d`; `cache_sweep` **disabled**, `synthesis` **disabled**, `rejected_cluster_sweep` clean (290 rejected reviews, 0 stale) |
| Other open PRs | #541 (handoff docs), #540 (bot, 2 real fixes + vendor config), #529, #519, #516, #514, #502 |
| Scheduled check-in | a `send_later` routine re-checks #542 every ~3h until merged or closed |

Nothing is half-finished. The branch is committed, pushed, green and safe to leave.
