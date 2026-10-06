# Next-session prompt — Insight Finder

> **Target agent:** Claude Code (fresh context, remote/web sandbox). Paste this whole file as the opening message.
> **Prerequisites:** GitHub MCP access to `justindean785/insight-finder` and `justindean785/seeker-spark-search-5362c57c`; the Lovable MCP (project `4ce11bc3-039d-4439-b293-acacca9e1e3a`, SELECT-only DB queries) for deploys.
> **Written 2026-10-06T21:30Z.** Every number is a dated measurement, not a state — re-verify. This file replaces the 2026-09-20 prompt, whose queue has drained.
> Address the user as **JD**. Engineering only — never investigate any person who appears in a scan.

---

# Objective

Take over a clean hand-off point and **move the audit queue forward one JD-approved release at a time**, starting by *observing* the two edge builds that are live but have never run in production (`9233ebd`, `3ad2d2f`). Do not build or ship anything JD has not named.

# Context

Insight Finder (a.k.a. Swarmbot) is JD's OSINT investigator: Vite + React + TS + Tailwind/shadcn on Vercel; Supabase (Postgres/Auth/Storage + Deno edge functions, chiefly `osint-agent`) behind Lovable. **Frontend ships on merge to `main`; the edge function does NOT** — it needs stamp → surgical mirror sync → `verify:deploy` gate → Lovable deploy message → `/health` proof → ledger (recipe and its traps: `SESSION_HANDOFF_2026-10-06_release-train-and-audit-queue.md` §5).

Verified at hand-off (2026-10-06T21:25Z): canonical `main` = `2ba2842`; live `osint-agent` build = **`3ad2d2f`**; `deploy/live` → `3ad2d2f`; mirror `main` = `c9b1ba3`; `verify:deploy` VERIFIED with `mirror tree -> equal` (bytes unverified, as always); `reveal_breach_data=true`. Edge baseline **2163 / 0 / 6**; frontend last measured **2367 / 1 / 187** and e2e **52 / 2** on `8039235` (re-measure on clean `main` before crediting any delta).

# Current Problem

1. **Two shipped fixes are unobserved.** #697 (SDK-rejected tool inputs now get a `tool_usage_log` row) and #696 (a Shodan 404 for a real IP is a negative result, not a dead endpoint; a Jina "Target URL returned error" page is not evidence) are proved only by `/health` keys and tests. No tool call has run since they deployed.
2. **Eleven finished PRs sit in DRAFT** (#693 #694 #698 #703 #667 #701 edge; #702 #699 #700 #695 #666 frontend; plus #593 #612 #613 #516). A draft never merges, and an unmerged PR cannot ship — the merge queue is this project's documented bottleneck. Do not merge any of them on your own initiative.
3. **`CLAUDE.md`'s dated-state block is stale** (it still says live `325daad`); a small docs PR to refresh it, the readiness formula and the baselines is queued.

# Files to Inspect

Search the repo if paths differ.

- `SESSION_HANDOFF_2026-10-06_release-train-and-audit-queue.md` — **read first**: §1 state, §3 JD's rules, §4 queue, §5 recipe traps, §7 JD's pending decisions, §9 plan.
- `CLAUDE.md` — authoritative on deploy topology and the SETTLED decisions (ignore its dated-state blocks; they are stale).
- `deploy-log.jsonl` (the ledger; last row `3ad2d2f`), `scripts/stamp-build.mjs`, `scripts/record-deploy.mjs`, `supabase/functions/osint-agent/build-info.ts`, `health-handler.ts`.
- `supabase/functions/osint-agent/lib/negative-lookup.ts`, `circuit.ts`, `tool-outcome.ts`, `lib/tool-cache-version.ts`, `lib/tool-input-failure.ts` (what Releases 1–2 changed).
- `scripts/ops/leakcheck-probe-verify.ts`, `scripts/ops/opsis-live-contract.ts` — JD-run, key-from-env-only checks (never ask for or echo a key).

# Implementation Requirements

Work in this order and **stop to ask JD** at every outward step.

1. **Orient (read-only, ~5 min):**
   ```bash
   git fetch origin main && git log --oneline -5 origin/main
   git fetch origin refs/heads/deploy/live:refs/heads/deploy/live   # a fresh clone lacks this ref
   git fetch --unshallow --filter=blob:none                          # the clone is shallow at depth 50
   curl -s "https://skzqwbyvmwqarfgfvyky.supabase.co/functions/v1/osint-agent?health=1"
   ```
   Expect `main` ≥ `2ba2842`, build `3ad2d2f`, keys `checks.tool_input_failure_log` and `checks.negative_lookup_semantics` present. If either moved, another session worked here — read the newest handoff and the ledger first. Then `list_pull_requests` and read `draft`.
2. **Observe Releases 1–2 (read-only):** `mcp__Lovable__query_database` (SELECT only) on `tool_usage_log` since `2026-10-06 21:15Z`. Look for: Shodan rows for valid IPs that are `empty`, not `failed`/`disabled for thread`; any SDK-rejected-input rows (`outcome='failed'`, field-path-only message, no values). Report what you see — including "no scan has run yet". Do not claim either fix works without rows.
3. **Ask JD which single PR is next** (name it; recommended order and caveats are in handoff §4: #693 first — note it changes the report layer on Vercel immediately — then #694 → #667 → #666 → #698 → #703 → #701 last and OFF). Then run the recipe for exactly that PR, one release per go-ahead, stopping on any anomaly. "Go"/"Continue" from earlier sessions are **not** standing approvals.
4. After that, the small docs PR for `CLAUDE.md`, then (only if JD asks) the queued small edge PRs — LeakCheck error-text pass-through, `checks.credentials` excluding capability-disabled/keyless tools, the "0 hits is a real finding" prompt line (`system-prompt.ts:88`). Each **test-first** (watch it fail for the right reason, then minimal code, then the full suite), one edge PR in flight.

# OSINT / Analyst Requirements

- Evidence-ranking, confidence caps, chain-of-custody, credential masking and minor-safety detection are integrity-critical: **no change without JD's sign-off.** The only approved rule is the interim write-time negative-qualifier rule (#693).
- Keep confirmed evidence separate from AI inference; never state a source supports more than it does. A zero-hit lookup is a coverage observation, not corroboration and not proof of absence.
- Open and unfixed: recall-circular corroboration (`oathnet_lookup (recalled from memory)` classifies `breach`), the missing call-to-artifact lineage, `evidence_log.artifact_id` NULL on all 13,329 rows. These need JD's sign-off before any code.
- Scans contain real people. Do not research them, do not put their names/handles/IDs in commits, PRs or docs, and use synthetic fixtures in tests.

# Do Not

- **Do NOT change `REVEAL_BREACH_DATA`** (stays ON: "leave it on, do not change"), `MAX_PAID_CALLS`, or infer intent from prose. Everything in `CLAUDE.md` → SETTLED stands.
- **Do NOT use Opus or any top-tier model for subagents** (JD: "don't use … super high credit models"). Prefer direct tool calls; if you delegate, use a small model.
- **Do NOT merge, stamp, push to the mirror, send a Lovable deploy message, apply schema, change secrets, or touch billing without JD's explicit go-ahead for that step.** Never answer a Lovable tool-approval pause yourself.
- Do NOT delete the ten blank "New investigation" threads (invariant I-1: not a defect), disable any provider, change any subscription, rotate the Opsis key, or opt in to the LeakCheck probe (`#701`) until `scripts/ops/leakcheck-probe-verify.ts --spend-2` PASSES with the key in JD's own shell.
- Do NOT blanket-overwrite the mirror (surgical sync of changed files only, tests included), click Lovable's "Try to fix", merge the mirror's own PRs, or type a SHA by hand (copy it from `git rev-parse` / the PR payload).
- Do NOT mix frontend, edge and schema in one PR; do NOT run more than one edge PR at a time; do NOT report a green check board as "reviewed" (Devin Review is skipped, Cursor is neutral).
- Do NOT echo JD's billing/card/address details or any credential.

# Acceptance Criteria

- [ ] Orientation numbers re-measured and compared with this file; any drift reported before acting.
- [ ] Releases 1–2 either **observed** (with the specific `tool_usage_log` rows) or reported as "not yet observable — no scan since deploy".
- [ ] No outward step taken without a named, explicit go-ahead from JD.
- [ ] If a release was approved: `/health` `build` moved to the new marker, the new proof key is present, `verify:deploy` VERIFIED with `mirror tree -> equal`, ledger PR merged, `deploy/live` pushed.
- [ ] Every new test was shown failing first (and, for edge PRs, fails with the source change reverted); full suites green; `reveal_breach_data` still `true`.

# Verification

```bash
npm run typecheck && npm run lint && npx vitest run            # never bare `tsc`
npm run test:edge                                              # deno; add --no-lock; Deno is not preinstalled
PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome npm run test:e2e > e2e.log 2>&1; echo "playwright exit: $?"   # read the real status
npm run verify:deploy -- --mirror <path-to-mirror-clone>       # read-only; "mirror tree -> equal" is the hard gate
```

Run each PR in its own worktree with its own `node_modules` (a missing one makes `npx vitest` try to download vitest). `npx eslint` every new edge file — CI's Frontend job lints and typechecks `supabase/functions/` too, and edge files the frontend imports must not use the `Deno` global.

# Return

Per step: the state you measured, what you changed (files, PR numbers, SHAs copied from tool output), tests run with the real counts, `/health` proof (key + value), what you did **not** do and why, remaining risks, and the exact question for JD. If a solution fails, stop and re-plan instead of patching forward; for 3+ step or architectural work, write a short plan and confirm it with JD before implementing.
