# Full code review + live-state audit — Lovable · Vercel · GitHub · Supabase

> **Measured 2026-10-18 between 09:00Z and 09:45Z, against canonical `origin/main` `719b057` and mirror `origin/main` `8274dea`. This is a dated measurement, not a state. Re-check anything below before acting on it.**
> Read-only audit. Nothing was merged, deployed, or changed in any secret or setting. The only write is this document.

## 1 · Executive summary

**Scope.** This pass covered:
- **Code:** the whole canonical repo — the frontend in `src/`, the four edge functions, `supabase/migrations`, CI and the deploy scripts — plus the Lovable mirror.
- **Live state:** `/health`, the production database (via the Lovable connector), the Vercel project and its deployments, the Lovable project and its agent messages, GitHub Actions in both repos, and the open PR queue.

Every test gate was re-run from a clean `npm ci`. Five parallel review agents read the code. I then re-checked their headline claims against code and production data, and the confidence labels below come from that second check, not from the agents alone.

**Verdict: deploy pipeline healthy, product at risk.**

**Deploy pipeline.** All channels are in sync:
- Live `osint-agent` = `cabfeb9` = `deploy/live` = the newest functional commit on `main`.
- Vercel production = `719b057` = the tip of `main`.
- The mirror tree equals canonical byte-for-byte.
- Every gate is green: vitest 2603/1, edge 2449/0/6, e2e 52/2, typecheck, lint and build.

**Product.** It is at risk on evidence authority.

**Breach reveal: JD ruling, 2026-10-18.** `REVEAL_BREACH_DATA` **stays ON, exactly as it is, deployment-wide. Do not change the breach reveal settings at all.** This audit noted that the flag applies to every account, not only the owner's. JD has reviewed that and ruled to leave it unchanged. Re-verified live after the ruling: `/health` `reveal_breach_data=true`. This is settled. Do not re-raise it or offer "scope reveal to admins" as a fix (see F1).

**Top open question for JD.** There are several **model-writable authority paths** (findings F2–F5). One is a Serus keyword search for a person's name that skips write-side quarantine. Another is the dispatch guard not seeing Serus and Indicia selectors at all. Two more are model-written custody classifications and free-text "court records" labels that earn confidence 90. Each of these touches evidence ranking or custody, so each needs JD's sign-off. Production shows **no observed instance yet** of any of them. They are latent, and they reopen boundaries that #433/#448/#581 closed.

## 2 · Method & what could NOT be verified

| Source | Reached? | Reliability | Notes |
|---|---|---|---|
| Test gates, run here | ✅ | High | fresh `npm ci`, Deno 2.9.7, pinned Chromium 1194 |
| Live `/health` | ✅ (×3) | High | build, checks and flags recorded |
| Production DB (`mcp__Lovable__query_database`) | ✅ | High | read-only SELECTs only, full-corpus counts |
| Vercel API (project, deployments, runtime errors, domains) | ✅ | High | env-var *values* not read |
| Lovable API (project, messages) | ✅ | High | |
| GitHub (PRs, Actions runs/jobs, both repos) | ✅ | High | |
| Unauthenticated / anon-key probes of the 4 edge functions + PostgREST + storage | ✅ | High | the public anon key from the shipped bundle |
| Supabase Auth settings (`disable_signup`, `mailer_autoconfirm`) | ❌ | — | inferred from `auth.users` timing (30/34 confirmed in under 5 s) and the `Auth.tsx` comment |
| Edge-function logs (Supabase) | ❌ | — | so the JWT-expiry finding (F12c) remains **Likely** |
| Whether anything internal is reachable from Supabase's edge network (SSRF impact) | ❌ | — | F15 remains **Likely** |
| Anthropic / Z.AI billing consoles | ❌ | — | credit expiry 10-23 is from the 10-14 handoff, **Unverified** |
| Deployed bytes (vs source) | ❌ | — | inherent; `verify:deploy` says so itself |

## 3 · Measured gates

All gates ran on `719b057` in this sandbox, after a clean `npm ci` (13 s).

| Gate | Result | Duration | vs docs |
|---|---|---|---|
| `npm run typecheck` | pass | 22 s | — |
| `npm run lint` | 0 errors / 10 warnings (react-refresh) | 16 s | — |
| `npm test` (vitest) | **2603 passed / 1 skipped / 205 files** | 82 s | CLAUDE.md: 2560/1/198 (10-14), **stale** |
| `npm run build` | pass | 13 s | largest chunk: vendor-charts 390 kB |
| `test:edge` (Deno 2.9.7, `--no-lock`) | **2449 passed / 0 failed / 6 ignored** | 89 s | CLAUDE.md: 2316 (10-14), **stale**; another line still says 1885 |
| `test:e2e` (Playwright, pinned Chromium) | **52 passed / 2 skipped** | 1.6 m | matches |
| Canonical CI, `main` @ `719b057` | all 4 jobs green (frontend 5m32, e2e, edge, migrations) | — | — |
| **Mirror CI, `main`** | **red on every push since 2026-07-03** | — | see F21 |

The gates passed on a clean tree. One side effect: the edge test run rewrote the root `deno.lock`, which is the hazard CLAUDE.md warns about. That change was reverted rather than committed.

## 4 · Deploy & live state

| Channel | Observed | Matches | Verdict |
|---|---|---|---|
| `osint-agent` `/health` build | `cabfeb9` (committed 10-15 07:22 PDT), version 1.2.2 | `deploy/live` → `cabfeb9`; ledger → `cabfeb9` | **current** |
| Canonical `main` | `719b057` = ledger commit #792 (after stamp #791) | split-channel: nothing after `cabfeb9` touched the edge | **no lag** |
| `npm run verify:deploy -- --mirror …` | `VERIFIED`, mirror tree `121cb64ea8fa -> equal`, mirror pushed | — | gate clean (but see F20 on the gate itself) |
| Mirror `diff -rq` (osint-agent, evidence-export, security-test-lab, _shared) | empty | — | **zero drift** |
| Vercel production | `dpl_4Z4dkbH6…` READY, sha `719b057`, alias `insight-finder-sandy.vercel.app` (public, 200) | `main` tip | **current** |
| Vercel runtime errors (7 d) | none | — | weak evidence: static SPA, so no server runtime to error |
| Lovable project | `agentFinished:true`; last message 10-15 14:29Z (deploy AS-IS of `8274dea`) | — | idle, no unsynced Lovable edits since 10-07 |
| **Lovable-published frontend** | **`seeker-spark-search.lovable.app` is LIVE and public (200), serving the mirror's own frontend against the production Supabase**, with no CSP or X-Frame-Options | CLAUDE.md calls it "deprecated" | **see F19** |

What `/health` reports right now:
- **Orchestrator:** GLM-5.2 is pinned as primary, with Anthropic `claude-sonnet-5` as the backup that takes over only when GLM can't start a run (kill switch off).
- **GLM health check:** read `timeout` at 09:12Z, then `ok` twice at 09:20Z. That was a transient blip.
- **Run lease:** `LEGACY` (`RUN_LEASE_DISABLED`), unchanged and intentional.
- **Feature switches:** `synthesis` and `cache_sweep` are both disabled.
- **Breach reveal:** `reveal_breach_data=true`.
- **`checks.credentials`: `ok:false`.** The refusals, with counts:

| Tool | Refusals |
|---|---|
| `oathnet_lookup` | 7 |
| `github_code_search` | 3 |
| `reddit_user` | 3 |
| `deepfind_disposable_email` | 1 |
| `gemini_vision` | 1 |
| `nominatim_geocode` | 1 |
| `oathnet_subdomains` | 1 |

**10-14 handoff queue: fixed & live.** These PRs all merged on 10-13 to 10-15 and are inside `cabfeb9`: #756, #757, #758, #759, #765, #769, #774, #778, #780, #781, #786 and #790. CLAUDE.md's "Unmerged, waiting on JD: #758, #756" and "Last verified … live 66cf1c3" lines are **stale**.

## 5 · Production measurements (full corpus)

Corpus totals: 322 threads · 16,764 artifacts · 25 `kind='finding'` · 20,480 `tool_usage_log` rows · 1,525 `agent_memory` rows · 34 auth users.

**Orchestrator, last 7 days.**

| Day | Provider | Invocations | Errors | Avg duration | Tool calls | Metered |
|---|---|---|---|---|---|---|
| 10-18 | GLM | 15 | 1 | 113 s | 173 | $3.38 |
| 10-15 | GLM | 21 | 0 | 137 s | 351 | $5.93 |
| 10-14 | Anthropic | 38 | 19 | — | — | $13.34 |
| 10-14 | GLM | 21 | 0 | — | — | — |

- The 10-14 Anthropic errors are the `tool_use.input` 400 that #765 fixed. Anthropic has not run since, which is expected: it is now the backup only.
- **10-18 06:33:26Z: a GLM run died mid-run** with `Insufficient balance or no resource package. Please recharge.` It had completed 12 steps and 21 tool calls, then ended with `stream_error`. The next invocation, at 06:35Z, worked.

**Run integrity.**
- 257 finished threads carry a run marker; 82 were recovered with a reason. **None** is finished with no reason and no reply after the last user message.
- **None** of 175 finished-and-unrecovered threads ends in a short (<1.5 k chars) last assistant message.
- So F10 and F12a have not been observed in production.
- 5 threads are `active` with no run marker. These are blank drafts from September, and leaving them alone is correct per I-1.

**Tool failures, last 7 days** (`outcome='failed'`):
- **OathNet: 7 of 7 calls failed with HTTP 401 on 10-18.** It had 8 successful calls on 10-15. JD is working the cause out with OathNet's owner (2026-10-18).
- `github_code_search` is intermittent, not dead: 9 ok and 3 failed (401) in 30 days, last ok 10-13.
- **DeepFind (`deepfind_*`, 4 tools): effectively down.** 32 failed (403) and 2 ok in 30 days; last ok 10-10.
- `nominatim_geocode`: 403 since 09-23, its last success (upstream usage policy, which typically wants an identifying User-Agent).
- `fofa_search`: 3 of 3 failed with a plan error.
- `reddit_user`: 403, the datacenter-IP block.
- `jina_reader_scrape`: 13 failures, mostly 403s from target sites.
- Schema rejections still waste steps after #747/#790 shipped:
  - `memory_save` sent `{memories:[…]}` or `{memory_items:"…"}` (the normaliser doesn't treat either as `entries`).
  - `google_dorks` sent `{query}` at **10-15 15:45Z**, after #790 was live (presumably an ambiguous-shape query, which falls through by design).
  - `record_artifacts` was not valid JSON: 7.3 k characters of tool-call text on 10-18.
  - `minimax_correlate` was sent with `{seed}` and no `artifacts`.

**Access control (Confirmed).**
- 34 accounts; 30 were confirmed within 5 seconds of signing up; the newest signed up 09-19.
- 13 non-admin accounts made 28 breach-tool calls (OathNet / Serus / RapidAPI / LeakCheck / HIBP). 3 users were active in the last 30 days.
- No cross-tenant rows exist today: 0 artifacts, messages, notes or reviews whose `user_id` differs from the owning thread or artifact.

**Anon-key probe (Confirmed clean).**
- All 4 edge functions return 401 both with no auth and with the anon JWT.
- PostgREST returns `[]` for 12 tables and views, and the storage bucket list is empty.
- All 6 views are `security_invoker=true`.
- Buckets are private with owner-folder policies. One leftover bucket, `database_export_28_08_26`, holds 1 object (see F28).

**pg_cron is not installed live**, so nothing server-side sweeps stale runs on a schedule. Recovery runs only at run startup and on `/health` calls.

## 6 · PR & issue reconciliation

| PR | Repo | Kind | Draft | Merge vs `main` | Behind | Risk / note |
|---|---|---|---|---|---|---|
| #772 workspace redesign | canonical | frontend, 27 files | yes | **clean** | 20 | CI green (e2e skipped on PRs: run it by hand before merging) |
| #763 apify_skip_trace | canonical | edge, 13 files | yes | **clean** | 27 | a new paid people-search tool; review it on its own merits (breach reveal settled, F1) |
| #764 invalid-JSON tool call wedges on Anthropic | canonical | edge | yes | CONFLICT | 27 | probably superseded by #765/#769: production now logs `invalid_json` as a plain failed call (4× on 10-18, no wedge). **Check, then close** |
| #741 model cannot write review/release keys (A1) | canonical | edge | yes | CONFLICT | 56 | **the defect is still live** (F4); needs a rebase and JD sign-off |
| #738 memory is context, not evidence | canonical | edge, 18 files | yes | CONFLICT | 57 | JD review |
| #701 LeakCheck key probe | canonical | edge | yes | CONFLICT | 94 | the 10-14 handoff recommended **closing** it; still open |
| #613 lineage schema | canonical | migration | yes | CONFLICT | 94 | prerequisite for the learning layer; apply via Lovable with JD's go |
| #593 dedupe never transfers authority | canonical | frontend, 22 files | yes | CONFLICT | 56 | JD sign-off |
| #516 account deletion (dark) | canonical | frontend + migration | yes | CONFLICT | 289 | rebase or close |
| #117 sync package-lock | mirror | CI | yes | — | — | correct lock, but CI stays red on lint, edge and vitest underneath (F21) |

**7 of the 9 canonical drafts now conflict with `main`.** CLAUDE.md says "The bottleneck is the MERGE", and that is visible again here.

## 7 · Findings & action-list delta

Severity runs P0 to P3. Confidence is **Confirmed** (exact path traced and/or reproduced, or measured in production), **Likely** (strong reading with one assumption unverified), or **Unverified**. Every item is classified **new**, **still open**, **fixed & live**, or **disproven**.

### P1

**F1 — Breach reveal scope: SETTLED by JD on 2026-10-18; leave as is.** *Recorded for history, not an open action.*
- Observed: `reveal-policy.ts:47` applies `REVEAL_BREACH_DATA` to the whole deployment, sign-up is open with auto-confirm (`Auth.tsx:133-152`; 30 of 34 accounts confirmed in under 5 s), and 13 non-admin accounts made 28 breach-tool calls.
- **JD's ruling: breach reveal stays ON, unchanged, for the whole deployment. Do not change any breach reveal setting, and do not scope it to admins.** Re-verified live after the ruling: `reveal_breach_data=true`.
- Separate from reveal, and informational only: every new account gets a $0.50 starting credit (column default on `user_credits.balance_micro_usd`), so several accounts add up to more free spend. Whether sign-up stays open is JD's call; it is not tied to the reveal setting.

**F2 — A Serus `keyword` search for a person's name is never quarantined.** *New.* **Confirmed** by an agent probe against the real module; **0 production instances**.
- `queryIsNameOnly` (`auto-persist-findings.ts:769-773`) treats `identifierValue` as a concrete selector and returns before reading `identifierType`. The tool's own description tells the model to search names with `keyword`.
- The probe: "Jordan Vale" as a keyword search persisted strangers' email, phone and username with `subject_unlinked=false`.
- Production: 10 keyword searches returned results; none had a `First Last`-shaped value. 118 came back empty.
- This reopens the #433 write boundary.
- Fix: decide on `looksLikePersonName(identifierValue)` when `identifierType==='keyword'`, before the concrete-key loop.

**F3 — The dispatch guard cannot see Serus, Indicia, OSINT-Navigator or CordCat selectors.** *New.* **Confirmed** (`cache.ts:391-411`).
- `detectSelectorValue` and `detectSelectorType` never read `identifierValue`/`identifierType`, `query`, `q`, or `discord_id`. The empty selector passes both `isRejectedDispatch` and `isDispatchRefused`.
- (a) An **analyst-rejected** email or phone still reaches paid Serus (2500) and Indicia (2000–3000) calls.
- (b) A **quarantined** selector is sent **without the `unproven_linkage` taint**, so its results persist at full subject authority. This is exactly the hazard CLAUDE.md's #581 section warns about.
- `auto-persist` already has the correct key list (`BREACH_SUBJECT_INPUT_KEYS`); the two lists have drifted.
- Fix: a dispatch-only extractor, so the cache and circuit keys don't change, plus Serus and Indicia tests.

**F4 — The model can write authority directly.** *Still open (#741 unmerged) plus new angles.* **Confirmed** in code; **0 production rows** with model-written `reviewed:true`.
- (a) `record_artifacts` spreads model metadata unchanged (`tool-registry.ts:5713`, `:6183`): `reviewed:true` renders as Attested, and `false_positive:true` excludes the row.
- (b) The free-text source `"court records and news"` persisted a `name` at confidence 90 and `verified`, with no tool having run (probed). Only breach has a "did this tool run" check; court and government classes do not.
- (c) `record_evidence` (`:6315-6340`) writes the model's `classification` and uncapped `confidence` into `evidence_log`. Separately, `meta.classification` overrides the derived one (`:6001-6006`). `evidence-export` prints the result as "HARD · 95%".
- (d) `isVerifiedSelfAdmission` (`lib/cluster.ts:280`) accepts a model-written `source_quote`/`ownership_proof` and promotes to 90. That feeds the identity-memory ceilings, which carry across cases.
- Tool output reaches the model without untrusted-content framing, so a scraped page can trigger any of these.
- Fix: rebase #741 and extend its strip list to the (d) keys. Derive custody classification server-side. Let a source class count only when it maps to a tool slug that ran in this thread or to a URL host. **Evidence-integrity sign-off required.**

**F5 — The model can re-record a quarantined value under a new source label and drop the quarantine.** *New.* Code path **Confirmed**; whether runs do it is **Likely**.
- Quarantine is inherited only by `name`/`person`/`source_person` rows (`tool-registry.ts:708`).
- The dedup key includes `source` (`artifact-hygiene.ts:55-59`).
- So a tainted email, username or profile that the model `record_artifacts` again under another label becomes a second, full-authority row. Since #581, this is the main way taint can be lost.
- Fix: inherit for any kind that has an active `subject_unlinked` row for the same canonical value.

**F6 — The Breach Exposure table in the on-screen report ignores quarantine and reviews.** *New.* **Confirmed**.
- `CaseReport.tsx:1006` calls `buildBreachExposure(artifacts)`, which takes no reviews and applies no `forSubject`, unlike every sibling builder in the same file (`:44-48`, `:82`).
- Rows from quarantined namesakes, analyst-dismissed rows, and rows derived from rejected ones render as the subject's breaches, with revealable values.
- Fix: filter on `forSubject(reviews, a)` plus the rejected-derivation set. Frontend-only.

**F7 — Concurrent runs on one warm isolate reset each other's per-run state.** *New.* **Likely**.
- `index.ts:161-182` resets the module globals `guard`, `triageState`, `routingGuard`, `degradedTools` and `deadHosts` on every request, and the code elsewhere assumes concurrent runs can share an isolate.
- Run B's `triage_seed` replaces run A's `triageState.seed`, which `record_artifacts` uses for dedup and the provenance whitelist (`tool-registry.ts:5569,5655,5787`). One tenant's seed then shapes another tenant's integrity decisions.
- The `correlateCalls` cap and the correlate-outcome downgrade also reset mid-run.
- Fix: a per-request context, as `toolCallBudget` already uses.

**F8 — The primary model's balance is a single point of failure mid-run, and the backup's credit may expire.** *Operational.* **Confirmed** (DB); expiry **Unverified**.
- Z.AI ran dry mid-run on 10-18 06:33Z (§5), and before that on 10-13.
- The Anthropic backup only starts runs; by design it never takes over mid-run, so a mid-run failure loses the run.
- The 10-14 handoff says the Anthropic promo credit (~$93) **expires 2026-10-23** with auto-reload off. After that, the backup may fail as well.
- Actions: top up or auto-recharge Z.AI; decide the Anthropic budget before 10-23. A design follow-up worth scoping is a "balance error mid-run → finalize with what you have" path, which is not a provider switch.

### P2

**F9 — `/health` is unauthenticated, and every hit makes a paid GLM call and runs service-role sweeps.** *Still open* (CLAUDE.md and mem note it; no fix merged). **Confirmed**.
- `index.ts:159` routes `?health=1` before any auth.
- `health-handler.ts:380` makes a real `chat/completions` call (`max_tokens:4`) to Z.AI on every request, with no cache.
- Lines 657-765 recover up to 20 threads (with writes), run the rejected-cluster sweep, and do a 7-day `tool_usage_log` read with `limit(5000)`.
- The frontend also calls it on thread open and **every 30 s during a run** (`ChatWindow.tsx:2571-2599`).
- I hit it 3 times during this audit without auth.
- Fix: cache the GLM probe for about 60 s; run the sweeps only when a secret header is present; return just `{ok, build}` to anonymous callers. Lovable's 09-24 bounded-query change (reverted) is a starting point.

**F10 — The sidebar marks dead runs "finished", so they show as Complete with no report.** *New.* Path **Confirmed**; 0 instances in production now.
- `ThreadSidebar.tsx:173-182` writes `{status:'finished'}` with no `recovery_reason` once `updated_at` is more than 3 minutes old. `deriveRunState` (`case-snapshot.ts:114-115`) turns that into **completed**, which breaks I-2. Server recovery only selects `status='active'` rows, so this write also stops the recovered report from being written.
- pg_cron is not live, so server recovery happens only when a run starts or `/health` is called.
- Fix: delete the write. The UI already derives Interrupted from a dead heartbeat.

**F11 — Cross-tenant write paths in RLS.** *New.* **Confirmed** (live `pg_policies`); 0 exploited rows; requires knowing the victim's UUIDs.
- The INSERT/UPDATE `WITH CHECK` on `messages`, `artifacts`, `artifact_reviews` and `investigator_notes` is only `auth.uid() = user_id`, with no check that the parent thread or artifact belongs to the caller.
- Service-role readers trust these rows. Recovery builds a stub report from them (`recovery.ts:580,616,789`), clustering reads them (`lib/cluster.ts:642`), and reviews are loaded by id with no user filter (`reviews.ts:184`, `cross-case-reviews.ts:316`).
- So a forged review could pull another tenant's artifact into the attacker's own prompt.
- Fix: add `EXISTS (select 1 from threads t where t.id = thread_id and t.user_id = auth.uid())` to each `WITH CHECK`, and `.eq('user_id', …)` on the service-role review reads. This is a schema change, so it goes through Lovable and is verified live.

**F12 — Run-lifecycle defects in the edge core.** *New.* Mixed confidence.
- (a) **Confirmed** path, 0 observed. A *persist-phase* `finalize_no_findings` part, checked by type rather than success, suppresses salvage and meets the completion contract. With `memory_save` failing four times, the run ends green with no report (`orchestrator-finalize.ts:700,713,766`; `index.ts:1985,2194`).
- (b) **Confirmed.** `markRunStarted` writes `status:'active'` unconditionally (`recovery.ts` ~877), so a Stop pressed during intake or preflight is silently undone. Fix: `.neq('status','stopped')`.
- (c) **Likely.** The user-scoped client reuses the request JWT. A token that expires during a 3–6 minute run fails the final assistant insert and the terminal status writes (`index.ts:2155,2206`), and stale recovery then posts a stub over a run that actually finished. Fix: do terminal writes via `supabaseAdmin` with explicit user and thread filters. Confirm in edge logs first (search for `JWT expired`).
- (d) **Likely.** `onError` treats survivable SDK error chunks (an unparseable SSE chunk) as terminal while the loop keeps spending.
- (e) **Confirmed.** Billing gaps:
  - salvage on GLM is never metered or debited (`index.ts:2030-2036`);
  - GLM steps are billed at MiniMax rates (`:1772`);
  - salvage runs after a Stop and after the credit hard-stop;
  - the checkpoint cursor advances before its RPC succeeds (`:565`).
- (f) **Likely.** Non-streaming salvage is cut off by the 90 s idle timer (`fetch_retry.ts:115-150`).

**F13 — A second billed run can start on the same thread.** *New.* **Confirmed**.
- `retryLastUser` (`ChatWindow.tsx:2403`) calls `submitRefusal(status, lock)` without `serverRunActiveRef`.
- `rerunInvestigation` (`:2341-2346`) checks only the local stream status.
- With the lease disabled, a second tab or a stale Retry card starts an overlapping paid run.
- Also, `onRunPivot` (`:2197/2203`) toasts "sent" and then the send is silently dropped.
- Fix: pass `serverRunActiveRef.current` on every path.

**F14 — OPSEC: chat markdown loads remote images automatically.** *New.* **Likely**.
- `chatMarkdownComponents` (`ChatWindow.tsx:974-1004`) has no `img` override, and the CSP allows `img-src https:`.
- An image planted by prompt injection, e.g. `![](https://subject-host/x.png)`, sends the analyst's IP and the app's origin to a server the subject controls.
- Fix: render images as text links; `img-src 'self' data: blob: https://*.supabase.co`; `Referrer-Policy: no-referrer`.

**F15 — The SSRF guard checks only literal hosts, after redirects.** *New.* **Likely**: the probe confirms the bypass shapes, but internal reachability from the edge is unknown.
- `169.254.169.254.nip.io`, 6to4 (`2002::/16`), `64:ff9b:1::/48`, `198.18/15` and `192.0.0/24` all pass.
- `redirect:"follow"` requests every intermediate hop before `assertSafeUrl(r.url)` runs.
- `http_fingerprint` returns headers and body excerpts, so it would be a full-read SSRF.
- Fix: follow redirects manually and check each hop; check the resolved A/AAAA records via `Deno.resolveDns`.

**F16 — Fetched bodies are read in full before the size check.** *New.* **Confirmed** path.
- `archiver.ts:121` and `tools/gemini_vision.ts:146` call `res.arrayBuffer()` first. A lying or 405 HEAD skips the length gate, and an oversized body can exhaust the isolate's memory mid-run.
- Fix: use the existing `readCapped`.

**F17 — API keys in query strings may reach the model.** *New.* **Likely**: it depends on whether the runtime's fetch errors include the URL.
- FOFA (`tool-registry.ts:2966`), Hunter (`:5342/5411/5419`) and OpenCorporates (`:3871`) put keys in URLs and return `{error: String(e)}`.
- `sanitizeToolOutput` redacts by key name only.
- Fix: run `redactErrorMessage` inside `cache.ts scrub()`, and send Hunter's key in the `X-API-KEY` header.

**F18 — Chain-of-custody is weaker than "tamper-evident".** *New.* **Confirmed**; sign-off required.
- `append_evidence` can be executed by `authenticated`.
- `verify_evidence_chain` checks hash linkage only and never recomputes `content_hash` from the row.
- There is no immutability trigger on `evidence_log`.
- **Live** storage policies give owners UPDATE and DELETE on `evidence-archive` (re-created by mirror-only migration `20260624173943`, which reverses the 06-13 append-only drop). The bucket currently holds 0 objects.

**F19 — The deprecated Lovable frontend is still public.** *New.* **Confirmed**.
- `seeker-spark-search.lovable.app` returns 200, serves the mirror's own `src/` against the production backend, and sends no CSP or X-Frame-Options (clickjackable).
- Its code is not maintained here, so none of the frontend integrity fixes reach it.
- Fix (JD): unpublish the Lovable *frontend* (hosting only; the edge functions and DB are unaffected). Then confirm that Google OAuth redirect URLs don't depend on it.

**F20 — The `verify:deploy` gate is wrong before a deploy and too lenient after one.** *New.* **Confirmed** (code; the agent simulated both cases).
- (a) `record-deploy.mjs:95-100` finds the stamp with `git log --all -S … -1`. Pickaxe also matches the commit that *removes* the marker line, and `-1` takes the newest. So while live is still the previous build, it picks the *next* stamp. **The `marker_offset_mismatch` that CLAUDE.md calls "expected before the deploy" is this bug, not something inherent.**
- (b) A post-deploy `mirror_tree_differs` is only a warning, and the exit code comes from `markerProvenanceOk` alone, so a drifted mirror still prints `VERIFIED` with exit 0 and can be `--record`ed.
- Fix: choose the pickaxe hit whose `build-info.ts` actually contains the marker; make `differs` block, or add a `--pre-deploy` mode.

**F21 — Mirror CI has been red for 3.5 months and carries no signal.** *New.* **Confirmed**.
- The last green run on `main` was 2026-07-03; every run since 09-15 has failed (82 runs). It is a private repo, so these failures still consume the account's shared Actions minutes.
- The failures stack in layers:
  - typecheck since 07-03;
  - then lint;
  - then the Deno job (`Module not found scripts/metadata-source-measurement-policy.ts`);
  - from 09-11 (`821905a`, Lovable added `drizzle-*` and `postgres` and updated only `bun.lock`), `npm ci` fails.
- #117 fixes the lockfile only. Underneath it are 10 lint errors in Lovable-authored files, an edge job with `No test modules found` (the tests moved to `supabase/tests/` in #774), and 4 stale vitest failures.
- Fix: cut mirror CI down to what the mirror is for (`deno check` of the functions, the 4.3 MB bundle limit, tree equality with canonical), or delete it.

**F22 — Live schema that canonical doesn't know about.** *New.* **Confirmed**.
- Since `821905a`, Lovable writes migrations to **`drizzle/migrations/`**, not `supabase/migrations/`.
- Mirror-only and live:
  - the `get_thread_sidebar_metrics()` RPC and the `idx_artifacts_user_thread` index;
  - the evidence-archive UPDATE/DELETE policies (F18);
  - `realtime.messages` RLS;
  - a `chat-uploads` UPDATE policy that checks `owner`, not the user's folder, so a user can move their own object into another user's folder;
  - `artifact_linkage_releases`, which is unused and has 0 rows.
- Canonical's `types.ts` is missing 15 live objects.
- Neither repo can rebuild the live DB.
- Fix: backport these as canonical migrations (sign-off needed for the evidence-archive part) and regenerate `types.ts`.

**F23 — Credentials.** *Operational.* **Confirmed**.
- OathNet (`oathnet_lookup`, `oathnet_subdomains`) has returned 401 on every call today (new). **JD is resolving it with OathNet's owner (2026-10-18); no code change is planned.**
- **DeepFind's 4 tools return 403**: 32 failed and 2 ok in 30 days, last ok 10-10. Check the key or plan.
- `nominatim_geocode` has returned 403 since 09-23.
- `github_code_search` is intermittent (9 ok and 3 failed in 30 days), not dead as 09-13 reported.
- `reddit_user` is blocked by datacenter IPs and has never worked; consider disabling it.
- `fofa_search` fails on plan limits.

**F24 — Frontend data correctness.** *New.* Mostly **Confirmed**.
- Realtime channels with fixed names (`threads-sidebar`, `artifacts-${id}`, …) are reused when the component remounts, so the sidebar's live updates die after the first thread switch (**Likely**). Fix: the `channelSeq` suffix that `useThreadToolActivity` already uses.
- Out-of-order reloads in `useThreadArtifacts.loadStore` and `review.ts:417` can revert a just-clicked verdict.
- Artifacts load the **oldest** 1000 rows (`useThreadArtifacts.ts:175`), so a large case drops its newest run.
- "Chain-of-custody coverage" always reads 1/N, because every `append_evidence` passes `_artifact_id: null`.
- The report's "Analyst Narrative" is a stale 120-character summary.

### P3

- **F25 — Input-schema near-misses still waste steps** (§5). Small alias additions would fix most: `memories`/`memory_items` → `entries`, and `minimax_correlate` called with `seed` and no `artifacts`.
- **F26 — CSP is weaker than it looks.**
  - `script-src 'unsafe-inline' https://*.supabase.co` allows inline script and any Supabase-hosted JS, and there is no `object-src 'none'`.
  - `connect-src` lists `api.serus.ai`, which the frontend never calls.
  - `CustodyTab.tsx:337` puts `href={r.source_url}` straight from model-written `meta.url` into a link with no scheme check, so it can carry `javascript:`. React 18 does not block that. Fix: a shared `safeHttpUrl()`.
- **F27 — Password reset never asks for a new password.**
  - The reset link lands on `/auth`, which redirects to `/` on any session; there is no `PASSWORD_RECOVERY` handling (`Auth.tsx:117-121`).
  - `Settings.tsx:39` changes the password without asking for the current one.
- **F28 — Hygiene.**
  - Bucket `database_export_28_08_26` holds a DB export (private; delete if no longer needed).
  - `client_errors` accepts anon inserts with unbounded jsonb, and its purge is never scheduled.
  - `has_role(any_user_id)` can be called by `authenticated`, which reveals who is an admin.
  - `_shared/ai-gateway.ts` is imported by nothing.
  - `leaflet`/`react-leaflet@5` are unused (react-leaflet@5 also expects React 19).
  - `edge-health.yml` still requires `checks.minimax.ok`.
  - `stamp-build.mjs` runs `git` in the current directory, not the repo root.
  - `ANTHROPIC_THINKING=adaptive` would make every Anthropic run fail with a 400 while `/health` still reports ok.
- **F29 — CI cost and attribution.**
  - `cancel-in-progress: true` on `main` cancelled 43 of 100 October `main` runs, including the runs for every deployed marker commit (`cabfeb9`, `66cf1c3`, …). No functional change escaped e2e (each burst ended in a green run), but the deployed SHA itself never has a completed run.
  - Each `main` push costs about 14 billed minutes, including docs, stamp and ledger pushes (roughly 42 minutes per edge release). Fix: `cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}` and `paths-ignore` for docs and ledger.
- **F30 — CLAUDE.md drift.** The live-build line, the baselines (two different edge figures), the "unmerged #758/#756" line, "3 functions share `_shared`", and "marker_offset_mismatch BEFORE the deploy is expected" (F20) are stale or wrong. This report doesn't edit CLAUDE.md (it rides separately, per the small-PR rule).

### Disproven / closed this pass

- **`thread_metrics` view leaks thread ids across tenants:** disproven. Live, it is `security_invoker=true`, and the anon key gets `[]`. The migration that creates it is still missing from both repos (F22).
- **GLM is down:** disproven. The health check timeout at 09:12Z cleared on re-probe, and live runs on 10-18 succeeded.
- **Mirror drift:** none. Tree hashes are identical and `diff -rq` is empty. Lovable's 09-24 runtime edits were reverted the same day (mirror #90).
- **The 10-14 queue (#756, #757, #758, #759, #765, #769):** fixed & live.

### Notably well built (keep)

- **Edge auth:** `auth.ts` verifies the user via `getUser()`, checks thread ownership before doing any work, caps the body at 2 MB and rate-limits per user. Every function rejects both no auth and the anon JWT.
- **GLM-to-Anthropic switch:** `createStartFallbackModel` is latched and sticky, and cannot switch mid-run. Recovery's compare-and-set, and client-cancel isolation (the server-owned stream is the only writer), are careful race handling.
- **Paginated reads:** `loadRefusedArtifacts` reads every page correctly despite PostgREST's silent row cap.
- **Two-channel recording policy:** model metadata can only *lower* a cap, never raise it.
- **SSRF literal-IP handling:** decimal, octal, hex, `127.1`, mapped, NAT64 and ULA forms are all blocked.
- **`record_analyst_feedback`:** append-only, enforced by triggers.
- **Client write paths:** clients have none into `user_credits`, `user_roles` or `tool_call_cache`.
- **Frontend:** `fetch-retry.ts` retries GET and HEAD only, so it cannot start duplicate runs. `isClusterIneligible` is enforced inside `buildIdentityClusters`, so every call site is covered. react-markdown runs without `rehype-raw`.

## 8 · Recommended next actions (priority order)

These need JD's authorization. Nothing here auto-merges or auto-deploys, and a mirror merge is not a deploy.

1. **F8: money.** Recharge or auto-recharge Z.AI, and decide the Anthropic budget before the **10-23** credit expiry. **OathNet:** JD is resolving it with OathNet's owner (2026-10-18). Once fixed, confirm with a `tool_usage_log` query that `oathnet_lookup` returns `ok` again. **DeepFind:** check the key or plan (F23).
2. *(F1 breach reveal: settled by JD, leave as is, no action.)*
3. **F3 + F2: close the reopened quarantine boundaries.** Two small edge PRs, each with tests and a kill switch: the dispatch selector extractor (F3), then the Serus keyword name check (F2). Ship them one at a time through the normal stamp → sync → gate → deploy → `/health` cycle.
4. **F6 + F10 + F13: frontend integrity fixes. Built 2026-10-18 as draft PRs, awaiting JD:** F6 → **#794**, F10 → **#795**, F13 → **#796**. Each is frontend-only, test-first, and was e2e-checked by hand (52/2). They touch disjoint files and merge cleanly with each other.
5. **F4: rebase #741 and get sign-off**, extending it to `source_quote`/`ownership_proof` and server-derived custody classification. Then F5's quarantine inheritance.
6. **F9: gate `/health`.** Cache the GLM probe, and run sweeps only with a secret header.
7. **F7 + F12b/e: per-request run state; the Stop race; billing gaps.**
8. **F11 + F22: schema hardening via Lovable.** Add parent-ownership `WITH CHECK`s, then backport the mirror-only DDL and regenerate `types.ts`. Schema first, verified live, then code.
9. **Release tooling:** fix `verify:deploy` (F20); cut down or delete mirror CI (F21); `cancel-in-progress` and `paths-ignore` (F29).
10. **Queue hygiene:** close #701 (recommended since 10-14); check #764 against #765/#769 and close if superseded; rebase or close #516; unpublish the Lovable frontend (F19); delete the export bucket (F28); refresh CLAUDE.md's dated lines (F30).

Standing constraints: no auto-merge and no auto-deploy; JD authorizes each merge, Lovable deploy, secret change and closure. `REVEAL_BREACH_DATA` stays ON. `RUN_LEASE_DISABLED` stays `true`. Any evidence-ranking, cap or custody change needs explicit sign-off.

## 9 · Gaps in this audit

- **Auth settings and edge logs:** Supabase Auth settings and the edge-function logs were not readable. That leaves sign-up/auto-confirm inferred (strongly) from data, and the JWT-expiry finding (F12c) Likely.
- **Agent probes:** they ran the real modules under Deno 2.9 in a scratchpad, not the deployed runtime. The runtime differences that matter are F17 (fetch error text) and F15 (network reachability).
- **Production non-observation:** "0 production instances" for F2, F4, F10 and F12a is measured against current state. Data that was later overwritten or recovered would not show up.
- **Coverage:** the 6.9 k-line `tool-registry.ts` was reviewed for integrity and security, not tool by tool for correctness of each upstream API's response parsing.
- **Mirror frontend:** reviewed only for what it changes in the database and deploy path (drizzle, `mcp`), not as a product, because it is deprecated.
- **Deployed bytes:** they still cannot be proven equal to source. The platform exposes no artifact digest.
