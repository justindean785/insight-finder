# CLAUDE.md dated-state history (archived 2026-10-10)

Verbatim copy of the dated-state blocks that used to sit near the top of `CLAUDE.md` (lines 16-285 at `cf1d715`).
Every block here is a dated MEASUREMENT from 2026-09-22 or earlier and is STALE; kept only for history and for the lessons embedded in them
(stamp ordering, tool-cache versioning, the `ledger_ref_divergence` instrument trap, marker offset). `CLAUDE.md` keeps the rules; take current
state from `/health`, `git log origin/main` and the newest handoff.

---
> ⚠️ **Every dated-state block below is from 2026-09-22 or earlier and is STALE.** As of
> 2026-10-06T21:25Z `main` = `2ba2842`, live `osint-agent` = **`3ad2d2f`** (#697 → `9233ebd`, then
> #696 → `3ad2d2f`, both deployed and ledgered), mirror `c9b1ba3`. The current state, the PR queue
> and the release-recipe traps are in `SESSION_HANDOFF_2026-10-06_release-train-and-audit-queue.md`.
> It is itself a dated measurement — re-check `/health` and `origin/main` first.

> **Dated state — 2026-09-22T16:30Z.** `main` = **`3b905b4`**. Live `osint-agent` build =
> **`325daad`** — **DEPLOYED AND VERIFIED at 16:29Z.** `deploy/live` → `325daad`, ledger row
> `3b905b4` with **zero problems and zero warnings**, `verify:deploy` **VERIFIED** with
> `mirror tree -> equal` (`b83660e70bcf`), mirror `main` = `8aa6c1b`. Bytes unverified, as
> always — read the scope line, not the green word.
>
> **This shipped the prompt char budget chain: #604 (`74e98ad`), #615 (`151b664`), #616
> (`48acc71`).** Proof of deploy is the behavioural key, not the SHA:
> **`checks.prompt_budget_ceiling`** = `{ok, "hard ceiling 220000 chars, tail=summarize"}`.
> Read `tail=summarize` specifically — it proves **#615** is in the bundle, because the
> pre-#615 code referenced the tail instead of summarizing it. A marker can never prove that.
>
> ⚠️ **The 2026-09-22 audit in #614 says "#604 is merged and must not be deployed as-is."
> That verdict is STALE and was already stale when it was written down.** #614 was opened at
> 10:51Z recording two unrepaired findings; **#615 merged 11:33Z and #616 merged 11:50Z**,
> against exactly those two findings, in exactly the files they named, both with tests, and
> #616's wiring test is negative-control verified (it fails against pre-fix `index.ts`). Do
> not let #614 merge carrying that instruction — it would write a false deploy blocker into
> this file, which is the same failure mode #614's own body warns about for #564.
>
> **The one-commit offset bit, as it always does, and the ordering that avoided it is worth
> copying.** The stamp (#619) had to merge while `main` was at `325daad` so its parent IS the
> marker; #618 (docs) was deliberately held behind it. Had the docs merged first the gate
> would have reported a false `marker_offset_mismatch`. Sequence stamp → sync → gate → deploy
> → ledger, and hold every unrelated PR until the stamp lands.
>
> **#617 itself needed no edge cycle at all** — it touches ZERO files under
> `supabase/functions/`, which is why the edge sat at `4bb19d9` until this deploy.
>
> **The frontend DID ship, and was verified the hard way.** Vercel production deployment
> `dpl_BhatGqZjQNjQnCi3xuci2bUei51Z`, `state: READY`, `target: production`,
> `githubCommitSha: 325daad`. A green Vercel check on a PR is a PREVIEW (`target: null`) and
> proves nothing, so the check that counts was done on the live alias: fetch
> `insight-finder-sandy.vercel.app`, pull its stylesheet, and look for keys only the new code
> introduces — `stat-rule`, `panel-flat`, `panel-primary`, `case-mark`, `subtle-foreground`,
> `faint-foreground`, all present, and `.chat-label-chip` carrying `border:1px dashed`.
> **This is the frontend equivalent of `/health`'s behavioural proof key, and it works.** Use
> it; the JS bundle hash is NOT usable for this (Vercel builds independently, so a local
> build's hash never matches and a mismatch means nothing).
>
> **⚠️ Re-measured baselines. The three figures in the 09-20 block below are STALE, and that
> block's `main` = `ad4937b` was already stale before #617 — the real tip was `48acc71`.**
> On `main` at `325daad`: frontend **2178 passed / 1 skipped / 181 files** (`npx vitest run`;
> CI's own Frontend job agrees on 181), edge **1898 passed / 0 failed / 6 ignored** (CI, and
> unchanged by #617 since it touches no edge file — the 1885 → 1898 move came from #615/#616),
> e2e **51 passed / 2 skipped**, unchanged.
>
> ⚠️ **`npx tsc --noEmit` IS NOT THIS PROJECT'S TYPECHECK and will tell you everything is
> fine when it is not.** Bare, it resolves the root `tsconfig.json` and checks nothing: it
> returned exit 0 on a file containing an outright JSX syntax error, which `eslint` then
> caught. The real command is **`npm run typecheck`**
> (`tsc --noEmit -p tsconfig.app.json && tsc --noEmit -p tsconfig.node.json`). Every
> "typecheck clean" claim in this repo's history that used the bare form is worth nothing.
>
> ⚠️ **A green check board on this repo currently has NO review behind it.** `Devin Review`
> passes while reporting *"Full review skipped: trial expired and no credits remaining"*, and
> `Cursor Automation` reports `skipping`. Since II's §2.1 records that every defect caught in
> review here was a timeline or identity error that passed the full suite, typecheck, lint and
> build, treat green as "CI found nothing", never as "reviewed".
>
> ⚠️ **`npm run test:e2e` cannot run in a fresh worktree until the pinned browser is
> installed.** It had NEVER run in this one: all 53 specs failed with
> `browserType.launch: Executable doesn't exist`. `npx playwright install chromium` fixes it
> (~94 MB). Worse, the failure is easy to miss — `npm run test:e2e | tail -25; echo $?`
> reports TAIL's exit code, not Playwright's, so the run looks green. Redirect to a file and
> read the real status.
>
> **The merge queue is still the bottleneck, and it got worse:** **13 of 18 open PRs are
> DRAFT.** #617 was opened READY on purpose for that reason.

> **Dated state — 2026-09-20T12:00Z.** `main` = **`ad4937b`**. Live `osint-agent` build =
> **`4bb19d9`** — UNCHANGED; nothing merged and nothing deployed on 2026-09-19.
> ⚠️ **Three finished, green, mergeable PRs are sitting in DRAFT** — #602 and #603 (frontend,
> ship on merge) and **#604 (edge, does NOT ship on merge)**. #604's proof-of-deploy key is
> **`checks.prompt_budget_ceiling`**; only one edge PR may be in flight, so it blocks the rest
> of the edge plan. This is the documented bottleneck, live again.
>
> **⚠️ The three baselines below this block were measured at `4bb19d9` and are STALE.** On clean
> `main` at `ad4937b`: edge **1885** / 0 / 6, frontend **2106** / 1 / **173 files**, e2e **51** / 2.
> Stash your branch and re-measure before crediting or blaming a diff for a suite-total change.
>
> **Highest-value unfixed defect:** `sanitizeModelMessages` pass 3 keys `resolved` by tool-call id
> GLOBALLY while the AI SDK validates POSITIONALLY, so an overlapping run that delivers its result
> late leaves the earlier duplicate call unpaired and the run dies with `MissingToolResultsError`
> before any provider call. Reproduced end to end AND observed in production (thread `bfa55610`,
> 2026-09-12: two invocations dead in 85 ms with the SAME tool call id). Overlap runs at **12.2%
> of invocations**. Fix = resolve per POSITION. Detail: the 2026-09-20 handoff §4.
>
> **`stop_reason='unknown'` is explained** and is not a failure: `budgetExhausted` is never passed
> by `deriveStopReason`'s only call site (`telemetry.ts:423`), so `budget_exhausted` is
> unreachable and every tool-calls run that neither stream-errored nor force-finalized is labelled
> `unknown` by construction. One-line fix, own PR.
>
> **Dated state — 2026-09-15T00:20Z.** `main` = `06328a9`. `BUILD_MARKER` = `4bb19d9`.
> Live `osint-agent` build = **`4bb19d9`**, `ok: true`, `deploy/live` → `4bb19d9`,
> mirror `main` = `898a3a3`, `diff -rq` **empty for all four function dirs**.
> Edge baseline: **1879 passed / 0 failed / 6 ignored** — the number moved because #597 fixed the
> test glob, not because tests were added.
> Proof-of-deploy key for this build: **`checks.tool_cache_version`** =
> `{ok, "username_sweep=v2, username_search=v2"}`.
>
> ✅ **`github_code_search` is RECOVERED.** `checks.credentials` now lists it under `recovered`
> rather than `refusing`. JD's `GITHUB_API_TOKEN` fix took. The remaining refusals are
> `deepfind_email_breach`, `reddit_user`, `deepfind_disposable_email`, `deepfind_telegram_channel`
> — and a 403 is not a dead credential, see the section at the bottom of this file.
>
> ⚠️ **CORRECTION — the 2026-09-14 handoff (#596) merged STALE and its §1 is wrong.** It was
> written against `ff6ad26` / live `0a04e1b` and merged after four newer commits had already
> landed, so it records a state that was three deploys old on arrival. #597, #598 and #599 below
> are all things that handoff lists as *future* work. Take the state from THIS block, never from
> that handoff's §1 — which is the standing rule for every handoff in the series.
>
> **What landed between `0a04e1b` and `4bb19d9`:**
> - **#597** — `test:edge` globbed `*_test.ts` at the osint-agent top level only, so **five test
>   files had never been executed by CI or by the documented local command**, including
>   `lib/cluster_test.ts`, the suite guarding against false identity merges. All 34 pass. The
>   script now passes directories so Deno discovers recursively. Baseline 1845 → **1879**.
> - **#598** — **Scope & controls removed from the composer.** It enforced nothing (the endpoint
>   accepts `{messages, threadId}` and nothing else) and its `— Scope & controls (analyst
>   instructions) —` block was stored as part of the seed and truncated into the Timeline and
>   Activity Log. A corrected target still reaches the agent as ONE `Target: <value> (<kind>)` line.
> - **#599** — ⛔ **read this before trusting any tool-behaviour fix.** `tool_call_cache` is keyed on
>   `sha256({selector_type, selector, tool, params})` with **nothing in the key saying which
>   interpretation produced the row**, so a fix to how a tool decides its result stays invisible
>   until old rows expire. Measured: #594 went live ~16:30Z and a **17:19Z re-scan still narrated
>   "3 confirmed hits (Mixcloud, Telegram, HackerRank)"** — `tool_usage_log.cached` was true,
>   replaying a 13:44Z row. `lib/tool-cache-version.ts` now folds a per-tool
>   result-interpretation version into BOTH hashes. Kill switch `TOOL_CACHE_VERSION_DISABLED`.
>
> **The lesson, generalised: a deployed fix to how a tool INTERPRETS a result is invisible while
> the cache can replay a pre-fix row.** Bump the tool's version in `lib/tool-cache-version.ts` in
> the same PR, or the verification scan will look like the deploy failed.
>
> **Previous dated state — 2026-09-14T17:05Z.** `main` = `ff6ad26`, live `0a04e1b`
> (#592 `eaf0191` → #594 `0a04e1b` → #595 stamp `584da1b` → ledger `ff6ad26`), mirror `5f01506`,
> tree `422991e39c8b`, edge 1845/0/6 under the old glob.
>
> **What shipped:** #594 gave six platforms an `echoUnsafe` marker — HackerRank, Mixcloud, Spotify,
> Telegram, Trakt and NameMC answer 2xx for ANY string and echo it back, so `accountIsProven`'s
> generic echo fallback proved a registration for every username ever swept (309 HackerRank
> artifacts across 114 threads). #592 made `foldWords` fold URL path segments, so a URL artifact no
> longer needs a `metadata.handle` key to join its cluster.
>
> **Previous dated state, for the record — 2026-09-13T00:30Z.** `main` = `811c2cd` (#587 `c87c07b` →
> #588 stamp `4bdd1b4` → ledger `95b8d50` → #589 docs → #590 docs `811c2cd`).
> Re-confirmed at 00:30Z: **nothing is undeployed** — the only `supabase/functions/` change
> between `c87c07b` and `main` is `build-info.ts` itself, which is the stamp offset, not code.
> Mirror `main` = `71b79c4` — surgical sync of 11 `osint-agent/` files (10 + `build-info.ts`),
> landed as mirror PR #84; `diff -rq` empty for all four function dirs.
> Live `osint-agent` build = **`c87c07b`** — DEPLOYED AND VERIFIED 2026-09-13T00:02Z:
> `/health` moved `2864860` → `c87c07b`, `deploy/live` → `c87c07b`, ledger `95b8d50`,
> `verify:deploy` **VERIFIED** with `mirror tree -> equal` (`e0330dd1bf66`). Bytes
> unverified, as always — read the scope line, not the green word. Orchestrator
> `selected_provider: deepseek`, `orchestrator_reason: pinned`,
> `reveal_breach_data: true`.
>
> **`/health` now carries THREE behavioural keys**, and the newest one is
> **`checks.credentials`** (#587) — the proof-of-deploy key for this build, and the first
> one that reports a *fault* rather than a state. On its first probe it read
> `{"ok": false, "detail": "refusing: github_code_search (3x), deepfind_email_breach (2x),
> reddit_user (1x) · recovered: indicia_person, jina_reader_scrape, wayback_cdx_search"}`.
> That is correct behaviour, not a broken deploy: `ok:false` is what "a provider is refusing
> us" is supposed to look like, and a read failure reports `ok:false` too, because "cannot
> tell" is not healthy. The other two are `checks.synthesis` = `{ok, "disabled"}` and
> `checks.rejected_cluster_sweep` = `{ok, "clean: 361 rejected review(s), 0 stale
> assignment(s)"}`. **The next build's proof key must be a key that build introduces** — the
> marker alone can never prove a bundle.
>
> ⚠️ **`github_code_search` is genuinely 401 and JD's fix did NOT take** — measured against
> `tool_usage_log`, not inferred. Every call in the 21-day window failed `github 401`,
> **including 2026-09-12T20:53Z**, hours after the token was reported fixed; there is not one
> `ok` row in the window. The secret the code reads is `GITHUB_API_TOKEN`, falling back to
> `GITHUB_TOKEN` (`env.ts:256`), set in **Supabase function settings**, not Vercel or the repo.
> By contrast `rapidapi_breach_search` is **19 ok / 0 failed over 7 days** — that fix is
> confirmed. `reddit_user`'s single failure is 2026-09-07 (datacenter-IP block, expected) and
> `deepfind_email_breach` is 3 ok / 2 failed, listed only because its most recent event was a
> failure. Do not treat the `/health` list as four dead providers; that is the exact mistake
> the "A 403 is not a dead credential" section below exists to stop.
>
> Previous verified state, for the ledger: live `2864860`, stamp `5cbd7b0`, `deploy/live` →
> `2864860`, ledger `c50f383`, `verify:deploy` VERIFIED with `mirror tree -> equal`
> (`3da3b6a7d702`); before that live `7c7888f`, stamp `5807c31`, tree `c9edfe634fcf`.
>
> **⚠️ `subject_unlinked` is a PROMOTION gate as of #581 — the dispatch half of
> #518/#519 is deliberately reversed.** A quarantined selector is now LOOKED UP, and
> everything it yields inherits the quarantine (`lib/unproven-linkage.ts`). Analyst
> rejection still refuses dispatch. Kill switch, read at call time:
> `PROMOTION_QUARANTINE_DISABLED=true`. The table further down is updated; do not act
> on any older text that says quarantine blocks a tool call.
>
> ⚠️ A fresh sandbox clone has **not** fetched the `deploy/live` ref, which leaves that
> axis of the gate blind and can surface as a false `ledger_ref_divergence`. Run
> `git fetch origin refs/heads/deploy/live:refs/heads/deploy/live` first — confirmed
> necessary again on 2026-09-12.
>
> Mirror function dirs, enumerated rather than trusted: `_shared`, `evidence-export`,
> `mcp`, `osint-agent`, `security-test-lab`.
>
> **Both `subject_unlinked` dispatch-boundary reopenings were CLOSED by #519** —
> kept as history. ⚠️ Read it knowing #581 has since made quarantine a PROMOTION
> gate, so the "every quarantined selector dispatched normally" failure it
> describes is no longer a failure for quarantine; the paging correctness it won
> still matters, because an incomplete read now means a missed TAINT rather than a
> missed refusal, and the rejected-selector half of the guard is unchanged. The refused-key read paged only as far
> as PostgREST chose to answer — an unbounded select returns at most `db-max-rows`
> rows with NO error, a well-formed short 200 — so past that cap every quarantined
> selector dispatched normally. And the refusal text interpolated the
> classifier-written reason and the target-controlled selector into `error`, which
> `isIntentionalSkip` regex-matches BEFORE `deriveOk` reads `ok`: a selector like
> `gated.com` flipped a refusal to `ok:true` and deleted it from the failure metric.
> The read now advances by rows actually returned and ends only on an empty page or
> the true count; the message is a constant, with the reason carried as
> `quarantine_reason` (deliberately not `reason`).
>
> **The `mirror_tree_digest` gap stays CLOSED — do not re-report it as drift, or as a
> "known cosmetic gap".** This block used to say the digest differed because
> canonical-only TEST files were deliberately not synced. They were synced on
> 2026-09-07, and every sync since has carried test files too, so `diff -rq` over
> `osint-agent` is EMPTY and the gate reports `mirror tree -> equal`. That matters
> beyond tidiness: while the digests differed, the one gate protecting deploys was
> permanently yellow and so could not distinguish the known gap from real drift —
> the entire thing it exists to catch (11 Lovable-authored commits landed on the
> mirror on 2026-08-29 and were caught only because someone read the diff by hand).
> `evidence-export`, `security-test-lab` and `_shared` are empty too. **Keep syncing
> test files.**
>
> **A gate that always complains tells you nothing — check the instrument before the
> code.** On 2026-09-07 `record-deploy.mjs` reported `ledger_ref_divergence`. Not
> real: a fresh sandbox clone had never fetched the `deploy/live` ref, leaving that
> axis blind. Run
> `git fetch origin refs/heads/deploy/live:refs/heads/deploy/live` in a new checkout
> before trusting the gate.
>
> **`marker_offset_mismatch` between the stamp and the deploy is EXPECTED, not a
> fault.** Between stamping and deploying, live still reports the OLD marker while
> the newest stamp names the new one, so the gate says NOT VERIFIED. The hard-gate
> condition to read at that moment is `mirror tree -> equal`, nothing else. It flips
> to VERIFIED on its own once `/health` moves.
>
> Previous dated states, kept for the record: `main` = `4a5eb1c` / live `e50db9e`
> (#529 as `42d8609`, #519 as `e50db9e`; mirror `571cb9e`, tree `e854a98f4110`);
> `main` = `8691e55` / live `4e6888a`
> (#549 + #547 + #550; stamp `57c0912`); `main` = `43ae2db` / live `eab3668` (#542's
> backend half; stamp `8bec158`); `main` = `35ff20b` / live `7b0138d` (stamp
> `cfbb404`); `main` = `550fd60` / live `7cd74b5`.
>
> This block is a *measurement*, not a state — re-check `/health` and `list_deployments`
> rather than trusting it.
>
> **`/health` now carries a BEHAVIOURAL proof of deploy, not just the marker.** #511 added
> `checks.synthesis` to the health payload. That key exists only in code shipped at or after
> `cf06cbb`, so its presence proves the deployed BUNDLE contains the new `health-handler.ts` —
> which the `BUILD_MARKER` alone never could, since that is a static string the running code
> echoes about itself. It reads `{"ok": true, "detail": "disabled"}`, and `disabled` is
> correct: synthesis ships dark behind two independently-defaulted-OFF flags. If you need to
> confirm a future deploy landed, look for a key the new code introduces, not only the SHA.
> The successor keys are **`checks.rejected_cluster_sweep`** (2026-09-02) and
> **`checks.credentials`** (#587, live in `c87c07b` — see the dated state above). On
> `rejected_cluster_sweep`: the health path now
> clears stale `cluster_id`/`subject_id` on analyst-rejected rows every probe — bounded,
> idempotent, converging to one read, kill switch `REJECTED_CLUSTER_SWEEP_DISABLED` — so a
> Dismiss binds on the persisted columns within a probe interval instead of at the next
> re-run. Its absence from `/health` means that build is not deployed.
>
