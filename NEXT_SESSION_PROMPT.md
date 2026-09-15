# Next-session prompt — Insight Finder

> Paste this whole file as the opening message of a fresh session. It is self-contained.
> **Written 2026-09-14T17:05Z, CORRECTED 2026-09-15T00:20Z** — the first version merged stale. Every number is a dated measurement, not a state — re-verify.

---

## Start here — five minutes, before anything else

```bash
git fetch origin main && git log --oneline -5 origin/main
git fetch origin refs/heads/deploy/live:refs/heads/deploy/live   # a fresh clone lacks this ref
git fetch --unshallow --filter=blob:none                          # the clone is shallow at depth 50
curl -s "https://skzqwbyvmwqarfgfvyky.supabase.co/functions/v1/osint-agent?health=1"
```

**Expect `main` = `06328a9` or later and live edge build = `4bb19d9`.**

If either moved, another session has worked this repo — read the newest `SESSION_HANDOFF_*.md`
before anything else. That has now happened **six** times, and once produced two conflicting PRs
for one task (#548 / #551).

**Then run `list_pull_requests` and look at `draft`.** The merge queue — not the deploy — is this
project's documented bottleneck.

Read, in order:

1. **`SESSION_HANDOFF_2026-09-14_sweep-false-positives-and-the-memory-retrieval-gap.md`** — newest.
   §2 is the sweep bug that was manufacturing evidence, §4 the memory-retrieval gap, §5 the
   built-and-dark synthesis layer, §7 the ruling on Lovable's audit prompt, §8 the trap list,
   §9 the one open decision, §11 the ordered plan.
2. **`CLAUDE.md`** — authoritative on deploy topology and on decisions that must not be
   re-litigated.
3. `mem/index.md` — the memory index.

---

## Verified state — 2026-09-14T17:05Z

| Axis | Value |
|---|---|
| canonical `main` | `06328a9` |
| live edge build | `4bb19d9` (`ok: true`) |
| `deploy/live` | `4bb19d9` |
| mirror `main` | `898a3a3` |
| `diff -rq`, all 4 fn dirs | 0 differing paths |
| proof key for this build | `checks.tool_cache_version` = `username_sweep=v2, username_search=v2` |
| edge suite | **1879** passed / 0 failed / 6 ignored (moved by #597's glob fix, not new tests) |
| frontend suite | 2104/1/172 — **carried forward, not re-measured 2026-09-14** |
| Vercel production | on `main` |

**Nothing is undeployed.** The latest edge cycle shipped **#599 under stamp #600** at `4bb19d9`; the cycle before it shipped #592 + #594 together under stamp #595 at `0a04e1b`.

---

## What shipped 2026-09-13 → 09-14

- **#592** — a URL artifact could only join an identity cluster when its metadata happened to carry a
  `handle` key, so the strongest artifacts became isolated singletons. `foldWords` now folds URL path
  segments. Kill switch `CLUSTER_URL_HANDLE_TOKENS_DISABLED`.
- **#594** — six platforms (HackerRank, Mixcloud, Spotify, Telegram, Trakt, NameMC) answer 2xx for
  any string and echo it back, so the generic echo test proved a registration for **every username
  ever swept**. New `echoUnsafe` marker. Live probe: 6 offenders before, 0 after.
- **#595** — build marker `c87c07b` → `0a04e1b`. `ff6ad26` recorded the ledger.
- **#597** — `test:edge` ran only the osint-agent top level, so five test files had never executed.
  All 34 pass. Baseline 1845 → **1879** — coverage moved, not new tests.
- **#598** — Scope & controls removed from the composer; it enforced nothing and polluted the seed.
- **#599 + #600 stamp** — versioned the `username_sweep` cache key; marker `0a04e1b` → **`4bb19d9`**,
  `f20d71e` recorded the ledger. Proof key: **`checks.tool_cache_version`**.

⚠️ #592/#594 added no new `/health` key, which is why #599's `checks.tool_cache_version` is the
proof key for the CURRENT build. Read that key, not the marker alone.

---

## ⛔ Read this before re-running any verification scan

**A deployed fix to how a tool INTERPRETS a result is invisible while the cache can replay a
pre-fix row.** Measured 2026-09-14: #594 went live at ~16:30Z and a **17:19Z re-scan still
narrated "3 confirmed hits (Mixcloud, Telegram, HackerRank)"** — `tool_usage_log.cached` was true,
replaying a 13:44Z row. The fix was live and correct; the cache made it look like the deploy had
failed. #599 closed this with `lib/tool-cache-version.ts`, which folds a per-tool
result-interpretation version into both cache hashes. **Bump that version in the same PR as any
future tool-behaviour fix**, or your own verification will lie to you.

## First thing to check — did the deploy actually change the product?

Re-run seed **`kaileyhxo`** (username), which is now a clean test because the cache key is
versioned. Measured before the fix, from JD's own export:

| Handle | Claimed | Actually real |
|---|---|---|
| `kaileyhxo` | 3 platform registrations | **0** — all three fabricated |
| `kaileymhart` | 3 platform registrations | **1** (SoundCloud only) |

On `4bb19d9` (the fix plus #599's versioned cache key), `kaileyhxo` should report **0 registrations** with HackerRank, Mixcloud and Telegram
demoted to unverified leads. If it still reports 3, the deploy did not take — check `/health` `build`
before touching any code.

---

## ⛔ The one decision blocking the next PR

Make an analyst **"false" mark suppress a platform globally** for the account instead of per-thread.
Ask JD, and do not guess:

> **Does a single "false" mark suppress that platform for your account, or does it take N marks
> across N separate cases before it sticks?**

Context he gave, verbatim: *"I have explained over 100 times and mark false… and it still calls
hacker rank… 200+ scans deep with 0 actionable pivots… that's the whole memory / improvement system
I want."* He is right, and §3 of the handoff shows it could never have worked: the detector was wrong
by construction, `sweeper.ts` takes **no suppression input at all**, and rejection keys are
per-thread. Twelve lessons about HackerRank already sit in `agent_memory` with no lever to act on.

---

## Then, in order

2. **Verify migration `20260907000000` against the live DB** — `artifacts_synthesis_cluster_uniq`.
   Ops via Lovable, not a PR. `supabase/migrations/` is intent, not mechanism; the live ledger tops
   out at `20260825024640`. **Hard prerequisite** before any synthesis flag.
3. **`FINDING_SYNTHESIS_DRY_RUN` + forward path on** — measure distribution, write nothing.
4. Flip dry-run off once it looks right. Backfill (175 closed cases) is a **separate, later** call.
5. **Tool-lesson recall axis** — `memory_recall` matches on `subject` only, so 101 tool-reliability
   lessons are filed under case-specific selectors and are unretrievable forever. Key tool lessons by
   tool name and recall them every run.
6. ~~Fix the `test:edge` glob~~ — **DONE, #597.** Five files had never run; all 34 passed.
7. ~~Scope & controls~~ — **DONE, #598**, removed entirely. Frontend channel still has the
   readiness denominator (`reportSafe / TOTAL`, which punishes collection).

---

## Do NOT rebuild these — they exist

| Thing | Status |
|---|---|
| **finding synthesis** | complete, deployed, **three flags all OFF**. 9,615 artifacts / 181 threads / **13 finding rows lifetime**. Runs in the health sweep, structurally outside the finalize window |
| `SweepSite.confirm` | the documented fix lever, unreachable until #594 — populating it needs a **known-real profile** per platform |
| `shouldAllowToolCall` (`runtime-policy.ts:556`) | complete, tested, **unreferenced** |
| `circuit.applyBaselineDisables()` | explicitly empty hook, already called once per thread |
| `tool-routing-policy.ts` | 100% dead code |
| Evidence board "Leads drawer" | already shipped (#543) |

---

## Traps that cost time this session

- ~~**`lib/*_test.ts` has NEVER run in CI.**~~ **CLOSED by #597.** `test:edge` now passes
  DIRECTORIES (`. ../evidence-export`) so Deno discovers recursively. Five files had never run,
  including `lib/cluster_test.ts`; all 34 passed. Put new edge tests wherever they belong — the old
  "put them at the top level" advice is retired, and do not restore the glob.
- **A deployed tool-behaviour fix can be invisible behind `tool_call_cache`** — see the section
  above. Bump `lib/tool-cache-version.ts` in the same PR.
- **`promoteConfidence`'s corroboration branch is a no-op.** `Math.max(c, Math.min(75, c)) === c`.
  It can only cap, never promote. Confirmed across 64 production rows. Evidence-ranking — needs JD's
  sign-off, not a drive-by.
- **Report readiness is `reportSafe / TOTAL artifacts`**, denominator includes rows that can never be
  report-safe. **Collecting more evidence lowers the score.**
- **`marker_offset_mismatch` during a deploy is EXPECTED.** Read `mirror tree -> equal` and nothing
  else at that moment.
- **Lovable's `send_message` MCP call times out at 60s** regardless of `timeout_seconds`. The message
  still lands. **Check `list_messages` before re-sending** — a second send supersedes and could
  double-deploy.
- **A 403 is not a dead credential.** `reddit_user` 403s on datacenter IPs, permanently.

---

## Carried forward — JD's, not the agent's

1. ~~**`GITHUB_API_TOKEN`**~~ — ✅ **RECOVERED.** `checks.credentials` now lists
   `github_code_search` under `recovered`, not `refusing`. JD's fix took. Remaining refusals:
   `deepfind_email_breach`, `reddit_user`, `deepfind_disposable_email`,
   `deepfind_telegram_channel` — and a 403 is not a dead credential.
2. **Lovable connector** on the Sept 20 A2b Routine — it stores no connectors, so the
   per-investigation budget measurement cannot run.
3. **Mirror PR #41** — open, unmerged, Lovable-authored, touches `index.ts` and `tool-registry.ts`,
   does **not** touch `build-info.ts`. **Backport into canonical; never merge on the mirror.**

---

## Integrity items needing sign-off before anyone touches them

- **Minor-safety redaction did not fire.** The `@wopdell` case printed a plaintext password and its
  SHA-256 from a `com.roblox.client` stealer log while the report claimed minor-related records stay
  redacted.
- **Fabricated URLs persisted as evidence.** Three `gemini_deep_dork` YouTube URLs with impossible
  video IDs at confidence 55. `auto-persist-findings.ts:254` validates URL **shape** only.
- **`promoteConfidence`** (above).
