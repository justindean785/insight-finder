# Session handoff — 2026-11-07 — Findings table shipped; adoption 0 of 1

Every number below is a dated measurement from 2026-11-07 (07:10–08:30Z), not a state. Re-measure first.

## §0 Rules (unchanged; all in CLAUDE.md → SETTLED)

`REVEAL_BREACH_DATA` stays ON · `RUN_LEASE_DISABLED=true` stays · `MAX_PAID_CALLS` stays bounded · intent is not inferred from prose · GLM primary / Anthropic backup, do not re-pin · edge ships only via stamp → surgical sync → `verify:deploy` → Lovable message → `/health` moved build → ledger · one PR = one behaviour · never mix frontend and edge · squash only, never delete branches · edge PRs wait for JD's named go (merge, then deploy). Address the user as JD. Engineering only; no handle, name, ID, credential or storage URL from a run goes into code, tests, commits, PR text or docs.

## §1 State

- **Live `osint-agent` = `b1b2313`** (#974 alone, stamp #977 `430642f`, parent == marker). `/health`: **68 checks / 0 not ok**, `checks.findings_table` `{ok:true, enabled:true, switch:"FINDINGS_TABLE_EXPANSION_DISABLED"}`, `glm-5.3-flash` pinned, `run_lease` LEGACY, `reveal_breach_data: true`.
- `deploy/live` = `b1b2313` (`git ls-remote`). Ledger row #978 (`d0b482f`), recorded 2026-11-07T07:50:19Z: mirror `cea6314`, tree `5c664e3b03fc` `equal`, `pushed`, previous build `c67f90d`. A re-run of `verify:deploy` after the ledger merge read `ledger / ref b1b2313 / b1b2313`, VERIFIED.
- Rollback: `FINDINGS_TABLE_EXPANSION_DISABLED=true` (runtime, no deploy; the literal marker then shows in reports). Previous build `c67f90d` is itself an eight-PR bundle (rollback point `979f199`).
- Frontend: #976 is live on Vercel production (`5af7edf`, deployment `dpl_8hbQ8AWSX4e8q43P3qeqcJuTNn54`, READY, `target: production`).
- Open PR board: READY edge PRs #973, #963, #929 untouched; drafts #883, #882, #821, #804, #800, #793, #763, #701, #613, #593, #516 untouched.

## §2 What shipped (all squash, each pinned to its head SHA)

| PR | What | Merge |
|---|---|---|
| #975 | docs: 11-04 handoff, prompt, CLAUDE.md | `f101b22` |
| #976 | frontend: chat reconcile treats the in-place expansion as the same message | `5af7edf` |
| #974 | edge: engine-authored closing Findings table | `b1b2313` |
| #977 | stamp `b1b2313` | `430642f` |
| #978 | ledger row | `d0b482f` |

Mirror: one commit `cea6314` = the five #974 runtime files (`env.ts`, `health-handler.ts`, `index.ts`, `system-prompt.ts`, `lib/findings-table.ts`) + `build-info.ts`. The mirror holds no `supabase/tests/`. Two Lovable-agent commits from 2026-11-03 (`349f94d`, `e8a626c`) touched only `.lovable/` and `src/integrations/supabase/types.ts` — no edge file — and were left as they are.

CI on the push runs (`main`): `5af7edf` → vitest **3278 passed / 2 skipped / 276 files**, edge **2945 / 0 / 6**, e2e **127 passed / 10 skipped**; `b1b2313` → edge **2988 / 0 / 6**, vitest 276 files passed, e2e **127 / 10**. The second vitest skip (was 1) is new and not traced.

## §3 Adoption — measured on the first post-deploy run

One real run (thread `71ae1e79`, started 08:17:40Z, finished 08:20Z, `status=finished`, no `recovery_reason`). Structure only, from the stored assistant message:

| Check | Result |
|---|---|
| Engine table (its fixed header `\| # \| Finding / value \| Kind \| Basis \| Source \| Label \| Confidence \| Source classes \|`) | **absent** |
| Literal `{{FINDINGS_TABLE}}` | absent → the model never wrote the marker (`marker_found:false`) |
| `## Findings` section | present, **model-authored**: one 3-column table, 5 rows, **1 `[CONFIRMED]` label**, no percentages |
| `## Network`, `## Summary` | present |
| `## Evidence Record — authoritative` (server block, #479) | present |
| `record_finding` calls in the run | **0** (13 tool calls) |

**Cause (traced in code, n=1):** the message's last parts are `record_artifacts` → `memory_save` → text — the forced finalize phases. The report was written under `buildFinalizeDirective()` (`orchestrator-finalize.ts:740`), whose line `:749` says *"Write the complete final Findings report … confirmed findings grouped by type with confidence and source"* — no marker, and it asks for hand-typed confidence. It overrode the system prompt's marker line (`system-prompt.ts:173`). The salvage prompt `buildSalvageSynthesisPrompt` (`orchestrator-finalize.ts:954–957`) has the same gap; salvage wrote 16 of 32 timed reports on 11-01, so fixing `:749` alone leaves a large share unchanged. Until both are fixed, every report from either path skips the engine table.

Not measured: whether the report renders twice in chat (expansion never ran, so #976 was not exercised).

## §4 Traps found

- **`findings_table_expanded` is a `console.log` only** (`index.ts` ~2404) — it never reaches Postgres, so `query_database` cannot count it. Measure on the stored message instead (the engine header above, `{{FINDINGS_TABLE}}`, `_Findings table unavailable` / `_Findings table withheld`). Reading the edge logs needs the Lovable agent (a message, credits).
- **Read `messages.parts` through `jsonb_array_elements(parts)->>'text'`.** Splitting `parts::text` on newlines fails (the newlines are escaped), which first made the `## Findings` heading look absent.
- **Lovable `send_message` timed out at 60 s client-side but was delivered.** Check `list_messages` before resending — a second message supersedes (rejects) the first. Then poll `get_message` (max 55 s per call). `list_messages` with `limit: 3` still returned 136k characters; read it with `jq` from the saved file.
- The Lovable agent's own "deployed" report included its self-checked `/health` read; only our own `/health` read counts as proof.
- `marker_offset_mismatch` before the deploy was expected (two lines); the gate was `mirror tree -> equal` + `mirror pushed -> pushed`.
- The salvage step runs before the expansion in `persistFinalMessages` (salvage ~`index.ts:2132`, expansion ~`:2391`), so a salvage report that writes the marker should expand — verify, do not assume.

## §5 JD's decisions this session

- "Go" → merge #975 then #976. "Go, merge #974". "deploy" → the full recipe under one go with stop-on-first-failed-gate (stamp merge, mirror push, Lovable message, ledger merge, `deploy/live` push).
- "handoff" → stop here; the finalize-directive follow-up is its own edge PR in a fresh session.

## §6 Subscriptions and check-ins

None active. #977 and #978 subscriptions ended on merge (auto-unsubscribed). No `send_later` check-in was armed. All background monitors finished.

## §7 Next

1. **Edge PR: the closing-report directives write the marker** — brief in `NEXT_SESSION_PROMPT.md`. Prompt text only in `buildFinalizeDirective` and `buildSalvageSynthesisPrompt`; tests pin the marker in both; JD's go to merge and again to deploy. Design question for JD inside the brief: should the two directives ask for the marker only when expansion is enabled (so the kill switch rolls back cleanly), or unconditionally like `system-prompt.ts:173` does today?
2. After that deploy: re-measure adoption the same way (§3) on the next real runs, both a forced-finalize run and a salvage run if one occurs.
3. Then the queue in `NEXT_SESSION_PROMPT.md`, one item at a time, JD's choice.

## Opening prompt for the next session

> You are Claude Code, continuing Insight Finder (JD). Read `CLAUDE.md`, then `SESSION_HANDOFF_2026-11-07_findings-table-shipped-adoption-zero.md`, then the fenced brief in `NEXT_SESSION_PROMPT.md` and execute it. Re-measure first: `git log origin/main`, one `/health` read (expect build `b1b2313`, `checks.findings_table` ok), `list_pull_requests`. One edge PR this session; merge and deploy are JD's named go.
