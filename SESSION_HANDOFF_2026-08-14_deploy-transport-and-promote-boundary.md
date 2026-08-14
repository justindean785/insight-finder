# Session handoff — 2026-08-14 — deploy transport & the promote boundary

Fourth in the series: `…2026-08-09_beta-stabilization` → `…2026-08-10_…-II` →
`…2026-08-10_…-III` → **this**.

Read **`CLAUDE.md` first** — it was corrected today (#455) and is now the accurate entry
point. Read this for what changed, what is open, and what to do next. Read III only for
its evidence; its status claims are superseded and it carries a banner saying so.

Every claim here was measured on 2026-08-14 with the command printed beside it. Where
something was *not* measured, it says so. **This document is a dated measurement, not a
state** — that lesson cost III's headline claim six hours of life, and it applies here too.

---

## 1. The two things to take away

> **1. The deploy axis is green end to end, and for the first time the backend marker is
> honest. Live `/health` = `8c6184b`, canonical `main` = `96b1cbc`, Vercel production =
> `795dbf5`, mirror = `0adafc4`. All four agree.**
>
> **2. The `subject_unlinked` promote boundary is CLOSED on every deployed surface. What
> is still open is a fourth, non-deployed surface — a published Lovable frontend that can
> never receive the fix — and a transport defect that makes backend shipping manual.**

### 1.1 Verify it yourself before trusting any of this

```bash
curl -s "https://skzqwbyvmwqarfgfvyky.supabase.co/functions/v1/osint-agent?health=1" | jq
git log --oneline -3                                     # main
npm run verify:deploy                                    # read-only provenance check
diff -rq supabase/functions/osint-agent \
         ../seeker-spark-search-5362c57c/supabase/functions/osint-agent   # must be empty
```

`verify:deploy` (landed today, #444) does the first three in one command and prints its own
ceiling. **Read the ceiling line, not the green word** — see §4.

---

## 2. What shipped

Ten commits landed on `main`. Everything below is merged AND deployed unless stated.

| PR | What | Channel | Live? |
| --- | --- | --- | --- |
| **#448** | bind `subject_unlinked` at the PROMOTE boundary | frontend | ✅ Vercel `795dbf5` |
| **#450** | stop rendering every assistant message twice | frontend | ✅ |
| **#445** | evidence-count tooltip fires in both divergence directions | frontend | ✅ |
| **#456** | cap a quarantined row's displayed confidence NUMBER, not just its label | frontend | ✅ |
| **#444** | deploy-provenance recorder (`verify:deploy` / `record:deploy`) | tooling | ✅ |
| **#446** | handoff III, merged as a dated record with a SUPERSEDED banner | docs | — |
| **#451** | report layer bypasses the integrity engine | docs | — |
| **#455** | **CLAUDE.md corrected on nine load-bearing points** | docs | — |
| `795dbf5` | stamp `BUILD_MARKER` → `8c6184b` | backend | ✅ deployed |
| `96b1cbc` | deploy ledger + `deploy/live` ref | tooling | — |

Closed, not merged:

- **#447** — the deliberately-red promote-boundary reproduction. Superseded by #448, whose
  suite is a strict superset. It also *could not* merge: its second commit renamed the file
  to `src/test/promote-boundary.test.ts`, the same path #448 uses → add/add conflict.
- **#411** — command-center UI. Already landed via **#428** (`60b24bc`, "revives #411").
  Second copy of shipped work, and conflicting.

### 2.1 #448 — the P0 that three handoffs chased

Closes the last of the three authority boundaries (write #433 · pivot #436 · **promote
#448**). New shared predicate `isClusterIneligible` in `src/lib/report-hygiene.ts`, applied
at all five `buildIdentityClusters` call sites plus `isConflicted`
(`confidence-dimensions.ts`) and `isConflict` (`entity-graph.ts`).

**Deliberately separate from `isCollisionArtifact`.** Widening that one instead looks like
the one-line fix and is wrong — it is also the membership test for the report's collision
section, so widening double-lists every quarantined row.

**Verified on the harness before merge, same fixture both sides:**

```
before (gate off)   10 entities · 2 real links · 5 clusters
after  (gate on)    10 entities · 1 real link  · 4 clusters
```

The two quarantined rows re-render conflict-coloured and detached. They keep their place in
the artifact table and the Evidence count. **Quarantine removes authority, never existence
— a change that makes a quarantined row disappear is a regression, not a tightening.**

#448 also bundled the label cap (§3.4 of III), which III asked to be a separate sign-off-gated
PR. Its commit records operator approval dated 2026-08-10. Flagged at merge; noted here so
nobody re-derives it.

---

## 3. ⛔ NEW — the deploy transport is one-directional (P1 infra)

**This is the most important new finding and it is not in any earlier handoff.**

`CLAUDE.md` said: *"a push to that mirror only SYNCS the code into the Lovable project — it
does NOT deploy."* True, but **it understated the problem: the push does not necessarily
sync either.**

Measured today. After mirror PR #83 merged (`0adafc4`), the Lovable workspace still reported:

```
origin  https://git.private.lovable-gcp.code.storage/4ce11bc3-….git   ← NOT GitHub
git ls-remote origin main   →  b8e2056     (the PREVIOUS head)
build-info.ts               →  e7e3f80     (the stale marker)
git ls-remote https://github.com/justindean785/seeker-spark-search-5362c57c main
                            →  could not read Username — no GitHub credentials
```

40+ minutes, zero propagation. It is not eventually-consistent. The real chain has **four**
hops, not three:

```
insight-finder/main  --PR-->  seeker-spark-search-5362c57c/main   (GitHub)
                                        │
                       GitHub → Lovable sync    ← BROKEN / MANUAL. The stuck hop.
                                        ▼
                          Lovable internal git mirror
                                        │
                       supabase--deploy_edge_functions    ← the step CLAUDE.md already flags
                                        ▼
                                  live function
```

**Direction matters:** Lovable → GitHub works (that is how the GLM/Z.AI work reached
canonical as #449, mirror-first). GitHub → Lovable does not.

**Consequence, and it is bigger than a marker:** a backend change can be merged to canonical
and frontend-deployed while remaining **unshippable to Supabase** without a manual
Lovable-side source operation. A marker was recoverable by hand. A real behavioural change
would not have been.

### 3.1 How today's deploy actually completed

Since the transport was dead, the marker was written **by hand in the Lovable workspace**,
under a byte-equivalence gate proven first:

```
Lovable working tree  vs  b8e2056 (stale)     → IDENTICAL across all 223 files
Lovable working tree  vs  0adafc4 (intended)  → exactly 1 line: build-info.ts
Lovable latest_commit_sha == GitHub b8e2056 full SHA (content-addressed ⇒ same tree)
post-edit sha256 == canonical's build-info.ts sha256
canonical tree 5cc38b1ac1f0 == mirror tree 5cc38b1ac1f0
```

**Do not repeat the hand-edit without that gate.** Writing the marker first and assuming the
rest of the tree matches would weaken the exact invariant the marker exists to protect.

**Do not try to repair the transport as a drive-by.** Scope it as its own infrastructure
item. It is the same failure class as mirror/source drift on the master action list: the
deployment chain asserting a state it has not verified.

---

## 4. ⚠️ The stale-mirror trap produced THREE wrong conclusions in one day

`CLAUDE.md` §1.2 warns that a whole-repo diff against the mirror is meaningless. That warning
is necessary but **not sufficient** — the sharper form is:

> **The Lovable workspace contains a COMPLETE, OLDER COPY of the frontend. Only
> `supabase/functions/<fn>/` is ever synced. Its `src/` has never received a frontend commit
> and never will. Reading it as canonical is the single most productive source of false
> findings in this project.**

Three false findings today, all from that one mistake:

| Claim | Reality |
| --- | --- |
| "#453's MCP fix is not mirror-synced or deployed" | It **is** synced — mirror `b8e2056` carries it |
| "`src/lib/intel.ts` has no `subject_unlinked` awareness; `rg` → 0 hits" | Canonical has **43** hits and **16** `isClusterIneligible` hits |
| "P0-B: client surfaces FAIL on five boundaries" | Three of four already landed in #448 |

**How to detect it in one step.** Line numbers and suite size diverge hugely:

| Signal | Canonical `main` | Mirror frontend |
| --- | --- | --- |
| `buildIdentityClusters` | 1642 | **1107** |
| `labelForArtifact` | 337 | **214** |
| `adjustedConfidence` | 239 | **180** |
| `intel.ts` lines | 2074 | **1325** |
| frontend test count | **1295 / 106 files** | ~419 |
| tooling | `npm`, `tsc` | `bunx`, `tsgo` |

**If a report cites `intel.ts:1107` or ~419 tests or `bunx`, it read the mirror. Stop and
re-measure against canonical before acting.**

### 4.1 The root cause is still live — and it is P1

`seeker-spark-search.lovable.app` is **`is_published: true`, `publish_visibility: public`**
(per Lovable's own project metadata), and its `src/integrations/supabase/client.ts` hardcodes
`DEFAULT_SUPABASE_URL = "https://skzqwbyvmwqarfgfvyky.supabase.co"` — the production
database.

So: **a second, published frontend with zero quarantine awareness, serving live production
evidence, that can never inherit #448.** Any analyst on that URL sees the promote-boundary
leak the whole boundary work exists to close.

`CLAUDE.md` calls it "deprecated". **Deprecated and unpublished are different things.**
Reachability was not confirmed from the sandbox (the proxy returns HTTP 000 for every host,
including known-good ones), so verify from a real browser.

**Recommended action: unpublish it.** One operation, closes the exposure, removes the tree
that generated three false findings, and needs no code.

---

## 5. Deploy state — measured 2026-08-14 21:44 UTC

```
canonical main HEAD ......... 96b1cbc  chore(deploy): record live build 8c6184b
  └─ 795dbf5  chore(build): stamp osint-agent build marker 8c6184b
     └─ 8c6184b  docs: CLAUDE.md corrections (#455)      ← the marker names THIS
build-info.ts BUILD_MARKER .. 8c6184b
mirror origin/main .......... 0adafc4  sync(osint-agent): stamp build marker 8c6184b (#83)
live /health build .......... 8c6184b   ← INDEPENDENTLY VERIFIED, not relayed
live build_committed_at ..... 2026-08-14T02:32:12-07:00
Vercel production ........... 795dbf5  target=production, READY
selected_provider / model ... deepseek / glm-5.2  (orchestrator_reason: pinned)
reveal_breach_data .......... true
tools ....................... 16/19 optional APIs configured
```

**Read the one-commit offset correctly or you will chase a phantom.** `stamp-build.mjs`
writes the marker for HEAD *at stamp time*, then that write becomes its own commit. So the
marker names the stamp commit's **parent**. `/health` reporting `8c6184b` while `main` is
`96b1cbc` is correct. A successor who "fixes" this by expecting `/health == main` will
re-stamp forever.

### 5.1 What `verify:deploy` does and does not prove

```
marker commit in canonical history : yes
stamp commit / parent verified     : yes
mirror tree vs canonical           : equal
deployed artifact digest           : unavailable (deploy path exposes none)
DEPLOYED BYTES VERIFIED            : NO — unknown, not established by this check
```

That last line is permanent and deliberate. The recorded verdict field is
`markerProvenanceOk`, **not** `verified`; `deployed_bytes_verified` is always `false`;
`proves` is the string `observed-runtime-marker-maps-to-canonical-source-history`. A
regression test is named for the ceiling. **Keep the naming.** The failure mode this project
suffers from is a tool reporting a stronger guarantee than it has.

Today's deploy went through a hand-edited working tree (§3.1), so the honest ceiling is
marker provenance, not bytes.

**Still uninstrumented:** `evidence-export`, `security-test-lab` and `mcp` expose **no build
marker at all**. For those three there is no way to distinguish synced from deployed. If an
export bug appears, suspect a stale deployed `evidence-export` first.

---

## 6. Production canary — PASS

Run `4d0193c7-4d90-4a1d-8031-3954749d5bdd`, seed `"John Michael Smith"` (`seed_type=person`),
on verified build `8c6184b`.

```
run_started_at   21:16:23Z
updated_at       21:17:14Z          ← ~51 seconds
status           finished
finishReason     stop
recovered_at     NULL               ← genuine terminal finish, no recovery rescue
cost_micro_usd   61,612
tool calls       8, all ok=true, none cached
artifacts        29 persisted, 24 quarantined
```

**This matters against III §5.1**, which measured a 192s run dying inside the finalize window
with nothing durable. A 51-second clean finish is a real datapoint. It is **one** run — do
not generalise it into "finalization is fixed".

### 6.1 Backend promote-boundary — proven on production data

| Check | Canary thread | Corpus-wide (7,426 artifacts) |
| --- | --- | --- |
| quarantined | 24 | **129** |
| with `cluster_id` | 0 | **0** |
| with `subject_id` | 0 | **0** |
| labelled CONFIRMED | 0 | **0** |
| max confidence | 55 | — |

The corpus-wide row is the strong one: the invariant holds across every run ever recorded,
not a fixture. Backend enforcement points: `lib/quarantine.ts` (predicate),
`lib/cluster.ts:144` (union-find exclusion), `graph.ts:240`, `recovery.ts:120`,
`tools/recording.ts:157` → `collisionPeerSignal`.

---

## 7. Open PRs — 27, of which 1 is ready

**#454 is the top priority.** #456 and #457 were created and merged this session.

### Act on these

| PR | Branch | What | State |
| --- | --- | --- | --- |
| **#454** | `claude/findings-table-provenance` | **THE LIVE P0** — Findings table from persisted rows | draft, green, 0 behind at creation |

**#454 is now the top priority.** It is backend, so it needs the full recipe **and** §3's
manual transport step. Measured evidence in its own commit: every row the model upgraded to
CONFIRMED it also inflated — published 95 vs stored 70, published 70 vs stored 45 — several
above the server's own `confidence_cap_applied`.

### Review queue (green, but against an older base)

`#435` paid-call accounting · `#425` run correlation telemetry · `#427` evidence-card
source-class ceiling (**overlaps #456 — read both together**) · `#420` breach provider
observations · `#412` checkpoint races · `#410` broad report integrity (23 files, partly
superseded) · `#408` slices design.

`#430` conflicts and is **settled policy** — `MAX_PAID_CALLS` stays bounded. Do not merge it
as a fix for cap pressure; the answer is the dispatch guard (§8).

### Stale cohort — rebase-or-close decisions, not reviews

`#404` `#401` `#402` `#389` `#386` `#379` `#378` `#347` `#341` `#331` `#330` `#326` `#324`
`#321` `#307` — 36 to 366 commits behind, oldest touched 2026-07-01. **10 of 27 conflict
with `main`.**

Two carry findings recorded on the PRs today:

- **#326** — CI is **genuinely red** (Migrations psql validation fails). Not red-by-design.
  188 behind, not wired to runtime. Do not merge.
- **#198** — the **only non-draft PR**. 366 behind, conflicts, three unresolved review
  threads including a P1: deleting `storage.objects` rows does not remove the storage
  objects. Left open deliberately — retiring the only account-deletion work is an operator
  call, and the compliance requirement outlives the branch. Track it as an issue and
  reimplement on current `main`.

### Mirror repo — close #41

`seeker-spark-search-5362c57c#41`, opened 2026-06-30, is **96 commits behind and has no
merge base at all** — the mirror's history was rewritten under it by a past reconnect cycle.
It cannot be merged or rebased.

---

## 8. Open blockers, ranked

| Sev | Blocker | Next action |
| --- | --- | --- |
| **P0** | Report layer overstates persisted confidence | review + ship **#454**, then the full recipe incl. §3 |
| **P1** | **GitHub→Lovable transport is dead** (§3) | own infra issue; do not fix as a drive-by |
| **P1** | **Published stale frontend** (§4.1) | unpublish `seeker-spark-search.lovable.app` |
| **P1** | `mcp` returns `artifacts` with `select("*")` | raw metadata bypasses every integrity layer; own review |
| **P1** | 3 of 4 edge functions have no build marker | add one, or accept "synced ≠ deployed" explicitly |
| **P1** | Two-user Realtime canary never run | two accounts; A subscribes to B's thread, must receive nothing |
| **P1** | Runs die inside the finalize window | 60/150 threads carry `recovery_reason`; split historic vs fresh before quoting a rate |
| **P1** | Breach-value persistence incomplete | `addCorpus` discards fields the model can now print; sign-off gated |
| **P2** | **Quarantined selectors re-enter paid dispatch** | pre-flight guard on tool INPUT (§8.1) |
| **P2** | Backend catalog↔runtime asymmetry | reported: 7 runtime tools absent from catalog, 14 catalog entries with no impl |

### 8.1 The dispatch boundary — still the only unbound one

```bash
grep -rn "isSubjectUnlinked" supabase/functions/osint-agent/tool-registry.ts index.ts tools/
# → empty
```

Quarantine binds at *write* and *read-back*, never at *dispatch*. A name-only harvest leaves
its quarantined selectors in the model's context window, each able to seed its own paid
multi-tool breach stack. **This is the real cause of run spam and paid-cap pressure — not a
`MAX_PAID_CALLS` set too low.**

There is **no selector queue to filter**: `buildIntermediateStepPlan` never sees artifacts or
selectors. The enforcement point is a **pre-flight guard on tool input**. Two hazards:

- Key by **`type:normalizedValue`**, never value alone. `normalizeTarget` collapses
  non-alphanumerics, so username `"jordan.vale"` and name `"Jordan Vale"` both become
  `"jordan vale"` — keying by value let an ordinary name restore authority to a quarantined
  username. `src/lib/quarantine.ts` already gets this right; copy it.
- **A refusal must be legible as a refusal.** `repairUnknownTool` → `UNKNOWN_TOOL_SINK`
  returns `ok:true`, which is how `dork_harvest(completed)` reached a chain-of-custody record
  for a tool disabled since 2026-07-09.

---

## 9. Next steps — in order, for the next agent

1. **Unpublish the stale Lovable frontend** (§4.1). One action, highest value-per-effort on
   this list, no code.
2. **Ship #454** — the live P0. Backend, so: merge → `npm run stamp:build` → commit →
   surgical mirror sync → **manual Lovable transport (§3)** → explicit deploy → moved
   `/health` SHA → `npm run record:deploy`. Then re-run the canary and diff the published
   Findings table against persisted rows.
3. **File the transport defect** as its own infra issue with §3 as the evidence.
4. **Run the two-user Realtime canary.** Named P0 across three handoffs, still never run.
5. **Triage the stale cohort in one pass.** 15 PRs, 10 conflicting. Rebase the few describing
   live defects (`#386`, `#401`, `#324`), close the rest with a note. Close mirror `#41`.
   Then the ~311 orphaned branches.

**Do not** start with the dispatch guard (§8.1). It is the bigger win for API spend, but it
is a backend change needing the full manual transport, and it should land after the queue
above is clear.

---

## 10. Branch situation

**338 remote branches; 27 have an open PR; 1 is `main`.** Roughly **310 are orphaned** — no
PR, no purpose, mostly from the June consolidation. They make every branch search noisier
than it needs to be.

No branch deletion is safe from a name inventory alone. Each needs a reachability /
unique-commit proof against `main`, merged PRs, tags and open heads before deletion. Do it as
its own approved project, after closing superseded PRs.

### ⚠️ The shallow-clone trap — read before measuring any branch

The web/remote sandbox clones at **depth 50**. Every branch older than that gets a fabricated
merge-base, so `git rev-list --count main..branch` reports hundreds of phantom commits and
`git diff main...branch` reports **zero changed files**.

```bash
git fetch --unshallow --filter=blob:none      # run this FIRST
```

Measured today: before unshallowing, 13 branches reported "ahead=470–634, files=0". After, the
real numbers were 1–16 commits ahead. **Every divergence and conflict number in an earlier
handoff computed in this sandbox is suspect unless it says it unshallowed first.**

Also note `git merge-tree --write-tree` is the reliable conflict check; the old two-argument
form silently reports no conflicts on a treeless clone.

---

## 11. Test baselines — measured today

| Suite | Command | Result | Where |
| --- | --- | --- | --- |
| Frontend | `npx vitest run` | **1295 passed · 1 skipped · 106 files** | local, on #456 |
| Frontend | — | 1288 / 1 / 105 | local, on `main` |
| Edge | `npm run test:edge` | **1178 passed · 0 failed · 5 ignored** | CI, verified in job log |
| Migrations | psql validation | pass | CI |

The frontend number **moved four times in one session** (1220 → 1251 → 1260 → 1288 → 1295).
Re-measure; never quote it from a document.

**Use CI as the edge instrument.** Deno is not preinstalled here, and any PR gives a clean
`deno test` on a provisioned toolchain. A red PR is still a usable measuring device if you
read the per-job conclusions rather than the top-level X — today's 1178 came from a job log
on a PR whose frontend job was still running.

---

## 12. Discipline — what held, and what caught real defects

- **Only a first-party observation counts.** The deploy was reported successful by the
  Lovable agent; it was not believed until `curl` from this session returned `8c6184b`.
  Twice today a relayed claim was wrong.
- **Mutation-test the guard, not just the behaviour.** #456's tests passed **all six** while
  a mutation silently deleted #448's `linkage_confirmed` escape hatch. The missing control
  was added only because the mutation was run. This is handoff II §2.1 recurring: unit-green
  is not semantics-green.
- **A test must fail after the fix for the right reason.** #456's first "negatives still
  apply" assertion (`dismissed < 55`) would have failed *after* the fix too — it conflated
  "negative applies" with "cap applied". Rewritten around a sweep-only row.
- **Check which tree a finding was measured on.** §4. Three false findings in one day.
- **Say things at their true strength.** "Marker provenance verified" ≠ "deployed bytes
  verified". "No exploit path found by inspection" ≠ "unreachable".
- **Preserve quarantined evidence.** All 129 rows stay in the artifact table, the Evidence
  count, and keep their `subject_unlinked_reason`.
- **Never equate:** merged = deployed · mirror push = synced · synced = deployed · frontend
  published = backend deployed · HTTP 200 = investigation succeeded · `ok:true` = beta-ready.

---

## 13. Settled — do not re-litigate

Now consolidated in `CLAUDE.md` under its own heading. Short form:

- **`REVEAL_BREACH_DATA` stays ON.** Operator decision, verifiable at `/health`. If an audit
  re-flags the `?? "true"` default, the correct response is one line: *settled*. The one real
  release note: flipping it gives **masked-by-default, not click-to-reveal** — no per-item
  reveal control exists. That is a feature build, not a deploy-day config change.
- **`MAX_PAID_CALLS` stays bounded.** An unbounded run does not finish more often; it runs
  out of wall-clock instead of budget and dies in a worse place.
- **Intent is NOT inferred from prose.** A future-intent regex was implemented and removed —
  it matched the legitimate closing line *"Drop a seed and I'll run the investigation from
  TRIAGE through REPORT"* and fabricated a report on top of a plain answer.
- **`linkage_confirmed` clears quarantine; ordinary attestation does not.** `reviewed` /
  `confirmed` / `key` answer "is this value real?", not "is it this person's?". A proposal to
  make attestation always return `VERIFY` was **rejected** today — it would have deleted this
  distinction. Pinned by tests at both the label and confidence boundaries.

---

## 14. Operational note

A plaintext account password was pasted into the Lovable project chat during this session to
authorise the canary. **It must be rotated**, and it should be assumed compromised: that
thread is third-party-hosted, agent-readable, and likely retained in logs.

Canaries do not need it. A short-lived bearer token is sufficient and revocable — the canary
that ran used exactly that. **Never hand a password to an agent or a third-party chat.**

---

## 15. If you have one hour

1. `curl …?health=1` and `npm run verify:deploy`. Confirm the axis is still green before
   changing anything. If it moved, stop and find out why.
2. **Unpublish the stale Lovable frontend** (§4.1).
3. Read **#454** properly. It is the live P0 and the only remaining integrity defect on a
   deployed surface.
4. Rotate the password (§14).
