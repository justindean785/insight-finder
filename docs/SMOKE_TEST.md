# Live Smoke Test — Insight Finder Edge Functions

This document is a **runbook** for hitting the deployed `osint-agent` edge
function with real third-party APIs (Upstash Redis, Serus darkweb scan, MiniMax
LLM) to verify the live service is healthy. It does NOT cover the
Deno-based unit tests for the HTTP transport — those run on every commit
via `npm run test:edge` (see `supabase/functions/osint-agent/ratelimit_test.ts`
and `serus_test.ts`).

Use this runbook when:
- You change `env.ts`, `ratelimit.ts`, `auth.ts`, or `tools/serus.ts`
- You rotate a third-party API key and want to confirm the new one works
- You suspect a live regression the Deno unit tests can't catch (real
  third-party API contract drift, real network behavior, real auth)
- You need to verify a hotfix that touched the Serus poller or Upstash
  transport without waiting for production traffic

Do NOT use this runbook to burn credits during routine development — the
Deno unit tests cover 99% of regressions. The Serus scan path costs
0.25 credits per invocation.

---

## Prerequisites

You need:

1. **Supabase CLI** (`brew install supabase/tap/supabase`) OR ability
   to call the deployed function URL directly with `curl`
2. **Real secrets** in your local `.env.local` (not the project `.env` —
   these are operator-only, never commit):
   ```bash
   export SUPABASE_URL=https://skzqwbyvmwqarfgfvyky.supabase.co
   export SUPABASE_SERVICE_ROLE_KEY=eyJ...   # from Supabase dashboard
   export MINIMAX_API_KEY=***                 # primary orchestrator
   export SERUS_API_KEY=***                   # for Serus smoke
   export UPSTASH_REDIS_REST_URL=https://***.upstash.io
   export UPSTASH_REDIS_REST_TOKEN=***
   ```
3. **A test user** in the live Supabase project (create via
   `supabase auth admin create-user` or the dashboard, then sign in once
   to mint a real session JWT)
4. **An empty test thread** owned by that user (insert via SQL editor
   or `psql` against the project)

If you don't have these, the Deno unit tests are sufficient for most
changes. Don't go set this up just to be thorough.

---

## Quick check: function is alive

```bash
curl -s "$SUPABASE_URL/functions/v1/osint-agent" \
  -H "Authorization: Bearer $USER_JWT" \
  -H "Content-Type: application/json" \
  -d '{}' | jq
```

Expected: a 400 error with `code: "MISSING_PARAMS"`. If you get 401 the
JWT is bad. If you get 200 the function accepted an empty payload and
shouldn't have — investigate.

---

## Test 1 — Rate limit (Upstash)

Goal: verify the rate limiter is wired to Upstash, not just falling
through to in-memory.

### 1a. Confirm Upstash is configured

```bash
# Hit the function once, then check the Supabase function logs for
# evidence of an outbound POST to upstash.io.
curl -s "$SUPABASE_URL/functions/v1/osint-agent" \
  -H "Authorization: Bearer $USER_JWT" \
  -H "Content-Type: application/json" \
  -d "$(cat <<JSON
{
  "threadId": "$TEST_THREAD_ID",
  "messages": [{"role": "user", "parts": [{"type": "text", "text": "rate limit smoke test"}]}]
}
JSON
)" | jq
```

Then:
```bash
supabase functions logs osint-agent --since 5m | grep -i upstash
```

Expected: at least one line referencing `upstash.io` (the INCR/EXPIRE
pipeline). If you see none, Upstash isn't configured — the function is
running on the in-memory fallback (which works, but loses the
cross-instance protection).

### 1b. Force a per-minute block

```bash
# Fire 31 requests as fast as possible. Request 31 should 429.
for i in $(seq 1 31); do
  curl -s -o /tmp/rl_$i.json -w "%{http_code} " \
    "$SUPABASE_URL/functions/v1/osint-agent" \
    -H "Authorization: Bearer $USER_JWT" \
    -H "Content-Type: application/json" \
    -d "{\"threadId\":\"$TEST_THREAD_ID\",\"messages\":[]}"
  echo ""
done
```

Expected: first 30 are 400 (bad payload), 31st is **429** with body:
```json
{
  "error": "Too Many Requests",
  "code": "RATE_LIMITED",
  "detail": "Slow down — exceeded per-user rate limit (max 30/min, 300/hour). Retry in 60s."
}
```

If you see all 400s, the limit isn't applied — check
`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` are set in the
deployed function's secrets. In the Supabase dashboard:
`Edge Functions → osint-agent → Secrets`.

### 1c. Verify fail-open (optional)

Temporarily unset `UPSTASH_REDIS_REST_URL` in the dashboard, redeploy,
fire a request. You should see the same 200/400 response as before, plus
a log line: `[ratelimit] upstash unavailable, falling back to
in-memory`. Restore the secret when done.

---

## Test 2 — Serus darkweb scan

Goal: verify the Serus tool hits the real API, polls, and returns a
shaped result with `classification: "masked"`.

### 2a. Direct call via the LLM orchestrator (full E2E)

This is the realistic path — the LLM decides to call the Serus tool.
Cost: ~0.25 Serus credits + MiniMax LLM tokens (typically <$0.05).

```bash
curl -s -N "$SUPABASE_URL/functions/v1/osint-agent" \
  -H "Authorization: Bearer $USER_JWT" \
  -H "Content-Type: application/json" \
  -d "$(cat <<JSON
{
  "threadId": "$TEST_THREAD_ID",
  "messages": [
    {"role": "user", "parts": [{"type": "text", "text": "Run a serus_darkweb_scan on test@example.com and report the result."}]}
  ]
}
JSON
)"
```

Expected: a streaming response. After 5–30 seconds you should see a
tool-call artifact with:
- `tool: "serus_darkweb_scan"`
- `status: "success"` (or `failed` if test@example.com is a real breach)
- `scanId` (a string, e.g. `"3EhbxXzATBbEfixqrUDlgy6thGA"`)
- `totalBreaches: N` and `totalPastes: M`
- `classification: "masked"` (NOT `sensitive_unmasked` — that requires
  `reveal:true` AND the key has `darkweb:reveal` scope)

If you see `error.code: "serus_key_missing"`, the secret isn't set in
the deployed function. If you see `error.code: "unauthorized"` (HTTP
401), the key is bad — rotate it.

### 2b. Verify the `reveal` path costs more credits (optional)

Add `"reveal": true` to the tool call (the LLM will do this if you
ask, e.g. "Run serus_darkweb_scan with reveal=true"). Expect
`classification: "sensitive_unmasked"` in the result and ~0.5 credits
charged to your Serus account (reveal uses extra credits).

### 2c. Verify timeout path (optional)

The poller has a 10-retry × 2.5s = ~30s ceiling. If Serus is slow or
your test identifier triggers a long-running scan, the result will
have `status: "timeout"`, `error.code: "poll_exhausted"`. This is
intentional — the edge function would otherwise hit its 60s hard limit.

---

## Test 3 — Audit gate

Goal: verify the four late-injected audit tools fire after the agent
finishes its sweep.

The catalog should expose:
- `coverage_audit`
- `detect_contradictions`
- `tool_audit`
- `record_finding`

After a multi-tool run, check the messages table for the test user
(PG / Supabase dashboard):
```sql
SELECT role, parts FROM messages
WHERE thread_id = '$TEST_THREAD_ID'
ORDER BY created_at;
```

You should see tool-call entries for each of the four audit tools
before the final assistant message. If any are missing, the late-
injection pattern in `index.ts` is broken — the catalog contract test
(`src/test/tool-catalog-contract.test.ts`) catches this in CI.

---

## What to do if something fails

| Symptom | Likely cause | Action |
|---|---|---|
| 401 from function | JWT expired or bad | Re-mint via `supabase auth sign-in` |
| 403 from function | Thread owned by different user | Re-create test thread under your user |
| 429 from function | Rate limit hit (intentional or stuck) | Wait 60s, check `ratelimit_test.ts` |
| `serus_key_missing` in result | `SERUS_API_KEY` not in deployed secrets | Set in dashboard, redeploy |
| `[ratelimit] upstash unavailable` in logs | Upstash down OR misconfigured | Check Upstash dashboard, check env vars |
| `poll_exhausted` repeatedly | Serus is slow OR scan is taking >30s | Bump `POLL_MAX_RETRIES` (default 10) |
| `TypeError: fetch failed` in logs | Outbound network blocked from edge | Check Supabase function allowlist |

---

## Cost notes

| Path | Cost per run |
|---|---|
| Test 1a (single request) | <$0.01 (just LLM tokens) |
| Test 1b (31 requests) | <$0.05 |
| Test 2a (full Serus E2E) | ~0.25 Serus credits + <$0.05 LLM |
| Test 2b (reveal) | ~0.5 Serus credits + <$0.05 LLM |
| Test 3 (audit gate) | <$0.05 LLM tokens |

The Serus reveal path is the most expensive. Don't loop on it.

---

## Related

- Deno unit tests: `npm run test:edge` (41 tests, runs offline)
- Vitest unit tests: `npm test` (167 tests, runs offline)
- Catalog contract: `src/test/tool-catalog-contract.test.ts` (verifies
  78 runtime tools == 78 catalog entries)
- Health endpoint: `/functions/v1/health` (see `health-readiness.test.ts`)
