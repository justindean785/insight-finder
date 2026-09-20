# Next-session prompt — Insight Finder

> Paste this whole file as the opening message of a fresh session. It is self-contained.
> **Written 2026-09-20T12:00Z.** Every number is a dated measurement, not a state — re-verify.

---

## Start here — five minutes, before anything else

```bash
git fetch origin main && git log --oneline -5 origin/main
git fetch origin refs/heads/deploy/live:refs/heads/deploy/live   # a fresh clone lacks this ref
git fetch --unshallow --filter=blob:none                          # the clone is shallow at depth 50
curl -s "https://skzqwbyvmwqarfgfvyky.supabase.co/functions/v1/osint-agent?health=1"
```

**Expect `main` = `ad4937b` or later and live edge build = `4bb19d9`.**

If either moved, another session has worked this repo — read the newest `SESSION_HANDOFF_*.md`
before anything else. That has now happened **six** times, and once produced two conflicting PRs
for one task (#548 / #551).

**Then run `list_pull_requests` and look at `draft`.** The merge queue — not the deploy — is this
project's documented bottleneck, and right now it holds three finished PRs.

Read, in order:

1. **`SESSION_HANDOFF_2026-09-20_prompt-ceiling-payload-store-and-the-overlap-wedge.md`** — newest.
   §2 is the stale-baseline correction, §4 the production wedge that is the highest-value unfixed
   defect, §5 the `unknown` stop reason, §6 the payload-store decision, §7 the trap list,
   §9 the ordered plan.
2. **`CLAUDE.md`** — authoritative on deploy topology and on decisions that must not be
   re-litigated.
3. `SCOPE_same-thread-concurrency.md` if you are touching the overlap work;
   `DESIGN_payload-store.md` if you are touching persistence.

---

## Verified state — 2026-09-20T12:00Z

| Axis | Value |
|---|---|
| canonical `main` | `ad4937b` |
| live edge build | `4bb19d9` (`ok: true`) |
| `deploy/live` | `4bb19d9` |
| edge baseline | **1885 passed / 0 failed / 6 ignored** on clean `main` |
| frontend baseline | **2106 passed / 1 skipped / 173 files** |
| e2e baseline | **51 passed / 2 skipped** |

⚠️ **CLAUDE.md's baselines are stale** (1879 / 2104 / 172 / 52). They were measured at `4bb19d9`
and `main` has moved. Before crediting or blaming any diff for a suite-total change, **stash it and
re-measure on clean `main`.** This is the third consecutive session where a total moved for a
reason other than the code.

### The queue — nothing proceeds until this drains

| PR | head | channel | state |
|---|---|---|---|
| **#602** | `2bdbfe1` | frontend | green draft, `clean` — streaming throttle |
| **#603** | `174bc70` | frontend | green draft, `clean` — readiness denominator |
| **#604** | `9bd5587` | **edge** | green draft, `clean` — prompt budget hard ceiling |

#602 and #603 ship to production on merge via Vercel. **#604 does not ship on merge** — see the
edge recipe in CLAUDE.md, and note its proof-of-deploy key is **`checks.prompt_budget_ceiling`**.
Only one edge PR may be in flight at a time, so #604 blocks the rest of the edge plan.

---

## The job, in one line

Get the queue merged and #604 deployed, then fix the overlap wedge — the one defect measured
killing real runs in production.

---

## Ordered plan

| # | PR | channel | why this order |
|---|---|---|---|
| 0 | **merge #602, #603; merge + deploy #604** | both | nothing proceeds until the queue drains |
| 1 | **`sanitizeModelMessages` positional pairing** | edge | stops the production wedge; small, pure, independent of the concurrency model |
| 2 | **`budgetExhausted` at the `deriveStopReason` call site** | edge | one line; makes `stop_reason='unknown'` mean something |
| 3 | **request-body size meter** | frontend | the before/after number the payload work needs |
| 4 | **schema: `call_id` on `tool_usage_log` + `tool_call_payloads`** | migration | schema first, verified against the live DB, before any code reads it |
| 5 | **payload write path + aggregate inline budget** | edge | kill switch + `/health` key + the E2E gate |
| 6 | **drawer fetch-on-demand + `retained:false`** | frontend | — |

### #1 in detail, because it is the one worth doing first

`sanitizeModelMessages` pass 3 skips synthesising a placeholder when `resolved.has(toolCallId)`,
and `resolved` is a **global** id set. The AI SDK validates **positionally**. So when an
overlapping run delivers its result late, the array holds the same id twice — once unpaired, once
resolved — and the real result suppresses the placeholder the earlier dangling call needs. The run
dies with `MissingToolResultsError` before any provider call.

Confirmed in production on thread `bfa55610` (2026-09-12): two invocations died in 85 ms with
*"Tool results are missing for tool calls `01a09765…`"* — **the same tool call id both times**,
because the client kept re-uploading the poisoned history. It heals on reload, which is why it has
never shown up as bad DB rows.

Fix: resolve ids **per position**, not globally. Tests belong in `message_sanitize_test.ts` and
must drive `streamText` with a mock model on the reproduced array, not re-describe the function.

---

## Decisions JD has already made — do not re-open

- **Option A (a payload store), not summary-only.** Reason given: Insight Finder uses raw results
  to investigate and correct evidence, and absent drawer telemetry is not evidence that
  recoverability has no value.
- **The store is a TABLE (`tool_call_payloads`), not the `evidence-archive` bucket.** Driven by the
  distribution: 4,549 displaced objects / 14.0 MB at a 120k aggregate inline budget, p50 **812
  chars**, only 2 objects over 256 KB. Also removes an unproven dependency — that bucket holds
  **0 objects** and `archiver.ts` has never successfully written one.
- **PR-A (the prompt ceiling) goes first and is independent.** Shipped as #604.
- **#602 / #603 stay untouched and unmerged until JD says otherwise.**
- Everything in CLAUDE.md's **SETTLED** section: `REVEAL_BREACH_DATA` stays ON, `MAX_PAID_CALLS`
  stays bounded, intent is not inferred from prose.

## Open decisions — ask, don't assume

1. **The inline payload budget value.** 120,000 is modelled, not derived. 60k halves cost and
   displaces 73% of payloads; 200k displaces 27%. It trades how much recent raw detail stays in the
   transcript without a fetch — an analyst-workflow question.
2. **Whether to change the concurrency mechanism at all**, or only fix the wedge. Overlap runs at
   **12.2% of invocations**; the recommended model is accept-and-queue on
   `threads.last_heartbeat_at`, but the wedge fix stands on its own either way.

---

## Traps — verified this session, all of them cost time

1. **`orchestrator_invocations.created_at` is the telemetry insert at finish, not run start.** Use
   `started_at` / `finished_at`.
2. **`initial_context_chars` cannot tell you what a run saw.** It is computed *after* trimming.
   Two runs 16 chars apart proves nothing about their histories.
3. **The prompt is already protected.** `index.ts:244-323` truncates inbound history four ways on
   every request, so a 605,427-char persisted payload reaches the model as ≤16,000. Persistence is
   a **wire-and-storage** problem, not a prompt problem. Do not conflate them.
4. **`tool_call_cache` looks like a durable payload store.** 47 MB, 12,701 rows, only 129
   unexpired — it retains outputs only because `CACHE_SWEEP_ENABLED` is off. No `call_id`, no
   `thread_id`. ⚠️ **Turning that sweep on deletes the only accidental copy of historical tool
   outputs** — sequence it after the payload store, never before.
5. **`client_errors` shows 0 `MissingToolResult`** because the error is thrown server-side.
   Absence there is not absence.
6. **A per-item cap never bounds a thread.** 218 tool parts × any constant is still linear. Only an
   aggregate budget is O(1) in call count.

---

## How to work here

- **Small PRs.** One behaviour change + its tests + its kill switch. Never mix frontend and edge —
  they ship on different channels and a mixed PR can be neither cleanly deployed nor reverted.
  Every behaviour-changing edge PR adds one new `/health` key or durable log event.
- **Grep before you build.** CLAUDE.md's *BUILT AND UNWIRED* table exists because five separate
  times in one session the thing a plan said to build was already built and merely disconnected.
- **A behavioural test must DRIVE the shipped control flow, never re-describe it.** Prove it with a
  negative control: revert the source change and show the test fails.
- **Measure before you claim.** Every defect caught in review here was a timeline or identity
  error that passed the full suite, typecheck, lint and build.
- `npm run test:e2e` by hand for anything touching `src/` — PR CI does not run it.
- Deno is not preinstalled in the web sandbox; `--no-lock` is required.

---

## What the analyst actually feels, so the work stays anchored

Two complaints drove this whole arc, and both now have measured causes:

- **"It lags so bad, it stops mid-word."** Two independent causes: client-side markdown re-parse
  per token (#602, fixed), and ~431 KB of history re-uploaded from a phone on every turn (step 3–5
  above, not yet fixed).
- **"We do all these upgrades and it never changes the app."** The merge queue. Three finished,
  green, reviewed PRs are sitting in draft right now. That is step 0.
