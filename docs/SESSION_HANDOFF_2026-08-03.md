# Session handoff — 2026-08-03

Canonical `main`: **`a23fbc917dce9dffd3abf67e2c8d60eb22d7a04b`**
Live `/health` build: **`6035513`** · Frontend: Vercel on `main`
**Nothing in this session was merged, deployed, stamped, or mirror-synced.**

---

## 1. Open PRs (24)

### Active this session — all draft

| PR | head | CI | state |
|---|---|---|---|
| **#405** `fix(evidence): collapse breach corpus names into breach_exposure — CHANGES ARTIFACT PERSISTENCE` | `f166038` | **4/4 green** | **Backend behaviour PR.** Awaiting compatibility sign-off. |
| **#408** `design(runtime): Option B — automatic bounded slices` | `396ce00` | 4/4 green | Design rev 2. PR 1 **not started** pending review. |
| **#407** `fix(runtime): scope the tool-call budget to the investigation` | `3419066` | 4/4 green | **Self-blocked** by my own comment; recommended for closure unmerged. |

### Held (no implementation authorized)

| PR | head |
|---|---|
| #404 `design(identity): name normalization` | `6a96329` |
| #402 `design(evidence): evidence_log provenance` | `e43c9f8` |
| #401 `fix(circuit): gemini_vision timeout leniency` | `43357f1` |

### Recommended for CLOSURE (JD's call — not actioned)

| PR | why |
|---|---|
| **#377** `restore atomic tool budget reservations` | superseded by **#384 (`cb429f8`)**, already on `main` |
| **#383** `PR A — atomic tool-call budget reservation` | same; `main` is the strict superset |
| **#381** `deterministic finalize gate at ~80% tool budget` | landed in `cb429f8`, then **deliberately deleted by `e8313e5`**; tombstone at `orchestrator-finalize.ts:200`, and CLAUDE.md forbids relitigating it |

### Older backlog, untouched this session

#389, #386, #379, #378, #371, #347, #343, #341, #331, #330, #326, #324, #321, #307, #198

---

## 2. Blocked on JD — in priority order

1. **Minor-safety floor rewrite** (see §4). Blocks the confidence-authority cutover.
2. **#405 compatibility sign-off.**
3. **Two label movements** the cutover causes: `intel.ts:382` breach-only **promotion** VERIFY→INFERRED; `intel.ts:392` CONFIRMED **demotion**. Both integrity-critical.
4. **Closure of #377 / #383 / #381.**
5. **`NO_CACHE_TOOLS` live defect** — `cache.ts:690` has no admission gates; `triage_seed` costs 800 µUSD and is not in `ALWAYS_ALLOW_TOOLS`. 104 calls / 73 threads / $0.076 lifetime.
6. **PR 1 blockers** — the migration channel (§3), `pg_net` unprobed, model-step cost accounting, the headless-worker ceiling measurement, retry attempt count (2 vs 3).

---

## 3. Topology findings that CONTRADICT CLAUDE.md

- **The repo's `supabase/migrations/` is NOT the channel for production schema.** `supabase_migrations.schema_migrations` holds 35 rows with **nothing after `20260715105649`**, yet every object from repo migrations dated 20260628–20260727 exists in production. Lovable applies equivalent DDL by its own path.
  > **A migration file in this repo creates nothing in production. Green CI proves syntax, not application.**
- **`pg_cron` is NOT installed** (`cron` schema absent). `pgmq` 1.5.1 and `pg_net` 0.20.3 available, not installed. Migration role `postgres`, `rolsuper = false`.
- **The real scheduler is `.github/workflows/edge-health.yml`** — a GitHub Actions cron `*/15` hitting `?health=1`, which runs the stale sweep (42 threads recovered that way). GH Actions minimum schedule is **5 minutes**, delayed under load ⇒ worst-case resume 5–20 min.
- The earlier claim that "a `CREATE EXTENSION` silently failed here" is **retracted** — the migration was simply never applied.

---

## 4. ⚠️ Minor safety is TWO coupled parts — read before touching `adjustedConfidence`

```ts
// src/lib/intel.ts:342 — part 1: attestation cannot label-promote a minor
if (attested && meta.possible_minor !== true) return "CONFIRMED";

// src/lib/intel.ts:259 — part 2: the NUMBER is clamped so the ladder can't either
if (meta.possible_minor === true) return Math.max(0, Math.min(55, base + d + bonus));
```

The comment at `intel.ts:337` states the coupling: *"adjustedConfidence already caps a possible_minor's number at 55; skipping the short-circuit makes the LABEL respect that cap too."*

**Deleting `adjustedConfidence` deletes half of a child-safety guard.** A `possible_minor` row with stored confidence ≥70 would then flow through the ladder to INFERRED or higher.

**And the existing test would not catch it** — `src/test/intel-logic.test.ts:163` uses `confidence: 40`, already below the clamp, so it passes either way. Vacuous.

Fix is to re-express the floor at label level, but that is a rewrite of a minor-safety guard and needs explicit sign-off (CLAUDE.md).

---

## 5. Measured production facts (expensive to re-obtain)

**Run cost & size — 226 successful runs** (`finished`, ≥1 artifact, ≥1 call):

| | p50 | p95 | p99 | max |
|---|---|---|---|---|
| total calls | 60 | 185 | 262 | 302 |
| paid calls | 25 | **103** | 134 | 149 |
| cost | $0.13 | $1.31 | $3.05 | $4.02 |

- **73–92% of run cost is orchestrator tokens**, not API charges. Call caps govern 8–27% of spend.
- The **"$3.05 runaway"** that motivated cap enforcement is **p99 of successful runs**. Not a runaway.
- Caps of 320/100/$4.00 would clip **6.2% of successful runs** — `max_paid_calls=100` sits below p95 (103).

**Thread ≠ investigation.** 269 threads with messages: 87 single-prompt, 97 at 2–4, **84 at ≥5**, max 29.

**Breach corpora.** 708 rows / 45 threads, mean 43.5, max 88. 337 distinct, 65.6% seen in one thread only.

| corpus | share of breach threads | |
|---|---|---|
| `Collection #1-5` | **33%** | a combolist — an aggregation of hundreds of prior breaches |
| `Twitter` / `X (Twitter)` | 24% / 18% | **the same breach under two names** |
| `Anti Public` | 16% | also a combolist |

⇒ counting corpus names as independent corroboration is invalid. **Rejected on this evidence**; #405 §10 records it.

**Artifact duplication: 10.7%** on strict `(thread_id, kind, value)` — 1,233 of 11,544 rows, worst group 31, 154 threads. *Not* the 51% claimed elsewhere. There are **no slice retries today**, so retries did not cause it.

**116 rows legitimately carry a null confidence.** `artifacts.confidence` is nullable, no default, no CHECK. So "fail loudly on missing confidence" must mean *throw in server writers + DB CHECKs*, not throw on render — throwing on render would blank the board.

---

## 6. Other code facts worth not rediscovering

- **#384 (`cb429f8`)** already landed `reserveToolCall`, `isToolBudgetExhausted`, the live `cache.ts:962` gate, and un-quarantined `cache_budget_race_test`. `toolCapExceeded` is **#377's** symbol and is **not** on `main`.
- `buildEvidenceMatrixMarkdown(artifacts)` and `buildToolAudit(artifacts)` take **no reviews parameter** — that is why rejected rows leak into the Evidence Matrix and Tool Coverage. `buildReportMarkdown` *does* receive reviews.
- `run_death_forensics` logs no shutdown reason ⇒ **cannot** distinguish platform kill from model self-termination. The `recovery.ts:560` comment instructing inference from elapsed time is unsound and should be removed.
- **The 180s ceiling is well-measured** (p99 178, max 180.0, zero ≥200s, reproduced under a prior 240s budget). What is *not* established is the **attribution** — every sample held an open SSE stream to a browser, so a headless worker may not hit it.
- `extractFindings` caps at `MAX_AUTO_PERSIST_PER_TOOL_CALL = 25` with a hard `break`; breach corpus names were **evicting real identity findings** from that budget.

---

## 7. Agreed sequencing

> mechanical integrity + kill the second scorer → selector-keyed breach aggregate → server-authoritative corroboration → **recalibrate weights last**, only on clean data.

The frontend rule for the cutover: **may annotate confidence, may not numerically mutate it.**

---

## 8. Recurring failure modes to avoid repeating

Six mistakes this session, one shape: **verifying against a representation instead of the artifact.**

1. Read PR *diffs* without checking `main` → wrongly claimed #383 was unlanded. Use `git show origin/main:<path>`.
2. Inferred a failure from an absence → the retracted `CREATE EXTENSION` claim. Absence ≠ failed attempt; check the ledger.
3. **`cmd | tail -5; echo $?` reports `tail`'s exit status, not `cmd`'s.** Did this twice with `tsc` and reported clean when it was not. Run gates unpiped.
4. **Unauthenticated `curl` to `api.github.com` is blocked by the proxy** and hangs silently. Did this twice. Use the authenticated MCP tool.
5. Scripted import insertion landed inside a multi-line `import {`. "Insert after last line starting with `import `" is wrong.
6. Proposed corpus-counting that **#405 §3 had already warned against**. Re-read a design's own traps before proposing against it.
