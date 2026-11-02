# Session handoff — Case-desk revamp (2026-11-02)

> Frontend only. No edge, schema, secret, flag or deploy-recipe change happened in this session.
> Every number here is a dated measurement; re-measure before relying on it.

## 0. What JD wants (read first)

JD's complaint: "I keep doing work and it never reaches the product." He asked for a drastic, visible revamp
of the signed-in workspace into an agentic investigation tool:
- the AI correlates and scores links ("likely the same person", "likely a false positive"), so he no longer
  marks every row;
- he picks pivots, watches connections form, and confirms or overrides the agent;
- the graph shows the case visually.

**The design target is JD's own prototype:** `docs/design/case-desk-prototype.html` ("Insight Finder — Case desk",
fictional data only; open it in a browser). A screenshot is at `docs/pr-case-desk-shell-screens/prototype-1440.png`.

**JD's brief, verbatim (2026-11-02):** "Don't have to do same exact color scheme and not the exact exact same but very
similar that's how I need it. Use this HTML as the visual and interaction reference for Insight Finder. It includes
dedicated chat, Evidence, and one right workbench. Its data and agent activity are simulated; reuse existing application
logic for real behavior. Preserve breach reveal unchanged."

What that means in practice:
- **Very similar, not pixel-exact.** Match the layout, hierarchy, density and interactions, and keep the palette close.
- **Dedicated chat (Investigate), dedicated Evidence, and ONE right workbench** (Finding / Next pivots / Connections),
  shared by both. It replaces today's Workbench tabs; never two detail surfaces.
- **The prototype's data and agent activity are fake.** Wire every element to the existing logic: `useChat`, ChatWindow
  streaming, `useThreadArtifacts`, `useReviewStates`, `useWorkbenchPivots`, `computePivots`, `buildEntityGraph`, the case
  snapshot. Never ship simulated numbers.
- **Breach reveal stays exactly as it is.** `REVEAL_BREACH_DATA` is ON (settled, CLAUDE.md). Do not mask, hide or add a
  reveal step for breach or credential values in any restyled surface; render what is shown today.

Prototype essentials:
- **Palette:** bg `#0b0c0e`, panel `#101114`, raised `#17181d`, line `#25262d`, muted `#91939f`, ink `#eeeef2`,
  accent lavender `#ad98ef`, green `#84d6ae`, amber `#e4bd76`, red `#e79b9f`. Inter 14px; SF Mono for selectors.
- **Shell:**
  - a 72px icon rail;
  - the crumb "Insight Finder / Case N";
  - a case header: status line "● ASSESSMENT UP TO DATE / date", a 32px subject name, "Email seed · selector",
    and labelled stats on the right (Last assessment / Source records / Spend);
  - text underline tabs **Investigate · Overview · Evidence (n) · Activity · Report**;
  - a 26px bottom status strip.
- **Inspector** (368px), with tabs **Finding · Next pivots (n) · Connections**:
  - **Finding** shows "Finding support %" and "Subject linkage %" bars (amber below 70), a "+12 linkage since the
    previous assessment" delta, reasons, opposing evidence, Supporting records, and Confirm (white) / False match / Add note.
  - **Next pivots** shows priority cards and a "Preview pivot" dialog (scope / execution / cost / ownership).
  - **Connections** shows a node → link → leaf tree.
- **Evidence:**
  - a run-update banner;
  - search plus sort ("Linkage confidence ↓");
  - filter chips All / Supported / Unresolved / Conflicts / Quarantined;
  - rows **Finding | Evidence basis | Linkage %**;
  - a "One connection needs explanation · Compare candidates" box and dialog.
- **Investigate:**
  - a session strip ("Agent investigating · 0:18 · 4 tools · Stop");
  - an agent message with the "IF" avatar, an AUTO ANALYSIS tag and step chips (✓ Collect ✓ Correlate ◌ Verify linkage);
  - source chips (R-014) and an inline "Connections identified" card with "91% linkage ↑ 9 points";
  - an amber contradiction callout and a run-task row ("3 / 5 checks");
  - a composer with suggestion chips.
- **Overview, Activity and Report:** "The case, at a glance"; "Outcomes first. Raw calls stay one step away."; and a reader
  report with Executive summary / Supported observations / Contradictions and gaps / Next investigative question.

## 1. JD's standing decisions (this session)

- **Merge when green** for frontend PRs:
  - open them ready (never draft);
  - CI Frontend green;
  - e2e run by hand;
  - before/after screenshots next to the prototype;
  - squash merge, then confirm Vercel production READY on the merge SHA.
- **Edge PRs still wait for JD's go.**
- **Agent assessment layer:** the AI verdict and probability are shown everywhere. The analyst's Confirm / Key / Dismiss always
  overrides it and is shown separately. Confidence math, `record_finding` and authority are untouched.
- **Scoring:** deterministic code first. A Claude adjudicator (existing Anthropic key) handles only ambiguous / name-collision
  clusters, later and as an edge PR. GLM stays the orchestrator.
- **Graph stays** even though the prototype has no Graph tab. It is the 4th tab and is reached from Connections.
- **Type floor is 11px** (the prototype's 9–10px labels round up).

## 2. Shipped this session (all live on Vercel production)

| PR | What | Merge SHA |
|---|---|---|
| #945 | `[HISTORICAL MODEL OUTPUT]` stripped from chat/report; pivot-run chip; compact PivotStrip on phones; pivots stop repeating (variant matching, paged tool log, ended runs demoted); one tap-to-expand narrative notice | `85f8084` |
| #946 | Workbench **Live** tab (activity, connections, next pivots); folded-rail "Open Next pivots" fixed; `useWorkbenchPivots` shared hook | `fdea510` |
| #947 | Graph: neutral empty note (no yellow box), partial-realtime-row crash fixed, link-less case draws its entities, node Confirm/Key/Dismiss + Pivot, saved positions + Reset layout | `39094ef` |
| #948 | `searchKeys` URL-prefix strip only for URL-shaped targets (Codex findings) | `269d2a2` |
| #949 | **R1** — Case-desk palette (lavender), Investigate-first text tabs, Tools → Activity, icon rail by default, larger case title | `b69be8d` |

Design mockups I made, which JD **rejected** in favour of his prototype: https://claude.ai/artifact/VU3RBsNhr32iAmVZCLyKV9.

## 3. Open at hand-off

- **#949 (R1)** merged as `b69be8d`. Confirm its Vercel production deploy if this note does not already say READY.
- **Edge CI is red on `main`.** `supabase/tests/osint-agent/jina_target_403_test.ts:153` expects "401/403 unauthorized"; the
  circuit now says "401 unauthorized". This is a one-line test-wording fix with no runtime change, but it is **edge**:
  ask JD for a go once.
- Draft-PR triage still owed to JD: #883, #882, #821, #804, #800, #793, #763, #701, #613, #593, #516.

## 4. Exact next steps (R1b → R6), one PR each

1. **R1b — header and footer.** Rebuild `WorkspaceHeader` to the prototype layout: status line above, H1 subject,
   "Email seed · selector", and labelled stats on the right (Last assessment / Source records / Spend). Add the bottom
   status strip. Keep every existing text that e2e reads in `case-integrity.spec.ts` (evidence logged, verified, conflict,
   quarantined, tool calls).
2. **R2 — `src/lib/agent-assessment.ts`**, pure logic plus tests.
   - Per artifact: `subjectLinkage %` (null = unresolved), `findingSupport %`, `delta`, `reasons[]`, `opposing`, and
     `group` (supported / unresolved / conflict / quarantined).
   - Built from `buildIdentityClusters` (`src/lib/intel.ts:2582`), `independentSourceClasses` (`intel.ts:540`),
     `isClusterIneligible` (`src/lib/report-hygiene.ts:199`), `metadata.contradictions`, `displayConfidence`, and the
     backend `cluster_id` / `metadata.confidence_tier`. Add `cluster_id` to the `useThreadArtifacts` select (`:172`)
     and to `types.ts`.
   - Name-only matches cap at unresolved; quarantined rows get no linkage figure; it never writes a review.
3. **R3 — inspector.** Replace the Workbench tabs (Live / Sheet / Next / Connections, `src/components/workspace/Workbench.tsx`)
   with **Finding · Next pivots · Connections**.
   - Finding: metric bars, delta, reasons, opposing evidence, supporting records, and Confirm / False match (= review
     `wrong`) / Add note.
   - Next pivots: prototype cards from `useWorkbenchPivots`, plus the Preview dialog.
   - Connections: a tree from `buildEntityGraph`, plus "Open graph".
4. **R4 — Evidence ledger.** Banner, search plus sort, and chips (one source of truth with `STATUS_FILTER_GROUPS`).
   3-column rows with linkage %, and the conflict box plus Compare candidates dialog. Quarantine release must keep working.
5. **R5 — Investigate as an agent session.** Restyle `ChatWindow`: session strip, agent message, step chips from
   `humanizeStage`, source chips, an inline "Connections identified" card and a contradiction callout from R2, a run-task
   row, and composer suggestion chips from the top pivots.
6. **R6** — Overview "at a glance", Activity "outcomes first", Report reader layout. The PDF debugging session stays separate.
7. **Later (edge, JD's go):** the Claude adjudicator for ambiguous clusters; the Operator Directives panel (custom memory) via
   `agent_memory` `kind='lesson'`, `subject='tool:<name>'` (already read by the run-start brief `lib/memory-brief.ts`).

## 5. Traps found this session

- **Harness HMR plus a running e2e.** Editing `src/` while `npm run test:e2e` runs against the harness hot-reloads it
  mid-suite. Wait for e2e to finish before editing.
- **React Flow fires `onNodeDragStop` on a plain click.** Compare against the drag-start position (see `GraphTab.tsx`).
- **The `no-raw-confidence-outside-helpers` guard.** Every new raw `.confidence` read needs an allowlist entry with a reason.
  Cluster scores (`IdentityCluster.confidence`) qualify.
- **The Workbench `request` prop is one-shot** (`onRequestConsumed`). A retained request replays on remount (Codex #946).
- **Codex reviews every PR within about 2 minutes.** Its P2s on #945, #946 and #948 were all real. Read the threads before merging.
- **Edge CI is red on `main`** (see §3). It is not a frontend regression.

## 6. Verification commands

```bash
npm run typecheck && npm run lint && npx vitest run && npm run build && grep -rl harness.local dist/   # last prints nothing
rm -rf node_modules/.vite && PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:e2e
npx vite --config vite.harness.config.ts --port 5174   # /chat/11111111-2222-4333-8444-555555555555
```
Baselines at `8798be5`: vitest 3185 passed / 1 skipped / 267 files; e2e 121 passed / 13 skipped.

## 7. Subscriptions and check-ins

- No PR subscriptions remain: #945–#949 are merged and unsubscribed. The docs PR carrying this handoff is merged on green by the old session.
- No pending scheduled check-ins. The #947 (`trig_01X7GXukqmMB1akf2AprRfxQ`) and #949 (`trig_0192McYDbvcqS6RJ8zPRCToR`) check-ins both fired and disabled themselves.

## Opening prompt for the next session

> Read `CLAUDE.md` and `SESSION_HANDOFF_2026-11-02_case-desk-revamp.md` (§0 first). Re-measure: `git log origin/main -5`,
> `list_pull_requests` (look at `draft`), and whether #949 is merged; if it is open, `subscribe_pr_activity` on it and merge it
> once Frontend CI is green. JD's standing rule: frontend PRs open ready and merge when green, then confirm Vercel production;
> edge PRs wait for his go. Then build R1b on branch `claude/agentic-investigation-ui-rxpkju` (restart it from `main` if its
> PR merged), with screenshots beside the prototype (`docs/pr-case-desk-shell-screens/prototype-1440.png`), and continue R2 → R6
> in order, one PR each.
