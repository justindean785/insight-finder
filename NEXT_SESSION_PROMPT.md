# Next-session prompt — Insight Finder

> Paste this whole file as the opening message of a fresh session. It is self-contained.
> **Written 2026-09-13T00:40Z.** Every number is a dated measurement, not a state — re-verify.

---

## Start here — five minutes, before anything else

```bash
git fetch origin main && git log --oneline -5 origin/main
git fetch origin refs/heads/deploy/live:refs/heads/deploy/live   # a fresh clone lacks this ref
git fetch --unshallow --filter=blob:none                          # the clone is shallow at depth 50
curl -s "https://skzqwbyvmwqarfgfvyky.supabase.co/functions/v1/osint-agent?health=1"
```

**Expect `main` = `811c2cd` or later and live edge build = `c87c07b`.**

If either moved, another session has worked this repo — read the newest `SESSION_HANDOFF_*.md`
before anything else. That has now happened **five** times, and once produced two conflicting PRs
for one task (#548 / #551).

**Then run `list_pull_requests` and look at `draft`.** Nine PRs are open as of 2026-09-13, the
oldest from 2026-08-25. The merge queue — not the deploy — is this project's documented bottleneck.

Read, in order:

1. **`SESSION_HANDOFF_2026-09-13_instrument-truth-and-the-lineage-prerequisite.md`** — newest.
   Its §6 is the ordered roadmap, §7 is the small-PR discipline, §8 the trap list,
   §9 the ruling on Codex's planning PR #586, §10 the open-PR queue.
2. **`CLAUDE.md`** — authoritative on deploy topology and on decisions that must not be
   re-litigated. Its dated-state block and test baselines were refreshed 2026-09-13.
3. `mem/index.md` — the memory index; two entries were added 2026-09-13.

---

## Verified state — 2026-09-13T00:30Z

| Axis | Value |
|---|---|
| `origin/main` | `811c2cd` |
| Live `osint-agent` build | **`c87c07b`** — deployed and verified 2026-09-13T00:02Z |
| `deploy/live` | `c87c07b` |
| Mirror `main` | `71b79c4`; `diff -rq` empty for all four function dirs |
| Vercel production | READY, `target: production`, on `c87c07b` |
| Edge suite | **1832 / 0 failed / 5 ignored** |
| Frontend suite | **2104 / 1 skipped / 172 files** |
| e2e (by hand only) | **52 / 2 skipped** |
| Open PRs | **9** |
| Undeployed edge code | **none** |

---

## The goal

> **~3 minutes instead of 8. ~25 high-signal artifacts instead of 123 mixed ones. And a system
> that visibly sharpens with use.**

Today: 7.6% signal, 16% of invocations end on purpose, nothing is learned. The differentiator is
the last clause — of the eleven platforms analysts compare this to, **none learns from its
operator.**

---

## What to do next, in order

**1 · Operator action, five minutes: set `GITHUB_API_TOKEN`.** `github_code_search` has returned
`401` on *every* call for 21 days with zero successes. The secret lives in **Supabase → project
`skzqwbyvmwqarfgfvyky` → Edge Functions → Secrets** (falls back to `GITHUB_TOKEN`). It is **not**
the Claude Code GitHub MCP connector — that is a separate system and works fine. This confusion has
already happened once.

**2 · Merge PR #574.** It closes a real hole in the deploy gate: `verify:deploy` computes the
mirror tree digest from the mirror clone's **local** HEAD without checking it reached
`origin/main`, so an unpushed sync commit reads green. On 2026-09-11 that nearly shipped stale code.

**3 · Drain the rest of the PR queue** — cheaply. `list_pull_requests`, then `pull_request_read`
with `get_check_runs` per PR. Nine calls. **Do not fan out subagents for it**; a previous attempt
burned a lot of tokens on Opus agents for what is a handful of API calls.

**4 · Gate 0 — call-to-artifact lineage.** The structural finding of the 09-13 session, verified
against production: `artifacts` has **no join key** to `tool_usage_log`, and `metadata.tool` covers
only **38%** of rows and stores a tool *name*, not a call id. Per-source yield cannot be computed
honestly, so the entire learning layer — and the operator's "15 false positives" ask — is blocked
on it. Ship it as a junction table, **never** an array column on the call row.

Then §6 of the handoff: the replay benchmark, the outcome taxonomy, `coverage_observations`, the
prompt clauses that mandate volume, A2b, and only then the learning loop.

---

## Ship in SMALL PRs — do not attempt the roadmap in one

**In this repo a large PR cannot be deployed safely or reverted at all.** Full reasoning in §7 of
the handoff; the rules:

- **One PR = one behaviour change + its tests + its kill switch.**
- **Never mix frontend and edge changes.** They ship on different channels — frontend goes live on
  merge via Vercel; edge does **not** ship on merge at all.
- **Never mix a schema change with the code that depends on it.** Schema first, applied through
  Lovable, verified against the live DB, *then* the code.
- **Every edge PR that changes behaviour adds one new `/health` key** or durable log event, so its
  deploy is provable. `/health` proves a *build*, not a change — ship six changes in one build and
  you cannot bisect a regression.
- **At most one edge PR in flight** (the deploy queue is serialized). Frontend PRs run in parallel.
- **Docs and ledger updates ride in their own PR.**
- **Run `npm run test:e2e` by hand** for anything touching `src/` — PR CI skips it.

---

## A mirror push is not a deploy

```
merge to main → npm run stamp:build → surgical mirror sync (only changed files)
→ npm run verify:deploy reports `mirror tree -> equal`   ⛔ HARD GATE, re-run immediately before
→ explicit Lovable deploy message (project 4ce11bc3-039d-4439-b293-acacca9e1e3a)
→ /health build SHA MOVED   ← the only proof
→ npm run record:deploy && git push origin HEAD deploy/live
```

`marker_offset_mismatch` between stamping and deploying is **expected**; the condition to read at
that moment is `mirror tree -> equal`, nothing else.

---

## Non-negotiables

- `REVEAL_BREACH_DATA` stays **ON**; `MAX_PAID_CALLS` stays **bounded**; intent is **never**
  inferred from prose.
- **Never touch** `toolChoice`, `stopWhen`, the finalize window, or termination logic.
- **Quarantine is disclosure, not deletion.**
- Integrity-critical changes need written sign-off **before** code.
- Every live-behaviour change ships behind a **call-time** kill switch.
- **No real investigated selectors** in code, comments, tests or PR bodies.
- **Check whether it is already built before building it** — see CLAUDE.md's *BUILT AND UNWIRED*
  table. Five separate times in one session the thing a plan said to build already existed.
