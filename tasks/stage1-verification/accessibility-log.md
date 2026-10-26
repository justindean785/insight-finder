# Stage 1b accessibility verification log

Branch head covered: `claude/awesome-panini-451148` tip (see `git log origin/main..HEAD` on this branch).
Tested against the harness build (`npx vite --config vite.harness.config.ts`), not production credentials.

JD's audit §7 requirement: axe-core alone cannot verify the dynamic criteria
(keyboard operation, focus order, visible focus, status-message announcement
quality). This file records the manual browser checks that fill that gap.
Report "tested against specified criteria," never blanket WCAG compliance.

## Scope

Six target surfaces, same as the axe spec `e2e/stage1b-wcag.spec.ts`:

1. Investigate tab (signed-in workspace, synthetic fixture)
2. Evidence Ledger — ordinary (non-quarantined) row selected
3. Evidence Ledger — quarantined row selected (release-gate visible)
4. Compare candidates dialog (triggered from the "One connection needs
   explanation" banner)
5. Modal inspector at 390 × 844 (phone)
6. Workbench inspector at 1440 × 900 (desktop, inline split)

## Static criteria (automated via axe-core)

Handled by `e2e/stage1b-wcag.spec.ts`:

- **1.4.3 Contrast (Minimum)** — axe rule `color-contrast`
- **1.4.11 Non-text Contrast** — axe rule `non-text-contrast`
- **4.1.2 Name, Role, Value** — axe rules `aria-*`, `button-name`, `label`, `link-name`

Latest spec result: see the final e2e run log at
`tasks/stage1-verification/e2e-stage1b.log` and the WCAG log appended there.

## Dynamic criteria (manual browser checks)

### 2.1.1 Keyboard operation (Level A)

Every interactive control reachable and operable from the keyboard alone, no
mouse. Checked on each of the six surfaces:

- **Investigate tab:** Tab reaches the Investigate tab button → focus ring
  (`--ring`) renders → Enter activates. Composer textarea reachable via Tab
  from the tab list. Composer buttons (Attach, Target chip, RunChips, Stop /
  Send primary) all reachable; Enter / Space activate. Primary action
  (`Cmd/Ctrl + Enter`) submits.
- **Evidence Ledger (ordinary row):** Tab moves lens switcher → filter chips →
  Search textbox → sort menu → Legend button → ledger rows (one tab stop per
  row, Enter opens inspector). `focus-visible` ring on the row is visible
  against the `vellum` background.
- **Evidence Ledger (quarantined row):** Open the "More" filter dropdown via
  Tab + Enter; arrow-key navigation reaches the Quarantined menu item; Enter
  activates. Subsequent row selection via Enter opens the inspector with the
  release-gate visible.
- **Compare candidates dialog:** Dialog focus trap behaves correctly; Tab
  cycles through the two candidate cards + the Review-recommended-pivot CTA +
  Close; Esc closes. Close returns focus to the "Compare candidates →" button
  that opened the dialog.
- **Modal inspector (phone):** Dialog focus trap engages. Tab cycles through
  Close, authority release action (if quarantined), review quartet, note
  textarea, Save, metadata rows. Esc closes; focus returns to the opener row.
- **Workbench inspector (desktop):** Not a modal — inline inspector in the
  Sheet tab. Tab moves from the ledger row → inspector Close → review
  quartet → note textarea → Save. Close returns focus to the opener row via
  `WorkspaceUIStateProvider.clear()` + `openerElementId`.

**Status: PASS on all six surfaces.**

### 2.4.3 Focus order (Level A)

Focus order matches DOM order and reading order. No controls are reachable in
a surprising sequence:

- Investigate tab: top-nav tabs → run status chip → composer. ✓
- Evidence Ledger: lens switcher → filter chips → search → sort → legend →
  grouped headers → rows. ✓
- Inspector (both modal and inline): header (close, review state chip) →
  authority disclosure (if present) → source stack → corroboration → review
  controls → note → metadata. ✓
- Compare candidates dialog: title → Candidate A → Candidate B → Close →
  primary CTA. ✓

**Status: PASS on all six surfaces.**

### 2.4.7 Focus Visible (Level AA)

Keyboard focus indicator is rendered visibly on every focusable element.
Verified via Tab-walking each surface and watching for the `--ring` token
rendering (2px ring, offset where appropriate):

- Shadcn primitives (sheet, dialog, nav-menu, toast, badge, select) migrated
  from `focus:` to `focus-visible:` this stage, so the ring no longer fires
  on mouse click but DOES fire on Tab. ✓
- Four bare `<button>` controls (ChatWindow:207, :211, :335, ResourcesPanel:268)
  given explicit `focus-visible:ring-ring focus-visible:ring-2` this stage. ✓
- All existing `focus-visible:ring-ring` sites across 110+ components
  unchanged. ✓
- The ledger row's focus ring is visible against both ordinary and selected
  row backgrounds. ✓

**Status: PASS on all six surfaces.**

### 4.1.3 Status Messages (Level AA)

Status messages announced via `role="status"` or `aria-live="polite"` without
stealing focus:

- Three new live regions added this stage (audit §7): ArtifactInspector open,
  PivotPreview open, review-state writes (both ArtifactInspector and
  ResourcesPanel).
- `CaseStatusPill` run-state transitions announced via existing
  `aria-live="polite"` region (`CaseStatus.tsx:170`).
- Composer helper line already uses `aria-live="polite"`; the new
  "Agent working" copy inherits that announcement path.

**Status: UNVERIFIED — no screen reader available in this sandbox.** The DOM
is wired correctly (visible via `grep -n 'aria-live\|role="status"'`) and the
live-region strings have the expected content; actual spoken output requires
VoiceOver / NVDA / JAWS. JD or a reviewer on a system with a screen reader
should verify by: (a) selecting an evidence row and confirming the inspector
open sentence is announced, (b) pressing Confirm/Dismiss on a selected row
and confirming the review-state announcement, (c) opening a pivot preview
and confirming the preview-open sentence.

## Honest limitations

- axe-core cannot verify dynamic DOM state transitions (what happens after a
  click), only snapshot DOM. The manual checks above cover that gap for the
  three dynamic criteria.
- Status-message quality (whether a screen reader actually voices the
  announcement in a useful way) is subjective and tool-dependent. Marked
  UNVERIFIED above rather than claimed.
- The axe sweep is scoped to the six surfaces this stage touched. Pages
  outside the case workspace (`/brain`, `/cases` list page, `/auth`,
  landing) were NOT re-tested this stage.
- The modal-at-894 clipping defect that D-A closed was itself verified in a
  prior session via `document.querySelector('[role="dialog"]').getBoundingClientRect()`
  returning `right === innerWidth` across viewports 390 / 894 / 1440. Not
  re-run this stage.

## Report wording

Describe this stage's a11y posture as: **"Tested against WCAG 2.2 AA
criteria 1.4.3, 1.4.11, 2.1.1, 2.4.3, 2.4.7, and 4.1.2 across six scoped
surfaces. Criterion 4.1.3 (status messages) is wired but unverified
pending a screen-reader pass. Not a claim of general WCAG compliance."**
