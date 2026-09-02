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

Throttle, don't authenticate. Keep the sweep reachable anonymously and bound it to
**one sweep per 60 s per isolate**, claiming the window *before* the `await` so
concurrent probes collapse instead of racing. The cron's own cadence already
matches that window, so the scheduled sweep is unaffected while a flood collapses
to one. Bound the paid side separately: give `checkDeepseek()` a 60 s
proof-of-life cooldown mirroring `checkMinimax()`'s `minimaxHealthyWithin(60_000)`,
never cache failures, and always probe from a cold isolate so a real outage still
surfaces.

## ⚠️ Status: proposed, NOT yet on `main` — pending PR #502

On `main` today `handleHealthProbe` calls `recoverStaleActiveThreads` on **every**
request, with no per-isolate timestamp and no in-flight guard, so concurrent
anonymous probes do **not** collapse to one sweep. The throttle above lands with
PR #502 (`claude/audit-claims-verify-oi0urm`).

That distinction is load-bearing, not pedantic. This note exists to justify
leaving a service-role endpoint anonymous — so reading the throttle as already
deployed would mean accepting an unbounded DB-work path that does not yet have its
bound. Treat these as two separate claims: **anonymous is correct** (settled), and
**anonymous is bounded** (pending #502).

## Related

`?health=1&probe=1` is different — it makes live paid round-trips to DeepSeek,
MiniMax, Grok and Gemini. It is for on-demand operator use and **must never be
polled**. See `docs/ops/uptime-monitoring.md`.
