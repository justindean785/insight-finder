# Session handoff — 2026-08-26: workspace pass (#507) and what production evidence exposed

Supersedes nothing. Reads alongside
`SESSION_HANDOFF_2026-08-25_merge-deploy-and-tool-telemetry.md`, which remains
correct. **Every number here is a dated measurement, not a state.**

---

## 1 · State, verified at 10:20 UTC

| | |
|---|---|
| `main` | `a38963c` — **unchanged this session** |
| Live `/health` build | `865f49e` (`glm-5.2` via the DeepSeek slot, `pinned`) |
| `deploy/live` | `865f49e` |
| Mirror `main` | `783f879` |
| PR #507 head | `c66c153` — 10 commits, CI green on every one |
| Gate on every commit | lint 0 errors / **10 warnings** · typecheck clean · **1552 passed / 1 skipped / 126 files** · build ✓ |

**No backend change shipped this session. No deploy performed, none owed.**

Baselines moved again: **1552 / 126 files** (was 1543 / 124 at session start;
CLAUDE.md's recorded 1422 / 115 remains stale). Two tests were added.

---

## 2 · PR #507 — what shipped

Ten commits, all frontend. The first is the visual system; the rest are defects
found by sitting in each tab and looking, then by reading real production runs.

### The visual system (`7cd14a5`)

Every translucent highlight was a hue-neutral white film — `hsl(0 0% 100% / α)`
**83 times** in `index.css` plus ~84 `*-white/N` utilities in markup, none
token-backed. **That is the mechanical reason previous colour passes read as
"one little thing changed"**: whatever the palette said, a white sheet cancelled
it. `--film` is now a real token and Tailwind's `white` maps onto it.

Two rules: hue belongs to **authority**, not magnitude (five by-value confidence
ladders with four different threshold sets collapsed); and one meaning per token
(`358 92% 64%` was declared four separate times).

⚠️ The authority ladder was `var(--conf-*)` **aliases** — de-aliasing had to come
first or neutralising confidence would have silently drained four of the eight
authority states. Their **names are load-bearing**: `OverviewTab` builds
`--authority-${state}` at runtime, so a rename produces no type error, no
Tailwind miss and no failing test — the bars just go transparent.

### The Graph was structurally broken (`9c7bc3e`)

- **28 of 29 edges were `seed-discovery`** — provenance, not relationships, per
  the codebase's own `EDGE_HINT`. Drawing all of them buried the one real
  identity link in a starburst. The status bar already said "30 entities · 1
  real link". Off by default now, behind a toggle.
- **16 hostnames all truncated to `…northgate-logist…`** — the ellipsis ate the
  only distinguishing characters. Shared suffixes are demoted to a dimmed tail.
- **Nodes overlapped**: 24 chips on one ring at ~90px spacing, chips are 190px.
  Rather than tune three placement producers against each other, a `relax()`
  pass enforces the no-overlap invariant on the whole set, elliptical test
  matched to chip aspect ratio, deterministic. **Zero overlaps at 30 nodes.**
- The legend appeared **three times**; the read-only copy is gone.

### Charts that carried nothing (`e5b9936`, `f5df7e0`)

- `Spend by tool` normalised each bar against the largest row. Every tool is
  priced the same, so **every bar rendered at 100%** — nine identical full-width
  bars presented as a distribution. Now plots wall-clock, which is the axis that
  varies and the resource a run runs out of.
- The confidence radar went invisible once hue left confidence (14% alpha of a
  low-chroma token on true black).
- A **low** axis and an **unmeasurable** axis drew the same empty bar, when they
  mean opposite things.

### Chain of custody (`97a7c5f`) — the most serious one

The panel had exactly two states: verified, or broken.

```
const ok     = verification?.ok === true;
const broken = verification && !verification.ok;   // ok was !!row?.ok
```

Any response it could not read — RPC error, missing row, column rename —
coerced to `false` and rendered a red pulsing **"CHAIN INTEGRITY broken ·
evidence after this point may be tampered"**. An unanswered question displayed
as a positive finding of tampering, on the most safety-critical surface here.

Three states now. `broken` requires an explicit `ok: false` and is otherwise
unchanged — this never downgrades a real reported break, it only stops
inventing one. **Verification logic untouched, no threshold moved.**

**The harness could not review this tab at all**: the fixture supplied an older
column set (`action/actor/hash/created_at`) against what the panel selects
(`seq/classification/chain_hash/collected_at`), so every field was `undefined`
— 30 rows of "Invalid Date". CLAUDE.md says every tab renders in the harness.
This one did not, which is why none of it had been seen.

### Report layer (`c06cb8b`, `c66c153`)

Both found in the live "Jesus Acosta, age 31" run (41 artifacts, 0 clusters):

- The report published **two contradictory verdicts three lines apart** — "No
  cluster is corroborated…" immediately followed by "Every cluster reaches 2 or
  more…". With zero clusters both fallbacks fire, because both are vacuously
  true of an empty set; the second came through `[].join("\n") || fallback`.
  Regression test **verified to fail on all three assertions pre-fix**.
- One judgement about 25 artifacts printed as **25 identical sentences**.
- Seven blocks headed **"Evidence Record — authoritative"** in one thread. Only
  the newest report now presents as current; the rest collapse (never drop).

### Smaller, each costing something every session

`4398b85` next-step rationales cut mid-sentence with no affordance · the
Evidence lens switcher was five unlabelled squares · report-table heads at
muted-foreground/11px with 0.05-alpha rules. `dd12bf3` Overview reported **87
seconds as "1m"** (31% understatement) while Tools showed `87s` for the same
run. `543244a` the Table lens printed its own serialization
(`source_class=verified_provider`, wrapping *inside* tokens) and the Clusters
lens said "unknown" on every card. `d5fb013` two identical failure cards from
two render paths · a signed storage URL printed across two lines under the chip
that already named the file · timeline stamping the same date on forty rows.

---

## 3 · ⛔ NOT FIXED — found in production evidence, backend or undecided

These are recorded because they are real and measured, not because they were
handled. **Nothing below was changed.**

### 3.1 Phone normalisation manufactures a phantom selector

One phone produced **four artifacts**:

| value | cluster |
|---|---|
| `+19172915568` | seed |
| `19172915568` | `clus_45d02dea` |
| `9172915568` | `clus_45d02dea` |
| **`79172915568`** | `clus_65fc6d70` |

`79172915568` is the **Russian `+7` prefix**. It derives from the
`zoloto585.ru` row that the *same artifact set* explicitly labels
`"Svetlana Belousova, Kazan Russia — COLLISION, unrelated"`. The normaliser
minted a selector out of a row the run had already excluded, and gave it its
own cluster.

### 3.2 Raw breach fields concatenated into a display value

```
1110 ANDERSON AVE3F 1110 ANDERSON AVE APT 3F BRONX NY 10452
```

`address_street` + `address_street2` joined with no separator ("AVE3F"), then
the whole thing repeated. This is the artifact's `value`, i.e. what renders.

### 3.3 The same fact recorded 3–5 times, with disagreeing numbers

One building, one session:

| stat | values seen |
|---|---|
| `violations_total` | **670** / **676** / **28** |
| open violations | **34** / **30** |
| eviction filings | **117** / **118** |

Also: `V&S 1110 LLC` as **3** `organization` artifacts (55/75/75), `Ved Parkash`
as **3** `source_person` artifacts, the address as **4+**. The Evidence count of
88 is inflated by near-duplicates that differ only in phrasing.

### 3.4 ⚠️ Full SSN in an artifact VALUE, not just metadata

```
SSN 207563839 — AT&T breach: JESUS ACOSTA, 1110 Anderson Ave Apt 3F,
Bronx NY 10452, phone 9172915568
```

`sensitive: true` is set in metadata, but the **value string** — the part that
renders on the board, in the report, and in exports — carries SSN + full
address + phone together. These screens get screenshotted and pasted.

### 3.5 The dispatch boundary, in production

CLAUDE.md's open P1, observed live. Seed `"Jesus Acosta, age 31"` contains
spaces, which `breach_check` and `serus_darkweb_scan` **cannot** accept — a
knowable validation rule. Both were called anyway, and **serus was called twice
with the identical rejected input** (422 both times).

Run totals: **11 of 21 tool calls failed (52%)**. `jina_reader_scrape` 4/7
failed; `gemini_deep_dork` 2/2; `minimax_correlate` **failed**, which is why the
report has no clusters, which is what surfaced §2's contradictory verdicts.

### 3.6 Decisions for JD, not taken unilaterally

- **CSP blocks Vercel's own toolbar** (`vercel.live/_next-live/feedback/feedback.js`),
  twice per load. Fix is either adding `https://vercel.live` to `script-src` in
  `vercel.json`, or disabling the Vercel Toolbar for production. **Widening a
  security header is not a drive-by.** ⚠️ **PR #502 edits that exact CSP line** —
  do this after #502 lands or take the conflict.
- **A 401 on page load**: `threads?select=id&user_id=eq.<uid>` fires before the
  session hydrates, then self-recovers. **Could not be located by grep** — it
  matches no threads query in `src/`. Needs a real trace, not a guess.
- **Three `?health=1` probes per page load**, 1.3–1.6s each, one firing on
  `onKeyDown` — so **every scan pays ~1.5s of health probe before it starts**.
  Both call sites are explicitly guarded and commented as intentional
  (pre-flight deploy detection; stale-run recovery sweep). Touching them means
  touching the finalize/recovery machinery, which owns this project's worst
  incidents. Not done blind.

---

## 4 · Branches and PRs

| PR | Head | State |
|---|---|---|
| **#507** | `c66c153` | This session's work. Draft, CI green. **JD merges.** |
| **#504** | `43fe450` | Docs from the prior session. Draft, green. |
| **#502** | `0896e00` | Reviewed 08-25, all seven settled constraints hold. **Gates A3 and Part B.** CI green but stale at base `4cc7573`. |
| #505 / #506 | — | Should merge — `main`'s `mem/` describes code that exists only on #502's branch. |
| #493 | — | **Foundational**, not cleanup. |
| #491, #435 | — | A3 triage. |

`claude/design-palette-pass` is the working branch for #507.

---

## 5 · How to review #507

```bash
npx vite --config vite.harness.config.ts     # read the port off the banner
# /chat/11111111-2222-4333-8444-555555555555
```

There are **SIX** tabs, not five — `Overview` is `TABS[0]` and the landing tab.
Chromium: `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`.

The suite is a **rename tripwire, not a visual gate**: `window.matchMedia` is
stubbed to always return `matches: false`, there are zero snapshot tests, zero
axe/contrast tests, and exactly one test reads `index.css` as text — pinning
four literal substrings, one of them **whitespace-exact**
(`.signal-sweep { animation: none`), kept byte-identical.

---

## 6 · Method note worth keeping

The graph work — the largest real gain this session — came from **looking at
the screen**, not from the token audit that preceded it. The recon was still
worth its cost (it caught that a naive token edit would have changed nothing
visible and would have drained the authority ladder), but the defects that
mattered most to an analyst were visible to anyone who opened the tab.

Everything in §3 came from JD pasting real runs. **Production evidence beat
both the fixture and the audit.**
