# Session handoff — 2026-09-24
## Namesake leakage closed on two surfaces, an edge deploy left in flight, and three layers of broken logic

> Every number here is a **dated measurement**, not a state. Re-verify before acting.
> Written 2026-09-24T03:00Z, covering the session of 2026-09-23 → 24.
> Case identifiers are sanitized: the cases are described by shape, never by subject.

---

## 1. State at close — READ THIS FIRST, the edge deploy is UNVERIFIED

| Axis | Value | How verified |
|---|---|---|
| canonical `main` | **`360c661`** (#622 stamp) | `git log origin/main` |
| `BUILD_MARKER` on `main` | **`ca3aeae`** (#621 squash) | `build-info.ts` |
| mirror `main` | **`ba8a90c`** (mirror PR #85) | `git log` in the mirror clone |
| `verify:deploy` before the deploy message | **`mirror tree -> equal` (`2c58e5dfe7be`)** | run at ~23:37Z |
| Lovable deploy message | **accepted 23:37Z, reply NEVER READ** | `list_messages` |
| live `/health` build | **NOT CHECKED** — last known `325daad` | — |
| `deploy/live` ref / ledger | **still `325daad`, not recorded** | — |
| Vercel production for #620 | **NOT verified on the alias** | — |

⚠️ **The edge deploy of #621 is in flight, not done.** Nothing proves it landed. To finish it:

1. `curl …/osint-agent?health=1`. The build must read **`ca3aeae`**, and the payload must contain the new
   proof key **`checks.record_name_quarantine`** = `{ok: true, "record_artifacts inherits active person-name quarantine"}`.
2. If it still reads `325daad`: read the Lovable reply (`get_message` on
   `main:user#00000000001669#usr:TENG67PB`) **before** resending anything. Re-run the hard gate
   first, because the mirror may have drifted since.
3. Once the build has moved: `git fetch origin refs/heads/deploy/live:refs/heads/deploy/live`, then
   `npm run record:deploy -- --previous 325daad --mirror <clone>`, then `git push origin HEAD deploy/live`.
   Ledger and `deploy/live` updates ride as their own docs change.
4. Frontend proof for #620 is the live alias, not a PR preview. It has no new CSS key, so check
   the Report tab of a case with a rejected namesake: that row must no longer drive the Subject Profile.

⚠️ `marker_offset_mismatch` in the gate output at 23:37Z was **expected**. Live still reported
the old marker. It flips to VERIFIED on its own once `/health` moves.

### What merged this session (all squash, commit messages rewritten to drop case identifiers)

| PR | Commit | Channel | What it does |
|---|---|---|---|
| **#620** | `c25b787` | frontend (live on merge) | Subject-authority gate (`isSubjectAuthorityEligible`) on every subject-derived report surface, Hunter's Note and `computeRisk`; `isNullResultValue`; guardrail sources named by value, not UUID, with minor-flagged rows redacted |
| **#621** | `ca3aeae` | **edge (NOT live until verified)** | `record_artifacts` / `record_artifact` inherit an active person-name quarantine (`lib/record-name-quarantine.ts`). Kill switch `RECORD_NAME_QUARANTINE_DISABLED`. Proof key `checks.record_name_quarantine` |
| **#622** | `360c661` | stamp | `BUILD_MARKER = ca3aeae`, parent is the marker |
| mirror **#85** | `ba8a90c` | mirror sync | 6 files: `build-info.ts`, `health-handler.ts`, `index.ts`, `lib/record-name-quarantine.ts`, `record_name_quarantine_test.ts`, `tool-registry.ts` |

### Open PR

| PR | Head | Channel | State |
|---|---|---|---|
| **#623** | `a36358e` | frontend | **draft**, green, clean. Stale-chunk reload: a tab that outlived a deploy reloads once instead of hitting the error boundary (`src/lib/stale-chunk-reload.ts`, loop-guarded by a 30s `sessionStorage` window). Waiting on JD. |

### Baselines (re-measure before crediting a diff)

| Suite | Figure | Where |
|---|---|---|
| frontend | **2199 / 1 skipped / 182 files** | `main` (#620 head, identical tree) |
| frontend + #623 | 2207 / 1 / 183 | #623 branch |
| edge | **1914 / 0 / 6 ignored** | #621 head (edge tree identical to `main` apart from the stamp) |
| e2e | **51 / 2 skipped** | unchanged |
| `deno check index.ts` | 24 errors, all pre-existing | #621 head |

`CLAUDE.md`'s dated-state block still says `main` = `3b905b4`, live `325daad`. It is stale. Correct
it only **after** `/health` verifies. Do not write "deployed" into it on the strength of this handoff.

---

## 2. What was fixed, and the one edge case #621 cannot catch

**The hole (a username-seed case, 2026-09-23):** a name-only breach lookup was correctly
quarantined. The model then web-searched the same name and wrote four strangers in through
`record_artifacts` at 70–85, none of them quarantined. The report then published a namesake's
name, handle and 85% "analyst confidence" as the subject's.

- #620 closes the **report** side: every subject surface now applies the same exclusions as
  `pickBestIdentity`.
- #621 closes the **write** side: the rows inherit the quarantine.

**Known limit, disclosed in #621:** a same-name row recorded in the *same parallel step* as the
lookup that creates the quarantine cannot be caught, because the quarantine does not exist yet.

**⚠️ New, unverified risk — check this before trusting #621 on a two-seed thread.**
`quarantineSeed()` exempts a name the **person seed** links. In the 2026-09-24 producer-handle
case, the analyst added a *second* message containing a bare name as a **hypothesis** ("is this
the handle's real name?"). If that becomes `subjectSeedName`, the hypothesis name is exempt from
quarantine, which is backwards. Read `index.ts` around `subjectSeedName` to see which message it
derives from.

---

## 3. The three logic layers — measured on the 2026-09-24 export, not yet fixed

JD's verdict on that case: *"logic is all messed up."* That verdict is correct, and the fault is
not only the model's. It sits in three layers, and fixing one does not fix the others.

### 3a. Engine — `supabase/functions/osint-agent/lib/cluster.ts` (edge, evidence ranking ⇒ needs JD sign-off)

1. **`needs_review` is read as a contradiction.** `cluster.ts:228`:
   `/"status"\s*:\s*"needs_review"/i.test(a.metaRaw)` makes `isContradictionArtifact` true. The
   model writes `status: needs_review` on every unverified row, so every sweep-only hit of the seed
   handle is (a) excluded from union-find (`:406`) and (b) capped at 40 (`:458`). Measured: Snapchat,
   Threads, Roblox, Twitch, X, Reddit, TikTok, Pinterest, and the handle's own Instagram, all
   `promoted_confidence: 40`, all severed from the seed.
2. **Cluster ID is a hash of the selector SET, not of the joined component.** `:441`
   `clus_${stableHash(selectors.join("|"))}`. Verified by computing `stableHash("handle:<seed handle>")`: it equals the cluster ID all those rows share.
   Twenty contradicted singletons that each carry that one token get the same one shared cluster ID
   without ever being unioned. Every consumer that groups by `cluster_id` renders a fake cluster.
   Rows with no strong token hash `root${index}`, which is where the sequential
   `clus_104caef9…104caf02` IDs come from: each is a separate singleton.
3. **The displayed confidence is not the engine's.** The `confidence` column keeps the model's
   number (source-class capped). The engine's number exists only in `metadata.promoted_confidence`,
   and the report reads the column. Measured: sweep rows shown 45 against engine 40; one Instagram
   row 60 against 40; the MusicBrainz correction 75 against 40.
4. **Source-class caps are inverted.** A server-side platform fetch of a live profile
   (`social_profile_passive`, id + followers + bio) is capped at **40**. A Linktree *mention* of the
   same URL (`independent_public` via Jina) is capped at **75**.
5. **Links the model already wrote down are ignored.** The linker reads only
   `associated_handle / seed_association / instagram / handle / github` (`:299`). The export has
   `parenthetical: "instagram display name for @<handle>"`, `parenthetical: "snapchat display name
   for <handle>"`, and a Linktree `bio` naming the replacement handle. All three produced unlinked
   singleton clusters.
6. **A correction never retires its target.** The model records a `kind: contradiction` row with
   free-text `correction_of`. Nothing resolves that back to the corrected row, so the false
   "linked to BOTH" row stayed at 55 in the **seed** cluster while the correction sat in the stray
   group. A server-side "rescored to 0" was *narrated* and never written.
7. **Duplicate accounts are not merged or conflict-checked.** Seven accounts each appear twice (sweep URL
   plus PDF prose row), in different clusters. One pair carries conflicting join dates
   (`2023-02-02` against `2023-02-03`) and conflicting last-seen, and nothing flags it.

### 3b. Narration against persistence (edge / report layer)

The report prose asserts state the store does not hold. The footer already admits it: *"No
authoritative finding rows were recorded."*
- Confidences are narrated as "Confirmed (85)" but stored at 50. "Likely (90)" is stored at 40.
- "Clean across three independent corpora": the activity log shows `breach_check` **failed** in
  every cycle, and the Health tab shows no successful `breach_check` call. The row
  "no breach hits" still cites `breach_check` as a source.
- "Corroborated by Qobuz and Shazam": neither page was fetched. Both came from one
  `minimax_web_search` summary.

This is the `CLAUDE.md` "report layer bypasses the integrity engine" problem, reproduced. The fix
shape there (`{{FINDINGS_TABLE}}` expanded server-side from persisted rows) still stands.

### 3c. Pivot suggestions — `src/lib/recommended-pivots.ts` (frontend, small, no sign-off needed)

- **An Apple Music track ID became a high-priority phone pivot:** "Check phone association
  1802285951". `extractTarget` tries `PHONE_RE` against a bare 10-digit number (the track ID from
  `music.apple.com/za/song/…/1802285951`), and `priorityForRecommendation` rates phones `high`.
  The fix is to require phone formatting or a `phone`-led label, and never extract from inside a URL.
  **This is the cheapest correct fix on the list.**

### 3d. The finalize window starves the decisive call

It happened in 4 of the 5 cycles on that thread. The highest-value remaining call was skipped
every time: website/SoundCloud/BeatStars scrapes, the correlation pass, the breach check on the
newly found email, and finally the one query that answers the analyst's question (name + handle).
This is **termination territory**. Read `CLAUDE.md`'s oscillation history before touching it. It
is recorded here as measured, **not** as a fix to make.

---

## 4. Settled this session — do not re-litigate

- **The agent MAY pivot on passwords.** JD, explicitly: *"it can pivot on passwords"*. Password
  reuse is legitimate tradecraft and fits the settled `REVEAL_BREACH_DATA` posture. What stays open
  is narrower and is about LABELLING, not pivoting:
  - A password-derived string (a word lifted out of a leaked password) was recorded as a person's
    **name**.
  - A password pivot was sent to OathNet as a **username** search, which answers a different
    question.
  - The HIBP k-anonymity count (how often the string appears in breach data, for anyone) was
    labelled "[CONFIRMED] in 28 breach corpora", as if it were about the subject.
- **The Breach Exposure table stays ungated**. It is an evidence table, and the claims built on it
  are gated (#620).
- **Guardrail messages keep stable ids in `sources[]`**. Only the display text changed (#620).
- **No per-call cache of `loadQuarantinedNames`**. It would reintroduce the stale-read race
  (#621).

---

## 5. Trap list — instruments and channels that misled this session

1. **Lovable `send_message` times out at 60s on the MCP side while the message IS accepted.**
   Never resend after a timeout. `list_messages` first. A duplicate deploy request is the worst outcome here.
2. **`pull_request_read method=get_status` returns 403** ("Resource not accessible by
   integration"). Use `get_check_runs`.
3. **`deno test --no-lock` still rewrites `deno.lock`.** `git checkout deno.lock` after every run, or
   the next commit carries four dropped dependency entries.
4. **A frontend deploy breaks every open tab's first lazy route** ("Failed to fetch dynamically
   imported module … EvidenceTab-<hash>.js"). It is not a bug in the change that shipped. #623 is the
   fix. Until it merges, tell the analyst to reload.
5. **Graphify re-posts the same `buildTools()` / `artifactsToSources()` coupling finding on every
   commit.** Reply once per thread. Its advisory findings were wrong in 4 of 5 cases this session
   (verify each against the code). The one real one, a repeated-word name collapsing to one token,
   was fixed in #621.
6. **The stop hook demands a commit even when JD has said not to.** JD's words win. Say so, don't commit.
7. **JD rejected a background polling loop against `/health`.** Ask before starting any loop that
   hits a production endpoint repeatedly. One call, on request.
8. **Case identifiers leaked into commit messages twice** before being caught. Sanitize fixtures,
   PR bodies **and** commit messages. The squash merges this session exist partly to launder that.

---

## 6. Ordered next steps

1. **Verify #621 live** (§1 steps 1–3). Nothing else on the edge moves until this is done, because only
   one edge PR may be in flight.
2. **Merge #623** once JD marks it ready (frontend, independent of the edge).
3. **Frontend, no sign-off:** fix the `recommended-pivots` phone extraction (§3c).
4. **Check the two-seed exemption risk** (§2) by reading the code. It may need a fix before #621 can be
   trusted on hypothesis-seeded threads.
5. **Edge, needs JD sign-off:** `cluster.ts` §3a items 1 and 2 as one PR (contradiction =
   `kind: contradiction` or an explicit `collision_value` / `contradiction` field only; cluster ID
   from the joined component). Add a `/health` key and a kill switch.
6. **Needs JD sign-off:** display `promoted_confidence` (§3a.3), and re-order the source-class caps
   (§3a.4). JD decides where a direct platform fetch ranks.
7. **Queued edge fixes** (one at a time, after the above):
   - `fetch_retry.ts` should abort its per-attempt timeout with a `TimeoutError` reason, so an
     18-second socialfetch timeout stops reading as a run cancellation.
   - Selectors derived from an analyst-rejected lead should not bypass the dispatch guard.
   - Password-derived strings should not be labelled as names (§4).
   - The HIBP k-anonymity count needs honest labelling (§4).

---

## 7. Reading order

This handoff follows `SESSION_HANDOFF_2026-09-20_prompt-ceiling-payload-store-and-the-overlap-wedge.md`.
Its §4 (the positional `sanitizeModelMessages` overlap wedge) and §5 (`stop_reason='unknown'`) are
**still open**. Nothing this session touched them.
