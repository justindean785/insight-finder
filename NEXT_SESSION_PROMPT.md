# Next-session prompt — Insight Finder

> **Target agent:** Claude Code (fresh context, remote/web sandbox). Paste the fenced block below as the opening message, as-is.
> **Written 2026-11-08.** Replaces the 2026-11-07 prompt (executed: #980 built, merged and deployed as `456cb8e`; adoption measured 5 of 5). Every number is a dated measurement, not a state — re-verify.
> **Audit basis (2026-11-08):** `main` `aa1b661` plus this docs PR; live `osint-agent` `456cb8e` (`/health` 68 checks, 0 not ok); `justindean785/insight-finder` is **public**. Read `SESSION_HANDOFF_2026-11-08_findings-adopted-and-the-public-repo-exposure.md` first, especially §4.

```
# Objective

Step 0 (blocking, JD's call, not yours): the canonical repo is PUBLIC and its tree and history hold real-looking personal data from production runs (handoff §4). Ask JD for the decision on visibility, history and scrub scope before any scrub work, and add no new real-looking value anywhere in the meantime.

Then ONE edge PR: stop the edge from persisting an upload-only first message as the case title and seed. Today `supabase/functions/osint-agent/auth.ts` (~:284–296) writes the whole joined text of the first message into `threads.title` (80 chars) and `threads.seed_value` (200 chars). When that message is only the composer's "Attached files:" block, both columns hold raw markdown with a 7-day SIGNED STORAGE URL cut mid-way through, `seed_type` stays "other", and the token sits in the database. The frontend works around it (#983/#987: `attachmentOnlyNames`, `caseLacksSubject`, `threadDisplayTitle`), but the stored values are unchanged. Prompt/logic scope only; tests first; one kill switch; one proof. Open the PR READY when CI is green, then stop: JD merges, JD authorises the deploy.

Address the user as JD. Engineering only — the scans contain real people; never investigate anyone who appears in a run, never put a handle, name, address, phone, ID, credential or storage URL from a run into code, tests, commits, PR text or docs (the repo is public).

# Session hygiene (CLAUDE.md, JD 2026-10-19)

Report one line, unprompted, after any compaction, when a PR merges, and before starting a new task: `Session check: STAY — <reason>` or `Session check: START FRESH — <reason>` (with the handoff path and the opening prompt). Second compaction ⇒ START FRESH.

# Standing rules (do not re-litigate)

- `REVEAL_BREACH_DATA` stays ON. `RUN_LEASE_DISABLED=true` stays. `MAX_PAID_CALLS` stays bounded. Intent is NOT inferred from prose.
- GLM primary (`glm-5.3-flash`, deepseek slot), Anthropic `claude-sonnet-5` is the start-failure backup. Do not re-pin.
- Edge ships only via the `edge-deploy` skill: stamp (parent == marker) → surgical mirror sync → `npm run verify:deploy` hard gate (`mirror tree -> equal` + `mirror pushed`) → Lovable deploy message → `/health` build moved → `npm run record:deploy` → ledger PR + `deploy/live`. Never `supabase functions deploy`.
- One PR = one behaviour change + tests. Never mix frontend and edge. At most one edge PR in flight. Squash only; never delete branches.
- JD's 2026-11-08 instruction ("take control and be a leader") authorises driving frontend and docs PRs to merge when CI is green. It does NOT authorise, without JD's named go: any edge merge or deploy, stamp, mirror push, Lovable message, secret or flag change, schema, closing a PR, repo-visibility change, history rewrite, or billing action. Never answer a Lovable tool-approval pause yourself.
- Integrity-critical (no change without JD's written sign-off): evidence ranking, `confidence.ts`, `record_finding`, chain-of-custody, credential masking, minor-safety detection.
- No Opus/top-tier subagents; prefer direct tool calls. Never echo a key.

# Steps

1. **Orient (read-only).** `git fetch origin main && git log --oneline -5 origin/main`; one `/health` read (expect `456cb8e`, 68 checks; if the build moved, read the newest handoff and ledger first); `list_pull_requests`; `gh api repos/justindean785/insight-finder --jq .visibility`.
2. **Verify before building** (report what you find): read `auth.ts` ~:200–300; `attachment-intake.ts` (`parseAttachments`, `MARKER`) and reuse it rather than re-parsing; `validation.ts:123 formatThreadTitle`; the frontend readers `src/lib/attachments.ts` (`attachmentOnlyNames`), `src/lib/set-subject.ts` (`caseLacksSubject`), `src/lib/case-name.ts` — the new stored shape must keep all three working (they treat an empty or attachment-only seed as "no subject").
3. **Ask JD one design question before writing code.** Recommended: for a message with NO typed text and at least one attachment, store title `Attachment: <first file name>` (plus ` +N more`), store `seed_value` empty (never a URL), leave `seed_type` as it is (the display-only `attachment` kind stays frontend-only). Alternatives: a dedicated `attachment` seed kind (touches the edge cache-key mirror of `SeedKind`), or keep a name-only seed string. Also ask whether JD wants a **backfill** of existing rows that already hold a signed URL — a data migration, JD's call, not part of this PR.
4. **Tests first (red).** Upload-only message → title and seed contain no URL or token; typed text above an upload keeps its text and drops the block from `seed_value`; no attachment → behaviour byte-identical to today; with the kill switch on → today's behaviour byte-for-byte; the `.eq("title","New investigation")` guard still holds. Then the change (green). Kill switch: a new env flag read at call time (name it in the PR; default new behaviour ON).
5. **Proof key:** one new `/health` check (self-test on a synthetic upload-only message that asserts no URL in the derived title and seed) or one durable log field — not both.
6. **Run** the verification below; open the PR READY; subscribe; stop and ask JD: merge? then deploy?

# Verification

    npm run typecheck && npm run lint && npx vitest run
    DENO_INSTALL=/usr/local sh <(curl -fsSL https://deno.land/install.sh) -y   # Deno is not preinstalled
    cd supabase/tests/osint-agent && deno test --config=../../functions/osint-agent/deno.json --no-check --no-lock --allow-net --allow-env --allow-sys --allow-read . ../evidence-export
    npx eslint <changed edge files>

Baselines: vitest 3314 passed / 1 skipped / 282 files and `npm run test:e2e` 127 passed / 10 skipped (local, 2026-11-08, same code as `aa1b661`); edge **3001 passed / 0 failed / 6 ignored** and frontend 3314 / 1 / 282 on CI at `aa1b661`. `src/` should be untouched by this PR. Never bare `tsc`.

# After the deploy (a later step, JD's go)

Re-measure on the stored rows, counts only: threads created after the deploy whose first user message is upload-only — how many have a title or `seed_value` containing a signed-URL token (`token=`, `/object/sign/`)? Expect 0. Never read message text.

# Return

Changed files; tests with real counts (red → green); the proof key and its value; what you did NOT do and why; remaining risks; the PR link; the question for JD (merge? then deploy?).

# Queue after this session — do not start unless JD names it (one PR each)

Frontend / docs (merge-when-green):
1. **The scrub, by channel** — only after JD's §4 decision. (a) `src/test`, `src/lib` comments; (b) edge tests and CSV fixtures; (d) docs and archived handoffs. Plus the **ratchet test** that stops new real-looking addresses entering tracked files. Keep the relationships the assertions depend on (handle prefixes, dotted variants, email-local-part equals username); keep free-mail domains; #988 is the worked pattern.
2. **Insights** cannot title pasted-provider cases: it never receives the seed (limitation recorded in #987).

Edge (one build each, JD's go):
3. **System-prompt marker in backticks** (`system-prompt.ts:173`) — the matcher accepts only a bare `{{FINDINGS_TABLE}}` line; and the stale `CLOSING_TABLE_RULE` (`lib/finding-prompt.ts:71`). One small prompt PR with a test.
4. **#986 audit trail** for subject changes — a schema PR (trigger on `threads` + audit table + RLS), applied and verified before any code. JD's go.
5. **`indicia_web_dbs` schema gap** — `HTTP 400: snusbaseType is required when snusbase is selected`; `refine` so the pair is required together; a test; proof key.
6. **Heartbeat fix** (11-01 glm-5.3 handoff §5): `recovery.ts` `startRunHeartbeat` — bounded write timeout, clear in `finally`, `run_started_at` in the predicate.
7. **GLM pricing** — flat `[0.3, 1.2]` micro-USD/token for every GLM model (`index.ts` ~:1975); per-model table in the shape of `costs.ts` `ANTHROPIC_RATES_MICRO_USD_PER_TOKEN`; do NOT add a second `onCost` feed.
8. **Claude adjudicator** (#963 READY; `cluster_adjudications` table exists) — spends the Anthropic key; JD's go.
9. **Board triage owed to JD:** #929 (red: 1 edge test failed, 38 commits behind — rebase and re-run first), #963, #973 (mergeability unknown); drafts #883, #882, #821, #804, #800, #793, #763, #701, #613, #593, #516.
10. **Security observation** (11-01 audit §0): `anon`/`authenticated` hold default privileges incl. TRUNCATE on `orchestrator_invocations` / `orchestrator_step_metrics` in production. Chase or leave — JD's call.
```
