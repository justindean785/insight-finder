# Production uptime monitoring

**Status as of 2026-08-25: there is no automated production health monitoring.**
The `Edge Health` GitHub Actions schedule was removed in #483 and only
`workflow_dispatch` remains. This document is the replacement plan.

## Why not just restore the cron

The schedule ran at `*/15`. GitHub bills every Actions job **rounded up to a full
minute**, so a ~10-second curl cost a full billable minute — roughly 2,900
billed minutes a month for about eight hours of real work, on an account whose
Actions allowance is shared with CI.

On 2026-08-20 it exhausted that allowance and took **CI down on every pull
request for ~70 hours**. Jobs failed at dispatch with `runner_id: 0`, no `steps`
array, and 404 logs — which reads like a code failure and is not.

The second problem is worse than the cost: the probe then sat dark for ~65 hours
and nobody noticed, because its failure emails were indistinguishable from the
billing failures. **As alerting it was already not working.** Restoring the cron
would rebuild both problems.

## What to run instead

Any external uptime monitor. The endpoint needs no auth:

```
GET https://skzqwbyvmwqarfgfvyky.supabase.co/functions/v1/osint-agent?health=1
```

Note it is a **query parameter**, not a `/health` path.

Recommended settings:

| Setting | Value | Why |
| --- | --- | --- |
| Interval | 5–15 min | Free tiers allow this; there is no per-run cost as with Actions |
| Timeout | 15 s | The handler probes upstream providers; allow for a cold isolate |
| Expected status | `200` | The handler returns **503** when core config or the selected orchestrator is unhealthy — that is the signal, so do not treat 503 as "up" |
| Alert after | 2 consecutive failures | One failure can be a cold-start blip |
| Alert channel | Email + push | Must be distinguishable from GitHub billing mail — that confusion is what hid the 65-hour outage |

Free tiers that cover this: UptimeRobot (50 monitors, 5-min), BetterStack (10
monitors, 3-min), Healthchecks.io.

### Optional: keyword check

To catch "responds 200 but the orchestrator is degraded", assert the body
contains `"ok":true`. Monitors call this a keyword check.

### Do NOT enable a probe-secret monitor

`?health=1&probe=1` runs live provider round-trips against DeepSeek, MiniMax,
Grok and Gemini. That is a paid call per provider per run and is meant for
on-demand operator use, not polling.

The plain `?health=1` path is safe to poll: since the C1 fix its DeepSeek check
is cached for 60 s per isolate, and its recovery sweep is throttled to one run
per 60 s per isolate.

## What the response tells you

| Field | Meaning |
| --- | --- |
| `ok` | Overall readiness. Drives 200 vs 503. |
| `build` | Deployed build marker. Compare against `git log` to detect deploy drift. Note the documented one-commit offset — it is the stamp commit's parent, so it never equals the `origin/main` tip. |
| `selected_provider` / `orchestrator_reason` | Which orchestrator is live. Expect `deepseek` / `pinned`. |
| `orchestrator_active_ok` | Whether the selected provider answered. Deliberately does not gate the HTTP status, so a transient provider blip is visible without paging. |
| `checks.core` | Core Supabase config. This is where a missing `SUPABASE_URL` / service key surfaces. |
| `checks.recovery` | Stale-run sweep result, or `throttled`. |
| `reveal_breach_data` | Account-level breach-reveal policy. Boolean only. |

## The other three functions have no instrument

`evidence-export`, `security-test-lab` and `mcp` expose **no health endpoint and
no build marker**, so there is no way to distinguish synced from deployed for
them. If an export bug appears, suspect a stale deployed `evidence-export`
first. Giving `evidence-export` a marker is the smallest useful improvement
here — it is the one of the three that touches user-visible output.

## Manual reading

Until a monitor is configured, run the `Edge Health` workflow by hand from the
Actions tab, or:

```sh
curl -sS "https://skzqwbyvmwqarfgfvyky.supabase.co/functions/v1/osint-agent?health=1" | jq
```
