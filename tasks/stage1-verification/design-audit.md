# Stage 1b design-system audit

Branch head: `d15c3aa8815b698d2a238a6cf5e53b36689d4532`. Read-only. Evidence pass for the Stage 1b polish scope.

---

## 1 · Chip inventory and dimension audit

Canonical: `src/components/ui/authority.tsx` — `AuthorityChip` is the only chip with a token-driven variant table (`CHIP[state]` → `--authority-<state>` tokens), size="sm"|"md", icon slot, `h-3 w-3` icon.

### AuthorityChip variants (`authority.tsx:54-78`)
| size | padding | corner | font | icon |
|---|---|---|---|---|
| sm | `px-1.5 py-px` | `rounded` | `text-eyebrow` | yes 12×12 |
| md | `px-2 py-0.5` | `rounded` | `text-micro` | yes 12×12 |

### Review chip — SAME state (`REVIEW_SHORT[rState]`), FOUR renderings
| file:line | padding | corner | tracking | consistent? |
|---|---|---|---|---|
| `ResourcesPanel.tsx:1032` | `px-2 py-1` | `rounded-md` | `tracking-[0.14em]` | — |
| `ResourcesPanel.tsx:1154` | `px-2 py-0.5` | `rounded-full` | `tracking-wider` | ✘ different corner + padding |
| `ArtifactInspector.tsx:145` | `px-2 py-1` | `rounded-md` | `tracking-[0.14em]` | matches 1032 |
| `ArtifactInspector.tsx:254` | `px-2 py-0.5` | `rounded-full` | `tracking-wider` | ✘ different corner |
| `panel/EvidenceMatrixTab.tsx:252` | `px-1.5 py-0.5` | `rounded` | `tracking-wider` | ✘ third variant |

**Finding:** one semantic chip, three visually distinct shapes. All use `REVIEW_CLASS` for color (token-driven, OK), but padding/corner/tracking fork across sites.

### Ad-hoc chip-shaped tailwind inline (not using `AuthorityChip`)
| file:line | padding | corner | token color? |
|---|---|---|---|
| `SourceBadge.tsx:42` | — | `rounded-full` | `source-chip` class |
| `ThreadSidebar.tsx:607` | `px-2 py-1` | `rounded` | `warning/25` token |
| `ResourcesPanel.tsx:300` | `px-3 py-1.5` | `rounded-lg` | hardcoded `white/[0.05]` |
| `ResourcesPanel.tsx:436` | `px-2 py-0.5` | `rounded-md` | hardcoded `white/[0.035]` |
| `ui/workspace-primitives.tsx:406` | `px-2 py-0.5` | `rounded-full` | `surface-2/50` token |
| `panel/AnalysisTab.tsx:210` | `px-2.5 py-1` | `rounded-md` | `surface-2` token |
| `workspace/OverviewTab.tsx:441` | `px-1.5 py-px` | `rounded` | `surface-2` token |
| `workspace/EvidenceTab.tsx:106` | `px-1 py-px` | `rounded` | `warning/10` token |
| `pages/Landing.tsx:118` | `px-3 py-1.5` | `rounded-full` | `intel-blue` hsl token |
| `pages/CasesPage.tsx:308` | `px-3 py-1.5` | `rounded-lg` | `border-subtle` token |

**Finding:** 10 distinct chip grammars across non-authority surfaces. Corner radius forks four ways (`rounded` / `-md` / `-lg` / `-full`); padding forks eight ways.

---

## 2 · Focus-visible ring coverage

- **`focus-visible:ring` usage:** **110 instances** across `src/components|pages|hooks`. Samples: `ThreadSidebar.tsx:595, 684`, `ChatWindow.tsx:3026, 3139`.
- **`--ring` token (`ring-ring`):** **107 instances** — the dominant convention.
- **Hardcoded ring colors (`ring-[hsl(...)]` / `ring-[#...]`):** **4 instances**. Sample: `ChatWindow.tsx:3026` uses `ring-[hsl(var(--intel-blue)/0.4)]` (deliberate intel accent, acceptable).
- **`focus:` (not `focus-visible:`) — mouse-click rings:** **~8 instances**, all inside `src/components/ui/*` shadcn defaults: `sheet.tsx:60`, `dialog.tsx:45`, `navigation-menu.tsx:38`, `toast.tsx:55/70`, `badge.tsx:7`, `select.tsx:20`. These show rings on mouse click — Stage 1b should migrate the ones users interact with to `focus-visible:`.
- **Interactive elements WITHOUT focus-visible treatment** — plain `<button>` tags grep sample (count estimation only, not full audit): at least 15 in `ThreadSidebar.tsx`, `ResourcesPanel.tsx`, `ChatWindow.tsx` (e.g. `ChatWindow.tsx:207,211,335`, `ResourcesPanel.tsx:268,297,432,811,1544`). These likely inherit styling from parent `button[class]`, but a manual walkthrough is required (axe cannot verify this reliably).

---

## 3 · Hit-target audit against WCAG 2.2 AA (2.5.8 ≥ 24×24 CSS px, with exceptions)

| file:line | size | target | note |
|---|---|---|---|
| `panel/EvidenceMatrixTab.tsx:358` | `h-7 w-7` = 28×28 | "More review actions" button | ✓ MEETS 2.5.8 (28 > 24); fails AAA 2.5.5 (44) |
| `ResourcesPanel.tsx:1190` | `h-7` = 28 | review-reset Button | ✓ MEETS 2.5.8 |
| `ArtifactInspector.tsx:287` | `h-7` = 28 | review-reset Button | ✓ MEETS 2.5.8 |
| `panel/EvidenceMatrixTab.tsx:331` | `h-7` = 28 | review Button | ✓ MEETS 2.5.8 |
| `panel/CustodyTab.tsx:458` | `h-7` = 28 | sort Button | ✓ MEETS 2.5.8 |

Chip height distribution across `src/components` (occurrence count): `h-8` 34 · `h-9` 12 · `h-7` 12 · `h-11` 9 · `h-5` 5 · `h-4` 5 · `h-6` 2 · `h-10` 2.

**No sub-24px interactive controls found** in the primary workspace path. The `h-5`/`h-4` cases are all icons (`SwarmMark`, `PanelLeftClose`, `X` close marker, decorative dots), not click targets.

**Finding:** 2.5.8 AA is already satisfied. Stage 1b's 44×44 stretch target (2.5.5 AAA) would require h-11 across all review controls; current `h-7` is intentional density. Keep as-is unless JD asks for AAA.

---

## 4 · Confidence rendering surfaces

### Canonical path
- `displayConfidence` / `effectiveConfidence` used in **33 call sites** across `src/components|pages`.
- Canonical renderer: `ConfidenceExplain.tsx:29` (`displayConfidence(artifact)` + full explanation + caps + stored score).

### Raw `.confidence` reads outside `display-confidence.ts` — surfaces to migrate or justify
| file:line | context | action |
|---|---|---|
| `ChatWindow.tsx:2327` | `confidence: a.confidence ?? null` passing through to a downstream render | justify or convert |
| `panel/AnalysisTab.tsx:145, 171` | comparing stored vs cap for an "capped" counter | **justified** (needs raw vs cap, not effective) |
| `panel/CustodyTab.tsx:317` | `{r.confidence}%` on custody rows | migrate to `displayConfidence` |
| `panel/ClustersTab.tsx:198` | `<ConfidenceTag score={c.confidence} />` | migrate |
| `panel/CaseReport.tsx:1226, 1228` | `${f.confidence}%` + `tierInfo(f.confidence)` on report rows | migrate |
| `panel/TimelineTab.tsx:107` | `${it.confidence}%` on timeline | migrate |
| `workspace/GraphTab.tsx:170, 192-193, 218, 632` | 5 raw reads on graph nodes | migrate across the file |
| `investigation/ReportCardV2.tsx:196, 243` | reportcard cells | migrate |
| `pages/BrainGlobalPage.tsx:448, 605, 801` | memory list confidence | **out-of-scope** for Stage 1b (not case workspace) |

### Current labels beside confidence number (what Stage 1b replaces)
| file:line | label phrasing |
|---|---|
| `ResourcesPanel.tsx:761` | `${conf}% confidence` |
| `ResourcesPanel.tsx:1029` | `${shownArtifact.effective}% confidence` |
| `ArtifactInspector.tsx:142` | `${shownArtifact.effective}% confidence` |
| `panel/CaseReport.tsx:1226` | `${f.confidence}%` (no label) |
| `panel/CustodyTab.tsx:317` | `{r.confidence}%` (no label) |

JD's Stage 1b target: **"Confidence score N/100 — uncalibrated"** on hover/focus; bare numeric in the ledger CONF column; one explanation in the inspector header per selection.

---

## 5 · Run-status label surfaces

### Authoritative source
- `src/lib/case-snapshot.ts:67-77` — `CaseRunState = "draft" | "running" | "completed" | "interrupted" | "stopped"`
- Labels at `case-snapshot.ts:69-75`: Draft · Running · Complete · Interrupted · Stopped
- Derivation: `deriveRunState({ thread, chatRunning, nowMs })` at `case-snapshot.ts:92`

### Renderers
| file:line | component | labels used |
|---|---|---|
| `components/workspace/CaseStatus.tsx:18-26` | `CaseStatusPill` (PILL_TONE + DOT_TONE) | all 5 labels |
| `components/workspace/WorkspaceHeader.tsx:292, 348` | header | wraps `<CaseStatusPill snapshot={snapshot} />` |

### Durable run-start timestamp
- **YES** — `run_started_at` is a backend field, read in multiple tests (`case-snapshot-provider.test.tsx:123`, `case-snapshot.test.ts:32`, `workspace-evidence-count.test.ts:105`, etc.) and in `hasRunMarker({ run_started_at })`.
- Stage 1b's "Analyzing · Xs" interval has an authoritative durable source — no fabrication needed.

### Gap vs Stage 1b
- Today's five labels do NOT include "Ready" — the closest is `draft`. JD said **"Ready must not replace Running, Finalizing, Interrupted or another authoritative state."** The right scope: add "Ready" as the **label for `draft` idle state only**; preserve all five existing authoritative labels.
- Today's set has no "Finalizing" — that would need a new backend state. **Out of scope for Stage 1b.**
- "Analyzing · Xs" is a sub-label for the `running` state, using `run_started_at` to derive elapsed. Omit elapsed if the timestamp is null.

---

## 6 · Token coverage

| category | distinct values found | token coverage |
|---|---|---|
| chip height (approx chip-sized `h-N`) | 8 distinct: `h-4, h-5, h-6, h-7, h-8, h-9, h-10, h-11` | **no height token** — raw tailwind arbitrary |
| border radius (chip-shaped) | 4 variants in use: `rounded, rounded-md, rounded-lg, rounded-full` | tailwind defaults (not token-driven) |
| focus ring color | 107 use `ring-ring` (`--ring` token) · 4 hardcoded hsl | ~96% token coverage ✓ |
| primary accent | multiple HSL tokens: `--authority-*`, `--confidence-*`, `--brand`, `--primary`, `--intel-blue` | **fully token-driven**; no raw hex found in authority/review surfaces ✓ |

**Finding:** color tokens are strong (96%+ token coverage, `--authority-*` + `--confidence-*` + `--brand`). Chip **dimensions** (height, padding, corner radius) are NOT tokenised — Stage 1b item 1 should standardise against a new chip-dimension token set (e.g. `--chip-h-sm: 20px`, `--chip-h-md: 28px`, `--chip-radius: calc(var(--radius) - 4px)`), or at minimum a shared `cn()` helper that enforces the dimension triple.

---

## 7 · Live-region audit

### Present (`aria-live` or `role="status"` or `role="alert"`)
| file:line | surface |
|---|---|
| `ChatWindow.tsx:1041, 1071-1072` | ChatWindow one-line summary (polite) |
| `ChatWindow.tsx:1214` | interrupted message banner (status only, no live) |
| `ChatWindow.tsx:3355` | composer status (polite) |
| `ui/full-page-loader.tsx:22-23` | loader (polite) |
| `ui/workspace-primitives.tsx:113` | copy-to-clipboard confirmation (polite) |
| `panel/AuditTab.tsx:136` | audit cap error (`role="alert"`) |
| `chat/ServerFollowPanel.tsx:31` | server-follow time (polite) |
| `workspace/ToolsTab.tsx:185` | syncing tool activity (status only) |
| `workspace/WorkbenchConnections.tsx:85` | reviews-unavailable (status only) |
| `workspace/WorkbenchNext.tsx:105` | next-steps empty (status only) |
| `panel/PivotsTab.tsx:207` | statusMsg (polite, sr-only) |
| `workspace/CaseSheet.tsx:75` | reviews-unavailable (status only) |
| `workspace/CaseStatus.tsx:170` | run-state announcement (polite, sr-only, aria-atomic) ✓ |
| `pivots/ArtifactPivotAction.tsx:106` | pivot action status (polite) |

### Missing but should exist (per Stage 1b item 8)
| surface | file | required |
|---|---|---|
| **ArtifactInspector open event** | `workspace/ArtifactInspector.tsx` | ✘ no live-region — need `role="status" aria-live="polite"` announcing "Evidence detail opened: <value>. <kind>. Confidence score N/100 — uncalibrated. <authority state>." |
| **PivotPreview open event** | `pivots/PivotPreview.tsx` | ✘ no live-region — need equivalent |
| **Review-state change confirmation** | after `reviewSet()` writes | partial via toast; no sr-only live confirmation |

---

## Totals per section

1. Chip inventory: **15 renderings** across 3 distinct review-chip shapes + 10 ad-hoc chip grammars (3 shape forks on the same semantic chip, 8-way padding fork)
2. Focus-visible: **110 ring-coverage hits** · 4 hardcoded ring colors · ~8 shadcn `focus:` leftovers · unknown count of bare `<button>` without rings (manual walkthrough owed)
3. Hit targets: **0 sub-24px interactive controls** found; `h-7` (28×28) is the smallest click target in the primary path — meets 2.5.8 AA
4. Confidence surfaces: **33 displayConfidence sites** (good) · **11 raw `.confidence` reads outside the helper** (CustodyTab, ClustersTab, CaseReport ×2, TimelineTab, GraphTab ×5, ReportCardV2 ×2; some justified for cap comparison)
5. Run-status: **5 authoritative labels** rendered by `CaseStatusPill` from one source; `run_started_at` IS available for "Analyzing · Xs"
6. Tokens: color 96%+ token-driven ✓ · chip dimensions NOT tokenised (8 heights, 4 corners)
7. Live regions: **14 present** · **3 missing** that Stage 1b targets (inspector open, pivot-preview open, review-state write)

## Top three Stage 1b blockers

1. **Review-chip grammar is forked across 5 render sites in 3 shapes** — must converge to one component (or one dimension token triple) before any other chip harmonisation claims consistency.
2. **ArtifactInspector has no live-region on open** — the a11y announcement JD specified for Stage 1b item 8 cannot be verified until this element exists.
3. **11 raw `.confidence` reads bypass `displayConfidence`** across CustodyTab / CaseReport / TimelineTab / GraphTab / ReportCardV2 — Stage 1b's "Confidence score N/100 — uncalibrated" relabel will miss these surfaces unless they migrate to the helper first (or the relabel wraps the helper's output exclusively).
