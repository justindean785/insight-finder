# Verification of the forwarded edge tool-usage audit (2026-11-13)

> **Every production count in this report is unverified.** Run counts, failure rates and spend are the forwarded audit's claims. The query that would verify each one is in section 1, in the rows marked DATA. None was run.

Read-only. Code read at `main` `c8bc4ee`. No edge code, secret, schema or deployment was touched. No production query was run: every production figure below is the forwarded audit's claim, not a measurement. Section 4 lists what was not checked.

**`/health`, probed once at 2026-11-13 about 22:10 PST (plain probe, no maintenance):** build `3f6ed05`, 72 checks, 0 not ok, `selected_model: glm-5.3-flash` (pinned), `reveal_breach_data: true`, `checks.paid_provider_guard.guarded_tools: 0` (mode enforcing), `checks.tools`: 18 of 21 optional keys configured. The payload does not name the three missing keys, and its 21 names are not the capability gate's 22 key names, so the live tool count cannot be derived from it.

**The four findings that matter most:**

1. The model is offered up to 109 tools on an ordinary step, not 96 and not the "~30" the prompt states. The two open provider PRs would add 14 more.
2. An empty `memory_save` is rejected by the schema inside a forced finalize step. That repeats the step and can push the run to the backup report, so the 39-of-115 and 62% claims may share a cause. Not measured.
3. Anyone can run the maintenance sweeps with `GET ?health=1&maintenance=1`, and the only caller is an open browser tab. The cron migration in the repo calls the plain probe, which stopped running maintenance on 2026-10-19.
4. The audit's first fix (a per-seed-type tool list) is the documented `seedTypes` trap, and its second (choose the next pivot on the server) is partly live already as the resume brief (#861).

## 1. Claims

Legend: **CODE-YES** confirmed in code, **CODE-NO** refuted in code, **DATA** needs production data (query given, not run).

All queries are counts only, over `tool_usage_log` unless stated, with `outcome IN ('ok','failed')` where a rate is asked for.

### 1.1 Run shape

| Claim | Verdict | Citation or query |
|---|---|---|
| Limits are 22 steps and 36 calls | CODE-YES | `orchestrator-budget.ts:68` (`MAX_ORCHESTRATOR_STEPS = 22`), `:169` (`MAX_TOOL_CALLS_PER_RUN = 36`) |
| 106 runs in 10 days, about 5 steps and 8 calls per run | DATA | `select count(*), avg(steps), avg(tool_calls) from (select invocation_id, count(*) steps from orchestrator_step_metrics where created_at > now() - interval '10 days' group by 1) s` (column names must be checked against the live table first) |
| 62% of runs needed the backup report, 32% forced to finish | DATA | count of `orchestrator_invocations` rows in the window grouped by the salvage and finalize-reason columns. Names not checked. |
| About 60k tokens and 16 s per step, context 230k to 620k chars | DATA, and the character figure is a known floor | `orchestrator_step_metrics.context_chars` is fed by `approxPromptChars`, which omits tool schemas and three other terms (traps doc, "Where each number durably lives"). The honest figure is `prompt_size_step`, which is `console.log` only. |
| Distinct tools per week fell from 72 to 50 after the model change | DATA | `select date_trunc('week', created_at) w, count(distinct tool_name) from tool_usage_log where created_at > now() - interval '35 days' group by 1 order by 1` |

### 1.2 Tool list

| Claim | Verdict | Citation or query |
|---|---|---|
| "96 tools are sent to the model every step" | CODE-NO as stated | 96 is the count of inline `name: tool({` definitions in `buildTools` (`tool-registry.ts:745-6481`). The registry holds **115** keys: 96 inline, 10 imported (`:6483-6520`: serus, six indicia, pdl, gemini_vision, geoseer), 9 late-injected (`:6526-6970`). `catalog.ts` lists the same 115 names, no difference either way. The readiness gate (`index.ts:543-567`) then deletes every disabled or keyless tool, and `activeToolsOutsideFinalize` (`orchestrator-finalize.ts:87`) hides 2 more on ordinary steps. With every key set the model sees **109** on an ordinary step. The live figure depends on which keys are set; it is logged as `active_tool_count` in `prompt_size_step`. 96 could be right by coincidence, it is not what the code defines. |
| 35 tools had zero calls in 14 days | DATA | `select count(*) from (select unnest($registry_names) n except select distinct tool_name from tool_usage_log where created_at > now() - interval '14 days') x` |
| (a) saved key, no code: SocQ, Context.dev, Tavily, Apify | CODE-YES for "no code on `main`" | zero matches for `SOCQ`, `CONTEXT_DEV`, `TAVILY`, `APIFY` under `supabase/functions`. Whether a key is saved is a secrets fact, not checked. Code exists in open PRs: Context.dev #973 (ready) and #997 (draft), SocQ #998 (draft, stacked on #997), Apify #763 (draft). No Tavily PR found. |
| (a) saved key, no code: Serus AI | CODE-NO | `serus_darkweb_scan` is registered (`tool-registry.ts:6483-6491`) and gated on `SERUS_API_KEY` (`capabilities.ts:153`). If the saved secret has a different name, that is a secrets fact. |
| (a) a second GitHub token with no code | CODE-NO in part | `env.ts:324` reads `GITHUB_API_TOKEN ?? GITHUB_TOKEN`. A secret named `GITHUB_TOKEN` is read as the fallback. Any other name is unread. |
| (a) the paid-provider guard watches 0 tools | CODE-YES, and live | `/health` reports `guarded_tools: 0`. `lib/paid-provider-guard.ts:83` is an empty `Map`, by design ("changes nothing until a provider registers a policy in its own PR"). `registerPaidGuardPolicy` is called only in tests. Shipped in #996. #997 and #998 add `lib/paid-guard-policies.ts`. |
| (b) code exists, never handed to the agent: IntelBase email, BOSINT phone, two DeepFind tools | CODE-YES | `intelbase_email_lookup` is in `capabilities.ts:156` but not in the registry. `bosint_phone_lookup`, `deepfind_profile_analyzer`, `deepfind_ransomware_exposure` exist only under `tools/`. |
| (b) a leftover tool-list file used nowhere | CODE-YES | `tools/index.ts` (`ALL_STATIC_TOOLS`) has no importer in `supabase`, `src`, `scripts` or `e2e`. The edge-deploy skill says keep it parsing rather than delete it, because the Lovable build reads it. |
| (c) switched off on purpose: Firecrawl, dork harvest, IPQualityScore, two DeepFind tools | CODE-YES | `capabilities.ts:84, 97, 144, 157-159, 169` (`disabled: true`). Firecrawl is not in the registry at all. |
| (c) HIBP switched off | not settled | `hibp_lookup` is only key-gated (`capabilities.ts:43`). It is off only if `HIBP_API_KEY` is unset. `/health` says 3 of 21 optional keys are unset but does not name them. The `[readiness-gate] removed …` log line (`index.ts:563-566`) names every removed tool. |
| (d) catalog, pivot planner, geocoder, subdomain lookup, Hunter combined, Ransomware.live, Exa extras unused since October | DATA | `select tool_name, max(created_at) from tool_usage_log where tool_name in ('list_tools','minimax_plan_pivots','census_geocode','nominatim_geocode','crtsh_subdomains','crtsh_lookup','hunter_combined','ransomwarelive_lookup','exa_find_similar','exa_get_contents') group by 1` |
| (d) `GRAPH_PIVOTS_ENABLED` only acts inside the pivot planner | CODE-YES | read at exactly one site, `tool-registry.ts:1505`, inside `minimax_plan_pivots.execute`. If the planner is not called, the flag does nothing. |
| (d) the prompt says "~30 tools, call the catalog once" | CODE-YES | `system-prompt.ts:169`: "You have ~30 tools. If you need the full list of tool names, descriptions, when-to-use guidance, and per-seed planning recipes, call `list_tools` ONCE at the start." No test pins the wording. |
| (e) Reddit 5 of 5, Gemini deep search 6 of 13, page reader 22 of 99, Indicia timeouts | DATA | `select tool_name, outcome, count(*) from tool_usage_log where created_at > now() - interval '14 days' and outcome in ('ok','failed') and tool_name in ('reddit_user','gemini_deep_dork','jina_reader_scrape','socialfetch_web_read','indicia_person','indicia_phone','indicia_web_dbs') group by 1,2`. Read the streak as well as the ratio (`capabilities.ts:125-136`). `reddit_user` is deliberately left on (`capabilities.ts:138-140`). |

### 1.3 Bookkeeping

| Claim | Verdict | Citation or query |
|---|---|---|
| An empty memory save is a failure | CODE-YES | the schema requires `.min(1)` (`tool-registry.ts:6651`). The preprocess also drops entries with a blank subject, which can empty a non-empty list. A schema rejection never reaches `execute`. By contrast a list emptied by the analyst or merge gates returns `ok:true, saved:0` (`:6731-6739`). |
| What that costs | CODE-YES | the memory phase forces a tool call and advances only on an `ok:true` result (`orchestrator-finalize.ts:263-268, 286-289`). A rejected save repeats the phase, up to `FINALIZE_MAX_STEPS = 5` (`:58`), then falls to report salvage (`:322-333`). So this claim and the 62% backup-report claim may be linked. Not measured. |
| 39 of 115 failed, 36 with an empty list | DATA | `select outcome, count(*) from tool_usage_log where tool_name='memory_save' and created_at > now() - interval '14 days' and outcome in ('ok','failed') group by 1`. The empty-list split needs the `tool_input_failure` rows' issue codes (`too_small`). |
| The cleanup runs only inside the maintenance check | CODE-YES | synthesis, the rejected-cluster sweep, recovery and the cache sweep all sit in one block, `health-handler.ts:867-985`. |
| The maintenance check has no scheduler | CODE-YES, with a twist | the only caller in the repo is the browser (`src/components/ChatWindow.tsx:2895`). A pg_cron migration exists (`supabase/migrations/20260720031500_pg_cron_health_sweep.sql`) but it calls plain `?health=1`, which since the 2026-10-19 gate runs no maintenance (`health-handler.ts:410-420`). Whether that cron job exists in the live database was not checked; the traps doc measured no `pg_cron` on 2026-09-13. `.github/workflows/edge-health.yml` is manual only. |
| Anyone can trigger it | CODE-YES | `GET ?health=1&maintenance=1` needs no credential: `isHealthProbe` (`health-handler.ts:384-392`) runs before auth (`index.ts:196`), `maintenanceRequested` checks only the query string (`lib/credential-health.ts:147-155`), and a secret is required only for `?probe=1` (`health-handler.ts:855-862`). The work is bounded (20 threads per call) and touches only stale threads, so the exposure is database cost and timing, not data. |

### 1.4 Cost and evidence

| Claim | Verdict | Query |
|---|---|---|
| Opsis is about 60% of tool spend | DATA | `select (tool_name like 'opsis_%') is_opsis, sum(charged_micro_usd) from tool_usage_log where created_at > now() - interval '14 days' group by 1` |
| Weak leads and collisions stored as sentences | DATA | count of `artifacts` rows by `kind` where `length(value) > 80` and `value ~ '\s.*\s.*\s'`, counts only |
| About 85% of items unreviewed | DATA | count of `artifacts` left-joined to the review table, grouped by whether a review exists. Table name not checked. |

## 2. Collisions with standing decisions

1. **A per-seed-type tool list of 20 to 25 tools is the forbidden `seedTypes` change** unless it is built differently. The gate already exists (`capabilities.ts:223`) and is fed `null` on purpose (`index.ts:550`). The traps doc forbids populating it: an email seed yields a domain, a username and a phone mid-run, and a list fixed by the seed would hide the tools needed to follow them. A list that widens as new selector types are recorded would not be the same change, but it is a new behaviour that needs JD's ruling and a measurement from `prompt_size_step` first. The documented alternative is to cut the duplicated when-to-use prose from tool descriptions.
2. **The "~30 tools" line.** Correcting the number is safe wording. Do not combine it with any change to how `list_tools` is called.
3. **Server-side pivot choice.** No open pivot-planner edge PR exists. #882 is a frontend draft about pivot queues, with conflicts. Two pieces are already merged: `selectPivots` in `graph_pivots.ts` (#12, dark, reachable only through `GRAPH_PIVOTS_ENABLED` inside the planner tool), and the resume brief in `lib/next-pivot.ts` (#861, live, `checks.next_pivot_brief` ok). The resume brief ranks persisted selectors on the server with no model call, honours analyst verdicts and quarantine, and is appended to intermediate steps of a resumed turn only (`index.ts:997-1003`). Its header states the gap the audit describes: the planner "runs only when the MODEL chooses to call it". So the real choice is whether to extend the resume brief to first turns. Forcing the planner to run each cycle is a `toolChoice` change and falls under the termination oscillation section of `CLAUDE.md`. Do not do it by forcing a tool call.
4. **The backup-report rate touches the termination invariants.** Report salvage is the I-2 path. Nothing in this plan may gate finalize on completeness or add work inside the finalize window. The empty-memory-save change removes a wasted step from that window; it still needs JD's sign-off because it edits the finalize contract.
5. **Removing dead entries.** Do not delete `tools/*.ts`; the Lovable build parses them. Do not disable `reddit_user`; that reverses a settled decision. A 403 is not a dead credential: any removal needs the streak, not a ratio.
6. **Building SocQ and Context.dev.** Already built, and it works against the audit's own first fix.
   - **#997** (draft, mergeable): `contextdev_scrape` and `contextdev_people_search`, both behind the free-first guard, priced at $0.004 per credit. Proof key `checks.contextdev`, kill switch `CONTEXT_DEV_DISABLED`.
   - **#973** (ready, conflicting): the same provider with a third tool, `contextdev_web_search`, no free-first guard, priced at $0.002 per credit. It and #997 cannot both merge; JD picks one.
   - **#998** (draft, stacked on #997): 12 SocQ tools. Proof key `checks.socq`, kill switch `SOCQ_DISABLED`.
   - **#763** (draft, conflicting): `apify_skip_trace`. Its tests sit under `supabase/functions/`, which `src/test/edge-deploy-bundle.test.ts` has refused since 2026-10-15, so it needs a rebase that moves them.
   - #997 plus #998 take the registry from 115 to 129 tools. That is the opposite direction from a 20 to 25 tool list. Decide the tool-list question before adding 14 schemas to every step.
   - One edge PR in flight, so all of these queue behind #1017 to #1019.
7. **Closing the public maintenance trigger.** A single shared secret would break the browser sweep, which is the only live trigger for stale-run recovery, so that design would need a proven scheduler first. A sibling session (maintenance lockdown) is building a design that removes this ordering dependency and needs no scheduler:
   - an anonymous call is liveness only;
   - a call carrying a verified user JWT runs recovery scoped to that user's threads;
   - the probe secret runs all-users maintenance.

   What it changes: an open tab reaps only its own user's stale runs. Today any tab, or any anonymous caller, reaps up to 20 stale runs across all users. A run whose owner has no tab open then waits for the next secret-authenticated call, or for that owner's next run start (`index.ts:226` sweeps at startup). The all-users sweeps (rejected-cluster, synthesis, cache) run only on the secret path, so with no scheduler they run only when someone calls it by hand. This design was not reviewed here; it is described as the lead session reported it. Recovery is I-1 territory either way.
8. **Opsis spend.** Do not answer it by changing `MAX_PAID_CALLS`.

## 3. Ranked PR-sized changes

Ranked by evidence in hand and by how little each one can break. None is approved. Every edge row is one build, queued behind #1017 to #1019. The proof-key and switch names are proposals.

| # | Change | Channel | Proof | Kill switch | JD rules on |
|---|---|---|---|---|---|
| 1 | Run the section 1 queries and record the counts in a dated note | docs (read-only queries) | the note | n/a | permission to query production |
| 2 | An empty `memory_save` list returns `ok:true, saved:0` instead of a schema failure | edge | `checks.memory_save_empty` | `MEMORY_SAVE_EMPTY_OK_DISABLED` | it edits the finalize contract; wait for row 1's memory count |
| 3 | The prompt line drops the wrong number ("~30") | edge | `checks.prompt_tool_line` | revert | wording only |
| 4 | Maintenance lockdown, in progress in a sibling session: anonymous is liveness only, a verified user JWT runs recovery for that user's threads, the probe secret runs all-users maintenance | edge, with a frontend PR first so the sweep sends the user's token | that PR's own key | that PR's own switch | the design itself; that a tab reaps only its own user's stale runs; that all-users sweeps then have no automatic trigger |
| 5 | A scheduler for all-users maintenance: a cron job that calls the secret-authenticated path. Not a prerequisite for row 4. The existing migration cannot be reused as written: it calls the plain probe with no header | schema, through Lovable, later | the cron job row, plus `stale_thread_sweeper` events while no browser is open | unschedule the job | whether to have one at all; cadence; where the secret lives in the database |
| 6 | Pick #997 or #973, close the other | none | n/a | n/a | guard or no guard, $0.004 or $0.002 per credit, two tools or three |
| 7 | A durable home for `prompt_size_step` (columns on `orchestrator_step_metrics`) | schema, then edge | rows in the new columns | `PROMPT_SIZE_PERSIST_DISABLED` | needed before any tool-list target is set |
| 8 | Cut duplicated when-to-use prose from tool descriptions | edge | `checks.tool_description_budget` | revert | blocked on row 7's numbers |
| 9 | Resume brief on first turns | edge | extend `checks.next_pivot_brief` | `NEXT_PIVOT_BRIEF_DISABLED` (exists) | whether a first turn has enough persisted rows to rank |
| 10 | A tool list that widens as selector types are recorded | edge | new key | new switch | collision 1; blocked on rows 7 and 8 |

Not proposed: deleting `tools/*.ts`, disabling `reddit_user`, raising `MAX_PAID_CALLS`, any change to `toolChoice`, any change to the model pin. Failing-tool fixes (Gemini deep search, the page reader, Indicia timeouts) need row 1's counts and streaks before any of them is sized; #800 (wayback) is the only one with a draft.

## 4. Not checked

- No production query was run. Every count in the forwarded audit is unverified.
- Table and column names in the queries were not checked against the live schema; the three marked "names not checked" are sketches.
- Which optional keys are unset, so the live tool count and whether HIBP is off.
- Whether the SocQ, Context.dev, Tavily and Apify secrets exist. #997 and #998 say the first two are "in the vault"; that is the PR author's statement.
- Whether the pg_cron job exists in the live database, and whether `GRAPH_PIVOTS_ENABLED` is set.
- `/health` was probed without `maintenance=1`, so the synthesis, cache-sweep and recovery checks were not read. Which sweep the audit means by "findings cleanup (dry-run)" is not settled; synthesis and the cache sweep both have a dry-run switch.
- For #997, #998, #973 and #763 the descriptions and added tool, key and proof-key lines were read, not the full diffs. No test was run on any of them.
- #963 (cluster adjudicator) and #868 (`memory_save` aliases) were not read for overlap with rows 2 and 4.
- The mirror repo was not compared with `main`. Deployed bytes are not provable from `/health` (edge-deploy skill).
- The maintenance lockdown design in row 4 was not read or reviewed; its code is in another worktree.
