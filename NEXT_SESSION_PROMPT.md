# Next-session prompt — Insight Finder

> **Target agent:** Claude Code (fresh context, remote/web sandbox). Paste this whole file as the opening message.
> **Prerequisites:** GitHub MCP access to `justindean785/insight-finder` and `justindean785/seeker-spark-search-5362c57c`; the Lovable MCP (project `4ce11bc3-039d-4439-b293-acacca9e1e3a`, SELECT-only DB queries) for deploys.
> **Written 2026-10-14T03:00Z.** Every number is a dated measurement, not a state — re-verify. This file replaces the 2026-10-06 prompt (its queue drained on 2026-10-14; the old prompt's text is in git history).
> Address the user as **JD**. Engineering only — never investigate any person who appears in a scan.
> **Standing rules:** `REVEAL_BREACH_DATA` stays **ON**. `RUN_LEASE_DISABLED` stays `true`. Squash merges only, never delete branches, merge `main` into branches (never force-push). Ask before any merge, Lovable deploy message, secret change, closing anything, or billing action. Read a PR's body for sign-off notes before merging it.

---

# Objective

Take over at a clean point: **the Anthropic orchestrator is live but its API key is invalid**, four finished PRs wait on JD's "merge", and two of them (#758, #756) then need one edge deploy cycle. Do not build or ship anything JD has not named.

# Context

Insight Finder (a.k.a. Swarmbot) is JD's OSINT investigator: Vite + React + TS + Tailwind/shadcn on Vercel; Supabase (Postgres/Auth/Storage + Deno edge functions, chiefly `osint-agent`) behind Lovable. **Frontend ships on merge to `main`; the edge function does NOT** — it needs stamp → surgical mirror sync → `verify:deploy` gate → Lovable deploy message → `/health` proof → ledger. The recipe, its traps and this session's measurements are in **`SESSION_HANDOFF_2026-10-14_anthropic-orchestrator-and-the-dropped-connection.md`** — read it first (§0 rules, §1 state, §3 PR queue, §5 traps, §6 ordered plan, §7 verify commands).

Verified at hand-off (2026-10-14T02:46Z): canonical `main` = `5faa6ce`; live `osint-agent` build = **`66cf1c3`**; `deploy/live` → `66cf1c3`; mirror `main` = `120c76e`; `diff -rq` empty for all four function dirs; orchestrator **Anthropic pinned, `claude-sonnet-5`**, prompt caching working (~93% cache reads); `reveal_breach_data=true`; run lease `LEGACY`. Baselines: edge **2316 / 0 / 6**, frontend **2560 / 1 / 198 files**, e2e **52 / 2** (measured on the PR branches; re-measure on clean `main`).

# Current Problem

1. **BLOCKER — `ANTHROPIC_API_KEY` in Lovable is invalid.** Every run since 2026-10-14T02:36Z fails at step 0 with `invalid x-api-key [HTTP 401]`, $0 spent. Only JD can fix it: a key scoped to the **Insight Finder** workspace, saved via the Lovable secure form. Do not ask for, accept or echo a key in chat. Rolling back to `deepseek` would **not** work (Z.AI 429 insufficient balance); `minimax` is the working alternate pin.
2. **Two production bugs are fixed but unmerged.** #758 (edge): a dropped browser connection ran persistence early, marked the thread finished and discarded the loop's real end while it kept spending — the cause of JD's "stopped mid run" and of the Anthropic-billed vs metered gap. #759 (frontend): a provider 401 was read as the analyst's own session expiring and signed JD out on every scan. Both wait on JD's "merge".
3. **The Anthropic promo credit ($93.73 left) expires 2026-10-23.** Spend limit is $100/month, auto-reload off. Never enable auto-reload or buy credits.

# Files to Inspect

Search the repo if paths differ.

- `SESSION_HANDOFF_2026-10-14_anthropic-orchestrator-and-the-dropped-connection.md` — **read first.**
- `CLAUDE.md` — authoritative on deploy topology and the SETTLED decisions; its dated block at the top was refreshed 2026-10-14.
- `deploy-log.jsonl` (ledger; last row `66cf1c3`), `scripts/stamp-build.mjs`, `scripts/record-deploy.mjs`, `supabase/functions/osint-agent/build-info.ts`, `health-handler.ts`.
- `supabase/functions/osint-agent/lib/client-cancel.ts` + `index.ts` (the #758 fix), `lib/run-end.ts` (the mechanism, documented before it was fixed), `lib/leakcheck-guard.ts` (#756), `src/lib/tool-run.ts` + `src/components/ChatWindow.tsx` (#759), `src/lib/intel.ts` `buildInvestigationSummary` (#757).
- `supabase/functions/osint-agent/anthropic-orchestrator.ts` (`classifyAnthropicError`, cache breakpoints, run budget) and `providers.ts` (the pin).

# Implementation Requirements

Work in this order and **stop to ask JD** at every outward step.

1. **Orient (read-only):**
   ```bash
   git fetch origin main && git log --oneline -5 origin/main
   git fetch origin refs/heads/deploy/live:refs/heads/deploy/live   # a fresh clone lacks this ref
   git fetch --unshallow --filter=blob:none                          # the clone is shallow at depth 50
   curl -s "https://skzqwbyvmwqarfgfvyky.supabase.co/functions/v1/osint-agent?health=1"
   ```
   Expect `main` ≥ `5faa6ce`, build `66cf1c3`, `selected_provider: anthropic`, `checks.orchestrator_anthropic.ok` true. If either moved, another session worked here — read the newest handoff and the ledger first. Then `list_pull_requests` (20+ results overflow the tool result; parse the saved file with python).
2. **Confirm the key is fixed** (read-only DB, Lovable MCP `query_database`): the newest `orchestrator_invocations` row should have `stop_reason` ≠ `stream_error` and `credits_micro_usd > 0`. If the newest rows still say `invalid x-api-key`, tell JD and stop — nothing else can be observed until then.
3. **Ask JD which PRs to merge.** Recommended: #759 and #757 first (frontend, ship on merge, no deploy); then #758 (+ #756 once JD confirms its defaults: 3 LeakCheck calls per investigation, reserve 20 of the fixed 200-query pool). One edge deploy for both, following handoff §6 step 3 exactly: stamp PR whose parent IS the marker → surgical mirror sync of only the changed files (tests included) → `npm run verify:deploy -- --previous 66cf1c3 --mirror ../seeker-spark-search-5362c57c` prints `mirror tree -> equal` and `mirror pushed` → Lovable deploy message (AS-IS, `osint-agent` only, `wait=false`) → `/health` build moved and `checks.client_cancel_isolation.mode == "server_branch_only"` → `npm run record:deploy` → publish ledger + `deploy/live` (verify `deploy/live == marker` with `git ls-remote`) → ledger PR.
4. **Phone test after the deploy** (JD runs it): start a scan, switch apps for 30 s, return. Expect a finished report and no "Interrupted" card; expect no `premature_client_cancel` note on the new invocation row.
5. Then JD's reviews: #741, #738, #593 (keep, need sign-off); #701 (recommend close); #613, #516 (rebase or close). Small follow-ups are listed in handoff §6 step 6 — only on JD's word.

# OSINT / Analyst Requirements

- Evidence-ranking, confidence caps, chain-of-custody, credential masking and minor-safety detection are integrity-critical: **no change without JD's sign-off.**
- Keep confirmed evidence separate from AI inference; a zero-hit lookup is a coverage observation, not corroboration and not proof of absence.
- Scans contain real people. Do not research them, do not put their names/handles/IDs in commits, PRs or docs, and use synthetic fixtures in tests.

# Do Not

- Do NOT change `REVEAL_BREACH_DATA`, `RUN_LEASE_DISABLED`, `ORCHESTRATOR_PROVIDER`, `MAX_PAID_CALLS`, or any secret. Everything in `CLAUDE.md` → SETTLED stands.
- Do NOT merge, stamp, push to the mirror, send a Lovable deploy message, apply schema, close a PR, or touch billing without JD's explicit go-ahead for that step. Never answer a Lovable tool-approval pause yourself.
- Do NOT use Opus or any top-tier model for subagents. Prefer direct tool calls.
- Do NOT blanket-overwrite the mirror, click Lovable's "Try to fix", merge the mirror's own PRs, or type a SHA by hand (copy it from `git rev-parse` / the PR payload).
- Do NOT mix frontend, edge and schema in one PR; do NOT run more than one edge PR at a time.
- Do NOT trust the Lovable project agent's analyses without checking `/health`, the DB and the console (it reported a wrong limit and "caching off" this session).
- Do NOT echo JD's billing/card details or any credential, and do not bring up the key that was pasted in chat earlier.

# Acceptance Criteria

- [ ] Orientation numbers re-measured and compared with this file; any drift reported before acting.
- [ ] Key status confirmed from a real `orchestrator_invocations` row (not from `/health`, which only proves the pin).
- [ ] No outward step taken without a named, explicit go-ahead from JD.
- [ ] If the edge deploy ran: `/health` `build` moved, `checks.client_cancel_isolation` present with mode `server_branch_only`, `verify:deploy` VERIFIED with `mirror tree -> equal`, ledger PR merged, `deploy/live` == marker.
- [ ] Full suites green on anything you touch; `reveal_breach_data` still `true`.

# Verification

```bash
npm run typecheck && npm run lint && npx vitest run            # never bare `tsc`
cd supabase/functions/osint-agent && deno test --no-check --no-lock --allow-net --allow-env --allow-sys --allow-read . ../evidence-export   # Deno is not preinstalled
PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome npm run test:e2e > e2e.log 2>&1; echo "playwright exit: $?"
npm run verify:deploy -- --previous 66cf1c3 --mirror ../seeker-spark-search-5362c57c   # read-only; "mirror tree -> equal" is the hard gate
```

Run each PR in its own worktree with its own `node_modules`. `npx eslint` every new edge file — CI's Frontend job lints and typechecks `supabase/functions/` too.

# Return

Per step: the state you measured, what you changed (files, PR numbers, SHAs copied from tool output), tests run with the real counts, `/health` proof (key + value), what you did **not** do and why, remaining risks, and the exact question for JD. If a solution fails, stop and re-plan instead of patching forward.
