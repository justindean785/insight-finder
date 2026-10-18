# Session handoff — 2026-10-14 — Anthropic orchestrator live, the dropped-connection bug, and the PR queue drain

> **Read this first.** Every number below is a dated measurement (2026-10-14T02:46Z), not a state. Re-measure with the commands in §7 before trusting any of it.
> Address the operator as **JD**. Engineering only: never investigate any person who appears in scan data.
> This file lands on `main` via docs PR **#760** (branch `docs/handoff-2026-10-14`). If `origin/main` does not contain it, that PR is unmerged — read it from the branch and ask JD.

## 0. JD's standing rules (restated from this session, verbatim where it matters)

- Ask before **any merge, any Lovable deploy message, any secret change, closing anything, or touching `REVEAL_BREACH_DATA`** (it stays **ON**; verified `/health reveal_breach_data=true` at handoff).
- Squash merges only. Don't delete branches. Merge `main` into branches, never force-push (the one exception this session: `--force-with-lease` on my own session branch that held only already-merged history; JD was told).
- One edge PR in the release lane at a time. `RUN_LEASE_DISABLED` stays `true`; S1b fencing lands before it is re-enabled.
- Stop at every "needs approval / sign-off" note in a PR body. **#666 was merged without reading its sign-off note** (my error, 01:41Z); JD then approved keeping it with #754 on top. Do not repeat the pattern: read the body, not just the file list.
- Report outcomes faithfully; nothing is "done" until `/health` proves it.

## 1. State at handoff (measured 02:46Z)

| What | Value |
|---|---|
| Live `osint-agent` build | **`66cf1c3`** (deployed 01:58Z; batch #744 #745 #703 #698 #751 #746 #747) |
| `deploy/live` | `66cf1c3` · ledger row present (#755) · `verify:deploy` VERIFIED, bytes unverified as always |
| Mirror `seeker-spark-search-5362c57c` `main` | `120c76e` (sync PR #113); `diff -rq` empty for all four function dirs |
| Canonical `main` | `5faa6ce` (#754 was the last merge) |
| Orchestrator | **Anthropic, pinned**, `claude-sonnet-5`, `checks.orchestrator_anthropic.ok=true`, caching "system+tools prefix", run budget 1.5M tokens / $2 |
| **BLOCKER** | **`ANTHROPIC_API_KEY` in Lovable is INVALID**: every run since 02:36Z fails at step 0 with `invalid x-api-key [HTTP 401]`, $0 spent. Fix: a key scoped to the **Insight Finder** workspace, saved via the Lovable secure form. Nobody but JD can do this. |
| Anthropic billing | Org monthly spend limit raised **$5 → $100** by JD (it had tripped at $6.26). Promo credit **$93.73 of $100** left, **expires 2026-10-23**. Auto-reload **off**; a Mastercard is on file as default — never enable auto-reload or buy credits on JD's behalf. |
| Prompt caching | **Working.** Console rate-limits page: 221K input tokens *excl. cache reads* vs 3.38M input tokens the model received (step metrics) ≈ 93% served from cache. The dashboard "Prompt caching: Not enabled" card is wrong. |
| Metering gap | Anthropic billed $6.26; `orchestrator_invocations` metered $3.78. The gap is spend after a dropped connection closed the record (see §2.3) — **not** caching. #758 closes it. |
| DeepSeek (Z.AI) | `checks.deepseek` = `preflight_failed status=429` ("Insufficient balance"). **Rolling back `ORCHESTRATOR_PROVIDER` to `deepseek` would fail.** `minimax` is the working alternate pin. |
| `checks.credentials` | `ok:false`; refusals audited in §4, none is a code bug. |
| Run lease | `LEGACY via RUN_LEASE_DISABLED` (unchanged). |
| Proof keys deployed this session | `seed_account_id`, `exact_boolean_repair`, `memory_input_normalization` (all `ok` on `66cf1c3`) |
| Baselines | edge **2316 / 0 / 6** on the #758 branch (main ≈ 2310); frontend **2560 / 1 / 198 files** on the #759 branch (main 2557 / 197); e2e **52 / 2** |

## 2. What happened this session (in order)

1. **Anthropic provider shipped and verified live** (#748 feature → #749 stamp → #750 ledger; build `eea36c2`). First scans failed on an *organization-scoped* key ("must include the anthropic-workspace-id header"); a workspace-scoped key fixed it. #751 adds a `workspace_required` error class (merged, in `66cf1c3`).
2. **PR queue drained**: 22 open drafts → 14 merged (8 frontend: #742 #743 #699 #695 #702 #700 #666 #612; edge: #744 #745 #703 #698 #751, then #746 #747 after resolving `/health` key conflicts), #667 closed as superseded by #744, #752 archived 33 old root notes to `docs/archive/handoffs/`, #754 (JD-approved fix-forward for #666's over-flagging of observed selectors) merged.
3. **The dropped-connection bug, measured and fixed (#758, draft).** `index.ts` built two UI streams from one `streamText` result and wired `persistFinalMessages` to BOTH. The AI SDK fires a UI stream's `onFinish` on *cancel* too, so when the browser dropped its response branch (phone switching apps, lock screen, a new message mid-run), persistence ran FIRST with a partial transcript, marked the thread finished, and the loop's real end was discarded while it kept spending. `lib/run-end.ts` had documented the mechanism as "observability only". Fix: the server-owned branch is the only writer; kill switch `PERSIST_ON_CLIENT_CANCEL=true`; proof key `checks.client_cancel_isolation`.
4. **"It logs me out every scan" (#759, draft).** `parseHttpStatusFromError` falls back to any bare 3-digit number; the Anthropic classifier's text "rejected the API key (401)" was read as the analyst's own 401 and `ChatWindow` navigated to `/auth`. Fix: `isTransportAuthFailure` (only a leading `HTTP 401 …`, which is what `withHttpStatusInErrorBody` produces for the backend's own pre-stream failure) gates the redirect and the "Session expired" wording.
5. **LeakCheck** is healthy (216 ok / lifetime). The account holds a **fixed pool of 200 queries, not 200/day**; #756 (draft) fixes the wording and adds a fail-open per-investigation cap (3) and low-quota reserve (20), both env-tunable.
6. **`buildInvestigationSummary`** counted ATTESTED into CONFIRMED and ignored analyst reviews; #757 (draft) splits them. The function has **no callers** on `main` (exported, unwired).

## 3. Open PRs and what each needs

| PR | Kind | CI at handoff | What it needs |
|---|---|---|---|
| **#759** provider 401 ≠ session expiry | frontend | green (all 5 checks, 02:49Z) | JD: "merge". Ships via Vercel. Stops the sign-out loop. |
| **#758** dropped connection no longer ends the run | edge | green | JD: "merge", then the full deploy cycle (§6). Also a cost control. |
| **#756** LeakCheck fixed pool + guard | edge | green | JD confirms defaults (3 per run, reserve 20), then merge + deploy (can ride the same deploy as #758). |
| **#757** summary CONFIRMED/ATTESTED split | frontend | green | JD: "merge". |
| #741 model can't write analyst review keys | edge | green on own head | JD review (evidence authority). Kill switch ships off. Keep. |
| #738 recalled memory is context, not evidence | edge, 18 files | — | JD review; body says "not for merge until JD approves". Keep. |
| #593 dedupe never transfers authority | frontend, 22 files | — | JD sign-off (its own note). Keep. |
| #701 LeakCheck key probe | edge | conflicts | **Recommend close**: assumes a daily allowance, would spend pool queries from a public `/health` path polled every 30 s. Better: surface the last-seen `quota` in `/health` (unbuilt). |
| #613 lineage schema | migration | conflicts | Rebase; migration must be applied through Lovable with JD's go. |
| #516 account deletion (dark) | frontend+migration | 236 behind, conflicts | Rebase or close; activation needs separate authorization. |

## 4. Audits done this session (no code change needed)

- **`checks.credentials` refusals** (all HTTP 403, response bodies not logged — that is a gap): `reddit_user` 0 successes ever (datacenter IP block); `nominatim_geocode` 76 ok until 09-23 then 403 (upstream, no key involved); `deepfind_*` (`disposable_email`, `ssl_inspect`, `tech_stack`, `telegram_*`) mixed ok/403 on one shared key → plan/endpoint gating at DeepFind. Check the DeepFind plan; nothing to fix in code.
- **18/21 optional keys set.** The 3 unset are very likely `firecrawl` and `intelbase` (tools disabled by design) plus one of `osintnova` / `ipqualityscore` / `perplexity` (never a success). Only the Lovable secrets list settles it.
- **#698 verification**: its contract test passes; no post-deploy call to `shodan_internetdb` / `hackertarget` / `triage_seed` / `username_search` has happened yet. `triage_seed` does not log its parameters. Needs one IP seed + one username seed scan.
- **Phone-cut runs**: thread `968e33d8` had two `premature_client_cancel` ends (47 s, 51 s) with JD not pressing Stop — the #758 defect, confirmed from the invocation rows.

## 5. Traps learned (keep)

- **`git push origin HEAD deploy/live`** (the ledger script's "publish with" line) means push HEAD to its *own* branch AND the local `deploy/live` ref to `deploy/live`. I misread it once and pushed HEAD onto `deploy/live`; caught by re-checking `git ls-remote`, fixed with a full-SHA `--force-with-lease`. Verify `deploy/live == marker` after publishing.
- **Two edge PRs each adding a `/health` key conflict in `health-handler.ts`** (import line + `r.checks.x = …` line). Resolution is always keep-both; run the edge suite after.
- **GitHub MCP `list_pull_requests` for 20+ PRs overflows the tool result**; it is saved to a file — parse it with python rather than re-calling.
- **Lovable DB column names**: `tool_usage_log.error_msg` (not `error_message`), `tool_usage_log.ok/outcome/status_code/input_json`; `orchestrator_step_metrics.step_wall_ms/input_tokens/output_tokens/tool_names`; `orchestrator_invocations.error_message` (here it IS `error_message`). `messages` has no `content` column (select `m::text`).
- **Stamp PR must merge while `main` IS the marker commit** — done right this session (#753 parent = `66cf1c3`). `marker_offset_mismatch` before the deploy is expected; the gate is `mirror tree -> equal` + `mirror pushed`.
- **The auto-mode command classifier blocks some compound bash** (a python helper + git merge in one line); split into smaller steps.
- **Parallel Search MCP** hits a free-tier rate limit after a few fetches; Firecrawl scrape works for docs.
- **A second Claude session** (`session_01Etfzkyx2zA7QNnbGFnMMiY`, "Github insight finder") watches this repo. Coordinate stamps through `send_message`; it agreed not to stamp/deploy while this session held the edge lane.
- The Lovable project agent's analyses can be stale or wrong (it reported a "$40 limit", "caching off", and offered a DeepSeek rollback that would 429). Verify against `/health`, the DB and the console before acting on them.

## 6. Ordered next steps

1. **JD fixes the key** (Insight Finder-scoped, via the Lovable secure form). Then one scan; verify a new `orchestrator_invocations` row with `stop_reason` ≠ `stream_error` and `credits_micro_usd > 0`.
2. JD says merge → **#759** and **#757** (frontend, ship on merge).
3. JD says merge → **#758** (+ **#756** if defaults confirmed) → stamp PR (parent must be the marker) → surgical mirror sync of exactly the changed files → `npm run verify:deploy -- --previous 66cf1c3 --mirror ../seeker-spark-search-5362c57c` must print `mirror tree -> equal` and `mirror pushed` → Lovable deploy message (AS-IS, `osint-agent` only, `wait=false`) → `/health` build moved and `checks.client_cancel_isolation.mode == "server_branch_only"` → `npm run record:deploy …` → publish ledger + `deploy/live` → ledger PR.
4. Phone test after deploy: start a scan, switch apps 30 s, return — run should finish with a report and no "Interrupted" card.
5. JD reviews #741, #738, #593; decides #701 (close), #613 and #516 (rebase or close).
6. Small follow-ups, not started: classify the Anthropic spend-limit 400 as `spend_limit_reached`; `markdown_extract` `offset` sent as a string (numeric-string repair, #746 family); `memory_save` `entries[].content` undefined (#747 doesn't cover it); LeakCheck `type:"domain"` is Enterprise-only (guard); last-seen LeakCheck `quota` in `/health`; the #742/#744 follow-ups the other session listed (punctuated IDs > 15 digits, stored `seed_type='phone'` display, Steam64 fixture).
7. Credit expires **10/23**: use Anthropic freely until then; decide afterwards whether to buy credits or pin `minimax` (not `deepseek` until Z.AI is recharged).

## 7. Verify

```bash
curl -s "https://skzqwbyvmwqarfgfvyky.supabase.co/functions/v1/osint-agent?health=1" | python3 -m json.tool | head -80
git fetch origin main refs/heads/deploy/live:refs/heads/deploy/live && git log --oneline -3 origin/main && git rev-parse --short refs/heads/deploy/live
npm run verify:deploy -- --previous 66cf1c3 --mirror ../seeker-spark-search-5362c57c
cd supabase/tests/osint-agent && deno test --config=../../functions/osint-agent/deno.json --no-check --no-lock --allow-net --allow-env --allow-sys --allow-read . ../evidence-export   # expect ~2310+ / 0 / 6
npx vitest run                     # expect ~2557+ / 1 skipped
PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome npm run test:e2e   # expect 52 / 2
```
Read-only DB (Lovable MCP `query_database`, project `4ce11bc3-039d-4439-b293-acacca9e1e3a`):
```sql
SELECT started_at, provider, stop_reason, step_count, round(credits_micro_usd/1e6,3) usd, left(coalesce(error_message,''),120) err
FROM orchestrator_invocations ORDER BY started_at DESC LIMIT 8;
```

Session branches (all pushed): `claude/anthropic-orchestrator-provider-1viaji` (#756), `claude/attested-confirmed-summary-split` (#757), `claude/client-cancel-does-not-end-run` (#758), `claude/provider-401-is-not-session-expiry` (#759), `docs/handoff-2026-10-14` (this file).
