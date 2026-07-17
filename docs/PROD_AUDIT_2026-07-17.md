# Insight Finder — Production Audit & Beta-Blocker Report (2026-07-17)

Scope: the 12 issues raised from live-production observation. Every root cause
below is verified against **code (file:line)** and, where possible, **live
production data** (read-only queries against the Lovable-owned Supabase project
`skzqwbyvmwqarfgfvyky` via the Lovable MCP). Nothing here is speculative; items I
could not verify are marked **UNVERIFIED** with the reason.

## Verification boundary (read this first)

This environment can: read all code, run the frontend test suite (`vitest`, 962
tests) and typecheck, compile+run the backend pure functions (via esbuild), and
**query the production database read-only**. It **cannot**: reach the Supabase
edge host over HTTP (egress policy blocks `*.supabase.co` — `curl` → 403 CONNECT),
run `deno` (binary download blocked), or **deploy the backend** (the Supabase
project is Lovable-owned; deploy requires merge-to-`main` + the Lovable agent
step per CLAUDE.md). Therefore:

- **Frontend fixes in this PR are fully verified** (tests + typecheck) and ship via
  Vercel on merge.
- **Backend fixes are verified at the unit level** (esbuild-run against real prod
  strings) but **their live effect requires the Lovable deploy step** and is
  **NOT yet confirmed on `/health` / live investigations.**
- **Confidence, cluster, report, and pivot changes are documented, not applied** —
  they are integrity-critical (CLAUDE.md) and need owner sign-off.

---

## Production evidence baseline (tool_usage_log, all-time)

| outcome | ok | rows |
|---|---|---|
| ok | true | 10,190 |
| **failed** | false | **1,246** |
| empty | true | 401 |
| skipped | mixed | 669 |
| empty | false | 121 |
| (null legacy) | mixed | 53 |

The `failed` bucket is the problem. Breaking down the top `failed` rows shows it
conflates **six different things** the analyst sees as one red "failure":

| Real category | Example error (verbatim from prod) | Rows (sample) |
|---|---|---|
| TIMEOUT | `minimax_correlate exceeded 30000ms tool timeout`; `jina_reader_scrape exceeded 8000ms`; `gemini_deep_dork exceeded 12000ms` | 56+42+34+26+20+16+15+13+11+11+10+10+8 … |
| CANCELLED | `AbortError: The signal has been aborted` | 21+12+11+9 … |
| RATE_LIMITED | `upstream returned HTTP 429` (emailrep, deepfind) | 21+10+8 |
| BLOCKED (legal) | `jina 451` | 50 |
| HTTP_DENIED | `reddit request failed (403)`; `jina 403` | 11+7 |
| CONFIG / bad key | `Invalid or unauthorized key…` (ipqualityscore, HTTP 200); `HTTP 401` (stolentax) | 30+29 |
| **Governance mis-stored as failed** | `premium 'oathnet_lookup' already ran for this entity this investigation`; `skipped: guard not met`; `provider … already has a call in-flight`; `finalize window open` | 4+4+3+… |
| Genuine FAILED | `synapsint 500`; `indicia web-dbs HTTP 400` | 35+26 |
| **Opaque UNKNOWN** | `error_msg = NULL` **and** `status_code = NULL`, yet `outcome=failed` | **137** |

That last row is its own bug: 137 "failures" carry no message and no status —
completely un-diagnosable.

---

## Issue #1 — Tool health is lying → **FIXED (frontend) + FIXED (backend classifier)**

**Root cause.** Two problems. (a) The backend `classifyToolOutcome`
(`tool-outcome.ts`) only emits 4 coarse buckets; TIMEOUT/RATE_LIMITED/HTTP_DENIED/
BLOCKED/CONFIG all collapse to `failed`. (b) Two governance phrases —
`already ran for this entity` and `guard not met` — were **not** in the skip
regex, so dedup/guard skips were stored as `failed`. (c) The frontend
`ToolHealthPanel` painted **every** `failed` row red and listed the tool under
"Failing tools — need attention" (`ToolHealthPanel.tsx:34`, old). Three more
frontend classifiers (`deriveToolStatus`, `classifyActivityRow`, the panel) each
had their own taxonomy — none matching.

**Fix shipped.**
- New canonical taxonomy module `src/lib/tool-outcome.ts` — 11 categories
  (`success, empty, skipped, cancelled, timeout, rate_limited, http_denied,
  blocked, config_error, failed, unknown`), a `needsAttention` predicate (only
  `config_error/failed/unknown`), and `normalizeProviderError` (Issue #2).
- `useThreadToolHealth` now re-derives the canonical category from the stored
  `error_msg`+`status_code`, so timeouts read as **Degraded** (amber), governance
  as **Skipped**, and the 137 null-error rows as **Unknown** — not red failures.
  This also **corrects historical mis-stored rows** at read time.
- `ToolHealthPanel` redesigned: five honest tiles (Succeeded / No-record / Skipped
  / Degraded / Needs-attention) and an attention list gated to genuine problems.
- Backend `classifyToolOutcome` skip regex extended with `already ran for this
  entity`, `guard not met`, `internal paid-call cap`, `internal throttle`; added
  `classifyDetailedOutcome` + `normalizeProviderError` mirrors for the edge.

**Verified.** `src/test/tool-outcome-canonical.test.ts` (17 cases, all real prod
strings) + backend `tool_outcome_test.ts` additions, run via esbuild (19/19). Full
suite 962/962 green, typecheck clean.

---

## Issue #2 — 403 / 400 handling → **FIXED (normalization layer)**

Answers to "was it a bug / bad request / quota / auth / outage?", from the data:

| Observed | Real meaning (verified) | Canonical category | Analyst message now shown |
|---|---|---|---|
| `jina 403` | provider bot/IP block | HTTP_DENIED | "Access denied — provider blocked this request, usually bot protection…" |
| `jina 451` | **legal** takedown | BLOCKED | "Legally unavailable — blocked for legal reasons." |
| `jina 422` / `indicia 400` | **unsupported selector / malformed input** | FAILED | "Provider rejected the request — likely an unsupported selector type or malformed input, not an outage." |
| `HTTP 401` (stolentax) | auth | CONFIG_ERROR | "Provider authentication failed — key missing/unauthorized." |
| `Invalid or unauthorized key` @ 200 (ipqualityscore) | **dead key** (cut 2026-07-05, `tool-registry.ts:558`) | CONFIG_ERROR | "Provider credentials rejected — check the key in Supabase secrets." |
| `HTTP 429` (emailrep) | quota/rate | RATE_LIMITED | "Rate-limited — backed off automatically." |

`normalizeProviderError` lives in both `src/lib/tool-outcome.ts` and the edge
`tool-outcome.ts` (parity-tested). Raw HTTP codes are never dumped alone.

---

## Issue #3 — Timeout strategy → **PARTIAL FIX + documented**

**Findings (verified).** Two timeout layers must stay in sync by hand:
- Layer A: per-tool wrapper cap table `TOOL_TIMEOUT_OVERRIDE_MS` (`cache.ts:46-128`),
  default 12s (`cache.ts:43`).
- Layer B: each tool's own fetch budget, scattered in `tool-registry.ts` (e.g.
  OathNet `timeoutMs:20_000`). The invariant "wrapper cap > fetch budget" is
  enforced only by hand + one OathNet assert. `fetch_retry.ts`'s default per-attempt
  15s actually **exceeds** the 12s default wrapper cap — a latent guillotine.

Heavy tools _do_ get longer budgets (correlate/serus 30s, oathnet 22s, exa/whois
20s), but the table is hand-calibrated from incidents, not driven by data — even
though `tool_health.p95` exists and already feeds the EV score
(`runtime-policy.ts:314-320`). Two inversions caused most of the prod timeouts:
- `gemini_deep_dork` is deliberately capped **short** (12s) despite ~46s p95 as a
  "fast-fail" source → guarantees the 42× 12000ms timeouts.
- **`minimax_plan_pivots` had no override** → 12s default for a smart-tier planner
  → 10× timeouts.

**Fix shipped.** `minimax_plan_pivots` given a 20s override with rationale
(`cache.ts`), + a caps test. (`gemini_deep_dork` left as an intentional design
choice — flagged for owner, not changed.)

**Documented for next PR (P1):** drive the wrapper cap from `tool_health.p95` (a
per-tool `timeout = clamp(p95 × 1.5, floor, ceil)`) so the table stops being
hand-maintained, and add a general `wrapperCap > fetchBudget` invariant test.

---

## Issue #4 — Tool scheduling / "minimax_correlate called 3×" → **FIXED (root cause)**

**Root cause (verified).** The correlate auto-fire nudge counter
`guard.artifactsSinceCorrelate` was reset **only on the success path**
(`tool-registry.ts:483`, inside the `try` after the model `await`). On a wrapper
timeout the model call aborts and throws to `catch`, so the reset never ran — the
counter stayed ≥ the threshold (8, `guard.ts:34`) and the recorder re-surfaced the
"call minimax_correlate now" nudge (`guard.ts:45-53`) on **every** subsequent
`record_artifacts`. The model kept re-issuing the same 30s call. Compounded by
suppression state being per-**run** not per-**investigation** (`circuit.ts:539-555`
tears it down at end-of-run), so a new turn starts with a clean circuit and
re-times-out — the mechanism behind "3× in one investigation."

**Fix shipped.** Reset the nudge counter in a `finally` so it clears on **any**
completed attempt (success or timeout) — the deterministic local union-find
clusters regardless, so deferring the next correlate until a fresh 8-artifact
batch is correct, not a retry loop (`tool-registry.ts`).

**Documented for next PR (P1):** the circuit's **1-strike** provider-family
suppression (`circuit.ts:105-114, 448-454`) is too aggressive — one latency-noise
timeout kills a whole provider family for 10 min, and one `minimax_correlate`
timeout collaterally suppresses `minimax_web_search/plan_pivots/extract`
(`circuit.ts:80`). Recommend 2-strike default (OathNet/Jina already are) and
per-investigation (not per-run) suppression persistence. Also fix the abort
classification asymmetry (`circuit.ts:478-507`: a thrown abort → `timeout`+suppress,
a returned `{error:"Abort…"}` → `other`+no-suppress — same event, two behaviors).

---

## Issue #5 / #6 — Confidence engine & analyst confirmation → **documented (`docs/CONFIDENCE_ENGINE.md`)**

Full rule reference produced with every constant cited to `file:line`. Headlines:
- **Four parallel confidence systems** with divergent tier cut-points (display
  90/75/55/35 vs cluster 90/75/50/30 vs a third audit-linter set). Same number,
  different verdict per screen.
- **"Confirm" = +20 to the score** (`intel.ts:221`), forces the **CONFIRMED label
  unconditionally** (`intel.ts:330`), never touches the stored value or backend
  status, and is **explained to the analyst as +15** (`confidence.ts:110`) — a
  rationale that doesn't equal the applied delta.
- The owner's numbers decoded: **50** = one of five overloaded 50-constants;
  **70** (confirm) = 50 + 20; **70** (address) = emergent class cap, no address
  rule exists; **"excluded collision 30"** is actually the **bio-cross-link** cap
  (true collision cap is **15**, `confidence.ts:494`).

Formal analyst-confirmation model + a single-delta proposal are in the doc. **Not
applied** (integrity sign-off required).

---

## Issue #7 — Cluster / merge / collision → **documented; one real hole flagged**

**Verified good:** the name-collision safety property **holds** — names/surnames/
cities/area-codes are excluded from every merge key (`lib/cluster.ts:195-229`), and
model-flagged namesakes become `excluded_collision` (cap 15) that never union
(`confidence.ts:496-507`, `lib/cluster.ts:301`). The LLM `minimax_correlate` only
returns analysis, never writes `cluster_id` (`tool-registry.ts:484`).

**Real holes (documented for sign-off, P1):**
- **Username collisions are unguarded in the live merge.** A `username` artifact
  unconditionally emits a `handle:` token (`lib/cluster.ts:203`) — two unrelated
  people sharing a common handle (`mike`, `admin`) **merge into one subject**. The
  over-broad-handle guard (`isGenericHandle`, `graph.ts:80`) exists only in the
  **dark/advisory** graph path; the same-name+DOB guard `merge_guard.ts` is **dead
  code** (imported only by its test). Collision detection covers only
  phone/email/address, never usernames (`tool-registry.ts:4456`).
- The collision detector matches peers on the **raw string** (`.eq("value", …)`)
  while the merger normalizes (`normPhoneE164`, `normEmail`) — so
  `(916) 735-6524` and `916-735-6524` merge but evade the collision guard.

**Recommendation:** wire `merge_guard.ts` into `applyClusteringToThread`, apply
`isGenericHandle` to the live merge, and normalize values in the collision detector.

---

## Issue #8 — Report quality → **documented; concrete gaps identified**

The live report is `CaseReport.tsx` (the KPI strip the owner quoted is
`CaseReport.tsx:919-924`). Section inventory vs the 11 requested:

| Required | Status | Note |
|---|---|---|
| Executive Summary | ✅ | `CaseReport.tsx:1132` |
| Assessment | ⚠️ partial | scattered, no titled section |
| High-Confidence Findings | ✅ | `:1240` |
| Weak Signals | ⚠️ | "Leads", capped `.slice(0,40)` with no "+N more" |
| Conflicts | ✅ (if >0) | `:1260` |
| Recommended Next Pivots | ❌ broken | reads only `metadata.next_verification_step` (usually null); never calls the pivot engine |
| Missing Evidence | ⚠️ | "What We Don't Know" |
| Collection Gaps | ⚠️ | `auditCoverage` (`coverage.ts`) exists but isn't surfaced |
| Confidence Distribution | ✅ | `:1045` |
| Source Diversity | ⚠️ mislabeled | counts raw source labels, not independence — the code itself warns this is misleading (`:507`) |
| **Tool Reliability Summary** | ❌ missing | only on the global page; not in the report |

"Confirmed 0 / Probable 0 / Leads 52" is **structural, not empty**: the confirmation
bar requires ≥2 independent source classes and breach-derived items are forced to
`manual_review` (`evidence-status.ts:230-234`), so 52 single-source leads never
promote. **Risk LOW** is because `computeRisk` (`CaseReport.tsx:377-418`) keys only
on credential/financial/adult harm — a fully identity-resolved subject with no
breach scores 0. The strongest report components (`serializeReport`, `ReportCardV2`)
are **unwired / DEV-only** — a leading cause of "feels weak."

**Recommendation (P2):** wire `serializeReport`; add the Tool-Reliability section
(feed it the new canonical taxonomy from Issue #1); fix Recommended-Next-Pivots to
call the pivot engine; surface `auditCoverage`; add a doxxing/identity-resolution
term to `computeRisk`.

---

## Issue #9 — Accuracy guardrails → **verified; 2 gaps flagged (sign-off)**

AI-inference→Confirmed and cluster-size→Confirmed are **properly blocked**
(NEVER_HIGH caps; CLUSTER_CAP 80; self-admission gate). **Two gaps remain:**
- **G1:** the numeric _display_ tier has no independence gate, so a lone 90-capped
  court/government source renders "Confirmed" (the gate exists only on backend
  `status`/`ConfLabel`).
- **G2:** `meta.reviewed===true` short-circuits to the CONFIRMED label
  (`intel.ts:330`); if that flag is model-writable this is an AI→Confirmed path. A
  test pins the current behavior, so **verify the write path before changing.**

Both detailed in `docs/CONFIDENCE_ENGINE.md §5`. Not changed (integrity sign-off).

---

## Issue #10 — UI quality → **UNVERIFIED (needs the live app)**

The Tool-Health panel was redesigned (Issue #1). Broader UI polish (spacing,
mobile clipping, stale counters, scroll perf) **could not be verified** — the live
app runs against the blocked Supabase host and I cannot drive it end-to-end here.
One concrete counter-inconsistency was found in code: the Pivots tab computes its
own contradiction count (`PivotsTab.tsx:80-95`) unrelated to the report's
`buckets.contradiction`, so the same label shows two numbers across tabs (P2).

---

## Issue #11 — Pivot intelligence → **documented; EIG inputs already exist**

The shipping ranker `computePivots` (`pivot-engine.ts:255-260`) is a static
`status + type-yield + priority + conf + recency` heuristic where `STATUS_RANK_NEW
= 1000` dominates — i.e. "new before searched," which reads as reactive. The only
real multi-factor scorer (`tool-routing-policy.ts:49-99`) is **dead code**; the
graph selector (`graph_pivots.ts`) is dark-launched (`GRAPH_PIVOTS_ENABLED` off).

Every input an expected-information-gain ranker needs **already exists**:
uncertainty (`gradeConfidence`, `graph.ts:299`), collection gaps (`auditCoverage`,
`coverage.ts`), corroboration value (`distinctSourceClasses`, `graph.ts:283`), cost
(`costForTool`). **Recommendation (P2):** replace the static `TYPE_YIELD` term with
`EIG = w1·uncertainty + w2·novelSourceClassGain + w3·closesRequiredPivot +
w4·identityResolutionProb − w5·cost`. No new data collection required.

---

## Issue #12 — Production testing matrix → **BLOCKED (deploy/network)**

Multi-entity live runs (email/username/phone/person/address/IP/domain/business)
require a deployed build and reachable Supabase host — both unavailable here.
Instead I used the **production database** as ground truth (the tables above are
real all-time data) and the **unit/integration suite** for behavior. A live matrix
run is the first task after this PR is merged + deployed (see deploy path).

---

## What shipped in this PR (verified)

| Area | Change | Verification |
|---|---|---|
| Issue #1/#2 | Canonical outcome taxonomy + provider normalization (frontend) | 17 new tests + 962/962 suite + typecheck |
| Issue #1/#2 | Backend classifier: skip-phrase fix + detailed/normalize mirrors | esbuild-run 19/19 vs prod strings |
| Issue #1 | `ToolHealthPanel` + `useThreadToolHealth` redesign | tests + typecheck |
| Issue #3 | `minimax_plan_pivots` 20s timeout override | caps test |
| Issue #4 | Correlate nudge counter reset on any attempt | code fix + syntax check (deno unavailable) |
| Issues #5–#11 | Documentation + prioritized fixes | `docs/CONFIDENCE_ENGINE.md`, this file |

## Recommended next-PR sequence

1. **P1 — Circuit/timeout robustness (backend):** 2-strike default suppression,
   per-investigation suppression persistence, abort-classification symmetry,
   p95-driven wrapper caps, `wrapperCap > fetchBudget` invariant test.
2. **P1 — Cluster safety (backend, sign-off):** wire `merge_guard.ts`, apply
   `isGenericHandle` to the live merge, normalize collision-detector values.
3. **P1 — Confidence integrity (sign-off):** numeric-tier independence gate (G1),
   `meta.reviewed` write-path audit + gate (G2), display the stored capped value
   verbatim (F-4), single analyst-delta constant (F-2).
4. **P2 — Report:** wire `serializeReport`, add Tool-Reliability + Recommended-
   Next-Pivots + Collection-Gaps sections, doxxing risk term.
5. **P2 — Pivots:** EIG ranker in `computePivots`.
6. **P2 — UI:** live-app polish pass + fix cross-tab contradiction-count divergence.

## Deploy path (from CLAUDE.md — backend changes are NOT live until done)

Frontend (Issue #1/#2 panel) ships via Vercel on merge to `main`. Backend
(`tool-outcome.ts`, `cache.ts`, `tool-registry.ts`) requires: merge to `main` →
`npm run stamp:build` + commit `build-info.ts` → surgical mirror sync of the three
changed files to `seeker-spark-search-5362c57c` → **explicit Lovable deploy** (send
to project `4ce11bc3-039d-4439-b293-acacca9e1e3a`) → verify the `/health` `build`
SHA moved. A mirror push alone is NOT a deploy.
