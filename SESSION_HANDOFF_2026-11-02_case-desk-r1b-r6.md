# Session handoff — Case-desk revamp, R1b → R6 shipped (2026-11-02)

> Frontend only. No edge, schema, secret, flag or deploy-recipe change happened in this session.
> Every number here is a dated measurement; re-measure before relying on it.

## 0. Read first

This session took JD's prototype (`docs/design/case-desk-prototype.html`) from the shell (#949, R1) to the
whole signed-in workspace. The plan in `SESSION_HANDOFF_2026-11-02_case-desk-revamp.md` §4 (R1b → R6) is
**done**: all six PRs (#951–#956) are merged and READY on Vercel production; `main` is `f35f701`.
JD's brief still governs: very similar, not pixel-exact; dedicated chat, dedicated Evidence, ONE right
workbench; simulated data → real logic; breach reveal unchanged.

## 1. What shipped (all merged on green, all confirmed READY on Vercel production)

| PR | Stage | What | Merge SHA |
|---|---|---|---|
| #951 | R1b | Case header to the prototype layout (crumb line, assessment line, 32px subject, seed line, Last assessment / Source records / Spend); `WorkspaceStatusStrip` (custody with its basis + the two working rules); tabs `lg:px-8` | `e08b3c3` |
| #952 | R2 | `src/lib/agent-assessment.ts`: per artifact `findingSupport` (= `displayConfidence(a).effective`), `subjectLinkage` (= the identity-cluster engine's score for the seed's cluster; 100 for the seed; **null = unresolved**), `group` (quarantined › conflict › supported ≥ 60 › unresolved), `reasons[]`, `opposing[]`, `tier`, `backendClusterId`; `diffAssessments` / `formatDelta`. `useThreadArtifacts` now selects `artifacts.cluster_id` (column verified in production via `information_schema`); the generated Supabase types gained `cluster_id` / `subject_id` | `c784e5a` |
| #953 | R3 | ONE inspector: **Finding · Next pivots · Connections** (`Workbench.tsx`, `lib/workbench-tab.ts`). `ArtifactInspector` rewritten to the prototype's Finding layout (two bars, why confidence changed with the delta, supporting records, limits/opposing, Confirm / False match / Add note + Key · Recheck · Dismiss · Reset). `useAgentAssessment` hook with a per-thread **baseline** (the assessment when the latest run started, localStorage) for the "+12 linkage since the previous assessment" line. `WorkbenchConnections` as the node → link → leaf tree. `LiveBoard` removed. Legacy tab names (`live`, `sheet`, `next`) still honoured | `4f53c09` |
| #954 | R4 | Evidence ledger: visible heading + "N findings across M source records"; run-update banner; search; sort menu (Linkage confidence default · Finding support · Authority · Newest · Name); chips on their own line (Analyst view · All · Supported · Unresolved · Conflicts · Quarantined; Leads/Excluded behind More), each one of `STATUS_FILTER_GROUPS` with a new `conflict` **subset** of `review`; **Linkage column** over the unchanged confidence figure; prototype conflict box + Compare candidates. Also the R3 a11y fix: a valueless linkage bar is `aria-hidden`, not a meter | `cb50205` |
| #955 | R5 | Investigate as an agent session: `SessionStrip` (Agent investigating · stage chips · clock · tools · Stop), agent heading (IF mark · Insight agent · AI analysis tag), the live card as the run-task row (spinner, k / n tools), `AgentAssessmentCards` (Connections identified + Contradiction callout, from the same R2 assessment), composer suggestion chips (top two pivots → Workbench Preview; "What changed?") | `7a6cb34` |
| #956 | R6 | `SectionHeading` on Overview ("The case, at a glance" + the R2 group counts + Assessment boundaries note), Activity ("Investigation activity · Outcomes first. Raw calls stay one step away."), Report ("Case assessment" + the export gate's reading). Its subtitle must not repeat the status chip's text (a strict-mode e2e locator caught the duplicate) | `f35f701` |

Session check at hand-off: this session was compacted once (after #956's e2e, before its merge); the branch `claude/agentic-investigation-ui-rxpkju`
was restarted from `main` before every stage (force-with-lease against the previous head, which is the
documented case for a squash-merged branch).

## 2. JD's standing decisions (unchanged from §1 of the previous handoff, plus)

- Merge when green for frontend PRs (open ready, Frontend CI green, e2e by hand, squash, confirm Vercel
  production READY on the merge SHA). Edge PRs wait for JD's go.
- The AI verdict and probability are shown everywhere; the analyst's Confirm / Key / Dismiss is shown
  separately and overrides on the surface. **Confidence math, `record_finding` and authority are untouched**:
  every R2 figure is an existing engine's number (`displayConfidence`, `buildIdentityClusters`,
  `independentSourceClasses`, `isClusterIneligible`).
- Graph stays (4th tab), reached from Connections' "Open graph".
- Type floor 11px.
- New this session, made by Claude within the brief: a quarantined row gets **no** linkage figure ("Withheld"
  / "Unproven"); a name-only row tops out at unresolved; `linkageWord` never says "confirmed"; the delta line
  appears only once a baseline exists (never a fabricated change); "supported" = linkage ≥ 60, the cluster
  board's "Likely link" rung; the Conflicts chip is a subset of Unresolved so the Analyst union is unchanged.

## 3. Open at hand-off

- Nothing from the R1b–R6 plan. #956 merged at `f35f701` after the hand-run e2e (124 passed / 10 skipped / 1
  failed on `b3d7e5b`, the failure fixed in `bc036d3`, `case-integrity.spec.ts` re-run 33/33) and Vercel
  production READY on `f35f701` was confirmed.
- **Edge CI is red on `main`**: `supabase/tests/osint-agent/jina_target_403_test.ts:153` expects
  "401/403 unauthorized"; the circuit says "401 unauthorized". One-line test-wording fix, **edge**, needs JD's
  go once (commented on #951, #952, #953, #954, #955, #956).
- **Codex has no review credits.** Every PR this session got "You have reached your Codex usage limits";
  #951–#956 were merged without a Codex pass. JD decides whether to add credits.
- **Draft-PR triage** still owed to JD: #883, #882, #821, #804, #800, #793, #763, #701, #613, #593, #516;
  #929 (edge, English-only orchestrator) is open and ready, waiting on JD.
- The harness fixture links no row to the subject beyond the seed, so the "Connections identified" card is
  exercised only by its unit test (`agent-assessment-cards.test.tsx`). A fixture row carrying the seed email in
  its metadata would show it; the fixture is gitignored real data, so sanitize before adding.
- The composer's "What changed?" chip sends a prompt, i.e. starts a model run (cost). The two pivot chips do
  not run anything (Preview on the Workbench).

## 4. Traps found this session

- **Two Vite harnesses sharing one `node_modules/.vite` cache make e2e flake.** A second worktree whose
  `node_modules` was a symlink to the main checkout's shared the dep-optimizer cache; while its harness ran,
  the main checkout's e2e lost 6 lazy-loaded tab panels (Report, Graph, Evidence) with "element not found".
  Isolated re-run: 33/33. Fix: give each worktree a real `node_modules` directory of per-package symlinks (so
  `.vite` is local), and never run a harness and an e2e from the same tree at once.
- **A squash-merged branch is not an ancestor of `main`.** `git merge-base --is-ancestor` says no even though
  the content merged; restart the branch from `origin/main` and `push --force-with-lease=<branch>:<old head>`.
- **`role="meter"` needs `aria-valuenow`.** The Finding panel's bar with a null value failed axe
  (`aria-required-attr`, critical) only at xl widths where the inspector is inline, so R3's own e2e (run at
  1280/1440 too) did not catch it until R4 made quarantined rows reachable in the same flow. A track with no
  value is `aria-hidden`; the word carries the meaning.
- **Every production `buildIdentityClusters` call must pass the analyst's verdicts** —
  `review-authority-propagation.test.ts` scans call sites. The assessment engine therefore READS reviews for
  the cluster call only; it never writes one and no figure or word reads a verdict (both pinned).
- **The ledger's chip filter and the case-sheet hand-off share one table.** `statusFilterForAuthority` picks
  the narrowest group containing the state, so adding `conflict: Set(["conflict"])` moved a conflict hand-off
  from "Needs review" to "Conflicts" (`case-sheet-handoffs.test.tsx` updated).
- **The driver's `click <text>` can hit the header's copy button**: "click j.harker@…" copied the selector
  instead of selecting the row. Click `.ledger-row` with a direct Playwright script for Evidence selections.
- Tailwind's `normal-case` loses to `.chat-card__header{text-transform:uppercase}` (unlayered CSS); use an
  inline style for the agent heading.

## 5. Verification commands and baselines

```bash
npm run typecheck && npm run lint && npx vitest run && npm run build && grep -rl harness.local dist/   # last prints nothing
PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:e2e
npx vite --config vite.harness.config.ts --port 5174   # /chat/11111111-2222-4333-8444-555555555555
```
Baselines at `bc036d3` (R6 head): vitest **3220 passed / 1 skipped / 272 files** (CI's Frontend job agreed); e2e
**125 passed / 10 skipped** at `85c5f9b` (R5) and 124 / 10 / 1 at `b3d7e5b` with the one failure fixed in
`bc036d3`; lint 0 errors / 10 pre-existing warnings. `main` at `f35f701` is READY on Vercel
production (confirmed `dpl_ETXFCiBMAQU642AG4A6T65KTMUD6` on `f35f701`); the live `osint-agent` build is unchanged this session.

## 6. Subscriptions and check-ins

- None. The #956 subscription was dropped and its check-in `trig_01WVF5Dak83xJitdZ54r81rj` deleted after the
  merge; the earlier ones (#951–#955) were cancelled when their PRs merged. The docs PR carrying this file has
  its own subscription, created by the session that opened it.

## 7. What comes next (JD's call)

1. Merge the docs PR carrying this handoff and the `CLAUDE.md` reading-list line (docs only, no CI gate
   beyond Frontend).
2. Edge (one build, JD's go): the one-line `jina_target_403_test.ts` wording fix, then the Claude adjudicator
   for ambiguous / name-collision clusters (existing Anthropic key), then the Operator Directives panel via
   `agent_memory` `kind='lesson'` (`lib/memory-brief.ts` already reads it).
3. Frontend polish candidates seen but not done: the Evidence toolbar wraps the sort menu to a second line at
   1440 when the search is wide; the Overview's two cards could take the prototype's 20px padding; the
   prototype's "R-014" source chips need a stable per-record id the pipeline does not write yet.

## Opening prompt for the next session

> Read `CLAUDE.md` and `SESSION_HANDOFF_2026-11-02_case-desk-r1b-r6.md` (§0, §3, §7). Re-measure `git log origin/main -5`
> and `list_pull_requests` (look at `draft`). The Case-desk revamp R1b–R6 is shipped; pick up §7 in order: the edge
> items need JD's go first, the frontend polish candidates can be built straight away, one PR each, merge-when-green,
> confirming Vercel production READY on each merge SHA.
