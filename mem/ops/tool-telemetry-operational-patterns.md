---
name: tool_usage_log already answers "why did the run fail" — nobody reads it
description: 681 doomed calls across 158 threads (48.6s dead wall-clock per thread) are sitting in tool_usage_log unread; skips log with ok=true so naive queries miss them; the finalize window is a SYMPTOM of timeout ceilings set below provider latency
type: ops
---
**Measured 2026-08-25 against production** (build `865f49e`, 60-day window). Every number
here came from one SQL query. Nothing needed a code audit.

## ⚠️ The trap that will fool your query

**A skip is logged with `ok = true`** and the reason in `error_msg`:

```
serus_darkweb_scan   ok=true   "finalize window open; live lookup skipped"
minimax_correlate    ok=true   "finalize window open; live lookup skipped"
```

`where not ok` therefore **misses every finalize-window skip**. This cost a session: an
aggregate reported "breach_check 4/4 ok, zero skips" when one of those four was a skip.
Always filter on `error_msg is not null`, never on `ok` alone.

This is also the hazard CLAUDE.md names elsewhere — *a refusal must be legible as a
refusal*. It isn't, and it fooled a reader.

Only `indicia_phone`'s paid-cap refusal logs `ok=false`:
`"internal paid-call cap reached (12 this run) — internal throttle, not a provider limit"`,
raised at `runtime-policy.ts:444` (the runtime governor), NOT `cache.ts:1009` (the finalize
window). Two different gates, two different fixes — do not conflate them.

## The corpus finding

| class | calls | threads | tools |
| --- | --- | --- | --- |
| died at its own timeout ceiling | 417 | 143 | **30** |
| blocked / rate-limited (403/429/423) | 168 | 67 | 19 |
| malformed request — our bug (HTTP 400) | 96 | 55 | 12 |

**681 doomed calls · 7,683 dead seconds · 48.6 s per thread · avg 11.3 s each.**
Charged cost is `$0.000` — failures aren't billed. **The waste is wall-clock, not money.**

## Why that reframes the finalize window

Thread `e143a5af` started 18:19:10; its finalize window opened **18:20:40 — 90 s in**.
The corpus average is **48.6 s of doomed calls per thread**. Roughly **half the
pre-finalize budget is spent on calls that could not have succeeded.**

So "the finalize window is too aggressive" is a **symptom**. Fix the ceilings and the
blocks — mechanical, safe — and the window gets half its budget back **without touching
the finalize path**, which CLAUDE.md forbids adding work to and which owns this project's
worst incidents. Do NOT "fix" this by making the window budget-driven, and do NOT raise
`MAX_PAID_CALLS` (settled: the cap stays bounded; the dispatch guard is the lever).

**30 tools dying at their own ceilings is ONE configuration error, not 30 bugs.** No code
audit framed it that way, because each audit saw a single `timeout: 8000` in isolation.

## Standing offenders (60-day window)

| tool | calls | threads | ok | dominant error |
| --- | --- | --- | --- | --- |
| `reddit_user` | 24 | 23 | **8%** | `reddit request failed (403)` |
| `deepfind_reverse_email` | 19 | 9 | 11% | `exceeded 8000ms tool timeout` |
| `archive_url` | 12 | 7 | 25% | `upstream returned HTTP 429` |
| `wayback_cdx_search` | 88 | 63 | 33% | `timed out (archive.org slow)` |
| `minimax_plan_pivots` | 27 | 23 | 37% | `exceeded 12000ms tool timeout` |
| `indicia_web_dbs` | 52 | 33 | 37% | `indicia web-dbs HTTP 400` ← our request is malformed |
| `crtsh_lookup` | 47 | 36 | 45% | `crt.sh 502` |
| `hackernews_user` | 8 | 7 | — | `no usable result` (8 of 8) |

`reddit_user` has been 403-blocked across **23 separate investigations** and nothing noticed.
`indicia_web_dbs` returns **HTTP 400 on 45 of 52 calls** — that is not "no data", it is us
sending a malformed request 87% of the time.

## ⚠️ Empty is NOT broken

`indicia_person`: 168 calls, 103 `no record found`. That is a **correct negative** — real
evidence the selector isn't in that database. A naive learner files it beside
`reddit_user`'s 403 and concludes "Indicia is useless", then stops calling the best
people-search provider. **PR #493 (empty-vs-error telemetry) is the prerequisite** for any
learning layer, precisely because it makes that distinction.

## Also verified

- `tool_call_cache`: 10,906 rows, **10,835 expired (99.3%)**, oldest 2026-06-25, **40 MB**.
  Nothing sweeps it. A nightly `DELETE WHERE expires_at < now()` reclaims ~39 MB.
- An audit item said to `encodeURIComponent` an archive.org URL; #502 checked and found the
  file is dead code. Meanwhile `archive_url` is 25% ok on live 429s. **Audits read code;
  telemetry reads outcomes.** The code audit fixed a bug that did not exist while the real
  failure on the same provider went unseen.
