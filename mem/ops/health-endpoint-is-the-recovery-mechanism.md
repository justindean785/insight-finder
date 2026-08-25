# The anonymous `?health=1` call IS the production recovery mechanism

**Do not gate the recovery sweep behind the probe secret.** It looks like an
obvious hardening — an unauthenticated endpoint doing service-role DB work — and
an engineering audit recommended exactly that on 2026-08-24. Doing it silently
disables stale-run recovery in production.

`supabase/migrations/20260720031500_pg_cron_health_sweep.sql` schedules
`GET .../osint-agent?health=1` every 60 s with `headers := '{}'::jsonb` — **no
secret** — precisely so recovery keeps running when no browser tab is open. The
migration header documents the failure it was written to fix: mobile Safari
suspends background-tab timers, so client-triggered recovery stopped whenever the
tab backgrounded or the device slept.

## What to do instead

Throttle, don't authenticate. `health-handler.ts` keeps the sweep reachable
anonymously and bounds it to **one sweep per 60 s per isolate**, claiming the
window before the `await` so concurrent probes collapse instead of racing. The
cron's own cadence already matches the window, so the scheduled sweep is
unaffected while a flood collapses to one.

The paid side is bounded separately: `checkDeepseek()` has a 60 s proof-of-life
cooldown mirroring `checkMinimax()`'s `minimaxHealthyWithin(60_000)`. Failures are
never cached and a cold isolate always probes, so a real outage still surfaces.

## Related

`?health=1&probe=1` is different — it makes live paid round-trips to DeepSeek,
MiniMax, Grok and Gemini. It is for on-demand operator use and **must never be
polled**. See `docs/ops/uptime-monitoring.md`.
