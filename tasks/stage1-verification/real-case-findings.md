# Real-case verification findings (datatracera.com, 2026-10-25)

Captured during local-build visual verification on JD's `localhost:8083` running against the live Supabase backend with the `datatracera.com` case (27 evidence · 27 tool calls · 1 verified · $0.147 spend).

**Not production verification.** `localhost:8083` is a local frontend connected to the live backend. These findings describe rendered states against real data; they do NOT verify the Vercel production deployment, do NOT verify dispatch behavior, do NOT verify backend correctness. Screenshots demonstrate what the UI renders when given real case data.

**#874 dependency note.** This branch does NOT carry #874's "preview-first — remove best-card one-click dispatch." The Best Next Pivot card renders both a `Run now` button and a `Preview` button. If/when #874 merges, Run-now would be removed. Preview-first behavior should NOT be claimed on this branch. Visual verification must not click `Run now` or start a real investigation.

**Exact tested head on local build:** UNVERIFIED — must be confirmed with the operator (JD) by comparing the local worktree's HEAD against the branch heads we know (`340332f1` on this worktree; the local build at `:8083` may be running from a different worktree).

## Findings — presentation / wording / grouping (record only; no scope expansion in Stage 1b)

### F-1 (HIGH) · "No authoritative finding rows" alongside "1 verified" — different scopes, not labeled

**Code trace of the two labels:**

- **"1 verified (1 analyst-confirmed)"** in the case header. Source: `src/lib/authority.ts` — `verifiedLabel(n, m)` wraps `authorityFor(a, r)` which classifies each artifact into `verified | probable | review | conflict | quarantined | excluded | lead`. The "verified" state means "Corroborated by 2+ independent source classes, OR analyst-confirmed" (per LEGEND at `authority.ts:320`). **Scope: ALL 27 artifacts in the case**, each classified by `authorityFor`. One row reached `verified` via analyst click.
- **"No authoritative finding rows were recorded for this run"** in the report body. Source: `src/components/ChatWindow.tsx:1278/1300`; detector at `src/lib/message-integrity.ts:38` (regex `NO_AUTHORITATIVE_ROWS = /No authoritative finding rows were recorded/i`). This checks whether the model invoked the `record_finding` tool during the latest run. **Scope: this run's `record_finding` tool outputs, a different storage path than the artifacts table.**

The UI shows both numbers without labeling the distinction. A reader can reasonably infer "no scoring happened" (wrong — authority was computed for every artifact). JD's correction stands: label scopes explicitly, remove unsupported implications that no scoring occurred.

**Required fix shape (deferred; not in Stage 1b):**
- Case artifacts breakdown: "Case artifacts (27): 1 verified · 19 review · 2 conflict · 1 lead · ..." using `authorityFor` lingo.
- Model-adjudicated findings this run: "0" with "The model did not call `record_finding` this run. Artifact-level authority was still computed and is shown above."

### F-2 (MEDIUM) · Narrative recommends content research; Next recommends low-priority IP lookup + nameserver research

Visible mismatch: the agent's prose assessment on datatracera.com suggests content-side pivots (`/policy`, `/modules`, `/reviews` scraping), but the Workbench Next tab's Best Next Pivot is `LOW` priority "Check IP attribution" on `2620:4d:4000:6259:7:13:0:1`.

Required: trace the ranking inputs that produced the LOW infrastructure pivot vs. the stated content-research assessment. Report prior attempts (via `pivot-attempts` / `useThreadPivotAttempts` which live on #873's branch, NOT this one). Do NOT change ranking policy — this is a diagnostic trace, not a Stage 1b fix.

### F-3 (MEDIUM) · Connections lists `76.76.21.21` twice (once as `infrastructure`, once as `ip`)

Visible in the Unlinked candidates list. Both entries are real records with distinct typing — grouping for navigation is the correct action; neither record should be deleted; authority on each must stay distinct.

Required fix shape (deferred): collapse into one visual row with a "shown as infrastructure, ip" sub-note. Preserve both underlying records, their provenance, and the `type:normalizedValue` dispatch keys that CLAUDE.md's quarantine section explicitly requires.

### F-4 (MEDIUM) · Sheet subject empty state assumes a person for a domain case

The Sheet currently reads: "No name holds for the subject yet. Quarantined and rejected names are never used here." — correct phrasing for a person investigation (what Stage 1 shipped for the `alex.morgan@example.com` prototype case). For a domain investigation (`datatracera.com`), the subject IS the domain; what's unresolved is the operator identity.

Required fix shape (deferred): switch empty-state copy on case kind:
- Person case: current wording stays
- Domain case: "Subject: `datatracera.com`. Operator identity: unresolved."
- IP / URL / handle cases: equivalent framings per kind

### F-5 (LOW) · "27 entities, 0 shared links" in Next vs clearer Connections wording

The Workbench Next tab's Connected-so-far summary ("27 entities, 0 shared links, 2 clusters, 27 tied to the seed only by discovery, 9 withheld as unproven not counted") uses the pre-Stage-1b phrasing. Connections tab now uses the clarified wording ("Clustering groups candidates by shared signal; it does not establish identity.") shipped in `58d63c85`. Terminology should be consistent.

Required fix shape (deferred): reuse Connections' clarified wording in Next's summary. Pure copy change.

## Deferred to future stage

All five findings are RECORDED here. **No implementation during Stage 1b.** Presentation fixes separate from any ranking changes. #872 / #873 / #874 branches untouched throughout.

## Standing rails confirmed

`REVEAL_BREACH_DATA` enabled; raw records, provenance, masking, redaction, env vars, secrets, export visibility all untouched. No scoring, pivot ranking, review writer, report generator, authority predicate, or schema change contemplated by these findings.
