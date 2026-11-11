# Session handoff — 2026-11-10 — the attachment-seed fix shipped (#1010, #1007, build `3f6ed05`)

Every number below is a dated measurement from 2026-11-11 about 06:00–06:30Z (2026-11-10 evening PST), not a state. Re-measure first. No real case value appears here and none may be added: the repo is public.

## §0 Rules (unchanged; all in CLAUDE.md → SETTLED)

`REVEAL_BREACH_DATA` stays ON · `RUN_LEASE_DISABLED=true` stays · `MAX_PAID_CALLS` stays bounded · intent is not inferred from prose · GLM primary / Anthropic backup, do not re-pin · edge ships only via stamp → surgical mirror sync → `verify:deploy` → Lovable message → `/health` moved build → ledger · one PR = one behaviour · never mix frontend and edge · squash only, never delete branches. Address the user as JD.

## §1 State (verified)

- **Live `osint-agent` = `3f6ed05`** (#1007). `/health` at 06:25Z: 72 checks / 0 not ok (71 on `8c5f20c`); `checks.attachment_seed` = `{ok:true}`; `glm-5.3-flash`; `run_lease` LEGACY; `reveal_breach_data: true`.
- **`deploy/live` = `3f6ed05`** (pushed). Ledger row is in PR #1021 (open at write time; merge it, or the next `verify:deploy` reports `ledger_ref_divergence`).
- **`main` = `7de2257`** (stamp #1020; parent `3f6ed05`) before the ledger and this docs PR. Mirror `main` = `78c6afb` (mirror PR #142); `osint-agent` tree `14037fccc3c2` equal on both sides.
- CI push run on `3f6ed05` (contains #1010 and #1007): success, including the e2e job.
- `.github/workflows/stale.yml` is still on `main`, untouched. It uses placeholder messages and will label and later close inactive issues and PRs on a daily cron. JD's call.

## §2 What shipped

| PR | Channel | What |
|---|---|---|
| #1010 | frontend | titles and the assessment engines read the typed seed, not the composer's `Attached files:` block (`1b8361f`) |
| #1007 | edge | `threads.title` / `threads.seed_value`, the seed classification and the run-time seed come from the typed text; upload-only stores `Attachment: <file>` and an empty seed (`3f6ed05`). Kill switch `ATTACHMENT_SEED_STRIP_DISABLED`. Proof key `checks.attachment_seed` |
| #1020 / #1021 | edge release | stamp (parent == marker) and ledger row |
| #1013 | closed | duplicate of #1007; branch kept |

JD's rulings on #1007, given 2026-11-10 (all YES): (1) on a typed-name-plus-file case, lookups that echo the name are kept as normal evidence, as on typed-name cases without a file; (2) on an upload-only case the early-end fallback report calls the seed `(seed)`; (3) a run opened with an attachment is not written to the per-seed investigation cache.

## §3 Verification (local, on `main` + #1010 + #1007, tree identical to what merged)

Edge **3080 passed / 0 failed / 6 ignored** · vitest **3393 passed / 1 skipped / 291 files** · `npm run test:e2e` **128 passed / 12 skipped** · typecheck clean · lint 0 errors (8 warnings).

Evidence stays whole (read, not assumed): `auth.ts` inserts the user message's full `parts` before the title logic, and `index.ts` still hands the full `messages` to `runAttachmentIntake`. Only title, seed value, seed kind and the run-time seed lose the block.

#1007 against #1013 on 15 shared inputs: seed value and seed kind identical in all 15. Title differences only: several uploads read `+1` (not `+1 more`); a long file name is cut without an ellipsis; repeated spaces in a file name are kept.

## §4 Measurement — and what is NOT proven yet

Counts only, no message text. Pattern: title or `seed_value` matching `(token=|/object/sign/)`.

- Before the deploy (06:18Z): 378 threads, **23** matching; last 7 days: 11 threads, 3 matching.
- After the deploy (06:25Z): **0 threads created since the deploy**, so "0 matching" is vacuous. The fix is proven by the `/health` self-test and the test suites, not yet by a stored row.
- To close it, after JD next starts a case with an upload:

```sql
select count(*) as threads,
       count(*) filter (where title ~ '(token=|/object/sign/)' or seed_value ~ '(token=|/object/sign/)') as leaking
from threads
where created_at > '2026-11-11T06:24:00Z';
```

Expect `leaking = 0` with `threads > 0`. The 23 old rows are untouched; a backfill is JD's call (old tokens are 7-day links, so most have expired).

## §5 Open items from this session

1. **Merge ledger PR #1021** (one file, `deploy-log.jsonl`).
2. **Proposed follow-ups to the #1007 code, not built:** a test for the space-joined form (`<typed> Attached files: …` on one line; behaviour is already correct), a test for the multi-upload title, and aligning the kill-switch parse with the repo convention (`.trim().toLowerCase() === "true"`; today only the exact string `true` is honoured, where 19 of 20 other `_DISABLED` switches normalise first).
3. **Vercel previews are blocked on some PR branches** ("Deployment was blocked", Vercel's verified-commits git setting: the branch commits are unsigned). It is not a build failure, and squash merges to `main` are signed by GitHub, so production deploys. It does mean those PRs had no preview to look at.
4. **Mirror PR #138** (`sync/osint-agent-336bbe7`) is still open and stale; later syncs superseded it. Close or leave: JD's call.

## §6 The queue (nothing below is approved; one track per session)

Measured 2026-11-11 06:15Z. All READY and mergeable unless noted.

- **Frontend:** #1015 (right rail shows agent scoring and connections; shorter case header — before/after screenshots still missing, and `assessmentReading()` is a `TODO(human)` stub), #1016 (a dotted handle is a username seed, frontend half), #1009 and #1014 (interrupted-run notice; superseded-reply fix — #1014 is based on another branch, not `main`). Each merged cleanly on top of `main` + #1010 + #1007 when tested alone.
- **Edge, dotted-handle stack:** #1017 → #1018 → #1019. Each now conflicts with `main` in `health-handler.ts` (both sides add a check next to `seed_account_id`); rebase before merge. #1018 adds a quarantine trigger and #1019 adds a linkage path: **each needs JD's explicit ruling**, not inferred from "ready".
- **#1016 before #1017 (read of the call sites, not a run):** the edge classifies and stores `seed_type` on the first message, and the client does not send its own classification with a run. With #1016 merged and #1017 not deployed, the composer's preflight and pivot hints would call a dotted handle a username while the stored `seed_type` and the run stay `domain`, as today. No worse than now, but the two disagree on screen. Simplest: merge #1016 right before #1017 deploys.
- **Older edge:** #963 (clean), #973 (now conflicts with `main`), #929 (edge test job red).
- **Not started:** the Investigate chat-flow rework, the likelihood-register switch (`VITE_ASSOCIATION_LIKELIHOOD`), agent accuracy, memory across cases. See the untracked next-session prompt JD holds from the 2026-11-10 design session.

## §7 Traps met this session (workstation, macOS sandbox)

- `git worktree add` fails in the sandbox on `.mcp.json` ("Operation not permitted"). Use `--no-checkout` plus a sparse checkout that excludes `.mcp.json` and `.claude/`.
- `git switch -c <b> origin/main` fails writing upstream config; pass `--no-track`.
- Playwright cannot launch Chromium inside the sandbox: all 140 tests fail in 0–1 ms. That is not a test result. Run e2e outside the sandbox.
- `gh` and Node `fetch` (so `verify:deploy` / `record:deploy`) fail on TLS or "fetch failed" inside the sandbox.
- A stale local `deploy/live` makes `verify:deploy` print `ledger_ref_divergence`. Fetch it first: `git fetch origin refs/heads/deploy/live:refs/heads/deploy/live`.
- Running the edge suite rewrites `supabase/functions/osint-agent/deno.lock`; restore it before committing.
