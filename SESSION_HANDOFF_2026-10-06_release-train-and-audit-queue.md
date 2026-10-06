# Session handoff — 2026-10-06 — the release train, and the audit queue it was cut from

> **Read this one first.** It supersedes `SESSION_HANDOFF_2026-09-20_…` and the dated-state block at
> the top of `CLAUDE.md` (which is from 2026-09-22 and is stale — see §2). Every number here is a
> dated measurement, not a state: re-verify against `/health`, `origin/main` and the live DB.
> Engineering only. Nothing in this repo or this handoff authorises investigating any person who
> appears in a scan.

## 1. State at the end of the session (2026-10-06T21:25Z)

| Axis | Value | How it was proved |
|---|---|---|
| canonical `main` | **`2ba2842`** (ledger for `3ad2d2f`) | `git log origin/main` |
| live `osint-agent` build | **`3ad2d2f`** (Release 2) | `?health=1` moved `9233ebd → 3ad2d2f` at 21:15:53Z |
| `deploy/live` | `3ad2d2f`, ledger row recorded, **zero problems / zero warnings** | `npm run record:deploy`, ledger PR #707 |
| mirror `main` | **`c9b1ba3`** (PR #103) | `diff -rq` empty for `_shared`, `osint-agent`, `evidence-export`, `security-test-lab` |
| `verify:deploy` | VERIFIED, `mirror tree -> equal` (`b19a51c0e923`), `deployed_bytes_verified: false` | read the scope line, not the green word |
| edge baseline | **2163 passed / 0 failed / 6 ignored** (merged #696, pre-stamp) | CI Edge job + local `--no-lock` |
| frontend / e2e baseline | last measured on `8039235`: **2367 / 1 / 187 files**, e2e **52 / 2** | **not re-measured on `2ba2842`** — stash and re-measure before crediting any delta |

`/health` proof keys now live: `checks.tool_input_failure_log` (#697, `9233ebd`),
`checks.negative_lookup_semantics` + `checks.tool_cache_version`
(`…shodan_internetdb=v2, jina_reader_scrape=v2`) (#696, `3ad2d2f`). `reveal_breach_data=true`.
`checks.credentials` reads `ok:false` and that is **correct** (a provider is refusing us; see §7).

⚠️ **Neither release has been observed in production yet.** The last `tool_usage_log` row before
the deploys is 18:42Z; nothing has run since. The health keys and tests prove the *build*, not the
*behaviour*. The first real scan is the observation: no `disabled for thread` rows for Shodan on
valid IPs; the Activity tab's failed count equals the model's call count (the earlier scan showed
"Failed 0 of 23" beside 26 calls). **Do not report either fix as working until you have seen that.**

## 2. What happened, and what is stale

Two audits of real scans were verified (the audit text was accurate on every checkable point; two
of the *causes* it stated were wrong — a Nominatim User-Agent that is already sent, and "ten blank
threads still running" which is invariant I-1, not a defect). That produced a queue of small PRs
(§4). **Two releases were then shipped end to end under JD's per-release go-ahead:**

1. **Release 1 = #697** → live `9233ebd`. Observability only: SDK-rejected tool inputs get a
   `tool_usage_log` row (field paths + key names, never values).
2. **Release 2 = #696** → live `3ad2d2f`. A Shodan 404 for a real IP is a negative result, not a
   dead endpoint; a Jina "Target URL returned error" page is a failed read, not evidence; cache
   versions bumped so pre-fix rows stop replaying.

**Stale text to distrust:** `CLAUDE.md`'s dated-state block (09-22, `3b905b4`, live `325daad`) and
its "unfixed overlap defect" paragraph (the positional-pairing fix shipped; the run **lease** PR2/PR3
is still unbuilt). A docs refresh of that block is queued (§8). The 09-20 `NEXT_SESSION_PROMPT`
described a queue that has since drained; it was replaced by this session's prompt.

## 3. JD's standing rules (verbatim intent — do not paraphrase them away)

- Call him **JD**. Engineering only: no independent investigation of the people in any scan.
- **`REVEAL_BREACH_DATA` stays ON.** "Don't mess with breach reveal settings, leave it on, do not change."
- **Cheap agents only** — no Opus / top-tier models for subagents ("don't use … super high credit models").
  JD set the advisor to Fable himself via `/advisor`; that is his call, not a licence to spend elsewhere.
- **Every outward step needs his explicit go-ahead**: merge, stamp, mirror push, Lovable deploy message,
  schema apply, secrets, billing. His **"Go"** authorised Release 1 alone; **"Continue"** authorised Release 2
  alone. **Neither is a standing approval for the next release** — ask again, name the one PR.
- Nothing authorises: deleting the ten blank "New investigation" threads, changing any subscription,
  disabling any provider, opting in to the LeakCheck probe, rotating the Opsis key ("Opsis key is fine").
- Evidence-ranking / chain-of-custody changes need his sign-off. The ONE approved rule is the interim
  write-time negative-qualifier rule (#693).
- Do not echo his billing/card/address details or any leaked credential. None belong in this repo.

## 4. The queue — all DRAFT, nothing in it has been merged

**Edge PRs do not ship on merge.** Each is its own cycle (§5). **One edge PR in flight at a time.**
`health-handler.ts` is edited by six edge PRs, so after every release the next branch needs a
mechanical merge-of-`main` and a re-test before it can merge.

| PR | channel | one behaviour | proof key / kill switch |
|---|---|---|---|
| **#693** `2a20414` | edge **+ ships on Vercel at merge** | a source token qualified `(0 hits)` / `(404)` / `(no PTR)` / `(circuit-broken)` contributes no source class | `checks.negative_qualifier_rule` · `NEGATIVE_QUALIFIER_CLASS_DISABLED` |
| **#694** `46e2d9d` | edge | the agent's setup rows are inert in identity clustering | `checks.cluster_bookkeeping_inert` · `CLUSTER_BOOKKEEPING_INERT_DISABLED` |
| **#698** `e763351` | edge (guidance text) | catalog input names match the real zod fields | none needed |
| **#703** `5f895bf` | edge | an Opsis 402 says flip-a-setting vs buy-credits | `OPSIS_CREDIT_HINT_DISABLED`; health detail "402 credit hint on" |
| **#667** `55aae4c` | edge | a 17–20 digit account ID is not a phone seed | `checks.seed_account_id` |
| **#701** `9d00d0c` | edge, **ships OFF** | `/health` probes LeakCheck's key | `checks.leakcheck_key` · opt-in `LEAKCHECK_KEY_PROBE_ENABLED=true` |
| **#702** `623c7c9` | frontend | a LeakCheck plan/quota 403 is not "bot protection" | ships on merge |
| **#699** `00ce54b` | frontend | PDF-converted provider export names its real subject | ships on merge |
| **#700** `1af5900` | frontend | area-code warning needs two clusters sharing no code | ships on merge |
| **#695** `ef1f752` | frontend | contradicted analyst-supplied name → open question | ships on merge |
| **#666** `c771030` | frontend | zero-hit lookups are not corroboration | **merge only AFTER #667 is live** (client/server seed-kind parity) |
| #593 / #612 / #613 / #516 | mixed | #593 no-authority-transfer dedupe (needs claim-support helper F4a first); #612 superseded once S3 lands; **#613 is an UNAPPLIED lineage migration — merging it applies nothing**; #516 deferred | — |

**Recommended order, one release per go-ahead:** #693 (its Vercel effect is immediate — warn JD) →
#694 → #667 (then #666) → #698 → #703 → **#701 last**. #701 must not be opted in until
`scripts/ops/leakcheck-probe-verify.ts --spend-2` PASSES with the real key in JD's own shell (it spends
exactly 2 lookups; the key must never be pasted into chat). Frontend PRs are independent — one at a time.

## 5. The release recipe, and every trap this session paid for

`merge → stamp → surgical mirror sync → verify:deploy gate → Lovable deploy message → /health proof key → record:deploy → ledger PR + push deploy/live`. Full text in `CLAUDE.md`; the traps are here:

1. **The stamp must merge while `main` still equals the marker commit.** No unrelated PR in between, or the gate reports a false `marker_offset_mismatch`. Stamp → sync → gate → deploy → ledger; hold everything else.
2. **Never type a SHA.** A hand-typed full SHA caused a 409 "Head branch was modified" on mirror PR #102 (the branch was untouched; the SHA was invented). Copy `expectedHeadSha` from `git rev-parse` or the PR payload.
3. **A stale worktree lies to `diff -rq`.** `release-main` was parked on an old branch and the first per-directory diff compared against it. `git checkout --detach origin/main` first, every time.
4. **Pre-deploy, `verify:deploy` says NOT VERIFIED with `marker_offset_mismatch` — expected.** The condition to read is `mirror tree -> equal` and `mirror pushed -> pushed`. It flips to VERIFIED by itself once `/health` moves.
5. **Re-check mirror drift immediately before the deploy message** (`git fetch` in the mirror clone; `git log origin/main`, not just `diff -rq`). Lovable's agent writes to the mirror and does not touch `build-info.ts`. Also `git fetch origin refs/heads/deploy/live:refs/heads/deploy/live` or the ledger axis is blind.
6. **Lovable `send_message` times out client-side at ~60 s.** Use `wait:false`, then `get_message`. A `deduplicated:true` reply means the first call registered — never resend blindly. The agent queued the request ~2 minutes before running it. If it pauses on a tool approval, show JD the request and ask; do **not** call `respond_to_approval` yourself.
7. **Poll `/health` politely.** It is public, runs bounded health sweeps per GET, and the frontend already polls it every 30 s per running tab. A background loop at ≥20 s, capped, is plenty.
8. **`record:deploy` commits the ledger row onto whatever branch you are on** and moves the local `deploy/live`. Branch first (`release/record-<sha>`), then `git push -u origin <branch> deploy/live`, then a ledger PR.
9. **CI's Frontend job lints and typechecks `supabase/functions/` too.** `npx eslint <file>` every new edge file. Edge files the frontend imports (`source-classification.ts`) must not touch the `Deno` global.
10. **One worktree per PR with a `node_modules` symlink** — a missing one makes `npx vitest` try to download vitest and fail confusingly. Never `npx tsc`; use `npm run typecheck`.
11. **Do not click Lovable's "Try to fix"** on mirror-only findings — it edits the mirror directly. Fix in canonical and sync.
12. **A kill-switch test is only a negative control if it reproduces the measured chain on the old shape.** Every edge PR here was checked by reverting its source and watching the new tests fail.

## 6. Corrections I made to my own claims (so you don't inherit the errors)

- The LeakCheck probe is **not** "free" — only the rejected-key path was ever observed; a valid key's answer and quota effect are unmeasured, and LeakCheck's docs are silent on whether errors cost quota (they are also wrong about the wrong-key status: 400 documented, 401 live). #701 therefore ships OFF.
- `minimax_correlate` **can** be tuned (output cap 1,500, input slice 16,000, no faster tier, 41/148 attempts skipped by guards); p50 24.2 s, p90 32.5 s over 30 days. How much each lever buys is **unmeasured**.
- A 10 s Wayback cap would turn most valid empties into timeouts, but n=14 and nothing has called it since Oct 1.
- **Recall-circular corroboration is still open:** `oathnet_lookup (recalled from memory)` classifies `breach` — the class follows the tool name, nothing ties a label to a call made this run. Needs lineage or value-provenance (E-D), which is evidence-ranking and needs JD's sign-off.
- #693 only catches a **trailing parenthetical** negative; `…: 0 hits` and `returned 404` shapes are not caught.
- The LeakCheck "cancels Oct 27" date came from Lovable's note and a screenshot — **unverified** against LeakCheck.

## 7. Decisions only JD can make (none taken)

1. **Which release next** — name the one PR (§4).
2. **Opsis:** the fallback-to-subscription toggle showed "Could not confirm the setting change"; until it is truly on, Opsis searches answer 402 (API credits are spent first). `scripts/ops/opsis-live-contract.ts` (free by default; reads `OPSIS_API_KEY` from his shell) shows the real state, or buy API credits. The tools are in the schema on the running build.
3. **Providers:** `deepfind_email_breach` (capability-disabled 2026-09-30, can never "recover" in `checks.credentials`) — renew or leave disabled; `reddit_user` (0 ok / 9×403 in 30 days, datacenter-IP block) — disable or keep; `nominatim_geocode` 403s are an IP-level block of the shared edge IP, not a header problem.
4. **Orchestrator fallback:** `gemini-direct` has never finished a run (0/16); MiniMax never appears as an orchestrator provider. Recharge Z.AI and pick a fallback I can prove with a tool-bearing request.
5. **Finalize timing:** `finalize_forced` ends 56.5% of runs; correlate is refused by the finalize window in 29% of attempts. Open the window later / schedule correlate before 90 s / a deterministic non-LLM clustering pass.
6. **E-D value provenance** and **chain-of-custody `evidence_log.artifact_id`** (NULL on all 13,329 rows; the RPC param exists, no schema needed) — both evidence-integrity, both need sign-off, no backfill without it.
7. **pg_cron / pg_net are not installed live**, so nothing schedules the health sweeps. Install through Lovable or poll health externally.
8. Optional: delete the ten blank "New investigation" rows (destructive; not needed for correctness).

## 8. Still not done (the honest list)

Run lease E5 + schema S2 (**not even drafted**) · lineage writer E6 · S3 durable request-bytes · F3a plumb server `status`/`reason_not_confirmed` into `AuthoritativeFinding` · F4a/F4b claim-support helper then #593 · F5 one outcome classifier + #688 real error text · `checks.credentials` should exclude capability-disabled/keyless tools and show last-event age · Opsis kill switch should also remove the schema · gemini_vision HTTP 400 is the **image-URL fetch**, not Gemini (unaddressed) · the 195 KB assistant message (payload-store decision, 09-20 §6) · apply `20260907000000` (synthesis unique index) before any `FINDING_SYNTHESIS_*` flag · **docs PR to refresh `CLAUDE.md`'s dated-state block, readiness formula, overlap status, baselines**.

## 9. Ordered plan for the next session

1. Orient (five minutes): `git fetch origin main`, `git fetch origin refs/heads/deploy/live:refs/heads/deploy/live`, `git fetch --unshallow --filter=blob:none`, `curl …/osint-agent?health=1` → expect `main` ≥ `2ba2842`, build `3ad2d2f`. If either moved, another session worked here — read the newest handoff and the ledger before acting.
2. Observe Releases 1–2 on a real scan (§1). Read-only.
3. Ask JD which single PR is next. Do the recipe (§5) for exactly that one, stopping on any anomaly.
4. Docs PR for `CLAUDE.md` (small, separate).
5. Only then: the queued small edge PRs (LeakCheck error text pass-through; `checks.credentials` exclusions; the "0 hits is a real finding" prompt line `system-prompt.ts:88`) — each test-first, one edge PR in flight.

A self check-in (`trig_01CCxCHY8g65bamUY8Fs2UUQ`, ~2026-10-07T00:06Z) was armed on the previous session for its own PRs. It can wake that session only; it must never merge, deploy or opt in anything.
