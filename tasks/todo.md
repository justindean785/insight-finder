# Investigation Workspace UI/UX Upgrade

## Context / findings from inspection
The workspace already has a strong information architecture: five **top-level**
tabs (Chat, Evidence, Report, Graph, Tools) live in `WorkspaceTabs`, driven by
`ChatPage`, with a persistent `WorkspaceHeader` metric strip. So IA requirement
#1 is largely satisfied. The real, high-value gaps are in **Tools Activity**,
**Graph**, **shared primitives**, and **accessibility**. This pass targets those
without touching evidence-integrity logic (`lib/intel.ts`, confidence/labels).

Baseline: `npx vitest run` → 45 files / 536 tests pass.

## Plan (checkable)

### Shared primitives (reusable, typed)
- [x] `CopyButton` — icon button, aria-label, copied state (replaces ad-hoc copy)
- [x] `MetricCard` — labeled summary stat with icon + tone + optional tooltip
- [x] `FilterChips` — accessible segmented filter (radiogroup) with counts
- [x] `ToolStatusBadge` — succeeded/failed/skipped/pending icon+text chip
- [x] `ExpandableRow` — keyboard-accessible disclosure row
- [x] Reuse existing `EmptyState`, `ConfidenceMeter`, `TierBadge`, `StatusChip`

### Tools Activity upgrade (req #4)
- [x] Add short failure/skip `reason` to `useThreadToolActivity` events (additive)
- [x] Status filter chips: All / Succeeded / Failed / Skipped / Pending with counts
- [x] Summary `MetricCard`s (total, succeeded, failed, skipped)
- [x] Sort failures to the top by default
- [x] Expandable rows showing reason + tool id where available
- [x] Empty state + no-results (filtered) state
- [x] Status chips with icon + text (not color alone)

### Graph view upgrade (req #5)
- [x] Category filter toggles (identity/contact/social/infra/breach/web/crypto/other)
- [x] Legend with color + shape/icon + text label
- [x] Click-to-focus node detail panel (value, kind, source, confidence)
- [x] Zoom controls (in/out/reset) + larger, higher-contrast labels
- [x] Better edge contrast on focus; empty/loading states
- [x] Keyboard-focusable nodes with aria labels

### Accessibility / polish
- [x] `WorkspaceTabs`: arrow-key roving tab navigation + visible focus rings
- [~] `WorkspaceHeader`: left as-is — it already carries `title` tooltips on every
      metric and a DB-backed idle/active/completed status pip. Promoting to the
      full running/gathering/manual_review vocabulary needs live-run state the
      DB-backed header doesn't have; deferred to avoid a risky backend coupling.
- [x] All new icon-only controls have `aria-label` / titles

### Verification
- [x] `npx vitest run`
- [x] `npm run build`
- [x] `npm run lint` (new/changed files)
- [x] Targeted unit test for new `toolActivityReason` helper

## Results

### What shipped
- **Shared primitives** (`src/components/ui/workspace-primitives.tsx`): `CopyButton`,
  `MetricCard`, `FilterChips` (accessible `radiogroup`), `ToolStatusBadge`
  (icon + text), `ExpandableRow` (keyboard disclosure). Typed and reusable.
- **Tools / Activity** (`ToolsTab.tsx` + `useThreadToolActivity.ts`): status filter
  chips with live counts (All/Succeeded/Failed/Skipped/Running), four summary
  MetricCards, failures sorted to the top, expandable rows that reveal the short
  failure/skip reason + tool id, icon+text status badges, and empty + no-results
  states. Added an additive `reason` field to tool events via a new pure helper
  `toolActivityReason` (unit-tested).
- **Graph** (`GraphTab.tsx`): category filter toggles (with per-group counts),
  a legend that pairs **color + distinct shape + text** (circle/diamond/triangle/
  square/hexagon) so it never relies on color alone, click-to-open node detail
  panel (value, copyable, confidence meter, source, link rationale), zoom in/out/
  reset controls, higher-contrast + larger node labels, keyboard-focusable nodes
  with descriptive `aria-label`s, and a proper empty state.
- **Accessibility** (`WorkspaceTabs.tsx`): WAI-ARIA roving tabindex with
  Arrow/Home/End keyboard navigation and visible focus rings.

### Verification (all run locally)
- `npx vitest run` → **46 files / 541 tests pass** (was 45 / 536; +1 file, +5 tests).
- `npm run typecheck` → clean (no new errors).
- `npm run build` → succeeds (`✓ built in ~8s`).
- `npx eslint <changed files>` → clean.

### Not done / honest gaps
- No authenticated browser screenshots: this environment has no display,
  Playwright is not installed, and the workspace is gated behind Supabase auth +
  a live backend, so the real app cannot be driven headlessly here. Verification
  is build/typecheck/lint/unit-test based.
- Report/Evidence/Chat tabs were already mature; this pass focused on the
  highest-value gaps (Tools, Graph, primitives, a11y) rather than touching the
  integrity-critical evidence/confidence logic.

## Follow-up pass — Evidence textual status + filters (2026-06-15)

The Evidence board previously conveyed strength by a color-coded `%` only —
violating the "never color alone" rule and making strong-vs-weak hard to scan.

### Shipped
- **`src/lib/evidence-status.ts`** — pure, integrity-safe presentation layer that
  derives an analyst-facing status from the existing `labelForArtifact()` engine.
  Statuses: Verified / Probable / Needs corroboration / Manual review / Lead /
  Shared infrastructure / Contradicted / Rejected. Conservative by design:
  single-source can never display "Verified", breach/leak → "Manual review",
  shared-host/collision → "Shared infrastructure — not ownership proof".
- **`EvidenceStatusBadge`** (workspace-primitives) — icon + text chip, never
  color alone; distinct icon per status.
- **Evidence board rows** (`ResourcesPanel.tsx`) — every row now shows the status
  badge + an evidence-basis line (e.g. "Single-source · infrastructure").
- **Filter + sort toolbar** — quick-filter chips (All / Findings / Needs review /
  Leads / Excluded) with live counts, and sort (Strength / Confidence / Newest);
  accessible `radiogroup`s; sticky header; no-results state.

### Verification
- `npx vitest run` → **48 files / 567 tests pass** (was 47 / 557; +1 file, +10 tests).
- `npm run typecheck` → clean.
- `npx eslint` on changed files → clean.
- `npm run build` → succeeds.

### Backend note
The infra confidence sub-class split (earlier commit) is in the edge function and
must be synced to `seeker-spark-search-5362c57c` + deployed via Lovable to affect
new investigations. The Evidence-status UI works against whatever the backend
stores today (it reads existing `confidence` + metadata), so it improves the
display of past cases immediately once the frontend ships to Vercel.


## Review fix pass — semantic correctness (2026-06-15, PR #56 review)

Addressed all 6 blockers from the PR review.

### 1. Infra-only no longer overstated as generic "Verified"
- `evidence-status.ts` now reads the backend's authoritative `metadata.source_category`
  (falls back to source-string split only for legacy rows).
- New status `verified_infrastructure` ("Verified infrastructure", blue/probable
  tone) with basis "Infrastructure-only · not ownership proof". Infra-only
  findings can never display as a confirmed identity/owner claim.

### 2. Shared-infrastructure detection broadened
- `isSharedInfrastructure` now also catches `metadata.cdn`, `shared_infra`, and
  Cloudflare/Akamai/Fastly/AWS/GCP/Azure/shared-host strings in
  provider/org/asn_org/as_name/isp/asn (network-layer artifacts), plus
  reverse-IP/shared-host source strings and the `infra_shared_host` class.

### 3. New source sub-classes infra_passive + infra_shared_host
- `artifact_types.ts`: urlscan/wayback/archive/passive_dns → `infra_passive`;
  reverse-IP/shared-host sources → `infra_shared_host`.
- `confidence.ts`: caps infra_passive 70, infra_shared_host 35. Shared-host is
  excluded from infra corroboration counting and is in NEVER_HIGH.

### 4. VirusTotal taxonomy
- Added `threat_reputation` + `reputation_signal` to STRICT_KINDS.
- Evidence status treats VirusTotal/URLScan/EmailRep/IPQS as a
  "Threat/reputation signal" (Manual review), distinct from "Breach/exposure".

### 5. Weak AI summaries can't unlock 90+
- `confidence.ts`: new TRUSTED_NON_INFRA gate — only official_profile_match /
  court_record / news / independent_public unlock the >85 ownership path. infra +
  ai_summary (or many infra perspectives) stays ≤85.

### 6. Tools tab Gated / Degraded statuses
- `tool-run.ts` `deriveToolStatus()` → succeeded/failed/skipped/gated/degraded/pending.
  Gated = triage/policy/budget/rate-limit block; Degraded = partial/stale/timeout.
- `useThreadToolActivity` exposes status + gated/degraded counts; ToolsTab adds
  Gated/Degraded filter chips and a "Skipped / Gated" metric card; ToolStatusBadge
  gains Gated/Degraded variants.

### Tests added
- Backend (mirrored in vitest via `infra-confidence.test.ts`): shared-host cap 35
  + no-corroboration, passive classification, infra+ai_summary ≤85,
  infra+court_record >85, court+news = 95. Also in Deno `audit_fixes_test.ts`.
- `evidence-status.test.ts`: VirusTotal→reputation, real breach→breach/exposure,
  infra-only→Verified infrastructure, Cloudflare IP→shared infrastructure.
- `tool-activity-reason.test.ts`: deriveToolStatus gated/degraded/skipped/failed.

### Verification
- `npx vitest run` → **48 files / 581 tests pass** (was 567).
- `npm run typecheck` → clean. `npx eslint` (changed files) → clean.
- `npm run build` → succeeds.

### Remaining nuance
- The client-side **markdown report** (`buildReportMarkdown`) still groups by
  artifact `kind`, so a VirusTotal row stored as `kind:"breach"` lists under the
  report's Breach/Exposure section even though the Evidence board now labels it
  Threat/reputation. The board (the primary analyst surface) is correct; aligning
  the markdown grouping is a small follow-up.
- Backend confidence/taxonomy changes only affect new runs once synced to
  `seeker-spark-search-5362c57c` + deployed via Lovable. Frontend display fixes
  ship immediately via Vercel and improve existing cases.

## Screenshot review fix pass — 6 more blockers (2026-06-15)

Fixed all 6 issues found in the live preview screenshots.

1. **VirusTotal no longer shows as BREACH.** Added `isReputationArtifact()` +
   `displayKind()` to intel.ts (single source of truth). A breach-kinded row from
   a reputation source (VirusTotal/URLScan/EmailRep/IPQS) now displays as
   `threat_reputation`. Wired into the Evidence **Table** (EvidenceMatrixTab),
   the on-screen **Report** (CaseReport leads table + excluded from Sensitive
   Registrations), the markdown **entity table**, and the markdown **Network
   Connections** section (new "Threat / Reputation" subsection, pulled out of
   Breach/Exposure). evidence-status.ts now reuses the canonical helper.

2. **Clusters view labels infrastructure correctly.** ClustersTab detects an
   infrastructure-only cluster (all artifacts in the `infrastructure` group) and
   renders an "infrastructure" / "shared infra" badge instead of the identity
   "unknown" badge, with a "Shared infrastructure · not ownership proof" line for
   Cloudflare/CDN/reverse-IP clusters.

3. **Failures tab now matches Activity.** `extractFailedAndSkipped` was only
   catching `errorText`/`output-error`, missing `ok:false` rows (why the tab was
   empty while Activity showed 14). It now classifies every problem tool with the
   SAME `deriveToolStatus` the Activity feed uses, so the counts can't disagree,
   and groups Failed / Gated / Degraded / Skipped.

4. **Budget/gating no longer shown as red FAILED.** `deriveToolStatus` now
   inspects the reason text (errorText + output reason + runtime.rejection_reason)
   before calling something a failure: "budget exhausted" → **Gated**, "provider
   disabled / unavailable" → **Degraded**. Only real provider/runtime errors stay
   Failed. ToolsTab + FailedSkippedTab surface Gated/Degraded as first-class.

5. **Mobile primary nav.** Renamed "Chatbot" → "Chat", reordered to
   Chat | Evidence | Tools | Graph | Report, added scroll-snap (snap-x +
   snap-start) so tabs land cleanly and the active underline isn't clipped.

6. **Shared-infra confidence nuance.** Board/Table/Clusters all carry the
   "Shared infrastructure · not ownership proof" basis next to the confidence so
   a 70% DNS-resolution number can't be misread as ownership confidence. Shared-
   infra detection broadened to Cloudflare/Akamai/Fastly/AWS/GCP/Azure ASN/org.

### Verification
- `npx vitest run` → **49 files / 593 tests pass** (was 581; +12).
- `npm run typecheck` → clean. `npx eslint` (changed files) → clean.
- `npm run build` → succeeds.
- Activity ↔ Failures parity now guaranteed (shared `deriveToolStatus`).
- VirusTotal renders as Threat/Reputation across Table, Report, and markdown.
- Clusters label infra IPs as infrastructure / shared infra, not "unknown".

---

## 2026-06-22 — Workspace UI polish & IA audit (`feat/workspace-ui-polish-audit`)

Builds ON the unmerged UI stack: #104 (segmented tabs + deduped counts),
#105 (per-tab section headers), #106 (entity graph), #107 (confidence radar).
Header overload (audit #1) and global repeated-counts (audit #2) were already
resolved by #104/#105 — **verified, not redone**. This pass is presentation-only.

### Plan
- [x] Report card header: dropped the 6-chip count row (it duplicated the tab
      badges for artifacts/tools AND the Executive-Summary prose for
      confirmed/probable/leads) → one calm `type · N artifacts analyzed` scope
      line; kept the analyst-review tally. Bumped the seed to `text-lg` so the
      header reads as the title and Executive Summary is the first anchor.
- [x] Report section headers: were RED for every section (number-soup of
      warnings). Added a `tone` to `SectionHeader`; neutral by default, red
      reserved for genuine-risk sections (Safety/Legal Flags, Contradictions).
- [x] Report tables (bucket tables, Identity, Registrations): swapped
      `overflow-hidden` → `overflow-x-auto` + `min-w-[…]` so narrow widths
      scroll instead of exploding; row padding `py-2 → py-2.5`; reasoning
      contrast lifted (`text-destructive/80 → text-destructive`, muted/90).
- [x] Report export toolbar: primary downloads (Copy md / .md / PDF) split from
      secondary/raw (Matrix / JSON) by a divider that collapses on mobile;
      wrapped in a labelled `role="group"`.
- [x] Sidebar: active case row strengthened (`bg-white/[0.08]` + `ring-white/20`).
- [x] Contrast: lifted reasoning + reason-not-confirmed text where touched
      (restrained; no neon).
- [x] A11y: tables keep `<th>` semantics; export group labelled; status stays
      text+colour (ConfPill / ReviewPill), never colour-only; focus rings intact.

### Constraints
Frontend-only. No backend / clustering / confidence-math / report-generation /
graph / radar transform changes. No new/fake metrics. Presentation-only (no new
pure logic → no new transform tests; full suite stayed green).

### Results
- Files: `CaseReport.tsx`, `ReportTab.tsx`, `ThreadSidebar.tsx` (+ this doc).
- `npm run typecheck` clean · `eslint` 0 · `npm run build` OK · **675 tests pass**.
- Diff: +70/−32 across 3 components — focused, presentation-only.
- Header overload (#1) / global repeated-counts (#2) confirmed already handled
  by #104/#105 — not duplicated here.

---

## 2026-06-24 — Integrity fixes: safety DOB scan + breach caps (`fix/integrity-safety-breach-caps`)

Backend/report integrity ONLY (no UI, no schema, no runtime policy). From the
`gmansexybeast@att.net` trace. Priority #1 → #2 → #3.

### #1 — False minor-signal collision from DOB date parts  ✅
- Root cause: DOB reclassified `dob`→`other`; `safety.ts` scanned the raw value
  `1958-10-11`; the bare-age regex matched the month `10` → `bare-10` →
  `possible_minor`, conf cap 35, adult×minor collision, false top-of-report banner.
- Fix (`supabase/functions/osint-agent/safety.ts`): skip the value haystack for
  DOB artifacts (`kind==="dob"` or `metadata.original_kind==="dob"`); skip the
  bare-age heuristic on date-like strings (`DATE_LIKE_RE`). Cue/phrase detection
  (`age 16`, `i'm 15`, `minor`) untouched.
- Tests (`safety_test.ts`, 5): `1958-10-11` not flagged · date month/day 10–17 not
  flagged · adult-platform DOB no false collision · real cue/phrase/bare-age STILL
  fire · explicit cue inside a date-bearing bio still fires.

### #2 — Breach source caps misclassified as `unknown`  ✅
- Root cause: `applyEvidenceCaps` mapped single-token `classifySource` over WHOLE
  compound strings, so `breach_check+leakcheck+oathnet_lookup+deepfind_email_breach+serus_darkweb_scan`
  fell to `unknown`/cap 50 unless " breach" appeared standalone.
- Fix (`confidence.ts`): classify the whole label first; only `splitSourceLabels`
  when the whole is `unknown`; per-element drop of split-noise `unknown` sub-labels
  (keeps a genuine whole-element `unknown`, so court+news=95 stays). Added missing
  breach slug aliases (`deepfind_email_breach`, `serus_darkweb_scan`,
  `deepfind_dark_web_link`, `deepfind_ransomware_exposure`, `leakcheck`) to
  `source-classification.ts`. Whole-string-first preserves the shared-host/35
  downgrade (no split dilution) and the standalone-breach address at cap 60.
- Tests (`compound_source_caps_test.ts`, 6): compound→breach not unknown · `/`+`+`
  split · truly-unknown stays unknown/50 · two-breach nudge 65 / single 60 ·
  shared-host still 35 · standalone-breach address still 60.

### #3 — Duplicate Synthient breach artifacts  ✅
- Root cause: same Synthient 1.9B breach recorded twice (`weak_lead` +
  `breach_exposure`) under name variants from the same source pair; exact-match
  insert dedup misses name variants → double-listed in table + Network Connections.
- Fix (`report-hygiene.ts` `dedupeBreachDatasets`, wired into `intel.ts`
  `buildReportMarkdown`): collapse ONLY when same normalized source AND same
  count-magnitude token AND same year AND ≥1 shared significant word; keep the
  richer `breach_exposure` representative. Report-layer only; non-destructive.
- Tests (`report-hygiene.test.ts`, +5): two Synthient variants collapse to the
  breach_exposure row · different breaches stay separate · different source pairs
  stay separate · shared-number-only (no shared word) stays separate · non-breach
  kinds / missing count or year ignored.

### Verification (all run)
- `deno test --allow-net --allow-env --allow-sys --no-check` → **223 pass / 0 fail**
  (was 212; +11). `deno check` on changed modules → clean, no TS2304.
- `npx vitest run` → **680 pass / 0 fail** (was 675; +5).
- `npm run typecheck` clean · `eslint` (changed files) 0 · `npm run build` OK.
- No UI files changed (edge fn + `src/lib` report logic + tests only).
- Real-input confirmation (exact trace values used in tests): `1958-10-11` no
  longer flags minor; the compound breach email source classifies as breach (cap
  65, not unknown/50); the two Synthient rows collapse to one.

### Preserved / not weakened
- Real minor-age detection intact (cue + phrase + non-date bare age).
- Source caps still use split compound labels; shared-host & infra ceilings, the
  ownership guard, and the two-breach nudge all unchanged.
- Dedup is conservative + dataset-specific (source+count+year+shared-word), not a
  broad fuzzy collapse.

---

## 2026-06-22 — Production UI overlap bugs (`fix/production-ui-overlap-bugs`)

Small bugfix PR on top of the merged redesign (`main` @ b48406ef). Surfaced from
production screenshots. Fixes #110. Frontend-only; no redesign.

### Plan / findings
- [x] **Bug 1 — sticky Report sub-header transparent / bleed-through.** Root
      cause: shared `TabHeader` used `bg-[hsl(var(--surface-0))/0.98]`, which
      compiles to invalid CSS (`background-color: hsl(0 0% 3%)/0.98`) → the
      browser drops it → header has NO background. Only visible on Report (the
      one sticky header). Fix: valid opaque `bg-[hsl(var(--surface-0))]`.
      **Verified the generated CSS** is emitted (see Results), not assumed.
- [x] **Bug 2 — confidence radar overlaps export toolbar.** Same root cause as
      Bug 1 (transparent sticky header). The opaque-bg fix resolves it; the
      radar already sits below the header in flow, so no layout change needed.
- [x] **Bug 3 — possible duplicate vertical icon rail.** Investigated
      `ChatPage` layout: exactly ONE `<aside><ThreadSidebar/></aside>` (desktop)
      / one Sheet (mobile). The narrow icon rail in screenshots is the
      **collapsed** sidebar (one icon per thread) — intentional, NOT a
      duplicate. No change.
- [x] **Bug 4 — stale old-UI screenshot.** A browser tab loaded before the
      deploy still serving the cached SPA bundle. Not a code regression;
      hard-refresh (Cmd+Shift+R) shows the new build. No cache/service-worker
      work in this PR (none exists to hook into).

### Out of scope (noted, not changed per "same overlap bug only")
- `src/pages/ChatPage.tsx:117` mobile header carries the same malformed class,
  but it is NOT sticky-over-content (flex-column header) and its target colour
  equals the page background, so there is no visible bleed. Left as-is; can be
  swept separately.

### Results
- Code change: `src/components/ui/workspace-primitives.tsx` only (`TabHeader` bg
  → valid opaque `bg-[hsl(var(--surface-0))]`). +4/−1.
- **Generated-CSS verified** (built `dist/assets/*.css`): the fixed class emits
  `background-color:hsl(var(--surface-0))`; the old malformed
  `hsl(var(--surface-0))/0.98` value is absent. Not assumed — grepped.
- `npm run typecheck` clean · `eslint` 0 · `npm run build` OK · **675 tests pass**.
- Bugs 2/3/4 required no code change (see above). Scope held: one-file fix.
