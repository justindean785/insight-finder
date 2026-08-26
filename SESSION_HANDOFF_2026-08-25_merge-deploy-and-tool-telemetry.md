# Session handoff — 2026-08-25: A1 merges, the first edge deploy since #438, and the tool-telemetry finding

Session `01FbnhM3u7weHbAWUHeW69T6`. Everything below was re-measured at the end of the
session against primary sources — the live `/health` endpoint, the production database,
and a fresh gate run — not carried forward from mid-session notes.

## SHAs

| ref | value |
| --- | --- |
| `main` at session start | `4cc7573` |
| **`main` now** | **`a38963c`** |
| `deploy/live` | `865f49e` (was `14e42a5`) |
| **live `/health` build** | **`865f49e`** (was `14e42a5` since #438) |
| mirror `seeker-spark-search-5362c57c` main | `783f879` (was `af25a51`) |

`main` history this session:
`4cc7573` → `3556a97` (#501) → `42084a1` (#468) → `865f49e` (#503) → `df24977` (build stamp)
→ `a38963c` (deploy ledger).

## What shipped

### A1 — three PRs squash-merged, in the requested order

| PR | what | result |
| --- | --- | --- |
| #501 | report authority (#499/#500) | `3556a97` |
| #468 | Graphify `.mcp.json` config | `42084a1` |
| #503 | docs (`mem/`) | `865f49e` |

#468's CI was **stale** — green, but from 2026-08-16 against base `9c918d4`. Its branch was
updated onto the then-current `main` and re-run before merging. #503 got the same treatment.
Both were drafts and were marked ready first.

### Edge deploy — the first since #438

Three commits had been merged to `main` and never deployed: `0c5bdb8` (stamp), `6f71817`
(#486 — `record_finding` derives status server-side), `4cc7573` (#498 — authoritative
Evidence Record). The frontend had already shipped the report layer that expects them.

The canonical five-step recipe was run in full:

1. merged to canonical `main` — already done
2. **stamp** — `npm run stamp:build`, marker `14e42a5` → `865f49e`, committed `df24977`
3. **surgical mirror sync** — 14 files, `osint-agent` only, **zero deletions**, zero
   mirror-only files clobbered; `evidence-export` / `security-test-lab` / `_shared` verified
   byte-identical by `diff -rq` and left untouched; generated `mcp/` untouched → `783f879`
4. **explicit Lovable `supabase--deploy_edge_functions`** (`function_names: ["osint-agent"]`)
5. **verified live** — `/health` `build = 865f49e`, stable across three probes, `ok=true`,
   no failing checks, `selected_provider=deepseek` / `orchestrator_reason=pinned`,
   `reveal_breach_data=true`
6. **recorded** — `npm run record:deploy`, ledger + `deploy/live` published (`a38963c`)

**The Lovable MCP call timed out client-side at 60 s and the deploy still succeeded.** The
moved `/health` SHA was the only proof available and it was sufficient — the exact scenario
the recipe's "an agent's report is not proof" rule exists for. The agent's own report
arrived later and matched on all four points.

Two mechanical notes for the next deploy:
- `record:deploy` first refused with `ledger_ref_divergence` because **`deploy/live` existed
  on the remote but not locally**. `git branch -f deploy/live origin/deploy/live` fixed it.
- `DEPLOYED BYTES VERIFIED: NO` is expected on every row — the Lovable→Supabase path exposes
  no artifact digest. The check establishes marker-to-source provenance, nothing more.

## Verified state of `main` (`a38963c`)

| gate | result |
| --- | --- |
| `npm ci` | clean |
| `npm run lint` | **0 errors**, 10 warnings (all `react-refresh/only-export-components`) |
| `npm run typecheck` | clean |
| `npm run test` | **1543 passed / 1 skipped / 124 files** |
| `npm run test:edge` | **1370 passed / 0 failed / 5 ignored** |

**CLAUDE.md's baselines are stale.** It records 1422/115 files (frontend) and 1279/5 (edge);
actual is 1543/124 and 1370/5. Worth re-stamping.

## A2 — #502 reviewed, NOT merged

All seven settled constraints hold: `REVEAL_BREACH_DATA` untouched (default still
`!== "false"`); `linkage_confirmed` / `confidence_cap_applied` untouched; no `toolChoice`
code change (only prose in its handoff doc); `MAX_PAID_CALLS = 12` byte-identical;
`recovery.ts` / `orchestrator-finalize.ts` / `cluster.ts` untouched (I-1/I-2 preserved);
`metadata.label` untouched; no service-role client for user-scoped writes — the deletion RPC
takes **no arguments**, derives `_uid` from `auth.uid()`, filters all 15 `DELETE`s on
`WHERE user_id = _uid`, pins `SET search_path = public, auth`, and is `REVOKE`d from
`public`/`anon` with `GRANT EXECUTE` to `authenticated` only.

Two things the PR body under-describes:

- **`vercel.json` DOES change.** CSP `script-src` drops `'unsafe-inline'`. The body lists
  "vercel.json rewrite" under *deliberately not done*, which reads as though the file is
  untouched. Verified safe: built `dist/index.html` emits exactly one
  `<script type="module" crossorigin src="…">`, **zero** inline scripts, **zero** inline
  handlers. It is a genuine hardening win; it just needs a line in the body.
- **Its CI is green but stale**, at base `4cc7573`. `mergeable_state` is still `clean`.
  Its `src/lib/review.ts` change is a telemetry swap in `useReviewStates` and does not
  collide with #501's `loadFromDb` rewrite in the same file.

## Corrections — claims that were believed today and turned out false

This is the most useful section. Every one of these was asserted confidently first.

1. **`indicia_phone` was NOT a finalize-window skip.** Its row reads
   `ok=false, "internal paid-call cap reached (12 this run) — internal throttle, not a
   provider limit"`, raised at `runtime-policy.ts:444` (runtime governor), not
   `cache.ts:1009`. A sibling session concluded finalize-window from *other tools'* skip
   reasons quoted in model-authored artifact prose.
2. **#501 does not empty the Report.** `authoritySection()` returns `[]` when no authority
   is supplied and is rendered **above** Key Findings to qualify it (`intel.ts:1143`).
   Key Findings still computes over all artifacts and falls back to the strongest
   CORRELATED/INFERRED leads when nothing is CONFIRMED (`intel.ts:1230`). The banner it
   showed was **true**: that thread has 0 of 77 artifacts at `kind='finding'`.
3. **My own error: `where not ok` misses skips.** Finalize-window skips log with
   **`ok = true`**. I reported "zero skips" for a thread that had four. Filter on
   `error_msg is not null`.
4. **GitHub's check-runs API served 20+ minute stale data repeatedly.** Twice I read a
   finished job as hung — once nearly cancelling a healthy run. `list_workflow_runs` and
   `check_suite.completed` webhooks were the reliable signals; neither endpoint was
   consistently fresh.
5. **#503 (which I merged) shipped three defective claims** — see #505 below.

## Branch situation

- **Three merged head branches still exist on the remote** and can be deleted:
  `lead-project/report-finding-authority`, `cursor/graphify-mcp-20b6`,
  `claude/docs-session-notes-oi0urm`. (They read as "not contained in main" — expected, they
  were squash-merged. The PRs are merged.)
- `deploy/live` now exists **locally as well as remotely**, pointing at `865f49e`.
- This session's branch is `claude/merge-prs-501-468-503-ploupv` (PR #504), rebased onto
  current `main`.

## Open PRs and recommended disposition

| PR | state | what | disposition |
| --- | --- | --- | --- |
| **#502** | draft, CI green-but-stale | audit remediation + run-wedge + #476 deletion | **Merge next.** Reviewed; unblocks A3 and all of Part B |
| **#505** | draft, clean | corrects three claims #503 put on `main` | **Merge.** `main`'s memory currently describes code that does not exist |
| **#506** | draft, clean | comment-only truth-ups; +1 non-vacuous test | Low risk. `MAX_PAID_CALLS` values unchanged |
| **#493** | **not a draft** | empty-vs-error telemetry | **Promote to foundational** — see below |
| #491 | draft | address-seed dork family | A3 triage against #502 |
| #435 | draft | paid-call budget on real attempts | A3 triage against #502 |
| #504 | draft | this session's memory + handoff | Yours to merge |

## The tool-telemetry finding (new, and it reorders the plan)

Full detail in `mem/ops/tool-telemetry-operational-patterns.md`. Measured against production:

```
681 doomed calls · 158 threads · 30 tools · 7,683 dead seconds · 48.6 s per thread
  417 died at their own timeout ceiling   (30 tools)
  168 blocked / rate-limited 403/429/423  (19 tools)
   96 malformed request, HTTP 400 — ours  (12 tools)
```

Charged cost is `$0.000` — failures aren't billed. **The waste is wall-clock.**

Thread `e143a5af` opened its finalize window **90 s** into the run. The corpus average is
**48.6 s of doomed calls per thread**. So roughly half the pre-finalize budget goes to calls
that could not have succeeded — which makes "the finalize window is too aggressive" a
**symptom**. Fixing ceilings and blocks is mechanical and safe and hands the window back
half its budget **without touching the finalize path** or `MAX_PAID_CALLS`, both of which
CLAUDE.md marks settled/forbidden.

**30 tools dying at their own ceilings is one configuration error, not 30 bugs.** No code
audit framed it that way. One query over outcomes does.

Also confirmed: `tool_call_cache` is **40 MB, 10,906 rows, 10,835 expired (99.3%)**, oldest
2026-06-25, with nothing sweeping it.

### Suggested order from here

1. **#502** — unblocks everything
2. **#505** (and #506) — stop `main`'s memory lying about `main`'s code
3. **#493 in A3** — treat as foundational, not cleanup. It is the prerequisite for any
   learning layer: `indicia_person` returns `no record found` 103 times in 168 calls, and
   that is a **correct negative**, not a failure. Conflating the two teaches a learner to
   stop calling the best people-search provider.
4. **Timeout ceilings + block-list + `tool_call_cache` sweep** — mechanical, safe, ~49 s/run
5. **Operational-pattern rollout, Phase 1 (read-only)** — surface per-tool outcomes as
   `OPERATIONAL` memories distinct from `CASE` memories
6. Then **B1** as originally planned

## Unresolved

- **Deno availability in the sandbox is inconsistent.** This session's sandbox had **no**
  preinstalled Deno; the npm-registry route in `mem/ops/deno-tests-in-web-sandbox` worked and
  produced 2.9.5. #506 reports Deno **is** preinstalled (also 2.9.5). Do not "correct" that
  memory note in either direction until it is measured twice more.
- `MAX_PAID_CALLS` vs the finalize window remains a coupled design question, deliberately
  untouched. The telemetry above argues the pressure is relievable without changing either.
- Nothing was done about the sibling session `01XJGSHnzsGpSsA3C8NNcdot` (idle/blocked). It
  still holds corrections 1 and 2 above as live beliefs.

---

# Addendum — 2026-08-26: frontend design pass (no code shipped)

Appended at the end of the session. **Nothing under `src/` or `supabase/` was changed** — the design
work lives in a published canvas, and `src/index.css` is byte-identical to `main`.

## State at handover

| ref | value |
| --- | --- |
| `main` | `a38963c` |
| live `/health` build | `865f49e` |
| `deploy/live` | `865f49e` |
| mirror main | `783f879` |
| this branch (PR #504) | `claude/merge-prs-501-468-503-ploupv` |
| design branch | `claude/design-palette-pass` @ `a38963c` — **created, zero commits** |

Gate on `a38963c`: lint 0 errors / 10 warnings · typecheck clean · **1543 passed / 1 skipped / 124
files** · edge **1370 / 0 failed / 5 ignored**.

## What the design pass established

Full detail in `mem/style/evidence-workspace-design-direction.md`. The three findings that matter:

1. **99.4% tokenized** (102 CSS vars; 1,608 token utilities vs 10 hardcoded) — a recolour is an
   `index.css` edit, and it barely collides with B1–B7.
2. **`.panel` is a hue-neutral 2.6% white film**, not the `--surface-*` ramp. Overriding surface
   tokens changes almost nothing visible. This is the measured reason "colour scheme" passes on this
   app have repeatedly looked like nothing happened.
3. **`--danger` = `--confidence-low` = `--authority-conflict` = `358 92% 64%`.** Identical. A 38%
   confidence renders in alarm red beside a `Conflict` chip. Breaking this identity is the single
   highest-value colour fix available.

## Direction chosen

**"Dossier, alive"** — editorial-intelligence-document on true black glass, animated. JD reviewed
three static directions and picked Dossier, then asked for it bolder, darker, glassier and animated.

Canvas (authored source recoverable via `seed-canvas.mjs --extract`):
**https://claude.ai/code/artifact/f7d1ecf7-44eb-470f-a1a4-94249467697a**

The rule that must survive porting into `index.css`: **confidence is not coloured by value.** Neutral
numeral, hairline bar for magnitude, hue reserved for authority. Oxblood once per screen.

Unresolved before it can ship: the ~400px masthead is unchecked against the Graph and Tools tabs, and
PNG/PDF export falls back from Newsreader.

## Nothing was merged, deployed or mirror-synced by this addendum.
