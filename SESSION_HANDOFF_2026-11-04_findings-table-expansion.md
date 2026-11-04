# Session handoff — 2026-11-04 — engine-authored closing Findings table

Every number below is a dated measurement from 2026-11-04 (~11:00–11:30Z), not a state. Re-measure first.

## §0 Rules (unchanged; all in CLAUDE.md → SETTLED)

`REVEAL_BREACH_DATA` stays ON · `RUN_LEASE_DISABLED=true` stays · `MAX_PAID_CALLS` stays bounded · intent is not inferred from prose · GLM primary / Anthropic backup, do not re-pin · edge ships only via stamp → surgical sync → `verify:deploy` → Lovable message → `/health` moved build → ledger · one PR = one behaviour · never mix frontend and edge · squash only, never delete branches · edge PRs wait for JD's named go (merge, then deploy). Address the user as JD. Engineering only; no handle, name, ID, credential or storage URL from a run goes into code, tests, commits, PR text or docs.

## §1 State

- `origin/main` = `e8722038` (#972, ledger row for build `c67f90d`). Live `osint-agent` = `c67f90d`, `/health` 67 checks / 0 not ok, `glm-5.3-flash` pinned, `run_lease` LEGACY, `reveal_breach_data: true`. `deploy/live` = `c67f90d`; ledger row 2026-11-03T04:19:57Z: stamp `e57d3dd` (#971), mirror `e8a626c`, `mirror_tree_equality: equal`, `mirror_push_status: pushed`, previous build `979f199`.
- `c67f90d` bundled **eight** edge PRs in one stamp (#969, #928, #868, #943, #925, #912, #801, #799). A regression in it cannot be bisected by `/health`; its rollback point is `979f199`.
- **PR #974 (edge, READY): `feat(osint-agent): engine-authored closing Findings table ({{FINDINGS_TABLE}})`**, branch `claude/findings-table-expansion`, one commit `3d399fff` on `e8722038`. Not merged, not stamped, not deployed. It will be the next build.
- Docs PR (this file, `NEXT_SESSION_PROMPT.md`, CLAUDE.md "Last verified" + reading list): its own PR, no code, not merged.
- Open PR board (measured with `gh pr list`): READY edge PRs **#973** (Context.dev provider, 12 edge files), **#963** (Claude cluster adjudicator, ships dark), **#929** (English-only orchestrator; its `Edge functions (deno test)` check was failing when read) and now **#974**. Drafts, all CONFLICTING: #883, #882, #821, #804, #800, #793, #763, #701, #613, #593, #516. The "at most one edge PR in flight" rule is already exceeded by three READY edge PRs before #974.

## §2 JD's decisions this session

None new. The brief (`NEXT_SESSION_PROMPT.md`) was executed as written; the deviations are listed in #974's body (report-shape gate, 60 rows / 16,000 bytes, id tiebreak, second marker removed rather than duplicated).

## §3 Open

1. **Merge #974?** Then **deploy?** Both are JD's named go. Deploy follows `.claude/skills/edge-deploy/SKILL.md`; hard gate `npm run verify:deploy -- --previous c67f90d --mirror ../seeker-spark-search-5362c57c` must say `mirror tree -> equal` and `mirror pushed`; moved-build proof is `/health` `checks.findings_table` (`ok:true, enabled:true`). Merge #973/#963/#929 first or after is JD's order call — each is its own build.
2. #974 CI at open time: `Vercel` showed **"Deployment was blocked"** (a preview of an edge-only PR; cause not investigated), Actions jobs pending. Auto-fix is on for the session and will relay failures.
3. Adoption is unmeasured. Whether the model writes the marker shows only as `findings_table_expanded.marker_found` in the edge logs after a deploy. The finalize-phase directive (`orchestrator-finalize.ts:749`, "Write the complete final Findings report…") does not mention the marker and is the first candidate follow-up if adoption is low. The adjacent `CLOSING_TABLE_RULE` (`finding-prompt.ts`) still describes rows the model no longer writes.
4. The queue at the bottom of `NEXT_SESSION_PROMPT.md` is untouched and still JD's to name.

## §4 Traps found

- **The brief's premise was partly stale.** A server-authored block already existed: `lib/evidence-record.ts` (#479) appended to the stored message via `composePersistedParts`, rendering `record_finding` rows. Grep for `buildEvidenceRecord` before building anything "authoritative". #974 sits beside it and shares its ladder (`confidenceTierLabel`, `effectiveConfidence`, `isFindingRow`).
- **A GFM table is report shape.** `hasReportShape` (`orchestrator-finalize.ts`) treats a table separator as proof of a report and `recovery.ts:465` reads the *stored* text. `evidence-record.ts` refuses to emit a table for exactly this reason. #974 gates expansion on report shape of the message *without* the marker and works on a copy so `assistant.parts` is never assigned. Do not weaken either.
- **`capPartsSize` keeps a prefix.** An unbounded table placed before Network/Summary pushes them past the persisted-message cap; hence 60 rows / 16,000 bytes.
- **`assistant.parts` IS assigned once earlier** in `persistFinalMessages` (the salvage step appends its part, ~`index.ts:2267`). A "never assigned" source test must be scoped to the persistence region, not the file.
- **Metadata fields are not interchangeable.** `metadata.label` is the model's unchecked pick; `metadata.status` is server-derived but a second input; the number plus `metadata.confidence_cap_applied` is the single authority. `metadata.source_category` is the persisted source-class list.
- Tooling: the Lovable MCP `query_database` takes `sql` (not `query`); `echo ====` errors under zsh (`=` expansion), quote it; `du -b` does not exist on macOS (use `find … -exec stat -f%z`); a fresh worktree has an empty `node_modules` (`npm ci`); ESLint also lints `supabase/functions/` and needs `// eslint-disable-next-line no-control-regex` beside the `deno-lint-ignore` (`deno lint` itself flags the sibling `evidence-record.ts` too and is not a CI gate).
- Measurement framing: the audit's "0 of 73 calls" for `record_finding` was true at capture time; that run's single call landed ~24 minutes after the export. Quote the capture time with any rate.

## §5 Verify (re-run, do not trust)

    git fetch origin main && git log --oneline -5 origin/main
    curl -s "https://skzqwbyvmwqarfgfvyky.supabase.co/functions/v1/osint-agent?health=1"   # once
    gh pr view 974 --json state,mergedAt,statusCheckRollup
    cd supabase/tests/osint-agent && deno test --config=../../functions/osint-agent/deno.json --no-check --no-lock --allow-net --allow-env --allow-sys --allow-read . ../evidence-export
    npx vitest run && npm run typecheck && npm run lint && npm run build

Measured on the #974 branch: edge **2986 passed / 0 failed / 6 ignored** (2945 on `main` per the 11-03 baseline, not re-measured here; +41 new); vitest **3265 passed / 1 skipped / 276 files**; e2e **127 passed / 10 skipped**; lint 0 errors; `supabase/functions/osint-agent` = **2,995,085 bytes** (limit 4,300,000).

Step-1 measurement (read-only, counts only; window after `2026-11-03T04:19:57Z`): 22 invocations on 2 threads; both threads made ≥1 `record_finding` (3 calls, all `ok`); 36 `record_artifacts` calls. n=2: it does not move the earlier ~3% figure either way. SQL is in #974's body.

## §6 Subscriptions and check-ins

- Auto-fix is **enabled by the desktop app** for the session that opened #974; it watches CI, conflicts and review comments and sends `<ci-monitor-event>` messages. There is no trigger id to cancel.
- No `send_later` check-in was armed: the harness forbids scheduling or polling CI beside Auto-fix. A new session must re-bind #974 (`bind_pr`) and re-enable Auto-fix; the old session's subscription does not carry over.

## §7 Next

1. JD's go/no-go on merging #974, then on the edge deploy (§3.1).
2. After a deploy: read `/health` `checks.findings_table`; after the next real run, count `findings_table_expanded` log events by `marker_found`. If adoption is low, change the finalize directive at `orchestrator-finalize.ts:749` as its own PR.
3. Frontend, own session (from the brief's queue): attachment-seeded cases have no subject (title and seed kind from the attachment's file name; analyst-driven "Set as subject" — needs JD's design call).

## Opening prompt for the next session

> You are Claude Code, continuing Insight Finder (JD). Read `CLAUDE.md`, then `SESSION_HANDOFF_2026-11-04_findings-table-expansion.md`. Re-measure first: `git log origin/main`, one `/health` read, `gh pr view 974`. #974 (engine-authored Findings table, edge, READY) is unmerged and undeployed; merge and deploy are JD's named go. Do not start the queue in `NEXT_SESSION_PROMPT.md` unless JD names an item. Re-bind #974 and re-enable Auto-fix if you will watch it.
