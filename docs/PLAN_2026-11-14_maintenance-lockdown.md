# Plan: lock down `osint-agent ?health=1&maintenance=1` (2026-11-14)

Status: implemented as open, unmerged PRs (none deployed): E1 = #1031 (edge, draft), F2 = #1030 (frontend, ready, gated on #1031 live), E3 = the lockdown edge PR (draft). Verified against `origin/main` `c8bc4ee`.
No request was sent to production.

Scope: who may trigger the health-probe maintenance sweeps. Out of scope: what recovery does,
synthesis telemetry (the Lovable plan's M4 item 3), any scheduler, memory work (M1 to M3).

---

## 1. Verified findings

### 1.1 The maintenance path has no authentication (CONFIRMED)

- `index.ts:196`: `if (isHealthProbe(req)) return handleHealthProbe(req);` is the first statement of
  `Deno.serve`. It runs before `setupRequest` (`index.ts:220`), so no auth code runs on a health probe.
- `health-handler.ts:384-392` `isHealthProbe`: any GET or HEAD with `health=1`.
- `health-handler.ts:420`: `wantMaintenance = wantProbe || maintenanceRequested(u)`.
  `lib/credential-health.ts:147-155` `maintenanceRequested`: true when `maintenance=1` is in the URL, or
  when the secret `HEALTH_MAINTENANCE_ALWAYS=true`. It reads nothing from the request except the URL.
- `health-handler.ts:854-862`: the only credential check in the handler. It runs **only when
  `probe=1`**, compares `x-probe-secret` to `OSINT_AGENT_PROBE_SECRET` with `!==` (not constant time),
  and returns 403 on a mismatch. **Confirmed: only `?probe=1` checks `x-probe-secret`.**
  `env.ts:376-378` documents this: "The lightweight ?health=1 path remains public."
- `health-handler.ts:867-985`, run when `wantMaintenance`:
  - `:870` `createClient(SUPABASE_URL, SERVICE_KEY)`: a **service-role** client.
  - `:871` `recoverStaleActiveThreads(admin, { limit: 20 })`: all users.
  - `:880` `sweepRejectedClusterAssignments(admin)`: all users.
  - `:904-910` reads `tool_usage_log` (newest 300 rows, 7 days): all users.
  - `:948-967` `synthesizeMissingFindings(admin, { limit: 5, scope, dryRun })` for each enabled scope.
  - `:977-985` `sweepExpiredCache(admin, …)` when `CACHE_SWEEP_ENABLED`.
- What the caller gets back (`health-handler.ts:1078-1115`): the normal health body plus
  `checks.recovery` (number recovered and error count), `checks.rejected_cluster_sweep`,
  `checks.credentials` (names of providers that refuse calls, from `describeCredentialHealth`),
  `checks.synthesis` (scopes, dry-run state, proposed and written counts, distribution) and
  `checks.cache_sweep`. No artifact values, selectors or thread ids are returned.
- Gateway JWT check: `supabase/config.toml` contains only `project_id`; there is no `verify_jwt` entry
  for `osint-agent`. The browser sweep (`ChatWindow.tsx:2895`) and the `edge-health.yml` workflow both
  call the endpoint with **no headers at all**, which only works if the gateway does not require a JWT.
  **Inferred, not verified:** the gateway does not check one. Even if it did, the anon key is public
  in the frontend bundle, so the result would be the same.

### 1.2 What each sweep can do when called by anyone

| Sweep | User scope today? | What an all-users run can write |
|---|---|---|
| `recoverStaleActiveThreads` (`recovery.ts:847-871`) | **No.** Its options are `{now, limit, reason}`. The query (`:850-859`) filters by `status='active'`, the run marker (I-1, `:856-858`) and a 75 s stale heartbeat (`STALE_RUN_AFTER_MS`, `:8`). | For each stale thread (`recoverOneStaleThread`, `:608`), it re-checks staleness (`:614`). It then sets `threads.status='finished'` with `recovered_at` and `recovery_reason` (`:694`, `:727`). It inserts a recovered-report assistant message (`:789`). It can revert the status (`:764`, `:819`). Each write is conditional on the run marker the reader saw (`withRunMarkerGuard`, `:527-537`). |
| `sweepRejectedClusterAssignments` (`lib/rejected-cluster-sweep.ts:61-133`) | **No.** Its options are `{maxThreads, reviewPage, now, ignoreMemo}`. It reads up to 2,000 rejected `artifact_reviews` from every user (`:73-76`). | It clears `cluster_id` and `subject_id` on up to 5 threads' artifacts that analysts rejected (`clearStaleClusterAssignments`). The result always moves toward what the analyst decided. It keeps a **module-global** memo `lastCleanAt` (`:44`) that skips the sweep for 10 minutes after a clean pass. |
| Credential health (`health-handler.ts:904-910`) | **No.** It reads `tool_usage_log` for every user. | Nothing. It is read-only, but it **returns** to the caller the names of providers that refuse our credentials. |
| `synthesizeMissingFindings` (`finding-synthesis-sweep.ts:176`) | **No.** It reads finished threads (`:201`) from every user. | Today nothing, because `FINDING_SYNTHESIS_DRY_RUN=true` (Lovable's figure, **not verified**). With the dry run off, it `insert`s artifacts into closed cases (`:315`). |
| `sweepExpiredCache` (`cache-sweep.ts:127`) | Not applicable: `tool_call_cache` is a global cache. | It deletes expired `tool_call_cache` rows (`:178-179`) when `CACHE_SWEEP_ENABLED`. The default is off. |

**What an anonymous caller can cause today:**
1. Recovery reaps runs whose heartbeat is more than 75 s stale, for **any** user. A healthy run pulses
   every 15 s (`RUN_HEARTBEAT_INTERVAL_MS`, `recovery.ts:7`) and the writes are conditional on the run
   marker. So the anonymous caller cannot close a live run. It can only do sooner what the next sweep
   would do anyway. This is about **who triggers** recovery, not what recovery does.
2. Unbounded compute and database load from repeated calls. Each call reads up to 20 threads with up to
   500 artifacts each, 2,000 reviews, 300 log rows and synthesis candidates, all as the service role.
   There is no rate limit on this path.
3. Operational detail leaks: which providers refuse our credentials, synthesis state and counts, and
   recovery counts.
4. If anyone turns synthesis dry-run off or enables the cache sweep, anonymous **production writes**
   (synthesis) or **deletes** (cache).
5. Unrelated to `maintenance=1`, and not in this plan: every plain `?health=1` sends paid
   `chat/completions` pings (`checkDeepseek`/`checkMinimax`, `health-handler.ts:431-434`). CLAUDE.md
   already records this. It is a separate follow-up.

### 1.3 Every caller of the maintenance path

- **`src/components/ChatWindow.tsx:2884-2917`**, the only caller of `maintenance=1` in the repository.
  - It calls `void fetch(\`${FUNCTIONS_URL}?health=1&maintenance=1\`, { method: "GET" })` at `:2895`
    with **no headers at all** (no `Authorization`, no `apikey`) and discards the response.
  - It sweeps once when a thread opens (`:2897`), and only if `threadHasActivityRef` is set (`:2889`).
  - While a run is live it sweeps every 30 s (`:2913`).
  - After the stream ends it sweeps at 30 s and at 90 s (`:2909-2910`).
  - The same file already reads the session token for the chat transport (`:1753-1755`,
    `supabase.auth.getSession()` → `Authorization: Bearer …`). The sweep can reuse that pattern.
- **`supabase/migrations/20260720031500_pg_cron_health_sweep.sql:48-57`** schedules
  `net.http_get('…/osint-agent?health=1')` every minute **without `maintenance=1`**. So if it is live, it
  has done no maintenance since the 2026-10-19 gate. Whether it is applied: **not verified** (only the
  database can answer). The Lovable plan says no `cron.job` exists. Its header comment (`:5`) is stale:
  it calls the endpoint "unauthenticated" and names `refreshFinishedThreadReports`.
- `.github/workflows/edge-health.yml:41`, `scripts/record-deploy.mjs:47` and `scripts/stamp-build.mjs:14`
  call the **plain** `?health=1` only. The lockdown must leave them unaffected.
- Tests: `supabase/tests/osint-agent/health_handler_test.ts:204-225` pins `maintenanceRequested` and the
  plain-probe skip. `src/test/network-drop-suppression.test.tsx:262` and
  `src/test/server-run-active-retry-rerun.test.tsx:130` stub the sweep's `fetch`.
- `index.ts:226` (not part of this path) is a second, **authenticated** all-users recovery: every run
  start calls `recoverStaleActiveThreads(supabaseAdmin, { limit: 10 })`. It is behind `setupRequest`,
  so it needs a valid user, but it is not scoped to that user. It is left as it is (see §4, Q6).

### 1.4 How the edge verifies a user elsewhere (to reuse)

`auth.ts:66-133` (`setupRequest`):
1. It requires an `Authorization` header and returns 401 `MISSING_AUTH` without one (`:73-83`).
2. It builds an anon-key client that carries that header (`:114-116`).
3. It calls `supabase.auth.getUser()` (`:123`). That call verifies the token with Supabase Auth
   **server-side**, and the result returns 401 `INVALID_SESSION` on failure (`:124-132`).
4. It takes `userId = userData.user.id` (`:133`) from that verified result, never from the request body.
5. It checks thread ownership with `thread.user_id !== userId` → 403 (`:208-222`).

`setupRequest` itself cannot be reused: it also parses a POST body, rate-limits and admits a run
lease. The plan extracts steps 1 to 4 into a small helper that `setupRequest` keeps calling, so there is
one implementation.

### 1.5 A trap found while verifying: CORS preflight resets live-run state

Adding `Authorization` to a cross-origin GET makes the browser send an `OPTIONS` preflight first.
- `isHealthProbe` rejects OPTIONS (`health-handler.ts:385`). The preflight therefore falls through
  `index.ts:196` into the per-request reset block, `index.ts:198-217`. That block runs
  `degradedTools.clear()`, `deadHosts.clear()`, `resetCorrelateRun()`, `routingGuard.artifactsTotal = 0`,
  `memoryRecall*` and `triageState.*`.
- Only after that does it reach `setupRequest`, which answers `"ok"` for OPTIONS (`auth.ts:68-70`).
- `corsHeaders` (`env.ts:46-50`) sets no `Access-Control-Max-Age`, so browsers will preflight almost
  every sweep.
- If a preflight is served by the same worker as a **live run**, those resets clobber the run's
  module-scoped guards mid-run. Whether Supabase serves concurrent requests in one isolate is **not
  verified**. The code's own comments assume isolates are reused ("a warm isolate reuses `guard`").
- The chat POST already preflights once per run start. The sweep would add one about every 30 s
  **during** live runs, which is exactly when the reset does harm.
- That is why §2 puts a tiny edge PR **first**.

### 1.6 Behaviour change, stated plainly: whose stale runs get recovered

**Today:** any open tab, belonging to any user and on any thread that has activity, sweeps **every
user's** stale runs (limit 20 per call).

**After E3:** a tab sweeps only **its own user's** stale runs. That is all of the caller's threads, not
just the open one, still limit 20.

What still recovers another user's stale thread after E3:
1. **Run-start recovery, `index.ts:226`.** Every run start, by any user, calls
   `recoverStaleActiveThreads(supabaseAdmin, { limit: 10 })`. It is **not scoped**: it reaps the oldest
   10 stale threads of all users. E3 leaves it as it is, on purpose, as the cross-user backstop.
2. **The operator path.** `?health=1&maintenance=1` (or `probe=1`) with a valid `x-probe-secret` runs
   all-users maintenance, as today. Nothing calls it on a schedule (no scheduler; the repo's pg_cron
   migration calls the plain probe, and whether it is applied is unverified).
3. **The owner.** Opening any case that has activity sweeps all of the owner's stale threads.

**Can a thread now stay stale indefinitely?** Yes, in one case. Suppose its owner never opens the app
again, no user anywhere starts a run, and no operator calls the secret path. Then the thread stays
`active` with no report. Before E3 the same thread was also stuck until some tab was open somewhere,
so the new condition is "no run start anywhere" instead of "no tab open anywhere".
- The stuck thread is still not wrong data. It is an unfinished thread that recovery turns into a
  report on the next sweep that reaches it.
- Closing that gap for good needs a scheduler on the secret path. That is out of scope (JD's call, §4).

---

## 2. PRs, in landing order

The order is expand, then migrate, then contract. Each PR ships and reverts on its own.

```
E1 (edge)  OPTIONS answered before the per-request reset          ─┐ deploy + /health proof
F2 (front) sweep sends the user's access token; skips with no session ─┤ merges after E1 is LIVE
E3 (edge)  maintenance refuses anonymous; JWT path scoped to caller ─┘ deploys after F2 is in production
E4 (edge, later, separate) synthesis telemetry — the Lovable plan's M4 item 3; not planned here
```

**Why this order:** if E3 shipped before F2, every browser sweep would arrive anonymous and get no
maintenance, so open-case stale-run recovery would go dark. Runs would then sit `active` until the next
run start (`index.ts:226`). F2 is safe on today's edge, because the current build ignores
`Authorization` on the health path. F2 should wait for E1 to be **live** because of §1.5. E3 is the only
PR that removes behaviour, and its kill switch restores today's behaviour without a deploy.

### E1 — answer the CORS preflight before the per-request reset (edge)

- **Files:** `supabase/functions/osint-agent/index.ts` (move one early return) and
  `supabase/functions/osint-agent/env.ts` (`corsHeaders`: add `Access-Control-Max-Age: 600`). Add a
  small pure helper, `isCorsPreflight(req)`, beside `isHealthProbe`, plus its test file.
- **Behaviour:** an `OPTIONS` request returns `204` with `corsHeaders` at the top of `Deno.serve`,
  before `degradedTools.clear()` and the other resets. Nothing else changes, and POST runs are
  untouched.
- **Tests:** a unit test for `isCorsPreflight`. A source-reading test (the same pattern as
  `reviews_wiring_test.ts`) asserts that the OPTIONS return comes before the first `.clear()` in
  `Deno.serve`. A test asserts that `corsHeaders` still allows `authorization`.
- **Proof key:** `checks.cors_preflight_early` (`{ok:true, detail:"OPTIONS returns before per-request reset"}`).
- **Kill switch:** `CORS_PREFLIGHT_EARLY_DISABLED=true`, read at request time, restores the old fall-through.
- **Rollback:** set the kill switch, or revert and redeploy. No data is touched.
- **Open point:** JD may prefer to fold E1 into E3 to save a deploy cycle (§4, Q3). That only works if F2
  ships **after** E3, and that ordering cannot hold (see "Why this order"). So the choice is E1 as its
  own PR, or accepting the preflight risk for the F2-to-E3 window.

### F2 — the sweep sends the user's token (frontend)

- **Files:** `src/components/ChatWindow.tsx` (the sweep effect, `:2884-2917`, only). Possibly one small
  helper in a **new** `src/lib/` file (for example `src/lib/maintenance-sweep.ts`). It must not touch
  `src/components/panel/CaseReport.tsx` or any file the evidence-name branch owns.
- **Behaviour:** before each sweep, `const { data } = await supabase.auth.getSession()`.
  - With no session: **skip the sweep** and send no request.
  - With a session: `fetch(url, { method: "GET", headers: { Authorization: \`Bearer ${token}\`, apikey: SUPABASE_PUBLISHABLE_KEY } })`.
  - The cadence (open, every 30 s while live, 30 s and 90 s after the stream ends) and the
    `threadHasActivityRef` gate stay the same.
  - The token stays in the header, never in the URL.
  - Keep `void fetch` (the result stays discarded): F2 changes who calls, not what happens to the answer.
- **Tests (vitest):**
  - The sweep request carries `Authorization: Bearer <synthetic token>`.
  - With no session, no `fetch` is made.
  - The cadence is unchanged (fake timers: 1 call on open, then 30 s and 90 s).
  - Update the `fetch` stubs in `network-drop-suppression.test.tsx` and
    `server-run-active-retry-rerun.test.tsx` if they assert headers.
  - Run `npm run test:e2e` by hand, because the PR touches `src/`.
- **Proof:** the frontend has no `/health` key. Proof is the Vercel production build on the merge SHA,
  plus a vitest assertion. Observable after E3 by `checks.maintenance.detail` reading `scope: user`
  (see E3).
- **Kill switch:** none needed on the frontend. Old edge builds ignore the header. Rollback is a revert
  on `main`, and Vercel ships it.
- **Rollback:** revert. With E3 live, reverting F2 makes sweeps anonymous again. Set E3's kill switch
  first (see E3).

### E3 — maintenance refuses anonymous callers; the JWT path is scoped to the caller (edge)

The one behaviour: **who can trigger maintenance, and over whose threads.** It does not change what
recovery or the rejected-cluster sweep do to a thread.

- **Files:**
  - `health-handler.ts`: the gate at `:420` and `:854-870`, and a branch for the user path.
  - `lib/credential-health.ts`: replace `maintenanceRequested` with a pure `resolveMaintenanceAccess()`.
  - A new `lib/verify-user.ts`, extracting `auth.ts:73-133` steps 1 to 4. `auth.ts` then calls it with
    no behaviour change.
  - `recovery.ts`: add an optional `userId` to `recoverStaleActiveThreads` options. When it is set,
    `.eq("user_id", userId)` is added to the existing query. Nothing else in the query or in
    `recoverOneStaleThread` changes.
  - `lib/rejected-cluster-sweep.ts`: add an optional `userId`. It adds `.eq("user_id", userId)` on the
    reviews read and skips the global `lastCleanAt` memo for a scoped run, both reading and writing it.
    Otherwise a clean scoped pass for user A would suppress the all-users sweep for 10 minutes.
  - `env.ts`: the new switch.
  - Tests under `supabase/tests/osint-agent/`.
- **Access decision (a pure function, fully table-tested):**

  | Request | Result |
  |---|---|
  | `probe=1` or `maintenance=1` with a valid `x-probe-secret` | **operator**: all-users maintenance, as today (recovery, rejected-cluster sweep, credentials, synthesis, cache sweep). |
  | `maintenance=1` + `Authorization: Bearer <jwt>` that `auth.getUser()` accepts | **user**: recovery and rejected-cluster sweep **only**, both filtered to `user_id = <getUser().id>`. No credential-health read, **no synthesis, no cache sweep**. |
  | `maintenance=1` with a missing, invalid or expired JWT and no secret | **anonymous**: handled exactly as a plain `?health=1`. No service-role client is created, and there are no reads or writes. |
  | `probe=1` with a wrong secret | 403, as today. |

- **Rules the implementation must keep:**
  - The user id comes **only** from `auth.getUser()` on the server. The handler reads no `user_id` or
    `thread_id` from the query string or body. Any such parameter is ignored, and a test proves it.
  - The secret comparison is constant time. Hash both sides with SHA-256 through `crypto.subtle`, then
    compare the fixed-length digests with an XOR loop that never exits early. With the secret unset, it
    fails closed, as `env.ts:376-378` documents today.
  - The anonymous answer is the **plain liveness body**, byte-identical to `?health=1`, except
    `checks.maintenance.detail`, which says anonymous maintenance is refused. It contains no
    `checks.recovery`, `checks.credentials`, `checks.synthesis`, `checks.rejected_cluster_sweep` or
    `checks.cache_sweep`.
    - Status is 200 with `ok` decided by the orchestrator gate as today, not 401, so that HEAD and
      liveness monitors keep working.
    - The plain probe's 72 self-test checks and build marker stay public: `record:deploy`,
      `edge-health.yml` and the deploy gate depend on them.
  - The user answer: the plain body plus `checks.maintenance = {ok, detail:"ran (scope: user): recovery, rejected-cluster sweep"}`
    and `checks.recovery` with the caller's own counts only. It contains no other user's data and no
    credential, synthesis or cache detail.
  - The I-1 run-marker filter (`recovery.ts:856-858`) and the I-2 completion contract
    (`recoverOneStaleThread`) are not edited. The diff to `recovery.ts` must be the option and the one
    `.eq`.
- **Rate limiting and overlap: what is feasible inside an edge function**
  - Feasible: a per-user throttle on the user path using the existing `checkRateLimit`
    (`ratelimit.ts:125`, Upstash with an in-memory fallback), under its own key such as
    `maint:<userId>` so it does not use up the user's chat quota. Over the limit, the request is
    answered as anonymous (liveness only, no sweep), so a throttled caller never fails.
    - The browser sends about 2 sweeps a minute while a run is live, and the existing limiter allows
      30 a minute. JD decides whether a tighter maintenance-specific limit is worth adding (§4, Q5).
  - Feasible and already present: overlap safety at the **row** level.
    - Every recovery write is conditional on the run marker the reader saw (`withRunMarkerGuard`), and
      `recoverOneStaleThread` re-checks staleness. Two overlapping sweeps on the same thread therefore
      race to one winner, and the loser matches zero rows.
    - The rejected-cluster sweep only nulls fields that are already wrong.
  - Not feasible without a migration (out of scope): a cross-isolate mutex or advisory lock. That needs
    an RPC or table. The in-memory fallback in `ratelimit.ts` is per isolate, so when Upstash is
    unreachable the throttle is approximate. Say so in the PR.
  - Not feasible: rate-limiting the anonymous path per IP. Edge functions do not get a trustworthy
    client IP, and the anonymous path does no database work after E3 anyway. Its remaining cost is the
    paid LLM ping that every plain `?health=1` already sends (§1.2 item 5, a separate follow-up).
- **Tests (Deno, synthetic ids only, for example `00000000-0000-4000-8000-00000000000a`):**
  1. `resolveMaintenanceAccess` table: every row above, plus `HEALTH_MAINTENANCE_ALWAYS=true` without a
     secret, which must **not** grant all-users access (see the kill-switch note).
  2. Anonymous `?health=1&maintenance=1`:
     - The injected `createClient` spy is never called with the service key. Zero `.from()` calls.
     - The response has none of the five maintenance check keys.
     - The body equals the plain probe except `checks.maintenance`.
  3. JWT path, two users:
     - User A has a stale thread, and user B has a stale thread with a **known id**. A's call recovers
       A's thread and leaves B's row byte-identical.
     - The same again with `&thread_id=<B's id>&user_id=<B's id>` in the URL. Both parameters are
       ignored.
  4. JWT path never calls `synthesizeMissingFindings`, `sweepExpiredCache` or the `tool_usage_log`
     read (spies), even with every synthesis and cache flag on.
  5. Secret path: identical to today's behaviour (the existing tests stay green), plus a wrong secret
     of the same length is refused. The constant-time compare is tested for equal, unequal, empty and
     unset.
  6. An invalid or expired JWT behaves as anonymous: it must not 401 the liveness probe.
  7. A scoped rejected-cluster sweep does not set or read the global `lastCleanAt` memo.
  8. The recovery regression suite (`recovery_test.ts`, `orchestrator_finalize_test.ts`,
     `intermediate_step_plan_test.ts`) passes unchanged. If any of them needs editing, **stop**.
- **Proof key:** `checks.maintenance_auth`, a self-test that runs `resolveMaintenanceAccess` over three
  synthetic requests (anonymous, user, operator) and reports `{ok:true, detail:"anon→liveness, jwt→user, secret→operator"}`.
  Its presence proves the build. A durable log event `{event:"maintenance_sweep", scope:"user"|"operator", recovered, errors}`
  carries counts only, with no user id in clear. A short hash is fine if JD wants one.
- **Kill switch:** `MAINTENANCE_ANON_ALLOWED=true`, read at request time, restores today's behaviour
  (anonymous `maintenance=1` runs all-users maintenance). It is the rollback for a recovery outage
  without a deploy.
  - It is deliberately separate from `HEALTH_MAINTENANCE_ALWAYS`. If `HEALTH_MAINTENANCE_ALWAYS=true`
    is set in production (not verified), it must **not** keep granting anonymous all-users maintenance
    after E3. Otherwise the lockdown is a no-op.
  - JD decides whether `HEALTH_MAINTENANCE_ALWAYS` keeps its meaning only for authorized callers
    (§4, Q4).
- **Rollback:** set `MAINTENANCE_ANON_ALLOWED=true` (immediate), or revert and redeploy through the
  normal `edge-deploy` recipe.
- **Ships through** the `edge-deploy` skill (stamp, surgical sync, `verify:deploy` hard gate, Lovable
  message, `/health` proof, ledger), only on JD's go.

### Later, separate: E4 — synthesis telemetry

The Lovable plan's M4 item 3: one `finding_synthesis` log per run, counts only. It is a separate edge
PR after E3 and is not planned in detail here. Until a scheduler exists, the operator path (secret) is
the only path that runs synthesis after E3. **No scheduler is planned.**

---

## 3. Risks to the run-termination invariants, and how the plan avoids them

| Risk | Where | Mitigation |
|---|---|---|
| **Recovery goes dark** (runs stuck `active` with no report) because the sweep stops running | E3 shipping before F2, or F2 reverted after E3 | Order: E1, then F2 **live in production**, then E3. E3's `MAINTENANCE_ANON_ALLOWED` restores the sweep with no deploy. The run-start sweep (`index.ts:226`) still exists as a backstop. |
| **I-1**: a blank thread (no run marker) reaped as interrupted | `recovery.ts:856-858`, `:169-176` | E3 adds only `.eq("user_id", …)` to the query. It does not touch `REQUIRE_RUN_MARKER_FOR_RECOVERY`, `hasRunMarker` or `isStaleActiveThread`. The existing recovery tests must pass unedited. The F2 sweep keeps its `threadHasActivityRef` gate. |
| **I-2**: `finished` shown as complete without a report | `recoverOneStaleThread` (`recovery.ts:608-830`) | Not edited. A scoped run calls the same function with the same reason string. |
| A user call reaping **another** user's live run | E3 user path | The user id comes from `getUser()` only. The query filters on it. A test covers a known foreign thread id. Writes stay conditional on the run marker. |
| Preflight resets corrupting a **live run**'s guards | `index.ts:198-217` (§1.5) | E1 lands and is verified live before F2 merges. |
| Edge PR adds work inside the finalize window | n/a | Nothing in this plan runs inside a run request. The health path is a separate request, as today. |
| `toolChoice`, step budgets, lease, models, providers, secrets, `REVEAL_BREACH_DATA`, `MAX_PAID_CALLS` | n/a | Not touched by any PR. The only new env reads are the two kill switches. |
| The scoped rejected-cluster sweep weakening the global one | `lib/rejected-cluster-sweep.ts:44` memo | A scoped run neither reads nor writes `lastCleanAt` (test 7). |

---

## 4. Questions JD must answer before any code

1. **Queue position:** may E1 and E3 go ahead of the edge PRs already waiting (#1017 → #1018 → #1019,
   #963)? CLAUDE.md allows at most one edge PR in flight, and E1 and E3 are two edge deploy cycles with
   a frontend merge between them.
2. **Approve the split and order:** E1 (edge), F2 (frontend), E3 (edge), with E4 telemetry later and no
   scheduler?
3. **E1 as its own PR?** Or accept the preflight-reset risk (§1.5) for the window between F2 and E3 and
   fold the OPTIONS fix into E3? The recommendation is a separate E1.
4. **`HEALTH_MAINTENANCE_ALWAYS`:** is it set in production? After E3, should it apply only to
   authorized callers (the recommendation), or be retired?
5. **Throttle:** is reusing `checkRateLimit` under a `maint:<userId>` key (30/min, 300/h) enough, or do
   you want a tighter maintenance-specific limit?
6. **The run-start recovery** (`index.ts:226`) is authenticated but all-users. Leave it as it is (the
   recommendation: it is the backstop if the sweep goes dark), or scope it in a later PR?
7. **Anonymous answer:** keep 200 with the plain liveness body (the recommendation: keeps HEAD
   monitors, `record:deploy` and `edge-health.yml` working), or return 401 on `maintenance=1` without a
   valid caller?
8. **The plain probe's paid LLM ping** on every anonymous `?health=1` (§1.2 item 5): open a separate
   follow-up?
9. **The stale cron migration** `20260720031500_pg_cron_health_sweep.sql`: can someone check whether
   `cron.job` holds `osint-agent-health-sweep`? If it is live, it does no maintenance today and would
   keep doing none after E3.

---

## 5. What I could not verify

- Whether the Supabase gateway checks a JWT for `osint-agent` (`verify_jwt`). It is inferred off,
  because headerless calls are the working design (§1.1).
- Production secret values: `FINDING_SYNTHESIS_ENABLED`, `FINDING_SYNTHESIS_DRY_RUN`,
  `FINDING_SYNTHESIS_BACKFILL_ENABLED`, `CACHE_SWEEP_ENABLED`, `HEALTH_MAINTENANCE_ALWAYS`,
  `REJECTED_CLUSTER_SWEEP_DISABLED` and `OSINT_AGENT_PROBE_SECRET` (set or not). Every production figure
  in the Lovable plan is unverified.
- Whether the pg_cron migration is applied (database only).
- Whether Supabase's edge runtime serves concurrent requests in one isolate (the §1.5 risk depends on it).
- That the live build matches `origin/main` for these files. No `/health` call was made. The Lovable plan
  claims `osint-agent/**` is byte-identical to live `3f6ed05`, and that is unverified here.
- Exploitability against production. Deliberately not tested.
