# Session handoff — 2026-11-08 — Findings table adopted; the public-repo exposure

Every number below is a dated measurement from 2026-11-08 (about 06:00–07:00Z), not a state. Re-measure first. This handoff also covers the 2026-11-07 night session (#980–#987), which wrote none of its own.

## §0 Rules (unchanged; all in CLAUDE.md → SETTLED)

`REVEAL_BREACH_DATA` stays ON · `RUN_LEASE_DISABLED=true` stays · `MAX_PAID_CALLS` stays bounded · intent is not inferred from prose · GLM primary / Anthropic backup, do not re-pin · edge ships only via stamp → surgical mirror sync → `verify:deploy` → Lovable message → `/health` moved build → ledger · one PR = one behaviour · never mix frontend and edge · squash only, never delete branches. Address the user as JD. Engineering only: no handle, name, address, phone, ID, credential or storage URL from a run goes into code, tests, commits, PR text or docs.

**JD's standing instruction, 2026-11-08: "take control and be a leader."** That authorises driving frontend and docs PRs to merge when CI is green. It does **not** lift the standing rule that edge deploys, stamps, mirror pushes, Lovable messages, schema changes, secret or flag changes and billing actions need JD's named go.

## §1 State (verified 2026-11-08)

- **Live `osint-agent` = `456cb8e`** (#980). `/health`: 68 checks / 0 not ok; `checks.findings_table` = `{ok:true, enabled:true, directives:"finalize+salvage", switch:"FINDINGS_TABLE_EXPANSION_DISABLED"}`; `glm-5.3-flash` pinned; `run_lease` LEGACY; `reveal_breach_data: true`. `deploy/live` = `456cb8e`; ledger row #982 (2026-11-07T08:55Z).
- **`main`** = `aa1b661` (#988) before this docs PR. Frontend is live on Vercel from `main`.
- Verified green on `main` at `64db08b`: frontend, edge, migrations **and e2e**. On `aa1b661` (CI push run): edge **3001 passed / 0 failed / 6 ignored**, frontend **3314 passed / 1 skipped / 282 files**, migrations green; the e2e job was still running when this was written — read it.
- Local on the #988 head (same code): `npm run test:e2e` **127 passed / 10 skipped**; typecheck and lint clean. (The "second vitest skip, untraced" in older notes did not reproduce: one skip.)
- Open PR board (verified): READY edge PRs **#963** (clean, green), **#973** (mergeability unknown, base `e872203`), **#929** (`unstable`: edge tests **1 failed of 2936**, a Jina-reader "provider suppressed after 401/402" assertion; 38 commits behind `main`; rebase and re-run to learn whether it is flaky). Drafts #883, #882, #821, #804, #800, #793, #763, #701, #613, #593, #516 untouched. Open issues of note: #986 (audit trail), #489, #477, #474, #887–#889.

## §2 What shipped since the 11-07 handoff

| PR | Channel | What |
|---|---|---|
| #979 | docs | 11-07 handoff, prompt, CLAUDE.md state |
| #980 | edge | finalize and salvage directives ask for `## Findings` + `{{FINDINGS_TABLE}}`; same kill switch (`lib/findings-table-directive.ts`) |
| #981 / #982 | edge release | stamp (parent == marker) and ledger row; `456cb8e` live |
| #983 | frontend | ledger basis dedupe; harness linkage rows; attachment-case naming; **"Set as case subject"**; palette signed-URL leak fix; zero-row-write fix |
| #987 | frontend | HomeHub and Insights name an upload-only case by its file (closes #985) |
| #988 | frontend | harness fixture: real-looking addresses and names replaced with reserved-domain / synthetic values (closes #984) |

## §3 Adoption — measured (production counts only, no message text)

Assistant messages since the `456cb8e` deploy: **5, across 2 threads; all 5 contain the engine table header; 0 raw `{{FINDINGS_TABLE}}`; 0 "unavailable/withheld" lines.** Before #980: 0 of 1. One message has the forced-finalize shape (`memory_save` → text tail); four sit in one thread within nine minutes with a `text, text` tail (consistent with a salvage-style appended part — **not verified**). Residuals: `system-prompt.ts:173` shows the marker in backticks and the matcher accepts only a bare line (the directives override it at report time, so the path is unexercised); `CLOSING_TABLE_RULE` (`lib/finding-prompt.ts:71`) still describes rows the model no longer types; the in-place expansion's chat rendering (#976) has not been observed live.

## §4 ⛔ The public-repo exposure — read this first

**`justindean785/insight-finder` is PUBLIC** (`visibility: public`, verified). The mirror `seeker-spark-search-5362c57c` is private. The checked-in tree and its public history contain personal data lifted from production investigations:

- A repo-wide scan for free-mail addresses (counts and paths only, nothing copied here) finds about **45 files** with real-looking, non-placeholder addresses: `src/test/*` (~9 files), `src/lib/intel.ts` and `evidence-bands.ts` (comments), `supabase/tests/osint-agent/**` (~20 files, including two checked-in CSV fixtures named after production thread ids), **deployed edge source** (`supabase/functions/osint-agent/`: about 8 files, comments and logic), `docs/` and `docs/archive/` handoffs, `mem/ops/`, `.lovable/plan.md`, a root-level handoff and `supabase/functions/osint-agent/BETA_FINDINGS.md`.
- It is **not only addresses.** The same files hold phone numbers, a street address, full names and usernames. A regex scrub will not find all of it.
- JD's own address appears in a few allowlist/admin places; that is fine and expected.
- #988 scrubbed the fixture named in #984 (and its one dependent test). **Nothing else has been scrubbed.** Git history keeps the old values regardless of any file change; forks and caches may already hold them.

**Decision for JD (not mine to make — it is a repo setting and a trade-off):**

1. **Make the canonical repo private** (GitHub → Settings → General → Danger Zone → Change visibility). Strongest and fastest mitigation; reversible, though copies already taken are not recalled. **Trade-off:** public repos get free GitHub Actions minutes; the CI header already records that Actions allowance was drained once (#483), and a private repo draws on the plan's quota. Check Vercel's GitHub integration still has access afterward. The Lovable mirror is already private and unaffected.
2. **History:** rewrite (filter-repo) or accept. A rewrite breaks every clone, open PR and the `deploy/live` / ledger SHAs the release process pins, and forks keep their copy — so it is only worth doing together with (1). JD's call.
3. **Scrub scope:** phased by ship channel, because the channels do not mix: (a) frontend `src/test`, `src/lib` comments — verifiable locally, ships on merge; (b) edge tests and CSV fixtures — not deployed, needs Deno or CI; (c) **edge function source** — deployed bytes, so it needs an edge build (ride the next edge PR, or its own); (d) docs and archived handoffs.
4. **Prevent regrowth:** a ratchet test that fails when a new non-placeholder free-mail address appears in tracked files (baseline allowlist for the current ones), so the count only goes down. Small, frontend-channel.

Technique notes if a scrub is approved: keep each relationship the assertions depend on (a handle that is a prefix of another; a dotted variant whose dots-removed form equals the handle; a username equal to an email local part; same-surname rows). Keep free-mail **domains** (some tests classify by domain) and replace only the identifying parts. A tested pattern is in #988.

## §5 Other traps and findings

- **#986 (open, proposal only):** "Set as case subject" overwrites `threads.seed_value`, `seed_type` and `title` with no record of the old values. Proposed fix: a `BEFORE UPDATE` trigger on `threads` into a new audit table, as a **schema PR, applied and verified before any code depends on it** (RLS, `SECURITY DEFINER` with a fixed `search_path`, retention). Needs JD's go.
- **The edge still persists the raw "Attached files:" markdown** as the title (80 chars) and `seed_value` (200 chars) when the first message is only an upload (`auth.ts:284–296`), with a 7-day **signed storage URL** cut mid-way through. The frontend now works around it (#983/#987), but the token is still stored in the database. This is the next edge PR (see `NEXT_SESSION_PROMPT.md`). The frontend reads an empty or attachment-only seed as "no subject" (`caseLacksSubject`), so storing an empty `seed_value` and a file-named title stays compatible.
- **Process:** #983 bundled six behaviours (ledger label, harness rows, attachment naming, the new subject writer, a palette security fix, a write-guard fix) against the one-PR-one-behaviour rule; its commits carry an Opus co-author trailer although the standing rule says no Opus/top-tier agents. Frontend-only and reviewed, so low harm, but the next ones should be split.
- **Measure adoption on the stored message** (not logs): read `messages.parts` through `jsonb_array_elements(parts)->>'text'` and count the engine header, the raw marker and the fallback lines. Lovable `query_database` (project `4ce11bc3-039d-4439-b293-acacca9e1e3a`) answers counts-only queries; never read message text.
- `findings_table_expanded` is a `console.log` only (not in Postgres).

## §6 What comes next (ordered)

1. **JD decides §4** (visibility first). Until then, do not add any new real-looking value to the repo, and do not start the mass scrub.
2. If approved: phase (a), then the ratchet test, then (b) and (d); (c) rides an edge build.
3. **One edge PR: the attachment-seed fix** (`NEXT_SESSION_PROMPT.md`), JD's go to merge and again to deploy.
4. #986 as a schema PR, if JD wants it.
5. #929 rebase and re-run; #963 and #973 are JD's call; board triage of the eleven drafts.

## Opening prompt for the next session

> You are Claude Code, continuing Insight Finder (JD). Read `CLAUDE.md`, then `SESSION_HANDOFF_2026-11-08_findings-adopted-and-the-public-repo-exposure.md`, then the fenced brief in `NEXT_SESSION_PROMPT.md`. Re-measure first: `git log origin/main`, one `/health` read (expect build `456cb8e`), `list_pull_requests`, and the repo's visibility. Ask JD for the §4 decision before any scrub work.
