# Session handoff — Opsis search-side guard shipped, three edge drafts held (2026-10-23)

> Every number here is a dated measurement (2026-10-23 04:00 → 2026-10-24 02:00 UTC). Re-measure before relying on it.
> Measured by me unless marked **Unverified**. Nothing below changes a protected decision.

## 1. State at hand-off (read from the remotes 2026-10-24T01:59Z)

| Thing | Value |
|---|---|
| canonical `main` | `b7fadf3944a99a507626245a45e92d1e5661122c` (ledger PR #836) |
| live edge build (`/health`, read 2026-10-24T01:53:49Z) | `4c435f2` (committed 2026-10-23T18:43:56-07:00); `selected_model` glm-5.2 pinned on the deepseek slot; `checks.opsis_search_guard` ok; `reveal_breach_data` true; run lease `LEGACY`; 49 checks, **one not ok: `checks.minimax` = `{"ok":false,"reason":"timeout","role":"fallback"}`** (a provider ping in its fallback role; the deploy touched no provider code — **Unverified** whether transient) |
| marker / stamp | `4c435f2e` / `ed0b0707` (#835, parent == marker) |
| `deploy/live` | `4c435f2e` |
| mirror `seeker-spark-search-5362c57c` `main` | `9da069a` (#124); tree digest `17be976db2b9` == canonical; `diff -rq` empty for all four function dirs |
| last ledger row | marker `4c435f2`, stamp `ed0b070`, mirror equal + pushed, `deployed_bytes_verified: false` (always, on this path) |
| open edge drafts, all MERGEABLE/CLEAN after main moved | **#831** `386c56a3`, **#832** `e3696be4`, **#834** `72437b3c` (§4) |
| other open drafts | unchanged from the earlier 10-23 handoff §5 (13 drafts, #738 among them) |

## 2. What shipped this session

| PR | Merge | What |
|---|---|---|
| #833 | `4c435f2e` | edge: a paid `opsis_search` is only started when the run can read it (`lib/opsis-search-guard.ts`): same-selector refusal (this request's registry ∪ replayed history), cap of 2 un-read runs per thread, deadline rule (search 30s + collect 30s + completion 80s = 140s of the 180s budget → a collectable search starts within ~40s). Refusals are free, `skipped` at $0, never a provider failure, carry the pending run ids. Kill switch `OPSIS_SEARCH_GUARD_DISABLED`; proof key `checks.opsis_search_guard`. |
| #835 | `ed0b0707` | stamp `4c435f2` |
| #124 (mirror) | `9da069a` | surgical sync of 7 files, no deletions |
| #836 | `b7fadf39` | ledger: `4c435f2`, `deploy/live` moved |

Deploy proof: `/health` build moved `cdb13c1` → `4c435f2` with the proof key present (2026-10-24T01:53:49Z). The Lovable agent's reply (source SHA-256 `f0055d49…`) was noted, not relied on.

## 3. Measured on the brendanloza case (thread `0ea52455`, SELECT-only, 2026-10-23)

Lovable's audit of this case drove the session. What the data said, against its claims:

- **Case cost is NOT under-counted.** `runCostMicroUsd` is fed by tool charges (cache.ts) AND the per-step LLM meter (flat $0.30/M input, $1.20/M output for GLM; four buckets for Anthropic). That one accumulator is written to BOTH `threads.cost_micro_usd` ($6.86) and `orchestrator_invocations.credits_micro_usd` (sum $6.73). The "credits" column is tools + LLM, so adding the tool log ($3.74) to it double-counts; the LLM share is ≈ $2.99 ($0.14–0.20 per run). Lovable retracted its "$3.60 missing". **The GLM per-token constants are Unverified against Z.AI's list (including cached-input pricing) — separate PR.**
- **The 220k prompt budget is genuinely unmet** (Lovable right, my first read wrong): `initial_context_chars` is measured AFTER trimming and grew 45k → 346k over 16 runs. The un-trimmable floor is tool-call INPUTS: `record_artifacts` 117.7k chars (27 calls), `memory_save` 28.3k, `minimax_correlate` 16.5k, in 1.27M chars of stored messages. Fix shape, not built: summarize old tool-call inputs the way old outputs already are, keeping an object (Anthropic replay). Nothing in the finalize window.
- **Opsis waste:** 11 paid searches ($3.30, half the case), 4 read, 7 never read ($2.10). The finalize collect phase was live (`aae1152` deployed 2026-10-20T03:59Z) and by its own comment never affordable at the wall-clock trigger; 12/16 runs ended `finalize_forced`. Hence #833, search-side. Replay: deadline rule refuses 4/11 (all wasted, $1.20); the cap refuses `miniboss14` (wasted) and `imminiboss` (productive, delayed by a free read): **$1.50 of $2.10 prevented**.
- **Eight schema rejections, all uncharged, all under `aae1152`:** oathnet ×3 sent `{identifierType, value}`; socialfetch ×3 sent `{identifier}` only; google_dorks ×1 sent `{query}`; correlate ×1 sent `{artifacts: "<json>"}` with no seed; rapidapi ×1 a non-email `email`. → #834.
- **google_dorks `{query}`:** the `query→seed` rename DID run live. `applyInputCoercion` hands back the RAW input when the coerced value still fails validation; a person-name query gets no structural `kind`, so the SDK reported "seed undefined". Designed outcome, kept: `detectSeedServer` labels ANY few-word prose `person` ("look into this for me"), so mapping `person` → `name` would route prose into name dorks (`input_kind_inference_test.ts` pins "a name is not guessed from prose"). I widened it, measured, reverted.
- Also measured: crt.sh 502 counts toward the generic 3-consecutive-failure guard; Indicia timeouts already log `failed` not `empty`; `dork_harvest` is disabled deliberately; a blank thread must never be marked finished (I-1).

## 4. The three held drafts (JD: hold; one build each when shipped)

- **#831** `claude/memory-authority-rebase` `386c56a3` — #738 carried onto main as a `--no-ff` merge (main's E4 block kept; five new tests moved under `supabase/tests/`). **JD signed off 2026-10-23 04:43 PDT on both integrity items** (the widened `MEMORY_TOKEN_RE`; three kill switches + three proof keys in one build) and asked to keep it a draft. #738 stays open. Proof keys `checks.memory_authority`, `checks.history_label`, `checks.historical_memory`.
- **#832** `claude/analyst-authority-followup` `e3696be4` — #827 review follow-ups: `user_provided`/`analyst_provided` reserved (name-conflict anchor keys; 0 production rows, no writer exists); `record_evidence` strips model metadata; `checks.analyst_authority_boundary` detail is honest (pure probe, 11 reserved keys, wiring pinned in CI). Not changed, for JD: `name-conflict.ts:42` also trusts a `source` STRING of `user_provided`/`analyst_provided`/`analyst`.
- **#834** `claude/input-coercion-followups` `72437b3c` — OathNet accepts the Serus spelling; `minimax_correlate.seed` optional at the schema and resolved in execute (`lib/thread-seed.ts`: sent → person seed → first user message when STRUCTURAL kind; never `person`/`other`, never `triageState`), else the uncharged skip says what was tried; proof key `checks.correlate_seed_default`; google_dorks repro pinned. **One judgment call left to JD:** whether a person-name dork `query` should run (five lines in `DORK_KIND_FROM_SEED`, free tool only), at the cost that prose would run the name family.

Suggested ship order: #834, #832, #831 (JD's call).

## 5. Protected decisions (unchanged)

GLM-5.2 primary, Anthropic backup; `REVEAL_BREACH_DATA` ON; run lease off; synthesis off; `MAX_PAID_CALLS` bounded; no secret or flag changes; one edge PR per build; merges, deploys and Lovable messages only on JD's explicit go; never close a PR without JD.

## 6. Traps found this session

- **A refusal's error text must match `tool-outcome.ts` `SKIP_RE`**, or the `tool_usage_log` row logs `failed` and counts against the tool's health. My first guard commit had this defect; caught by Lovable's review check. Add the constant prefix to `SKIP_RE` and pin it with a captured-row test.
- **`detectSeedServer` returns `kind: "person"` for any few-word prose.** It is a word count, not a shape. Never treat `person` as structural (seed fallbacks, kind inference).
- **The schema cache is module-global** (`memoSchema`, one schema per tool name for every thread): a preprocess can never know the thread's seed. Thread-aware defaults resolve in execute.
- **`triageState` (guard.ts) is module state shared across threads on an isolate.** Never read it as "this thread's" anything.
- **`applyInputCoercion` returns the RAW input when the coerced value still fails validation**, so a rejection log can name a field the model never sent as missing. Read `sent_keys` before concluding a rename is broken.
- **`orchestrator_invocations.credits_micro_usd` is tools + LLM**, not LLM credits.
- **`gh pr checks --watch` in the background** is the polling-free way to wait on required checks; `send_message` to Lovable with `wait=false` then `get_message` avoids the 60s client timeout trap.
- **Stamp with `core.abbrev=7`** (`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.abbrev GIT_CONFIG_VALUE_0=7 node scripts/stamp-build.mjs`); verify:deploy before the stamp merges reports `marker_offset_mismatch` ×2 — expected; the hard gate is `mirror tree -> equal` + `mirror pushed`.

## 7. Opening prompt for the next session

> Read `CLAUDE.md`, `.claude/skills/edge-deploy/SKILL.md`, `tasks/lessons.md` and `SESSION_HANDOFF_2026-10-23_opsis-guard-ship-and-four-drafts.md`. Re-measure first: `git ls-remote origin refs/heads/main refs/heads/deploy/live`, `gh pr list --state open`, one `/health` read (build must be `4c435f2`; report whether `checks.minimax` still reads timeout). Then ask JD which held draft to ship (#834, #832 or #831) and ship ONE per build on the full cycle: ready → verify the head did not move → squash-merge → stamp with `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.abbrev GIT_CONFIG_VALUE_0=7 node scripts/stamp-build.mjs` on a branch off main while main is the marker, stamp PR merged while main is still the marker → surgical mirror sync of only the files `git diff --name-status <prev-marker> origin/main -- supabase/functions` lists (mirror clone `/Users/dizosint/seeker-spark-search-5362c57c`, PR + merge + pull) → `npm run verify:deploy -- --previous 4c435f2 --mirror /Users/dizosint/seeker-spark-search-5362c57c` must print `mirror tree -> equal` and `mirror pushed` → Lovable `send_message` to project `4ce11bc3-039d-4439-b293-acacca9e1e3a` (pull main, confirm `BUILD_MARKER`, `supabase--deploy_edge_functions` `["osint-agent"]`, AS-IS) with `wait=false`, then `get_message` → one `/health` read for the moved build and the PR's proof key → `npm run record:deploy -- --previous <prev> --mirror <clone>` on a branch, push `deploy/live`, ledger PR. Do not merge, deploy, change flags or secrets, or close any PR without JD's explicit go for that PR.
