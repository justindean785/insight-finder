# Session handoff — 2026-09-14
## Sweep false positives, the URL-handle clustering gap, and why 200 scans taught the agent nothing

> Every number here is a **dated measurement**, not a state. Re-verify before acting.
> Written 2026-09-14T17:05Z.

---

## 1. Verified state at close

| Axis | Value | How verified |
|---|---|---|
| canonical `main` | **`ff6ad26`** | `git log origin/main` |
| live edge build | **`0a04e1b`** | `/health` |
| `deploy/live` ref | `0a04e1b` | pushed |
| mirror `main` | `5f01506` | `git rev-parse origin/main` in mirror clone |
| `diff -rq`, all 4 fn dirs | **0 differing paths** | run per-dir |
| `verify:deploy` | **VERIFIED**, `mirror tree -> equal` (`422991e39c8b`) | `npm run record:deploy` |
| edge suite | **1845 passed / 0 failed / 6 ignored** | `npm run test:edge`, the exact CI command |
| frontend suite | 2104/1/172 — **carried forward, NOT re-measured this session** | — |
| open PRs of mine | zero | — |

Shipped this session, in order: **#592** (URL path-segment handle join) → **#594** (six platforms
proving registrations that cannot exist) → **#595** (stamp `c87c07b` → `0a04e1b`) → `ff6ad26`
(ledger). One deploy cycle covered #592 and #594 together.

⚠️ **This build introduced NO new `/health` key.** The three prior deploys each added one as
behavioural proof (`checks.synthesis` → `checks.rejected_cluster_sweep` → `checks.credentials`).
This one's durable signal is `singleton_count` on the `clustering_applied` log line — per-thread,
edge-logs only. So the proof here is the moved marker plus `verify:deploy`, which is **weaker than
the last three deploys**. The real behavioural confirmation is the next scan (see §6).

---

## 2. The finding that matters most — the sweep was manufacturing evidence

`accountIsProven` (`sweeper.ts`) falls back to a **generic handle-echo test**: if the fetched page
repeats the requested handle in a high-signal region (`<title>`, `og:` meta, canonical), that counts
as proof of registration.

**Six platforms answer 2xx for any string AND echo that string back**, so they proved a registration
for every username ever swept. Measured by replaying the module's own decision chain against two
different guaranteed-nonexistent handles:

| Platform | Reproduced |
|---|---|
| HackerRank, Mixcloud, Spotify, Telegram, Trakt | both runs |
| Minecraft (NameMC) | one run; errored (no signal) on the second |

**Production cost, from the live DB: 309 HackerRank artifacts across 114 threads.**

Two scans JD supplied, broken down exactly:

| Handle | Claimed | Real | Fabricated |
|---|---|---|---|
| `kaileymhart` | 3 registrations | **1** (SoundCloud) | t.me, hackerrank |
| `kaileyhxo` | 3 registrations | **0** | mixcloud, t.me, hackerrank |
| `wopdell` | 5 registrations | 3 | mixcloud, hackerrank |
| `thewopniqqa` | 3 registrations | 1 | t.me, hackerrank |

**This is the same bug class as the 2026-08-06 one already pinned in `sweeper_evidence_test.ts`'s
own header** — which even says *"the same platform set had already been marked FALSE by the analyst
on an earlier case."* That fix stopped HTTP **status** alone from proving registration. The **echo**
path survived it. JD has now reported this twice, five weeks apart.

**The fix (#594):** an `echoUnsafe` marker means echo carries no information there, so the site
reports `unverified` instead of a counted hit. Checked AFTER `confirm`, so a measured marker still
promotes a site back. The row stays in the sweep output as a lead — it stops being evidence.
Live probe against the fix: **6 offenders before, 0 after.**

### Why `confirm` and not `echoUnsafe` would have been wrong
`SweepSite.confirm` was **built and 100% unused** — its own comment says *"no site in the table
configures `confirm` yet, so it is unreachable through `sweepUsername`."* It is the documented fix
lever, but populating it honestly requires measuring a **known-real profile** on each platform. The
**negative** is what was actually measured, so the negative is what is encoded. `confirm` stays the
upgrade path and is now reachable for the first time.

---

## 3. Why teaching it never worked — three independent breaks

JD's complaint, verbatim: *"I have explained over 100 times and mark false… and it still calls
hacker rank… 200+ scans deep… that's the whole memory / improvement system I want."*

He is right, and it could never have worked. Measured:

1. **The detector was wrong by construction** (§2). No amount of teaching fixes a 200-for-everything
   endpoint.
2. **`sweeper.ts` takes NO suppression input.** `grep` for one returns nothing — the platform list is
   a hardcoded array compiled into the function. There is no parameter by which a lesson, a
   rejection, or an analyst "false" mark could remove a platform.
3. **Rejection keys are per-thread.** A "false" mark in one case is invisible to the next.

And the system *did* learn: **12 lessons about HackerRank** sit in `agent_memory`. It recorded the
lesson twelve times and had no lever to act on it once.

---

## 4. ⛔ The memory layer IS learning — the RETRIEVAL is what's broken

Measured against the live DB:

| | |
|---|---|
| `agent_memory` rows | **1,395**, back to 2026-05-27 |
| of which `kind='lesson'` | **517** |
| lessons about tool reliability | **246** |
| …of those, filed under a **case-specific** subject | **101** |

Real examples of what it captured:

> *"rapidapi_breach_search returned 0 hits for this email while breach_check (leakcheck) returned 21
> hits and oathnet/serus returned extensive data"* — filed under `caseypritchard1@gmail.com`
> *"Instagram profile could not be scraped (HTTP 451 block + SocialFetch not_found)"* — filed under
> `baig_azhar`

**`memory_recall` matches on `subject` only** (`tool-registry.ts:5707`, `.or(agentMemoryOrFilter(subj))`).
So a lesson about a **tool** is filed under the **selector it was learned on** and can only surface
by recalling that exact email again — which never happens.

**Fix shape (not built):** a second recall axis. Tool lessons get subject-keyed by tool name
(`tool:rapidapi_breach_search`) and every run recalls the tool-lesson set regardless of seed. That
turns recall from noise into the thing JD actually asked for.

**Do NOT conflate this with §2.** A detector that is wrong by construction is a code defect and must
be fixed in code; memory should carry genuinely case-specific knowledge. Conflating them is why this
has felt broken from both ends.

---

## 5. ⛔ BUILT AND DARK — finding synthesis (do not rebuild it)

`finding-synthesis.ts` + `finding-synthesis-sweep.ts` + `lib/finding-row.ts` are **complete,
deployed, and switched off**. Flags, all defaulting OFF:

```
FINDING_SYNTHESIS_ENABLED           forward path
FINDING_SYNTHESIS_BACKFILL_ENABLED  175 closed threads
FINDING_SYNTHESIS_DRY_RUN           compute + report, write nothing
```

That is why `/health` reads `checks.synthesis: {ok: true, detail: "disabled"}`.

Its own header carries the production measurement: **9,615 artifacts across 181 threads and 13
`kind='finding'` rows in the product's lifetime**, last written 2026-08-17. 175 of 181 threads never
produced a conclusion. Cause: `workflow_prompt.ts:34` makes `record_finding` **advisory** ("may
run"), and the model almost never does — the `@wopdell` run made 87 tool calls and **zero**
`record_finding` calls.

It runs in the **health sweep — a separate request from any run** — so it is structurally incapable
of failing finalize. Lovable's audit prompt (R1) asked for partial-report persistence *inside the
finalize window*, which is the one place CLAUDE.md and `INCIDENT_2026-07-26` forbid. **Reject that
mechanism; the capability already exists outside it.**

**Hard prerequisite before any synthesis flag flips:** migration `20260907000000`
(`artifacts_synthesis_cluster_uniq`) must be confirmed applied **against the live DB**.
`supabase/migrations/` is intent, not mechanism — the live ledger tops out at `20260825024640`. The
sweep is an unlocked read-then-write fired by pg_cron every 60s; without that index, overlapping
sweeps race.

**Sequencing that matters:** synthesis needs ≥2 **independent** source classes per cluster and
discounts `ai_summary`, `web_search`, `username_sweep`, `social_profile_passive`. Before #592, the
strongest artifacts were isolated singletons, so flipping synthesis on would have yielded almost
nothing. #592 is the prerequisite; it is now live.

---

## 6. How to confirm this deploy actually changed the product

This build has no new `/health` key, so the behavioural check is a scan:

**Re-run seed `kaileyhxo` (username).** Before: 3 platform registrations, all fabricated.
After: it should report **0**, with HackerRank, Mixcloud and Telegram demoted to unverified leads.
`kaileymhart` should report **1** (SoundCloud only).

Also watch `singleton_count` on the `clustering_applied` log line — on the `@wopdell` artifact set
it moved 35 → 27 with largest subject 25 → 33.

---

## 7. Ruling on Lovable's 2026-09-13 audit prompt (R1–R5)

Its measurement is sound; its prescription is mostly aimed at the wrong mechanism.

| | Verdict |
|---|---|
| **R1** partial report inside finalize | **Reject the mechanism.** Forbidden window; §5 capability already exists outside it. And "Run ended without a report" is invariant **I-2 working correctly** — the run genuinely wrote no report-shaped message. Lovable read an honest label as a defect. |
| **R2** tiered context, cap 80k | **Take the intent, the number is wrong.** Those 44k→518k figures come from `approxPromptChars` (`telemetry.ts:175,223`) — the meter that omits the workflow addendum, `analystDecisionsBlock` (0→~30k), per-step directives and every tool schema. 518k is a **floor**. Give `prompt_size_step` a durable home first. Do not "fix" `approxPromptChars` — it routes providers. |
| **R3** bind feedback to adjudication | **Misdiagnosed.** Nothing to bind to — zero `record_finding` calls. Also `intel.ts` defines analyst-confirm as ATTESTED, *"a decision, not a second source"*; making a click mint an authoritative finding converts opinion into evidence. Needs sign-off. |
| **R4** credential circuit-breaker | **Mostly already built.** `circuit.applyBaselineDisables()` is an empty hook already called per thread; `shouldAllowToolCall` (`runtime-policy.ts:556`) is complete and unreferenced. But a 403 is not a dead credential — `reddit_user` 403s on datacenter IPs, permanently. `github_code_search` is a real 401 whose fix is the **secret**, which R4's own "do not change secrets" forbids. |
| **R5** enable cache sweep | **Premise wrong.** 98.9% expired is not why the hit rate is low. Measure **key-miss vs expiry** first — L2 is keyed on full-param `input_hash`. |

---

## 8. Trap list — instruments and claims that lied this session

- **I overstated the sweep mechanism once and had to correct it.** I first said the `absent: 404`
  rule marks HackerRank "found". Wrong: a 2xx is explicitly *not* treated as proof, and a failing
  `absent` only makes it an unverified lead. The real mechanism is the **echo fallback**. Read
  `sweeper.ts:420-490` before describing this to anyone.
- **`lib/*_test.ts` has NEVER run in CI.** `test:edge` globs `*_test.ts` at the osint-agent top level
  only. `lib/cluster_test.ts` — the C-1 acceptance suite whose entire job is guarding against false
  identity merges (the Hamza Shakoor case) — is executed by **no automated gate**. New tests were put
  at the top level so they actually run; the C-1 suite was run by hand (10 passed). **Fixing the glob
  is its own small PR and may surface failures invisible for months.**
- **`promoteConfidence`'s corroboration branch is a mathematical no-op.**
  `Math.max(c, Math.min(75, c)) === c` for all `c`. `lib/cluster.ts` advertises confidence promotion
  and can only ever *cap* (contradicted → 40) or jump to 90 on a verified self-admission. Confirmed
  across 64 production rows: not one was promoted upward. **Either the expression is wrong or the
  comment is — evidence-ranking, so it needs JD's sign-off.** Not touched.
- **Report readiness is `reportSafe / TOTAL artifacts`** (`confidence-dimensions.ts:196-201`), and the
  denominator includes `weak_lead`, `excluded_collision`, avatar placeholders and engine notes that
  can never be report-safe. **Collecting more evidence lowers the score.** 7/64 = 11% on `@wopdell`;
  2% on the `kailey hart` run.
- **`marker_offset_mismatch` during a deploy is EXPECTED** — live reports the old marker while the
  newest stamp names the new one. The only condition to read at that moment is `mirror tree -> equal`.
  It flipped to VERIFIED on its own once `/health` moved, exactly as CLAUDE.md says.
- **A fresh sandbox has not fetched `deploy/live`** — confirmed necessary again today.
- **Lovable's `send_message` MCP call timed out at 60s** despite `timeout_seconds: 600`. The message
  was delivered and the deploy ran. **Do not re-send on that timeout** — check `list_messages` first;
  a second send supersedes the pause and could double-deploy.

---

## 9. Open decision — blocks the next PR

**The learning lever.** Make an analyst "false" mark suppress a platform **globally** for the account
instead of per-thread. One question, unanswered:

> Does a **single** "false" mark suppress that platform for JD's account, or does it take **N marks
> across N separate cases** before it sticks?

Everything else about that PR is specified: it needs a durable, account-scoped suppression the sweep
reads, replacing the per-thread rejection key, and `sweeper.ts` needs a suppression input it has
never had.

---

## 10. Carried forward, not done

1. **`GITHUB_API_TOKEN` in Supabase function settings** (JD's). `/health` still shows
   `github_code_search` 3× refusing. No deploy fixes it. Note `checks.credentials` now adds
   *"window truncated by row cap — counts are a floor."*
2. **Mirror PR #41** — still open, unmerged, Lovable-authored, touches `index.ts` and
   `tool-registry.ts`, does **not** touch `build-info.ts`. **Backport into canonical; never merge it
   on the mirror.** Verified still open at close.
3. **Lovable connector on the Sept 20 A2b Routine** (JD's) — it stores no connectors, so the
   per-investigation budget measurement cannot run without it.
4. **Scope & controls** — advisory only by its own header (*"the endpoint accepts `{messages,
   threadId}` and nothing else"*) and it **pollutes the case record**: `— Scope & controls (analyst
   instructions) —` is concatenated into the stored seed and then truncated into the Timeline and
   Activity Log. Seen in both the `@wopdell` and `kailey hart` exports. JD dislikes it. Open
   question: remove entirely, or keep and stop appending to the seed.
5. **Memory-recall toggle** — no UI switch because `system-prompt.ts:142` mandates it on the first
   turn. It is budget-exempt and rate-limited (2/30s), so the cost is latency and context, not spend.
6. **Fabricated URLs from `gemini_deep_dork`** — three YouTube URLs with impossible video IDs
   persisted at confidence 55 in the `@wopdell` case (`?v=GripBall_wopdell`, 16 chars; IDs are 11).
   `auto-persist-findings.ts:254` validates URL **shape** only. A Spotify URL was also built from an
   iHeart artist ID and the failure recorded as a platform limitation.
7. **Minor-safety redaction did not fire.** The `@wopdell` case printed `keir2011` and its SHA-256 in
   full from a `com.roblox.client` stealer log, while the report claims *"Records flagged
   minor-related stay redacted and are never shown."* If 2011 is a birth year the account holder is
   ~14–15. **Integrity-critical; needs sign-off, not a drive-by.**

---

## 11. Ordered plan for the next session

1. **Answer §9**, then ship the global platform-suppression PR (edge, kill switch, new `/health` key).
2. **Verify migration `20260907000000` against the live DB** (§5). Ops via Lovable, not a PR.
3. **`FINDING_SYNTHESIS_DRY_RUN` + forward on** — measure distribution, write nothing. Read
   `checks.synthesis` detail.
4. Flip dry-run off once distribution looks right. **Backfill is a separate, later decision** — it
   writes into 175 closed cases.
5. **Tool-lesson recall axis** (§4) — edge, self-contained.
6. **Fix the `test:edge` glob** so `lib/*_test.ts` runs (§8). Expect surprises.
7. Frontend, parallel channel: readiness denominator excludes non-claim kinds; Scope & controls (§10.4).

Rules that still bind: one PR = one behaviour change + tests + kill switch · never mix frontend and
edge · at most one edge PR in flight · every behaviour-changing edge PR adds a new `/health` key or
durable log event · docs ride separately · run `npm run test:e2e` by hand for anything touching `src/`.
