# Session handoff — Obsidian foundation and Stage A shell (2026-10-19)

> Frontend design revamp only. No edge, schema, secret or deploy-recipe work happened in this session.
> Every number here is a dated measurement; re-measure before relying on it.

## 1. State at hand-off (2026-10-19, about 18:30 UTC)

| Thing | State |
|---|---|
| `main` | `2f25d1d`, the squash merge of #806 (Stage A) |
| #805 Obsidian foundation | merged as `d180336`; palette, Plate and Lens materials, global focus ring |
| #807 session hygiene (CLAUDE.md) | merged as `dc5d733`. Its post-merge `main` CI was green on all four jobs, including Workspace e2e. |
| #806 Stage A shell | merged as `2f25d1d`. CI was green on its head `1dd2ba8` (Frontend, Edge, Migrations); local e2e 70 passed / 4 skipped. JD reviewed the preview on a phone. |
| Vercel production on `2f25d1d` | **not yet confirmed at hand-off.** Check: `list_deployments` with `sha=2f25d1d…`, project `prj_WCNXWbrxaXiOS5w6ZWKhkQXTVIWF`, team `team_AStXEwK8p0iTi4lDwkGubVKS`. |
| `main` CI on `2f25d1d` | not yet run at hand-off; it includes the e2e job, which runs on `main` only |
| #804, #772 | open drafts, **untouched**; JD decides on closure. Reuse parts as listed in §4. |
| Baselines (this session) | vitest 2662 passed / 1 skipped / 210 files; e2e 70 passed / 4 skipped (52 / 2 before Stage A); lint 0 errors / 10 warnings |

The plan of record is the approved "Obsidian Intelligence" plan: a hybrid of Obsidian Graphite as the foundation, with Black Glass ("Lens") only on the analytical brief, the selected-evidence inspector, the decision queue and active run controls. Indigo is for focus, selection and live state only, and violet only for inference. No navy. DESIGN.md carries the rules (§4 materials, §5 components, typography, Do's and Don'ts).

## 2. JD's standing rules for this work

- One branch and one draft PR per stage. JD merges, or explicitly says "merge". Squash merges only; never delete branches.
- Frontend only. No backend change for aesthetics, and no change to evidence authority, scoring or confidence math.
- `REVEAL_BREACH_DATA` stays ON and `RUN_LEASE_DISABLED` stays true. No secret changes, Lovable messages or PR closures without JD.
- Synthetic fixture data only in screenshots and tests. Never put real case data in commits, PRs or docs.
- Before asking for a merge: CI green on the **current head**, a before/after screenshot set, local e2e run by hand (PR CI skips it), and JD reviews the preview at phone, tablet and desktop.
- **Type rule:** 14px body and navigation, 12–13px interface labels, 11px only for nonessential metadata. 11px is a floor, not a target.
- **Scope rule:** once a PR is in review, stop adding features; record extras for a later stage.
- **Session hygiene:** CLAUDE.md §"Session hygiene". Post `Session check: STAY / START FRESH` after a compaction, on a merge and before a new stage.

## 3. Queue (JD orders; nothing below is authorized yet)

1. **Trust-labels PR** (JD picked this, then paused it until Stage A was approved). It needs JD's go, and it is an evidence-display change, so it needs sign-off. Display only, with regression tests:
   - `CaseReport.tsx` ~:1176. The "Auto-corroboration" panel counts `buckets.confirmed`, which includes **analyst-confirmed** single-source rows (`evidence-status.ts`: `analystConfirmed && !quarantined → "verified"`), yet captions them "backed by ≥2 independent source classes". Show analyst-confirmed and independently corroborated counts separately; take the second from the same calculation as the Confidence panel's Corroboration axis.
   - `buildSubjectProfile` (`CaseReport.tsx` ~:726) renders the highest-scoring non-quarantined row as a plain "Name: …" even when it is single-source and needs review. Carry its review state ("Candidate — needs review · N sources").
   - The Evidence inspector repeats one tool as Primary source, Source stack and Corroboration. JD's rule: one provenance section, and "Corroboration" lists only independent sources. Repeating one tool must never imply support or raise confidence.
   - Header counts: "64 evidence" (custody entries), 53 (artifacts) and 16 (needs review) carry no labels.
   - Test: confirming a single-source row raises the analyst count but not the corroborated count.
2. **Stage C1 — Investigate layout.** Run timeline built only from the recorded `stage`/`cycle_id` (otherwise "Unphased"), the brief as a Lens, an analyst queue, grouped tool outcomes, mobile brief first. Build on #804's `run-timeline.ts`, outcome words, selector treatment and title fix, **without its global CSS**. Salvage #772's compact composer, action tray, overflow tests and reading-position fix. JD's live-page audit (repeated cycle cards, execution log over results) is the brief.
3. **Stage C2 — failed and empty searches visible**, collapsed by outcome with counts and expandable raw calls. A separate PR with tests.
4. Stage D (Evidence ledger and Lens inspector), Stage E (Intelligence), Stage B (Home and Cases: plain case titles, a delete control not inside a linked row), then Stage F/G (Graph and Report reader-first layout, Tools summary strip, Graph controls ≥32/44px, a Graph empty state that doesn't overlay the seed, the 61 contrast failures).
5. **Separate investigation:** intermittent delayed or stalled Report loading in production ("Loading workspace" persisted on initial checks and resolved on a later visit). Instrument chunk and data timing first, then add a bounded skeleton with error and retry.
6. **Phone header:** `MobileCaseStrip` truncates the selector ("notcorrxptsgf@gm…"), against DESIGN.md's never-truncate rule. Pre-existing; small.

## 4. What Stage A built (where to look)

- `src/components/shell/AppShell.tsx` is the layout route around `/chat/:id`, `/cases`, `/cases/:id`, `/brain` and `/settings`.
  - **Rail:** wide pushes the page and remembers `if:leftCollapsed`; tablet starts at a 56px icon rail and overlays when expanded; phone uses `ShellTopBar` plus a drawer that closes on navigation and returns focus.
  - The **page slot keeps one position and key** at every width, so the live `ChatWindow` never remounts. Don't break this.
- `CommandPalette.tsx`: "Go to" everywhere; quick actions and section jumps only on `/chat/:id` (`useMatch`).
- `WorkspaceTabs` with `sections` and `CASE_VIEW_SECTIONS` (`src/lib/workspace-sections.ts`) replaced `ViewWorkspaceTabs`. `AppNav` is deleted.
- `ChatPage.tsx`: the case sheet folds to a 44px strip with the Needs-your-call count (`if:caseSheetCollapsed`).
- `GraphTab.tsx`: seed is a neutral plate with an indigo edge, capped at 20rem; selection is mirrored onto React Flow's `selected` flag; Enter/Space/Escape work on a focused node; nodes have `ariaLabel`.
- Tests: `e2e/app-shell.spec.ts` (17 tests, mid project only, via `playwright.config.ts` `testIgnore`), `src/test/workspace-controls.test.tsx` (viewer sections).

## 5. Traps found this session

- **A `coarse:` Tailwind screen silently disables every `max-*` variant.** A raw media query in `theme.screens` crushed the phone composer (`max-sm:hidden` stopped generating). `coarse:` is a **plugin variant** (`addVariant`) for that reason. Never move it into `screens`.
- **The workspace focuses its composer on load** (`ChatWindow.tsx` ~:1889, a `[threadId]` effect). A test that focuses something else straight after navigation loses focus to it under load. Wait for `#workspace-tabpanel-chat textarea` and its focus first.
- **Two harness dev servers sharing `node_modules/.vite`** produce duplicate-React errors ("reading 'useEffect'"). Run harnesses one at a time and clear `node_modules/.vite` between them.
- **`pkill -f "<pattern>"` inside a `bash -c` kills its own shell** when the pattern appears in the command line. Kill by port: `kill $(lsof -t -i:5174)`.
- **GitHub Actions had a repo-wide "degraded availability" incident** (about 15:50–16:30 UTC). Every run queued; all later passed. Check githubstatus.com before suspecting the repo.
- **The Codex review bot can "fail" without posting findings.** Record that as an incomplete review, not a code failure.
- **The signed-in Vercel preview needs a real login**, which a cloud session cannot do. Use the harness (`npx vite --config vite.harness.config.ts`) for screenshots, and JD reviews the preview.

## 6. Verification commands

```bash
npm run typecheck && npm run lint && npx vitest run && npm run build && grep -rl harness.local dist/   # last one prints nothing
rm -rf node_modules/.vite
PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome npm run test:e2e        # 70 passed / 4 skipped at 2f25d1d
npx vite --config vite.harness.config.ts --port 5174                                                # /chat/11111111-2222-4333-8444-555555555555 (full) · /chat/22222222-3333-4444-8555-666666666666 (empty)
```

## 7. Open scheduled tasks

- `trig_017DdYRQKYzFzMnSFhf58V7f` (one-shot, 18:41 UTC 2026-10-19) verifies the Vercel production deploy and `main` CI for `2f25d1d`. It fires into the old session and disables itself after firing.
- No PR subscriptions remain; #805, #806 and #807 are merged.
