# Audit: pivot workflow and analytical language

**Date:** 2026-10-24  
**Auditor:** Claude (read-only, no code changes)  
**Baseline:** `main` at `70766fce` · CI status not independently verified (no runs returned for this commit via `gh run list`)  
**Branch:** `claude/insight-finder-audit-f6d7d0` (read-only worktree, no changes committed)

## Limitations

- **No live-case access.** No investigation connector or authenticated page was attempted in this session. All case-specific claims from the audit prompt's screenshots are treated as unverified.
- **`/health` not called** (GET `?health=1` runs stale-thread recovery, sweeps, provider pings — a write side-effect). Live build state is taken from the latest deploy record: `chore(deploy): record live build 845f15e (#867)`.
- **Screenshot observations are evidence class: screenshot-only.** They are not proof of which code path, prompt, or stored data produced the visible text.
- **No production writes, paid lookups, merge/deploy, secret/provider/flag changes, or PR-state changes were made.**
- **`metadata.dob` writer not traced.** Who writes DOB into name artifact metadata was not examined. If the model writes it via free-form metadata, that is the same channel as the metadata self-promotion P0 (see memory), and display-side qualification is a band-aid.

---

## Finding 1 — Pivot execution contract mismatch (Audit area 1)

**Evidence class:** code path confirmed  
**Severity:** Medium (misleading product contract; no evidence of duplicate runs)  
**Status:** Reproducible in current source

### The contract says one thing; the code does another

Both `WorkbenchNext.tsx:18-21` and `Workbench.tsx:11` promise Preview first. The Workbench docstring adds: "Nothing here is a new authority or a new path to a run." The `WorkbenchNext.tsx` docstring says:

> "Every Run still opens its Preview first, and nothing is queued."

But `requiresPreview` in `best-pivot.ts:57-62` returns `false` for ordinary, clean pivots — those with no rerun, no unproven linkage, and no warnings (excluding `REPORT_ONLY_WARNING`). When it returns false, `NextSteps.tsx:266` binds the "Run now" button directly to `onRunNow`, which dispatches `proximity:run-pivot` immediately. The "Preview" button is rendered separately alongside it.

**Dispatch surfaces (4 confirmed):**
| Surface | File | Line |
|---------|------|------|
| WorkbenchNext | `src/components/workspace/WorkbenchNext.tsx` | 114 |
| PivotsTab | `src/components/panel/PivotsTab.tsx` | 195 |
| ArtifactPivotAction | `src/components/pivots/ArtifactPivotAction.tsx` | 68 |
| ChatWindow transcript rail | `src/components/ChatWindow.tsx` | 2262 |
| review.ts (programmatic) | `src/lib/review.ts` | 119 |

**Impact:** The operator can dispatch a clean pivot from any of these surfaces without seeing a preview. The docstring promise is broken for the most common case (ordinary unsearched pivot with no warnings).

**What this is NOT:** There is no evidence of duplicate dispatches or double-billed runs. The `proximity:run-pivot` event is listened to in exactly one place (`ChatWindow.tsx:2248`), and the submit guard (`submit-guard.ts`) blocks concurrent sends. The problem is a contract mismatch, not a safety failure.

### Recommendation

Determine whether the one-click dispatch for clean pivots was a deliberate design choice or an oversight (`git log -S"requiresPreview" --oneline -- src/lib/best-pivot.ts` will show when it was introduced; check the PR body). If deliberate, the docstrings in both files need updating. If not, the Workbench is an unpreviewed run path and `requiresPreview` needs to return true for Workbench-sourced dispatches.

---

## Finding 2 — Workbench action controls are misleading during active runs (Audit area 2)

**Evidence class:** code path confirmed  
**Severity:** Low-Medium (misleading controls, not a safety failure)  
**Status:** Reproducible in current source

### Busy state is never passed to the pivot controls

`WorkbenchNext.tsx:126-134` renders `<NextSteps>` without a `busy` prop, so it receives the default `false` (`NextSteps.tsx:48`). The "Run now" button's disable condition is `busy && !needsReview` (`NextSteps.tsx:265`), which with `busy=false` is always false — the button is never disabled by run state.

### The `proximity:run-pivot` listener is always mounted

ChatWindow lives inside the workspace (`AppShell.tsx:34` comment) and stays mounted across all workspace tabs (Investigate, Evidence, Tools, Graph, Report). The listener at `ChatWindow.tsx:2248` is always active. So a `proximity:run-pivot` dispatch from WorkbenchNext will always reach its listener — the "dispatching to nobody" concern does not apply when the workspace is open.

However, `hasPivotRunner(threadId)` at `WorkbenchNext.tsx:121` is a snapshot read from a module-level `Map<string, number>` (`pivot-runner.ts`). There is no subscribe mechanism, so the text "Open this case in the workspace to run them" can appear even while a runner is registered — or disappear while one is not.

### The real gap

The controls look actionable during an active run because:
1. `busy` is hardcoded `false`
2. `hasPivotRunner` is not reactive (snapshot, no subscription)
3. The existing submit guard (`isSubmitBlocked` in `submit-guard.ts`) uses three inputs — chat `status`, synchronous `locked` ref, and `serverRunActive` from `caseSnapshot.run.state` — but this guard only fires when the `proximity:run-pivot` event reaches ChatWindow and it calls `sendText`. The button appearance does not reflect this.
4. Even with `caseSnapshot.run.state === "running"` passed as `busy`, the guard's other two inputs (`status` and `locked`) live inside ChatWindow. The button would still look enabled in the "starting" window before `serverRunActive` fires.

**What this is NOT:** The downstream guards DO work. `submitRefusal` will return `"running"` or `"server_running"` when appropriate, and the event handler in ChatWindow will refuse the send. **The refusal IS surfaced** — `ChatWindow.tsx:2240` shows a toast: `"A run is in progress on this case. Start the pivot when it finishes."` The issue is that the button **looks enabled** when the action would be refused. The visual state (button appearance) does not reflect the runtime guard, so the analyst must click and read the toast to discover the action is blocked.

### Recommendation

Pass `busy` from a reactive source (e.g., `caseSnapshot.run.state === "running"`) into `NextSteps`. This covers only one of the guard's three inputs; a complete solution would have ChatWindow publish its guard state. The toast refusal already works (`ChatWindow.tsx:2240`); the gap is the button's disabled appearance, not the feedback channel.

---

## Finding 3 — Pivot explanation copy could be hedged (Audit area 3)

**Evidence class:** code path confirmed; Recheck reset exercised (`pivot-engine.ts:411`); dismissed-artifact scenario structural, not exercised  
**Severity:** Low-Medium (Recheck "No tool has run" is a confirmed explanation defect, not merely hypothetical)  
**Status:** Reproducible in current source

### "No tool has run against it yet" is wrong for Recheck candidates

`explainPivot` in `best-pivot.ts:22` emits this text when `pivot.status === "new"`. The `WorkbenchNext.tsx:70` filter keeps only `status === "new"` pivots, so the condition appears tautological — but it is not.

`pivot-engine.ts:405-411` explicitly resets candidates flagged for recheck back to `status = "new"`:
```typescript
if (decisions.recheckKeys.has(ck)) {
  decision = "recheck";
  status = "new";        // ← a previously-searched target becomes "new" again
  priority = "high";
  actionLabel = "Re-verify finding";
```

A recheck candidate has already been searched — the analyst asked for another look. Displaying "No tool has run against it yet" for such a candidate is **factually wrong**, not hypothetical. This is a reproducible explanation defect: any recheck candidate will show the misleading text.

The `queriedSet` incompleteness concern (variant spellings, trimmed tool logs) remains hypothetical but structurally possible.

### "Running it is how it gets a second source" is a promise, not a fact

`best-pivot.ts:23-24`: "Only one recorded row points at it, so running it is how it gets a second source." A search MAY find another source; it cannot guarantee one. The word "is" implies certainty.

Additionally, `sources.length` on line 21 counts `pivot.sourceArtifactIds.filter(id => artifactsById.has(id))`. If an artifact was dismissed or removed from the visible set, a pivot with two original sources could show `sources.length === 1` and trigger this text incorrectly — **hypothesized, not exercised.**

### "The report ranked it high" conflates priority sources

`best-pivot.ts:32`: emitted when `pivot.priority === "high"`. But priority can come from the report recommendation, the analyst (via `decisions.keyKeys` at `pivot-engine.ts:417-420`), or the engine's scoring. Saying "the report ranked it high" is wrong when the analyst set the priority.

### Recommendation (copy-hedging, not a correctness fix)

- Consider hedging "No tool has run" to "Not yet searched in this investigation"
- Replace "is how it gets a second source" with "may find a corroborating source"
- Replace "The report ranked it high" with "Marked as high priority" (source-neutral)

---

## Finding 4 — Four source-counting systems, two of which overstate (Audit area 4)

**Evidence class:** code path confirmed; drift impact hypothesized (no concrete fixture showing systems #1 and #4 disagreeing on the same artifact)  
**Severity:** High (inflated corroboration claims shown to the analyst)  
**Status:** Reproducible in current source

### The four systems

| # | Where | What it counts | Label used | Honest? |
|---|-------|---------------|------------|---------|
| 1 | `confidence.ts:81-87` | `src.all.length` — raw token strings from `tokenizeSourceChain` (splits on `+`, `,`, `/`) | "Found across N independent sources" | **No** — tokens are provider labels, not independent datasets |
| 2 | `intel.ts:540-544` | `independentSourceClasses` via `source_category`, filtered by `NON_CORROBORATING_CLASSES` | Used in `labelForArtifact` authority labels | **Yes** — the authoritative system |
| 3 | `CaseReport.tsx:364` | `subjectBreaches` — artifact ROW count filtered by `forSubject` and breach kind | "distinct breach corpora" | **No** — rows ≠ corpora; multiple rows can reference one breach |
| 4 | `source-independence.ts:162` | `computeEffectiveSourceCount` — collapses by origin (corpus/provider), mirror-pool, and aggregator host | Used in audit/report pipeline only | **Yes** — designed to prevent false corroboration |

### The drift

`explainConfidence` (system #1) is called by `ConfidenceExplain.tsx` (per-artifact popover) and `EvidenceMatrixTab.tsx` (evidence matrix). It tells the analyst "Found across 3 independent sources" while `computeEffectiveSourceCount` (system #4) might say "1 effective source" for the same artifact — **this disagreement has not been demonstrated with a concrete fixture**, but the counting methods are structurally different. The badge `"Multi-source corroborated"` (`confidence.ts:138-140`) fires when `src.all.length >= 2` — again counting tokens, not independent datasets.

`CaseReport.tsx:364-366` says "Subject appears in N distinct breach corpora" where N is the row count. Three credential rows from the same breach (email, username, password hash) count as three "distinct corpora."

### The honest systems are used — but not where the analyst reads

System #4 (`computeEffectiveSourceCount`) is used in `CaseReport.tsx:1092` (the audit pipeline), `ReportCardV2.tsx:44` (preview), and `report-serializer.ts:55` (export). System #2 (`independentSourceClasses`) drives the authority labels. But the **per-artifact confidence explanation** the analyst reads uses system #1, and the **breach summary note** uses system #3.

### Recommendation

**The three honest metrics measure different things — don't conflate them:**
- **Source classes** (system #2, `independentSourceClasses`): how many independent *categories* of evidence (e.g., breach, social, public record) — the right metric for "independent corroboration"
- **Effective sources** (system #4, `computeEffectiveSourceCount`): how many truly distinct datasets after collapsing mirrors and aggregators — the right metric for "how many places found this"
- **Distinct breach corpora**: how many separate breaches contain the data — different from both row count AND effective source count

What is **wrong** is system #1 counting raw provider-label tokens as "independent sources" and system #3 counting artifact rows as "distinct corpora." The fix is:
- `explainConfidence` should use source classes (system #2) when saying "independent sources" — that is what "independent" means in the product's own authority labels
- The "Multi-source corroborated" badge should use the same source-class count
- `CaseReport.tsx:364` breach summary should count distinct breach names (from artifact metadata), not artifact rows — OR use effective sources with language that says "effective sources" rather than "distinct corpora"
- This is a frontend-only change (the authoritative systems already exist and are correct)

---

## Finding 5 — DOB/age displayed without independence or review check (Audit area 5)

**Evidence class:** code path confirmed (the display gap); screenshot-only (the specific case observation); **metadata writer not traced**  
**Severity:** High (unsupported identity claim displayed as fact)  
**Status:** The code gap is reproducible; the screenshot's specific inference path is unverified

### The gap in `buildSubjectProfile`

`CaseReport.tsx:751-770`: The function picks the highest-confidence name artifact via `topByConfidence`, correctly notes when it's single-source (line 759-765: "Candidate — needs review"), then at lines 768-770:

```typescript
const dob = m.dob ? String(m.dob) : "";
const age = m.age != null ? String(m.age) : "";
if (dob || age) out.push({ label: "DOB / Age", value: ... });
```

The DOB/age field is pulled from the name artifact's metadata with **no independence check, no review check, and no source-class check**. Even when the name itself is annotated "Candidate — needs review," the piggybacking DOB appears as a plain fact in the Subject Profile.

### The safeguard that does NOT cover this

`intel.ts:2352-2381` (CO_RECORD_FIELDS) deliberately excludes DOB from identity linkage — this is the graph-link guard. But `buildSubjectProfile` is a display function, not a linkage function. The exclusion prevents DOB from creating identity graph edges; it does not prevent DOB from being displayed as a fact.

### The metadata writer is untraced (important caveat)

Who writes `metadata.dob` and `metadata.age` on name artifacts was NOT examined. If the model can write these through free-form metadata (as it can with other fields — see the metadata.source self-promotion P0 in memory), then display-side qualification is only a band-aid; the real fix is at the write side. **This must be determined before scoping PR 3.**

### The narrative layer (unverified)

The screenshot shows a running narrative linking breach-derived signals to what appears to be a birth-year or DOB-like assertion. The exact code path that produced this is NOT established — it could be the model's prose (which is not gated by `hasStatedLabel` unless it uses bracket labels like `[CONFIRMED]`), it could be memory replay, or it could be the report builder. The `hasStatedLabel` regex at `ChatWindow.tsx:777` matches `[CONFIRMED]|[CORRELATED]|...` bracket labels only; prose assertions without brackets escape both guards.

**What I did NOT examine (and the prompt says to verify end-to-end):** The memory/context layer for DOB propagation, the system prompt's treatment of DOB, how `applyMemoryContext` handles DOB-adjacent claims, and the metadata writer. These remain unverified.

### Recommendation

- Trace who writes `metadata.dob` before choosing a fix. If the model writes it via free-form metadata, the fix is at the write side (same shape as metadata.source self-promotion).
- If the writer is a structured tool, add source-class or review checks to DOB/age display in `buildSubjectProfile`, matching the name's own qualification
- The narrative layer requires the PR B design (report-authority boundary) from the existing plan
- Do NOT widen `hasStatedLabel` with prose pattern matching (CLAUDE.md: "intent is NOT inferred from prose")

---

## Finding 6 — Area-code collision triggers generic "different people" warning (Audit area 6)

**Evidence class:** code path confirmed; downstream impact hypothesized (the function enclosing `intel.ts:3142` and what consumes `collision` were not fully traced)  
**Severity:** Low-Medium (misleading language; **changing the boolean is an evidence-integrity signal change requiring sign-off**)  
**Status:** Reproducible in current source

### The boolean collapse

`intel.ts:3142`:
```typescript
collision = dupeName || conflictingStates || conflictingEmailRegions || conflictingAreaCodes;
```

When `conflictingAreaCodes` is true but `dupeName` is false, the generic warning at `intel.ts:3157-3160` fires: "may belong to different people." This is an overstatement — area codes indicate where a number was issued, not where the holder lives. The area-code-specific warning at `intel.ts:3171-3174` is correctly qualified as "only a lead," but the generic warning fires first and is stronger.

### Recommendation

**Wording-only fix:** qualify the generic warning when `conflictingAreaCodes` is the only contributor and `dupeName` is false. Do NOT exclude `conflictingAreaCodes` from the `collision` boolean itself — that changes an evidence-integrity signal and requires JD sign-off.

---

## Finding 7 — HIBP password occurrence count mislabeled (Audit area 7)

**Evidence class:** code path confirmed  
**Severity:** Medium (incorrect semantics in tool description; propagates through narrative)  
**Status:** Reproducible in current source

### The mislabel

`tool-registry.ts:3817` describes the HIBP Pwned Passwords `count` field as "how many breach corpora contain that password." This is wrong. The HIBP Pwned Passwords API returns **how many times that password hash appears in the dataset** (per [HIBP's own documentation](https://haveibeenpwned.com/API/v3#PwnedPasswords): "a count of how many times it appears in the data set"). A count of 50,000 means the hash appears 50,000 times, not that 50,000 databases contain it.

### The code is correct; the description is not

`tool-registry.ts:3845` correctly returns `{ ok: true, pwned: count > 0, count }` — the value is passed through faithfully. The problem is the description, which the model reads and uses when composing narrative.

### Propagation chain (6 files)

| File | What it says |
|------|-------------|
| `tool-registry.ts:3817` | "how many breach corpora contain that password" (**wrong**) |
| `catalog.ts:117` | "appears in breach corpora" (**imprecise**) |
| `system-prompt.ts:109` | `{ pwned, count }` — no label |
| `source-classification.ts:146` | classified as "breach" |
| `report-source-labels.ts:26` | "password exposure check" |
| `costs.ts:36` | cost = 0 |

### Caveat: `source-classification.ts:146`

If a password-range hit counts as a "breach" source class for the subject, that is a corroboration path beyond the label fix — a single HIBP lookup would contribute toward the "2+ independent sources" threshold. **Not verified** whether this actually happens in practice. If it does, "edge-only string fix" is incomplete.

### This is an edge function change

Change the description in `tool-registry.ts` and `catalog.ts` to match HIBP's own definition: "how many times this password hash appears in the data set." This requires the full edge deploy cycle (stamp → sync → gate → Lovable deploy → `/health` verify). Whether it needs its own `/health` key is a JD decision — it's a description string, not a behavioral change.

---

## Finding 8 — Cross-case state leak in WorkbenchNext (Audit area 8)

**Evidence class:** code path confirmed; cross-case dispatch safety NOT established  
**Severity:** Medium (stale selector from case A could dispatch against case B; needs interaction test)  
**Status:** Reproducible in current source

### No `key={threadId}` at mount site

`ChatPage.tsx:242`:
```tsx
<Workbench threadId={threadId} />
```

React does not reset `useState` when only props change. `WorkbenchNext` at line 31 uses `useState<RecommendedPivot[]>([])` for `reportPivots` and `useState<string | null>(null)` for `open`. When the user switches cases (changing `threadId`), these states persist from the prior case until the `useEffect` at line 35-43 fires and replaces them.

### The stale state is transient but NOT proven safe

The `useEffect` dispatches `swarmbot:request-report-pivots` with the new `threadId` (line 41). ChatWindow's handler (`ChatWindow.tsx:2817-2822`) guards on `detail?.threadId !== threadId` — it only responds when the requested thread matches its own. Since ChatWindow's props have already updated to the new case, it responds with its `reportPivots` for the new case (empty or populated), which replaces the stale state in WorkbenchNext.

The `proximity:run-pivot` dispatch at `WorkbenchNext.tsx:114` uses `threadId` from props (already the new case). **However, the selector payload (`value`, `type`, `prompt`) comes from `reportPivots` state — which is still the OLD case's data during the stale window.** A click during this window sends `{threadId: caseB, value: <selector from caseA>}` — a cross-case dispatch where a selector from one subject is run against a different subject's case.

**The "no wrong-subject-run risk" claim is NOT established.** The threadId is correct, but the selector's provenance is not. This needs an interaction test (mount with case A pivots, switch threadId to B, verify items list is empty or refreshed before any button is clickable). The `key={threadId}` fix at `ChatPage.tsx:242` addresses this by resetting all component state on case switch.

### Better fix location: `ChatPage.tsx:242` not `Workbench.tsx:75`

Adding `key={threadId}` to `<Workbench>` at `ChatPage.tsx:242` is better than per-panel keys because it also resets `tab` and `visited` state, which is correct behavior on case switch:
```tsx
<Workbench key={threadId} threadId={threadId} />
```

### Items read, not exercised

- **Preview invalidation on dismiss/quarantine:** `pivotEligibility` re-evaluates on every `computePivots` call, which reads live artifact and review state. Read, not exercised.
- **Evidence-to-Connections handoff:** Not verified.
- **Narrow screens:** Not verified (would require visual testing).
- **e2e coverage:** No case-switch test found in `e2e/` (no `threadId` references, no case-switch patterns).

---

## Data-lineage table: source → display

```
Tool output (provider response)
  ↓
artifact persisted (kind, value, confidence, metadata, source, source_category)
  ↓
┌─────────────────────────────────────────────────────────────────────────┐
│                    FOUR COUNTING PATHS DIVERGE                         │
├─────────────────────────┬───────────────────────────────────────────────┤
│ confidence.ts           │ tokenizeSourceChain(source) → raw token      │
│ (per-artifact popover)  │ count → "N independent sources" [WRONG]      │
├─────────────────────────┼───────────────────────────────────────────────┤
│ intel.ts                │ source_category → independentSourceClasses    │
│ (authority labels)      │ → filtered by NON_CORROBORATING [CORRECT]    │
├─────────────────────────┼───────────────────────────────────────────────┤
│ CaseReport.tsx          │ artifact rows of breach kind → count →       │
│ (breach summary)        │ "N distinct breach corpora" [WRONG]          │
├─────────────────────────┼───────────────────────────────────────────────┤
│ source-independence.ts  │ origin (corpus/provider) → collapse mirrors  │
│ (audit pipeline)        │ → computeEffectiveSourceCount [CORRECT]      │
└─────────────────────────┴───────────────────────────────────────────────┘
  ↓
Report builder → CaseReport display
  ↓
Export (evidence-export reads evidence_log, not prose)
```

---

## Ranked findings summary

| # | Finding | Severity | Evidence class | File(s) | Fixable in |
|---|---------|----------|---------------|---------|-----------|
| 4 | Source-counting drift: "independent" ≠ independent | High | code path confirmed; drift hypothesized | confidence.ts:81-87, CaseReport.tsx:364 | Frontend PR |
| 5 | DOB/age displayed as fact without review check | High | code path confirmed; metadata writer untraced | CaseReport.tsx:768-770 | Frontend PR (after tracing writer) |
| 1 | Pivot contract says Preview-first; code dispatches directly | Medium | code path confirmed | best-pivot.ts:57, WorkbenchNext.tsx:18, Workbench.tsx:11 | Frontend PR |
| 7 | HIBP count mislabeled as corpus count | Medium | code path confirmed | tool-registry.ts:3817, catalog.ts:117 | Edge PR |
| 2 | Busy state not shown in Workbench controls; silent refusal | Low-Med | code path confirmed | WorkbenchNext.tsx:126, ChatWindow.tsx:2248 | Frontend PR |
| 6 | Area-code collision overstates "different people" | Low-Med | code path confirmed; downstream hypothesized | intel.ts:3142 | Frontend PR (wording only) |
| 8 | Cross-case stale selector dispatch (safety not established) | Medium | code path confirmed; cross-case dispatch NOT proven safe | ChatPage.tsx:242 | Frontend PR (1 line + interaction test) |
| 3 | Pivot explanation wrong for Recheck; copy could be hedged | Low-Med | code path confirmed; Recheck defect exercised | best-pivot.ts:22-32 | Frontend PR (copy only) |

---

## Implementation plan (approval-gated)

> **Memory note:** JD wants frontend-only work in ONE ready PR. The plan below proposes grouping frontend findings into two PRs (controls + semantics), plus one edge PR. Adjust grouping per JD's preference.

### PR 1 — Workbench controls and cross-case leak (frontend only)

**Scope:** Findings 1 (contract), 2 (busy + silent refusal), 3 (copy hedging), 8 (cross-case stale display)

1. Add `key={threadId}` to `<Workbench>` mount at `ChatPage.tsx:242`
2. Pass `busy` from `caseSnapshot.run.state === "running"` through WorkbenchNext into NextSteps
3. Hedge `explainPivot` copy:
   - "may find a corroborating source" (was: "is how it gets a second source")
   - "Marked as high priority" (was: "The report ranked it high")
4. Update `WorkbenchNext.tsx` and `Workbench.tsx` docstrings to match actual behavior
5. Tests: new unit tests for `explainPivot` with fixture pivots; Workbench mount/unmount test with threadId switch

**Verification:** `npm run typecheck`, `npm run test:e2e` (hand-run — PR CI skips it), harness before/after screenshots at the same viewport.

**Does NOT change:** `requiresPreview` logic, submit guard, downstream dispatch guards, confidence scoring, ranking, auto-run behavior.

**Decision for JD:** Should Workbench pivots ALWAYS go through Preview (enforce the docstring), or should the docstring be updated to match the code (clean pivots dispatch directly)? Check `git log -S"requiresPreview" --oneline -- src/lib/best-pivot.ts` for the original intent.

### PR 2 — Source-counting alignment, DOB qualification, collision wording (frontend only)

**Scope:** Findings 4, 5 (display side only), 6 (wording only)

1. `explainConfidence` uses `independentSourceClasses` or `computeEffectiveSourceCount` instead of `src.all.length`
2. `badgesFor` "Multi-source corroborated" uses the same honest count
3. `CaseReport.tsx` breach summary uses `computeEffectiveSourceCount` on breach artifacts
4. `buildSubjectProfile` qualifies DOB/age when the parent name artifact is single-source or unreviewed (**after tracing the metadata writer** — if model-authored, this is a band-aid and the write side needs the fix)
5. Qualify the generic collision warning when `conflictingAreaCodes` is the only contributor and `dupeName` is false (wording only — do not change the `collision` boolean itself)
6. Tests: unit tests with fixtures showing token count ≠ effective count; DOB qualification test; collision wording test

**Verification:** `npm run typecheck`, `npm run test:e2e`, harness screenshots.

**Does NOT change:** The stored `confidence` value, `intel.ts` authority labels, the audit pipeline, scoring math, the `collision` boolean, or any edge function.

### PR 3 — HIBP description fix (edge only)

**Scope:** Finding 7

1. Change `tool-registry.ts:3817` description to match HIBP's own definition: "how many times this password hash appears in the data set"
2. Change `catalog.ts:117` to match
3. Verify whether `source-classification.ts:146` treats a password-range hit as a "breach" source class contribution. If so, note in the PR that the label fix is necessary but not sufficient.
4. Tests: existing HIBP tool test + catalog-guidance contract test

**Edge deploy cycle:** stamp → surgical sync → hard gate → Lovable deploy → `/health` verify → ledger.

### Deferred (existing plan items, not new)

- **Narrative integrity / report-authority boundary (PR B design):** The full narrative labeling work is already designed in the existing plan. Finding 5's narrative layer depends on it.
- **Memory authority (PR A):** Already drafted as #738.
- **metadata.dob writer trace:** Required before committing to a display-only fix for Finding 5.
- **Historical data migration:** No changes to stored records without a correction policy approved by JD.

---

## Acceptance tests (synthetic fixtures only)

All tests use synthetic data, never live case data. All PRs require `npm run typecheck`, a hand-run `npm run test:e2e`, and harness before/after screenshots.

### PR 1
- `explainPivot({sources: [{id: "a"}]})` → text says "may find" (not "is how it gets")
- `explainPivot({priority: "high"})` → text says "Marked as high priority" (not "report ranked")
- `explainPivot` with a recheck candidate (`decision: "recheck"`) → text does NOT say "No tool has run against it yet"
- WorkbenchNext with `key={threadId}` on parent: mount with threadId A, switch to B, verify `reportPivots` state resets AND no stale items are clickable before the new case's data arrives (interaction test)
- NextSteps with `busy=true`: "Run now" button is disabled

### PR 2
- Artifact with `source: "LeakCheck+DeHashed"` → `explainConfidence` should count source classes (system #2), NOT raw tokens; two aggregators of the same breach are one source class
- Three breach artifact rows from one corpus → `CaseReport` breach summary should count distinct breach names or effective sources, NOT artifact rows
- Name artifact at confidence 45 with `metadata.dob: "1990-01-01"` and no review → DOB field shows qualification
- `buildIdentityClusters` with `conflictingAreaCodes=true, dupeName=false` → warning text qualifies (not generic "different people")

### PR 3
- HIBP tool description in `buildTools` output matches HIBP's own definition and does NOT contain "breach corpora"
- Catalog-guidance contract test passes
