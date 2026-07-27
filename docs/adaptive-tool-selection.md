# Adaptive tool selection — design spec

Status: **proposed, not implemented.** Written 2026-07-27 from JD's spec so it can be
corrected in one place instead of re-explained. Nothing here is built yet.

## The goal, in JD's words

> "Instead of fanning out thirty calls at once, pick the smartest call each time —
> the ones you're seeing get the most results."

> "I basically wanted to take a mental note each time it gets rich results from a scan.
> It doesn't even have to show all the results it found. It could just say, I'm getting
> rich results from OathNet after an email is given to me."

Not a hardcoded chain. A scheduler that learns which call is worth making next, from
what has actually produced evidence before.

## Why the current build cannot do this

Three independent reasons, all verified against production on 2026-07-27:

1. **The health signal measures the wrong thing.** `tool_health` is read by the
   scheduler (`cache.ts:451`) but scores *reliability and latency*. `ok = true` means
   the HTTP request succeeded, not that anything was learned. `google_dorks` logs
   **99.7% ok** across 309 calls and produced **5 artifacts total**.

2. **The ranker is dormant.** `tool-routing-policy.ts` implements
   `scoreToolCandidate` / `routeNextTools` — pending-pivot bonus, query-type fit,
   source-class novelty, official-authority bonus, cooldown on real 429/5xx. Nothing
   in production calls it.

3. **Memory is write-only.** 954 `agent_memory` rows, 72 ever recalled (7.5%).
   `memory_recall` fired 450 times and produced 39 artifacts (0.09/call) — the tool
   runs, the lookup does not match.

## The reward signal

**Kept artifacts per call**, never raw artifact count.

Raw count is actively misleading. On email seeds `username_sweep` leads on volume
(3.45 artifacts/call) and the analyst rejects **47%** of what it produces (52 of 111
reviewed). A router optimising raw count would learn to spam the noisiest tool in the
catalog.

Quality-adjusted, measured on production:

| tool | artifacts/call | rejected | kept/call |
|---|---|---|---|
| `username_sweep` | 3.45 | 47% | 1.83 |
| `oathnet_lookup` | 2.07 | 12% | 1.82 |
| `serus_darkweb_scan` | 2.25 | 20% | 1.80 |
| `leakcheck_lookup` | 1.68 | 10% | 1.51 |
| `minimax_web_search` | 0.33 | 14% | 0.28 |

A "kept" artifact is one that is **not** analyst-rejected (`dismissed` / `wrong`),
**not** collapsed as sweep noise, and **did** add a source class the run did not
already have. Analyst attestation (`confirmed` / `key`) counts double — it is the only
ground truth in the system.

Caveat on the numbers above: artifacts carry several tools in `source`, and the
attribution join credits each contributing tool, so co-occurring tools are inflated.
Directional, not precise. Recalibrate from `tool_usage_log` before trusting a threshold.

## Context — what the note is keyed to

A tool is not good or bad in the abstract. It is good *in a situation*. Two keys:

- **Opener:** `(seed_type)` → which tool to run first on an email / username / address.
- **Transition:** `(seed_type, prior_tool)` → "after OathNet, pivoting on the accounts
  with socialfetch or the Exa scraper gives rich results."

The transition key is what makes the chain emerge without anyone hardcoding it.

Dork templates use the same structure with `template_id` as the arm, which is what
makes JD's case work: *"I got results when I ran a username with these dorks, but the
same dorks for an email gave nothing"* — different context key, different arm ranking,
no shared state.

## Proposed tables

```sql
tool_yield_stats (
  user_id, seed_type, prior_tool, tool_name,
  calls, kept_artifacts, rejected_artifacts, empty_runs,
  last_success_at, state  -- 'default' | 'demoted' | 'probation'
)

dork_template_stats (
  user_id, seed_type, template_id,
  runs, hits, kept_artifacts, state
)
```

Both are aggregates the planner reads **before dispatch**, not lessons the model may
choose to look up. That distinction is the entire fix for the 7.5% recall rate.

## The decision rule

**Exploit.** Rank dispatchable candidates for the current context by kept-yield and
take the top 1–3. Feed the ranking to `routeNextTools()`, which already handles
pending-pivot bonus, class novelty and provider cooldown.

**Demote.** An arm drops out of the default set on sustained failure, never on one bad
run. Require a minimum sample (≈8 calls in that context) and use a Wilson lower bound
on "produced anything kept", not a raw mean — otherwise 0/2 looks identical to 0/40.

**Last-ditch.** If the exploit set finishes a run with zero kept artifacts, dispatch
the highest-ranked *demoted* arm before giving up. Bounded to 1–2 per run so it cannot
become the fan-out again. This is JD's *"last ditch effort, let me run the one that
wasn't working and see if I get results this time."*

**Do not over-learn from one hit.** A success by a demoted arm moves it to
`probation`, **not** back to default. Returning to default requires sustained
evidence — proposed: 3 kept-yield successes in its last 10 attempts. A single hit
followed by another empty run leaves it demoted and records that it was noise.

> "I got some results? Okay, that's good, let me log that in. I run it again, don't get
> any results. Okay, it's still not giving me results. It was just a one off."

That asymmetry — quick to demote, slow to promote — is the part that is easy to get
wrong, and it is why a plain hit-counter will not do.

All thresholds above (8 calls, 3-of-10, 1–2 last-ditch) are **starting values to be
calibrated** against the 13k rows already in `tool_usage_log`, not tuned constants.

## Interaction with the run budget

The flat `MAX_TOTAL_CALLS=30` cap shipped 2026-07-27 was the right fix for a 262-call
blind fan-out and is the wrong instrument for an earned chain. Once yield is tracked,
budget should be spent per *earned* call: a call that returns kept artifacts buys the
next one, a call that returns nothing burns budget faster, and the run ends when yield
dies rather than when a counter trips. Until that lands the flat cap stays, because an
unbounded loop is worse than a truncated one.

## Build order

1. **Log yield.** Extend the `tool_usage_log` write with kept/rejected artifact counts
   and the context key. Additive, ships safely, starts accumulating immediately.
2. **Score on yield.** Point `tool_health` at kept-yield per context; fix the sample
   gate.
3. **Wire the ranker.** Call `routeNextTools()` at dispatch. Add the demote /
   probation / last-ditch state machine.
4. **Dork templates as arms.** Same loop, finer granularity.

Steps 2–4 are worthless without a backlog of step-1 data, so step 1 ships alone and
first.
