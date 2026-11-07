# Next-session prompt — Insight Finder

> **Target agent:** Claude Code (fresh context, remote/web sandbox). Paste the fenced block below as the opening message, as-is.
> **Written 2026-11-07.** Replaces the 2026-11-04 prompt (executed: #974 built, merged, deployed as `b1b2313`). Every number is a dated measurement, not a state — re-verify.
> **Audit basis (2026-11-07, ~08:30Z):** `main` `d0b482f`; `/health` read after the deploy; `deploy-log.jsonl`; one post-deploy run measured structurally (counts and flags only). Channel: edge (one build).

## State at hand-off (2026-11-07)

- Live `osint-agent` = `b1b2313` (#974 alone): `/health` 68 checks / 0 not ok, `checks.findings_table` `{ok:true, enabled:true}`. `deploy/live` = `b1b2313`; ledger #978. #976 (frontend reconcile) live on Vercel production.
- **Adoption 0 of 1.** The first real run's report was written under the forced-finalize directive, which never mentions the marker, so the model typed its own Findings table (one `[CONFIRMED]` label) and the engine table never rendered. Details: `SESSION_HANDOFF_2026-11-07_findings-table-shipped-adoption-zero.md` §3.

```
# Objective

One edge PR this session: make both closing-report instructions ask for the engine table. `buildFinalizeDirective()` (`supabase/functions/osint-agent/orchestrator-finalize.ts:740`, the line at `:749`) and `buildSalvageSynthesisPrompt()` (same file, `:940`, the lines at `:954–957`) must tell the model to write a `## Findings` heading followed by the single line `{{FINDINGS_TABLE}}`, and not to type a findings table, tier labels or confidence numbers itself — matching `system-prompt.ts:173`. Prompt text only. Tests first. Open the PR READY when CI is green, then stop: JD merges, JD authorises the deploy.

Address the user as JD. Engineering only — the scans contain real people; never investigate anyone who appears in a run, never put a handle, name, ID, credential or storage URL from a run into code, tests, commits, PR text or docs.

# Session hygiene (CLAUDE.md, JD 2026-10-19)

Report one line, unprompted, after any compaction, when a PR merges, and before starting a new task: `Session check: STAY — <reason>` or `Session check: START FRESH — <reason>` (with the handoff path and the opening prompt). Second compaction ⇒ START FRESH.

# Standing rules (do not re-litigate)

- `REVEAL_BREACH_DATA` stays ON. `RUN_LEASE_DISABLED=true` stays. `MAX_PAID_CALLS` stays bounded. Intent is NOT inferred from prose.
- GLM primary (`glm-5.3-flash`, deepseek slot), Anthropic `claude-sonnet-5` is the start-failure backup. Do not re-pin.
- Edge ships only via the `edge-deploy` skill: stamp (parent == marker) → surgical mirror sync → `npm run verify:deploy` hard gate (`mirror tree -> equal` + `mirror pushed`) → Lovable deploy message → `/health` build moved → `npm run record:deploy` → ledger PR + `deploy/live`. Never `supabase functions deploy`.
- One PR = one behaviour change + tests. Never mix frontend and edge. At most one edge PR in flight. Squash only; never delete branches.
- Ask JD before any merge, stamp, mirror push, Lovable message, secret or flag change, schema, closing a PR, or billing action. Never answer a Lovable tool-approval pause yourself.
- Integrity-critical (no change without JD's written sign-off): evidence ranking, `confidence.ts`, `record_finding`, chain-of-custody, credential masking, minor-safety detection.
- No Opus/top-tier subagents; prefer direct tool calls. Never echo a key.

# The termination area — read before editing `orchestrator-finalize.ts`

This file owns the project's worst incidents (CLAUDE.md → "Run-termination invariants"). This PR changes **directive text only**: no `toolChoice`, `stopWhen`, phase gate, finalize gating, `hasReportShape`, `needsReportSalvage`, or salvage trigger change. `hasReportShape` and `recovery.ts:465` read the STORED text; the expansion only runs when the message has report shape *without* the marker line, so the `## Findings` heading must stay in both directives (it satisfies `REPORT_HEADING_RE`). Read `SESSION_HANDOFF_2026-11-04_findings-table-expansion.md` §4 before touching anything.

# Steps

1. **Orient (read-only).** `git fetch origin main && git log --oneline -5 origin/main`; `git fetch origin refs/heads/deploy/live:refs/heads/deploy/live`; one `/health` read (expect `b1b2313`, 68 checks, `checks.findings_table` ok — if the build moved, read the newest handoff and ledger first); `list_pull_requests`.
2. **Verify before building** (report what you find):
   - The salvage text passes through the expansion: salvage appends its part ~`index.ts:2132–2267`, the expansion runs ~`:2391`. Confirm the order and that the salvage part is inside the expanded message.
   - Which existing tests pin the current directive wording (`orchestrator_finalize_test.ts`, `finding-prompt` wire-contract tests, anything matching "Write the complete final Findings report" or "Confirmed findings grouped by type").
   - `CLOSING_TABLE_RULE` (`lib/finding-prompt.ts:71`) still describes rows the model no longer writes. Leave it unless JD says otherwise; note it.
3. **Ask JD one design question before writing code:** should the two directives ask for the marker only when expansion is enabled (`findingsTableExpansionEnabled()` in `env.ts`), so the kill switch also restores the old wording and no raw `{{FINDINGS_TABLE}}` can reach a report — or unconditionally, like `system-prompt.ts:173` does today? Recommend the conditional form; it makes the switch a clean rollback for both prompts.
4. **Tests first (red):** each directive contains `## Findings` and `{{FINDINGS_TABLE}}` on its own line; neither asks for confidence or tier labels to be typed; (if conditional) with the switch off, both return the previous wording byte-for-byte. Then the change (green). Update pinned-wording tests deliberately, one by one, and list them in the PR.
5. **Proof key:** extend `checks.findings_table` (`health-handler.ts` ~:721) with a field showing both directives carry the marker (e.g. `directives: "finalize+salvage"`), or add a durable log field — one new proof per behaviour-changing edge PR. No second `/health` key if the existing one can carry it.
6. **Run** the verification below; open the PR READY; subscribe; stop and ask JD: merge? then deploy?

# Verification

    npm run typecheck && npm run lint && npx vitest run
    DENO_INSTALL=/usr/local sh <(curl -fsSL https://deno.land/install.sh) -y   # Deno is not preinstalled
    cd supabase/tests/osint-agent && deno test --config=../../functions/osint-agent/deno.json --no-check --no-lock --allow-net --allow-env --allow-sys --allow-read . ../evidence-export
    npx eslint supabase/functions/osint-agent/orchestrator-finalize.ts supabase/functions/osint-agent/health-handler.ts

Baselines (CI push runs, 2026-11-07): edge 2988 / 0 / 6 on `b1b2313`; vitest 3278 / 2 skipped / 276 files and e2e 127 / 10 on `5af7edf`. `src/` is untouched by this PR. Never bare `tsc`.

# After the deploy (a later step, JD's go)

Measure adoption on the stored message, not the logs (`findings_table_expanded` is a `console.log` only): count assistant messages since the deploy that contain the engine header `| # | Finding / value | Kind | Basis | Source | Label | Confidence | Source classes |`, the raw `{{FINDINGS_TABLE}}`, or the `_Findings table unavailable` / `_Findings table withheld` lines. Read text via `jsonb_array_elements(parts)->>'text'`. Counts and flags only, never message text. Note which path wrote each report (last parts `record_artifacts` → `memory_save` → text = forced finalize; a salvage part = salvage).

# Return

Changed files; tests with real counts (red → green); the proof key and its value; what you did NOT do and why; remaining risks; the PR link; the question for JD (merge? deploy?).

# Queue after this session — do not start unless JD names it (one PR each; measured 2026-11-04 on `e872203`, still open 2026-11-07)


Frontend (merge-when-green, their own session — do not mix into this one):
1. **Attachment-seeded cases have no subject.** When the first message is only an attachment, the stored title is the raw attachment markdown ("Attached files: - [file](https://…storage…)"), the seed kind is `url` on a signed storage URL, and the identity-cluster engine has nothing to link to: every ledger row reads Unresolved ("N tied to the seed only by discovery"), the Workbench says "No name holds for the subject yet", the export says "Detected subject: attached files -". #966 (`src/lib/case-name.ts`, `src/lib/seed.ts`) fixed the pasted-export title but not this. Fix shape: title from the attachment's file name (`src/lib/attachments.ts` parses the block); an analyst-driven "Set as subject" on an evidence row (never automatic, audited); seed kind `attachment`, not `url`. Needs JD's design call on where "Set as subject" lives (context menu/inspector, no new toolbar button).
2. **Quarantine basis text duplicates**: the ledger's Evidence-basis column renders "Shared infrastructure · Shared infrastructure · not ownership proof" — the status label and `evidence-status.ts:270`'s basis string are both printed. One-line fix plus a test.
3. **Harness fixture** has no row linked to the subject beyond the seed (11-02 handoff §3) — only the unit test exercises "Connections identified". Sanitised synthetic row.

Edge (one build each, JD's go):
4. **`indicia_web_dbs` schema gap** — reproduced live today: `HTTP 400: snusbaseType is required when snusbase is selected`. No PR, no code reference to `snusbaseType` anywhere. Schema `refine` in `tool-registry.ts` so the pair is required together; a test; proof key.
5. **Heartbeat fix** (11-01 glm-5.3 handoff §5): `recovery.ts:879` `startRunHeartbeat` still sets `inFlight` before the write and clears it only in `.finally()`, no timeout bound, predicate `.eq("id").eq("status","active")` lacks `run_started_at`. Bounded write timeout + clear in `finally` + `run_started_at` in the predicate. Offline-testable. Separate from (6).
6. **Durable admission row** — #903 is a docs proposal; its four decisions are JD's.
7. **GLM pricing** — `index.ts:1975` meters every GLM model at flat `[0.3, 1.2]` (fallback `[0.3, 2.5]`) micro-USD/token; `glm-5.3-flash` is overcharged ~2×, `glm-5.2` was undercharged ~4×; GLM salvage tokens are not metered at all. Per-model table in the shape of `costs.ts:272` `ANTHROPIC_RATES_MICRO_USD_PER_TOKEN` with a pessimistic unknown-model fallback and `pricing_known`; do NOT add a second `onCost` feed.
8. **Claude adjudicator** for ambiguous / name-collision clusters — `cluster_adjudications` table exists (#961/#962), zero code references; spends the Anthropic key; design first, JD's go.
9. **Operator Directives panel** via `agent_memory` `kind='lesson'` (`lib/memory-brief.ts:269` already reads them; /brain has `OutcomeLessonsPanel` from #968) — grep before building.
10. **Board triage** owed to JD: #929 READY (edge, English-only orchestrator); drafts #883, #882, #821, #804, #800, #793, #763, #701, #613, #593, #516. Codex review credits: JD's call.
11. **Security observation** (11-01 audit §0): `anon`/`authenticated` hold default privileges incl. TRUNCATE on `orchestrator_invocations` / `orchestrator_step_metrics` in production (RLS does not cover TRUNCATE; #962 fixed the same shape for `cluster_adjudications` only). Chase or leave — JD's call.
```
