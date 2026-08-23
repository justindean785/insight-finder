# SESSION HANDOFF — 2026-08-23 · report authority, #477, CI billing recovery

**Read this before `SESSION_HANDOFF_2026-08-10_*` III.** Where they disagree, this file wins —
every number here was re-measured against the live database and a clean checkout on 2026-08-23,
not recalled. Like every file in the series this is **a dated measurement, not a state**: re-verify
before acting.

---

## 0. Orientation — the 60-second version

- `main` = `5cc1940c5a87e6910563a6150484ac0002f52a63`
- Live edge build = `14e42a5`, healthy (`ok:true`, deepseek slot → `glm-5.2`, `reveal_breach_data:true`)
- **CI was dead for ~70 hours** (2026-08-20 09:23 → 2026-08-23 07:06). Cause and fix in §3. It is green again.
- **Four open PRs.** One is mine and green (#486). One is ready but unverified by CI (#481).
- The session's biggest finding is **not** in a PR yet: see §6, P0-1 (`intel.ts:2071`).

---

## 1. Exact repository state

| | value |
|---|---|
| `origin/main` | `5cc1940c5a87e6910563a6150484ac0002f52a63` |
| previous main | `6ab21fcbecf95cf60c73d601f83e83ac00115aaa` |
| main is protected? | **no** |
| live `/health` build | `14e42a5` (unchanged all session — **nothing was deployed**) |

> ⚠️ The remote/web sandbox clones **shallow at depth 50**. Run
> `git fetch --unshallow --filter=blob:none` before trusting any divergence or conflict
> measurement. This session did; the repo is 712 commits.

### Branches touched or created this session

| branch | head | state |
|---|---|---|
| `claude/477-record-finding-label-authority` | `517f01c1c3ef8dadd2432cc91afd0df00b1320ed` | **live — PR #486, green** |
| `fix/confidence-cap-display-invariant` | `6c395590ee6e6361c81c4c0d50d71008669b0dc9` | **live — PR #481**; I added the `linkage_confirmed` pin commit |
| `claude/report-authority-repair-gjf7vx` | `96d26433c0d156c3dc5e0dd11911f43665c69310` | **DEAD — squash-merged as #483 into `5cc1940`.** Safe to delete. Do not build on it. |

Pre-existing branches **not touched**: `claude/c2-confidence-caps`, `fix/edge-fn-key-and-cors-parity`,
`fix/next-steps-think-leak`, `cursor/graphify-mcp-20b6`, `fix/paid-call-accounting`.

---

## 2. Open pull requests

| PR | Title | Head | State | Notes |
|---|---|---|---|---|
| **#486** | `fix(record_finding): derive status server-side instead of ratifying the model's label` | `517f01c` | **draft, CI GREEN** | Mine. #477 core. Full evidence in the PR body + comments. |
| **#481** | `fix(confidence): display confidence may never exceed the server's recorded cap` | `6c39559` | **ready, CI NEVER RAN** | Its red X is the billing dispatch failure, not code. Green on local gates. **Needs one CI re-run to be trustworthy.** |
| #468 | Register hosted Graphify MCP in Cursor | `b8ba236` | draft | Not touched. Config only. |
| #435 | `fix: charge paid-call budget on real provider attempts` | `90474c5` | draft | Not touched — explicitly out of scope this session. |

**#483 merged** (cron removal, §3). **#484 closed** as a duplicate of #483.

---

## 3. The CI outage — cause, fix, and the trap

**Symptom:** every Actions job across every workflow failed in **3–7 seconds** with
`runner_id: 0`, empty runner name, **no `steps` array at all**, and logs 404.

**Do not read that as a code failure.** The tell was `Migrations (psql validation)` failing on a
PR that touched two frontend files. Two unrelated workflows failed identically while the endpoint
they probe was verifiably green (HTTP 200, `ok:true`).

**Root cause, two layers:**

1. **Immediate:** an account **Actions budget of $0 with "Stop usage: Yes"**. GitHub's message
   conflates two causes — *"recent account payments have failed **or** your spending limit needs to
   be increased"* — and shows **no amount due**, because a $0 budget is a stop, not a bill. Fixed by
   raising it to $20.
2. **Underlying:** the `Edge Health` workflow polled `*/15`. GitHub **bills every job rounded up to
   a full minute**, so a ~10-second curl cost a full billable minute — ~2,900 minutes/month for ~8
   hours of real work, on a **GitHub Free** account (2,000 included). It drained the shared
   allowance and took CI down with it. **Fixed in #483: the schedule is removed entirely**;
   `workflow_dispatch` retained. Cost → 0.

**Why removed rather than reduced:** the probe was dark ~65 hours and nobody noticed — its failure
emails were indistinguishable from the billing failures. A monitor that can fail silently for three
days while consuming the budget that runs the test suite is a net negative.

**Recovery confirmed** on 2026-08-23T07:06Z: run `32624683082` on `517f01c` — Frontend 2m55s,
Edge 1m13s, Migrations 22s, all success. Real durations are the proof of a real run.

**There is currently NO automated production health monitoring.** Run `Edge Health` by hand from
the Actions tab, or stand up an external uptime monitor — which is what the workflow header already
calls it.

---

## 4. Verified baselines — re-measure, but these were exact on 2026-08-23

| gate | value | note |
|---|---|---|
| Frontend `npx vitest run` on `main` | **115 files, 1422 passed, 1 skipped, 0 failed** | CLAUDE.md's 1288/105 is **stale** |
| Frontend on `#481` head | 116 files, 1445 passed, 1 skipped, 0 failed | |
| Edge `npm run test:edge` on `main` | **1279 passed / 0 failed / 5 ignored** | CLAUDE.md's 1178 is **stale** |
| Edge on `#486` head | 1286 passed / 0 failed / 5 ignored | +7 new |
| Migrations | **46/46**, 12 SECURITY DEFINER fns, **0** anon/PUBLIC offenders | fresh DB |
| Lint on `main` | 0 errors, 10 warnings | the 10 warnings are pre-existing |

**The "10 pre-existing frontend failures" cited in #481's body do not exist.** They were a
duplicate-React artifact from a shared `node_modules`. A clean isolated checkout with its own
`npm ci` gives **0 failures**. Always use an isolated worktree with its own install.

**Deno is not preinstalled** in the web sandbox:
`DENO_INSTALL=/usr/local sh <(curl -fsSL https://deno.land/install.sh) -y`.
Postgres 16 **is** present but not running: `service postgresql start`, then set the `postgres`
password, then create a throwaway DB per run.

---

## 5. Production measurements — the governing evidence

Queried live via the **Lovable MCP connector** (`mcp__Lovable__query_database`, project
`4ce11bc3-039d-4439-b293-acacca9e1e3a`). The custom `loveable` MCP server is **broken** — `echo`
works, but `list_investigations` and `get_investigation` both fail. Use the Lovable connector instead.

**Corpus: 8,788 artifacts across 167 threads.**

| metric | value | meaning |
|---|---|---|
| rows **exceeding** their own `confidence_cap_applied` | **0 / 8,788** | write-side enforcement is exact; every inflation is presentational |
| rows with `confidence_cap_applied` | 8,301 (94%) | in `metadata`, **never** top-level |
| `kind='finding'` rows | **13** | `record_finding` almost never runs — ~8% of threads |
| rows with `metadata.label` | **84** | only **16** are enum values; 68 are free text |
| `subject_unlinked` | **207** | quarantine does fire |
| `linkage_confirmed` | **0** | ⚠️ the release hatch has **never once** been used |

> ⚠️ **Do not generalise from a small sample.** Mid-session I drew systemic conclusions from 259
> rows (3 scans) and got three of them wrong — I claimed `record_finding` never runs, `metadata.label`
> is never persisted, and quarantine never fires. All three are false at scale. Corrections are
> posted on #479. **Query the database.**

### #477, measured

Of the 13 `record_finding` rows, **10 carry `label:"CONFIRMED"` at server confidence 15–78** — every
one below the ≥80 bar, mean 43.3, lowest **15**. `applied_label` echoed each back as ratified.

The other 68 `metadata.label` rows are free text on **artifact** rows — including record-company
names (`Mozzy Records`, `One RPM`, `Third Generation Records`) because the model read "label" in its
ordinary English sense — plus 56 rows of `triage_decision`.

### `metadata.label` carries THREE incompatible meanings

1. integrity verdict — `record_finding` (`tool-registry.ts:5638`) — **fixed in #486**
2. **META-KIND marker** — `triage_seed` writes `label:"triage_decision"` (`tool-registry.ts:459`,
   `tools/meta.ts:271`) and **`useThreadArtifacts.ts:63` `isMetaArtifact` reads it** to exclude those
   rows from every artifact count. **Load-bearing — do not rename or namespace `metadata.label`
   globally** or you inflate every number an analyst reads.
3. free text — model passthrough on artifact tool paths

---

## 6. NOT YET FILED — do these next

### P0-1 · filed as **issue #485** · the top safety defect

`src/lib/intel.ts:2071`:

```ts
const who = c.names[0] ?? seedName ?? c.emails[0] ?? c.usernames[0] ?? "unknown";
```

`seedName` **outranks the cluster's own email and username**, so any cluster without a `name`
artifact inherits the *seed subject's* identity. On a live two-person collision this published a
**full SSN, home address, phone and a 2014 felony narcotics arrest under the wrong named private
individual** — while the engine had separated them at 0.90/0.92, every PII row carried its own
distinct `subject_id` with `parent:null`, and a dedicated `collision_detector` had fired three
`contradiction` rows naming the exact conflict.

Detection worked. Attribution overrode it at one line.

**Fix:** `c.names[0] ?? c.emails[0] ?? c.usernames[0] ?? "unattributed cluster"` — drop `seedName`.
Nothing is hidden; rows render in full, under the right entity.

### P0-2 · **not filed** · "What Is Actually Corroborated" is a geography filter

`src/lib/intel.ts:1421-1426` filters clusters on `c.matchesSeedLocation === true` — a **state match,
not a source count** — and its source-chain fallback string is literally `"single source"`. That is
why the report listed 5 corroborated clusters while the app's own Confidence Signals panel read
**1 of 97 findings backed by ≥2 independent source classes**.

**Fix:** filter on independent source classes ≥2 (the number the panel already computes); render an
explicit empty state otherwise.

### P1 · **not filed** · quarantine release has never been used

207 rows `subject_unlinked`, **0** `linkage_confirmed`. #448 built an escape hatch no analyst has
ever touched. Either the UI does not surface it or nobody knows it exists. Worth its own issue.

### P1 · **not filed** · Key Findings and the Artifact Table disagree on the same row

`buildReportMarkdown`: `intel.ts:1079` `conf()` applies analyst reviews; `intel.ts:1021`
`buildEvidenceMatrixMarkdown(artifacts)` **takes no reviews parameter** and `:1024` calls
`labelForArtifact(a)` with no review argument. Measured live: `jayttf` 70 vs 50, `133 Entertainment`
65 vs 40 — deltas exactly `REVIEW_DELTA.confirmed` (+20) and `.key` (+25). This is **#478's defect
inside `buildReportMarkdown`**, a second call site worth adding to that issue.

---

## 7. Issue-graph corrections

- **#479's stated data source does not hold.** It builds the authoritative block from `kind='finding'`
  rows; there are **13 across 167 threads**, so it renders empty on ~92% of runs. The zero-findings
  case must be the *designed* case, or the source must change to artifacts. Posted to #479.
- **#479's "Blocked-by #477" is accurate** (I briefly claimed otherwise from the bad sample and
  retracted it on the issue). #477's warning is not precautionary: reading `metadata.label` would
  publish CONFIRMED on a row scored **15**.
- **#477 is two defects, deliberately split.** #486 fixes model-label ratification on
  `record_finding`. The overloaded-key / free-text passthrough on artifact rows is a **separate PR,
  not yet written**.
- **#482 confirmed with production data.** Cap is in `metadata` on 8,301 rows and **top-level on
  zero**. The harness fixture puts it top-level, where it is bit-for-bit inert. Its fix list
  (a3/a4/a6) is **incomplete — `a9` and `a10` also carry a top-level cap of 55**.

---

## 8. Settled this session — do not re-litigate

- **`linkage_confirmed` does NOT lift `confidence_cap_applied`.** Operator decision 2026-08-23.
  `linkage_confirmed` answers *whose* a row is (provenance); the cap answers *how strong* the evidence
  is (source classes). Orthogonal. Pinned by 4 tests in
  `src/test/confidence-cap-display-invariant.test.ts` on `6c39559`. The Graphify advisory that raised
  it was also **mis-framed** — there was no bypass to lose, because nothing in the scoring path read
  the cap before #481.
- **`resolveRecordingStatus` is the canonical recording-status authority** (`recording-source-policy.ts:83`),
  wrapping `deriveStatus` + `coerceCoherentStatus`. Already used at `tool-registry.ts:4662`, `:5021`,
  `tools/recording.ts:78`, `:319`. **Reuse it. Do not add a fifth ladder.**
- **`REVEAL_BREACH_DATA` stays ON.** Owner-reaffirmed 2026-08-23: private single-user analyst
  environment, full breach detail intentionally visible. Do not redact, mask, truncate, filter, or
  alter export/RLS/authorization behavior. Pre-release disclosure policy is a **separate project with
  explicit owner approval** — out of scope for any current work.

---

## 9. Standing constraints

- Work only in canonical `justindean785/insight-finder`. Lovable is a **surgical backend sync +
  deploy channel**, never the source of truth. Never blanket-sync; never `rsync --delete`.
- **A mirror merge is not a deploy.** The only proof of deploy is a moved `/health` build SHA.
- **No auto-merge.** JD gives merge and deploy authorization.
- Preserve run-termination invariants I-1 and I-2. No new work inside the finalize window. No global
  `toolChoice` change.
- `MAX_PAID_CALLS` stays bounded.
- A behavioural test must **drive the shipped control flow**, never re-describe it.
  `record_finding_corroboration_test.ts` is the anti-pattern — it re-derives the arithmetic inline and
  cannot catch a regression in the real call path. `record_finding_label_authority_test.ts` is the
  pattern to copy: it executes `buildTools(...).tools.record_finding.execute()` against a capturing stub.

---

## 10. Recommended next actions, in order

1. **Re-run CI on #481** (~$0.06). It is the only PR whose green is unverified by a runner.
2. **P0-1 / issue #485** — one-line fix, highest safety value. Failure-first tests against
   `buildIdentityClusters`.
3. **P0-2** — file it, then fix `intel.ts:1421`.
4. **#486 review + merge** when you are ready; then the #477 follow-up PR for the artifact-row passthrough.
5. **#479** — decide the data source before implementing (see §7).
6. External uptime monitoring to replace the removed cron.

**Nothing has been deployed. `/health` still reports `14e42a5`.** No mirror sync, no build stamp, no
database mutation, no production setting change was made this session.
