---
name: Insight Finder
description: A black operations workstation for OSINT analysts. Graphite plates on near-pure black, light only where attention belongs.
colors:
  ground: "#030304"
  surface-1: "#0B0B0E"
  surface-2: "#101013"
  surface-3: "#141417"
  surface-4: "#1B1B1F"
  ink: "#E9EAED"
  ink-muted: "#D1D2D7"
  ink-subtle: "#8E9098"
  ink-faint: "#84868E"
  film: "#FFFFFF"
  indigo-signal: "#7565F8"
  indigo-deep: "#4A33E0"
  inference-violet: "#C879F6"
  hairline: "#25262C"
  hairline-subtle: "#1C1D22"
  hairline-strong: "#33343B"
  authority-verified: "#2DBE7A"
  authority-infrastructure: "#3AACEE"
  authority-probable: "#399372"
  authority-review: "#F6AE31"
  authority-weak: "#74839A"
  authority-quarantine: "#939CA9"
  authority-conflict: "#EF485E"
  authority-failed: "#49525F"
  destructive: "#DA1B34"
typography:
  display:
    fontFamily: "Sora, 'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.35
  body:
    fontFamily: "'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.6
  data:
    fontFamily: "'JetBrains Mono', ui-monospace, Menlo, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.45
    fontFeature: "tnum"
  label:
    fontFamily: "'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.625rem"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "0.08em"
  figure:
    fontFamily: "Newsreader, ui-serif, Georgia, serif"
    fontSize: "2rem"
    fontWeight: 200
    lineHeight: 1.02
    letterSpacing: "-0.018em"
rounded:
  sm: "8px"
  md: "10px"
  lg: "12px"
  surface: "4px"
  lens: "12px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  panel:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.ink}"
    rounded: "{rounded.surface}"
    padding: "14px"
  chat-card:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.ink}"
    rounded: "{rounded.surface}"
    padding: "0"
  chat-card-header:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.ink-muted}"
    typography: "{typography.label}"
    height: "36px"
    padding: "0 14px"
  authority-chip:
    textColor: "{colors.authority-verified}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "1px 6px"
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ground}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "36px"
  input-composer:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "12px 14px"
---

# Design System: Insight Finder

## 1. Overview

> **History (dated, so nobody re-derives it).** "The Cold Room" (blue-black) until
> 2026-09-25 → a flat "Case desk" graphite with a teal accent, which shipped and was
> scored by JD on 2026-10-19 as a grey template → a blue "Cold Room 2.0" foundation
> drafted in PR #805, rejected by JD the same day for its navy surfaces → **Obsidian
> Intelligence**, approved by JD on 2026-10-19 after two black mockups were compared
> (hybrid: Obsidian Graphite foundation, Black Glass on selected surfaces only).

**Creative North Star: "Obsidian Intelligence — a black operations workstation"**

Near-pure black, graphite plates, silver ink. The room is black and the instruments carry the light: depth comes from tonal steps, an engraved hairline and a single top cap, never from colour or blur. One indigo signal marks what is live, focused or selected, as a thin edge or a small mark. Black Glass (the Lens) is reserved for the few surfaces that hold the analyst's attention: the brief, the selected evidence, the decision queue and the active controls. An analyst sits here for hours reading dense tables, so everything else stays quiet.

The system serves a single obligation stated in PRODUCT.md: the interface "must never make unverified data look confirmed." Every visual decision below is downstream of that. Colour is spent on authority, never on magnitude. A confidence of 38 is not "red"; it is a small number. Only the authority ladder, which answers whether a claim is corroborated, contested, or unlinked to the subject, may spend colour on a verdict.

This is a forensic instrument panel, not a hacker movie prop. What is restrained is how materials are used: glass is earned by attention, not applied to every card.

**Key Characteristics:**
- Near-pure black ground (#030304); graphite plates with no visible hue
- Two materials only: Plate (default) and Lens (Black Glass, budgeted)
- One indigo accent, spent as an edge, focus outline or live mark, never a fill
- An eight-state authority ladder carrying colour plus icon plus word
- Density without strain: an 11px floor, tabular numerals, mono only for data
- Machined corners: 4px on plates, 12px on the Lens, never consumer rounding

## 2. Colors

Black and graphite, where every hue is spoken for and none is decorative.

### Primary
- **Indigo Signal** (#7565F8): the one accent. Focus outlines, the active tab's underline, the live phase node, the selected row's 1px inset, the focused Lens's top hairline. Never a fill, never a gradient. **Indigo Deep** (#4A33E0) is reserved for pressed states.

### Secondary
- **Inference Violet** (#C879F6): agent and inference marks only (for example the "Agent analysis" tag on the brief). Held 35 degrees off indigo so the two never read as one.

### Tertiary
- **Film** (#FFFFFF at alpha): light, not colour. Top caps, hairlines on the Lens, corner ticks — always white at an alpha under 12%.

### Neutral
- **Ground** (#030304): the page. Near-pure black.
- **Surface 1 through 4** (#0B0B0E plate, #101013 hover and selected row, #141417 raised, #1B1B1F top step): a strictly monotonic graphite ramp. Saturation stays at or below 12% at under 12% lightness, which reads as black, not blue.
- **The ink ramp**, four levels of silver. Measured 2026-10-19; every level clears WCAG AA (4.5:1) on every surface it can land on:

  | Ink | Hex | ground | plate | plate-2 | raised | surface-4 |
  |---|---|---|---|---|---|---|
  | 1 Primary — values, headings | #E9EAED | 17.1 | 16.3 | 15.8 | 15.3 | 14.3 |
  | 2 Secondary — supporting copy | #D1D2D7 | 13.7 | 13.0 | 12.6 | 12.2 | 11.4 |
  | 3 Tertiary — source labels, timestamps | #8E9098 | 6.5 | 6.2 | 6.0 | 5.8 | 5.4 |
  | 4 Reference — counts, units, inert chrome | #84868E | 5.7 | 5.4 | 5.2 | 5.1 | 4.7 |

- **Ink 2 is held at 83% lightness on purpose.** About 80 call sites still draw it at reduced opacity (`/0.6`, `/0.55`); at 83% those composites are at least as legible as they were before this register (0.6 → 5.2:1 on the ground). Do not lower it, and replace opacity modifiers with ink 3 or ink 4 when touching those files.
- **Hairline / Subtle / Strong** (#25262C, #1C1D22, #33343B): the border ramp, strictly monotonic.

### The Authority Ladder
Eight states, each with a colour, an icon and a word. Never colour alone.
- **Verified** (#2DBE7A) · **Infrastructure** (#3AACEE) · **Probable** (#399372) · **Review** (#F6AE31) · **Weak** (#74839A) · **Quarantined** (#939CA9) · **Conflict** (#EF485E) · **Failed** (#49525F)

Quarantined is deliberately neutral and hatched, never a confidence hue: a quarantined row is not a low-confidence row, it is a row whose link to the subject is unproven.

### Named Rules

**The Authority Rule.** Hue belongs to authority, not to magnitude. The authority ladder is the only scale permitted to spend colour on a verdict. A confidence numeral renders in ink, always, because the bar beside it already says how big the number is.

**The Stated Is Not Measured Rule.** A verdict the agent typed and a verdict the engine computed must never look alike. The computed one is a filled chip carrying an icon and a number. The stated one is hollow, dashed, drawn from the ink ramp, and quieter than the sentence it sits in. The fill is the tell: it belongs to a value something actually calculated, and filling a stated label back in erases the only difference between a measurement and an opinion. Measured on a real run, 2026-09-22: the transcript published "Confirmed (95)" while the engine held zero finding rows and a maximum confidence of 65, and the two were painted identically.

**The One Meaning Rule.** One meaning per token. Aliasing across roles is how this system previously ended up with an authority ladder that was secretly the confidence ramp wearing a hat.

**The Light Source Rule.** Indigo appears only as a 1–2px edge, a focus outline, a live node ring or a small mark. It is never a fill and never a gradient. The moment it becomes a painted area it stops meaning "look here" and starts meaning nothing.

**The Two Axes Rule.** Indigo is focus, selection and live state; violet is inference. Nothing else may claim either hue.

**The No Navy Rule.** Surfaces carry no hue. A blue-tinted panel, a navy gradient or a coloured room bloom is a bug, whatever it looks like in a screenshot. Colour on screen belongs to the authority ladder, the signal and the inference mark — nothing else.

## 3. Typography

**Display Font:** Sora (falling back to IBM Plex Sans)
**Body Font:** IBM Plex Sans (falling back to system-ui)
**Data Font:** JetBrains Mono (falling back to ui-monospace)
**Figure Font:** Newsreader, a light text serif, reserved for numerals and case mastheads

**Character:** A geometric display face against a humanist body face is a real contrast axis, not two near-identical sans-serifs competing. The serif appears only where a document voice is wanted: a case title reads as a masthead, not a dashboard heading.

### Obsidian additions (2026-10-19)
- **Newsreader 300** is the brief's masthead only: 30px desktop, 22px on phones.
- **Labels** are IBM Plex Sans, sentence case, 12px, never monospace, never below 11px.
- **Selectors** use the data face with `overflow-wrap: anywhere`; never an ellipsis.

### Hierarchy
- **Display** (Sora 600, 1.5rem, -0.025em): case titles and top-level section headings only.
- **Headline** (Plex 600, 1rem): panel and tab headings.
- **Body** (Plex 400, 0.875rem, 1.6): prose in the transcript. Capped at 65 to 75 characters.
- **Meta** (Plex 400, 0.8125rem): secondary and supporting copy.
- **Data** (JetBrains Mono 400, 0.75rem, tabular): selectors, IDs, hashes, timestamps, table cells.
- **Micro** (0.6875rem): the dense reading floor.
- **Label** (Plex 600, 0.625rem, 0.08em, uppercase): badges and column heads, four words maximum.
- **Figure** (Newsreader 200, -0.018em): case mastheads and headline numerals.

### Named Rules

**The Data Face Rule, stated in full.** Monospace is for values a reader compares character by character: selectors, IDs, timestamps, hashes, counts, durations, the stated-label vocabulary. It is NOT a label face. The one sanctioned exception is a data table's own furniture -- `.ledger-head` and the group rule inside `.ledger` -- which sit directly on columns of monospace values. Everywhere else a label is set in the primary sans, in sentence case. PRODUCT.md names the failure this prevents: "terminal cosplay."

**The One Intensifier Rule.** Micro-type may carry ONE intensifier beside its size: heavy tracking, or uppercase, or reduced ink. Not two, never three. Measured 2026-09-22: the section rule was carrying six at once (monospace, 10px, 600 weight, 0.14em tracking, uppercase, 72% ink) on six headings per screen, which is how a page of real evidence came to read as a template.

**The Data Face Rule.** Monospace is a data face, not a body face. Reserve it for values a reader may need to compare character by character: selectors, IDs, timestamps, hashes, JSON. Labels and prose stay in the sans, or the console reads as terminal cosplay.

**The Micro Floor Rule.** Dense labels may run below body size but never below 11px, and never combine small size with both heavy tracking and reduced opacity. Pick at most one intensifier.

**The Ink Ramp Rule.** Four named levels, and an opacity modifier on ink is forbidden. The system shipped with two levels while the product needed four, so 48 files improvised the difference: 242 occurrences of 21 distinct values (`text-muted-foreground/70`, `/60`, `/55`, `/45`). That is a second, drifting source of truth for the one thing an analyst does constantly, which is read. Reach for `text-subtle-foreground` or `text-faint-foreground`, never `text-muted-foreground/60`.

**The Visible Ink Rule.** Two treatments are permitted to paint a gradient and clip it to text: the `h1, h2` top-lit ramp and the `.stat-figure` headline numerals. This is a sanctioned exception, decided 2026-09-22, and the only one. It carries a hard condition: a gradient may never be the sole reason text is visible. Both set `color: transparent`, so unlayered fallbacks restore solid ink under `forced-colors: active`, under `print`, and where `background-clip: text` is unsupported. Any new clipped-text treatment ships with the same three fallbacks or it does not ship.

## 4. Elevation — two materials

Depth is tonal steps and engraved edges on black. Two materials exist, and a component is one or the other.

### Plate (the default)
- `.panel` and every alias (`.glass*`, `.chat-card`, `.instrument-panel`, `.card-material`) read the shared `--pane-*` variables in `src/index.css`.
- Flat graphite (surface-1), a 1px hairline, a 1px inner black line (the engraved edge) and a 1px film top cap. 4px corner. No gradient, no blur, no glow.
- **Raised plate** (`.panel-raised`): surface-3, the same edge, one contained shadow — drawers, menus, popovers.
- **Corner ticks** (`.plate-ticks`): machined registration marks, on top-level plates only.

### Lens (Black Glass, budgeted)
- `.lens`, reading `--lens-*`: light film over black (a top radial film plus a vertical film), a 8.5% film border, a top specular, one deep shadow, 12px corner. A focused or selected Lens adds the indigo top hairline.
- **Allowed only on:** the analytical brief, the selected-evidence inspector, the analyst decision queue, active investigation controls (composer and run controls while focused or running), and a focused/selected plate row.
- **Budget:** one primary and one secondary Lens per screen.
- **Blur:** only where nothing scrolls beneath the Lens; never on a phone list.

### Shadow Vocabulary
- **Plate** (`inset 0 0 0 1px black/0.65, inset 0 1px 0 film/0.04`).
- **Raised** (`inset 0 0 0 1px black/0.6, inset 0 1px 0 film/0.06, 0 18px 40px -24px black`).
- **Lens** (`inset 0 1px 0 film/0.11, 0 0 0 1px black/0.85, 0 30px 60px -34px black`).
- **Blur tiers**: overlays (sheets, dialogs, popovers, palette) at 22 to 28px, plus the Lens under the condition above. Plates never blur.

### Named Rules

**The Glow Is State Rule.** A glow or halo must map to something real: active selection, live status, a confidence tier, an error. A glow with nothing behind it is the amateur tell. Cut it.

**The Blur Budget Rule.** Backdrop blur marks elevation, not surface. One intensity per tier. If two adjacent components blur by different amounts for no structural reason, one of them is wrong.

### Panel Roles
Three, and the difference is what a surface IS, not how it is decorated.
- **Flat** -- a list under a heading. No frame, no blur: `.rule-label` already opens a group without boxing it, and a list is not elevated above anything.
- **Panel** -- a plotted chart or a framed reading. One border, one blur tier.
- **Primary** -- the one surface on a page that asks the analyst to act. A second step of elevation, never a glow; glow is state.

## 5. Components

### Panels
- **Material:** Plate by default; Lens only on the named surfaces in §4.
- **Corner Style:** 4px on plates, 12px on the Lens.
- **Border:** the hairline plus the engraved inner black line.

### Shell (dossier header + icon rail)
- 56px icon rail; the active item carries a 1px indigo tick, not a fill.
- The dossier header is the ground itself, separated by a hairline: case identity on the left (seed kind, status word, the seed on the data face, the case title), readouts on the right as mono figures with word labels and visible denominators.
- On a phone: an identity bar (the seed wraps and is never truncated) with four readouts, and a bottom tab bar.

### Phase navigator / run log
- Phases come **only** from the recorded runtime `stage` and `cycle_id` on each tool result. A call without them goes in an **Unphased** group. Never assign a phase by tool name.
- Each phase shows its call count and outcome counts through the canonical outcome taxonomy (`src/lib/tool-outcome.ts`). Faulted, degraded, no-record, skipped and cached calls are counted, never hidden, and never presented as findings.
- Desktop: a 248px column that collapses to a 44px phase strip; the brief keeps at least 560px. Phone: a phase strip whose phases open their calls in a bottom sheet.

### Evidence ledger and inspector
- The ledger is a table grouped by authority: selector on the data face (never truncated), kind, authority chip, the sources named on the artifact, basis, computed confidence.
- The inspector is a Lens: the exact selector, the authority chip, the computed confidence and who computed it, the sources named on the artifact. It states in one line that call-level lineage is not recorded and never draws a call-to-artifact chain.
- Phone: a readable list (selector line, chip and confidence line, sources line) and a focus-trapped detail sheet with Esc/close and return focus.

### Source performance
- Per provider, from `tool_usage_log` through the canonical outcome taxonomy, with separate counts for succeeded, no record, skipped, degraded and faulted. Captioned: "execution outcomes, not evidence reliability". Never a phase-level breakdown presented as provider performance.

### Bottom dock (phones)
- The composer and the tab bar share one dock. Every scroll container reserves the measured dock height plus `env(safe-area-inset-bottom)`. Nothing fixed may cover report text, ledger rows or controls.

### Transcript Cards
- **Character:** the same material as a panel. The transcript is not a separate screen.
- **Speaker identity:** a 72px wash at the head of the card. Analyst and tool are neutral silver, the agent is the indigo signal at wash alpha, and failure is the one speaker permitted to raise its voice.
- **Header:** 36px, uppercase label type, a film hairline beneath.

### Authority Chips
- **Style:** a bordered chip at 10% tint of its own state colour, carrying an icon and a word.
- **Rule:** the two states that deny authority (quarantined, failed) additionally carry a texture, because on a 300-row ledger hue is the first thing that stops being legible.

### Confidence
- **Bar:** a 1.5px track with a tier-coloured fill.
- **Numeral:** ink, never the tier colour. The bar's length already says how big the number is; colouring the numeral too made a low score look like a failure rather than like a small measurement.

### Metric Cards
- **Style:** a lit `.panel` tile carrying an eyebrow, a 28px top-lit figure, its denominator in reference ink, and a 2px rule whose LENGTH is the share.
- **Rule:** hue on the icon and the rule, never on the figure. Weight follows what the number means, so a reading at zero recedes to reference ink.
- **Rule:** the label row reserves two lines at every width, so a bank puts every figure on one baseline whatever its labels do.
- **Rule:** one metric component. `MetricCard` is it. A second copy on another surface is how two banks of the same readings came to look like different objects.
- **Rule:** a bank earns its place only where its readings are not already stated better elsewhere. Three of the Overview's five tiles duplicated the case bar AND the authority distribution; they became one line of run figures instead.

### Stated Labels
- **Style:** a hollow chip with a 1px dashed edge, 10px mono caps, no fill, drawn from the ink ramp at three registers: claims of strength at ink 2, hedges at ink 3, alarms at the ladder's conflict hue.
- **Rule:** never the confidence ramp. That ladder belongs to the code that computes confidence, and a second copy of it in prose is a drifting source of truth. The chip also carries a title saying who wrote it, and the card footer says so once in text, because a hover reaches no touch device.

### Inputs
- **Style:** surface-1 ground, 12px radius, film hairline.
- **Focus:** the indigo ring at full strength. A focus ring is the single most "is this a real product" detail on a dark UI.

### Buttons
- **Primary:** near-white ink ground with black text, 10px radius, 36px tall. Deliberately not the indigo: a full-bleed saturated button is the cheapest-looking object on a dark UI, and the accent is worth more spent on state than on a rectangle.
- **Hover / Focus:** 150 to 250ms, ease-out. Focus-visible always restores a visible ring when `outline: none` is set.

## 6. Do's and Don'ts

### Do:
- **Do** spend hue on the authority ladder and nothing else.
- **Do** render every state with colour plus an icon plus a word, so the ladder survives colour blindness and a 300-row scroll.
- **Do** keep the indigo as a 1–2px edge, a focus outline or a live mark.
- **Do** keep body text at 4.5:1 and large text at 3:1 against the composited surface, not against the token in isolation. Measure through the glass, not each layer alone.
- **Do** use the shared `.panel` material for any new surface. It replaced six near-identical materials and exists so the workspace reads as one instrument.
- **Do** keep monospace for values a reader compares character by character.
- **Do** give every animation a `prefers-reduced-motion` alternative.
- **Do** ship the three fallbacks (`forced-colors`, `print`, `@supports not`) with any text that relies on `background-clip: text`. Transparent ink that never repaints is invisible text, not a subtle heading.

### Don't:
- **Don't** give any surface a hue, or use a gradient as a surface colour (The No Navy Rule).
- **Don't** put a Lens on more than two surfaces per screen, or on a surface not named in §4.
- **Don't** show a phase, a provenance link or a source rating that the data does not record. Say it is unavailable.
- **Don't** build "generic SaaS dashboards (gradient hero metrics, identical card grids, purple-glow marketing shells)."
- **Don't** reach for "Hollywood hacker cliché: neon-green matrix rain, glitch effects, scanline overlays, skull iconography, decorative 'typing' animations."
- **Don't** use "glass/glow used as generic decoration rather than a deliberate material with a budget," which is the tell separating a designed forensic console from AI slop wearing a dark theme.
- **Don't** ship "anything that renders a single-source lead with the same visual weight as a corroborated finding." This is the integrity failure mode and it outranks every aesthetic concern.
- **Don't** use a `border-left` or `border-right` above 1px as a coloured accent on a card, list item, callout or alert. A left rule on a genuine blockquote is typography and is permitted; an accent strip on a card is not.
- **Don't** truncate a sentence like a selector. A selector is compared character by character and belongs on one line in the data face; a finding written into the same column is prose and wraps to two lines in the reading face. `isProseValue` decides, and every list that shows an artifact value uses it.
- **Don't** let a count stand without the whole it is a share of. "Quarantined 9" is a crisis in a twelve-artifact case and a footnote in a five-hundred-artifact one.
- **Don't** pass a type-scale class and a text colour through `cn()` expecting both to survive without the `extendTailwindMerge` config in `src/lib/utils.ts`. `text-*` is ambiguous and tailwind-merge resolves it from a table; the scale has to be named to it.
- **Don't** fill a label the agent typed in prose, or draw it from the confidence ramp. Hollow, dashed, ink ramp. The filled chip means a number was computed.
- **Don't** colour a confidence numeral by its value.
- **Don't** give a quarantined row a confidence hue. Quarantine is a linkage state, not a low score.
- **Don't** round a data surface past 16px, or it reads as consumer software.
- **Don't** invent a radius between the steps. The scale is xs 4 (micro-chips and inline code, 128 uses), sm 8, md 10, lg 12, surface 13, pill. A `rounded-[9px]` and a `rounded-[11px]` were the only strays and both snapped to a step.
- **Don't** give every section on a page the same frame. Nine identical boxes is PRODUCT.md's own anti-reference, and it reads as a template whatever is inside them.
- **Don't** let a new surface invent its own blur, radius or border alpha. That is how the six-material drift happened the first time.
- **Don't** animate a layout property to show a data change. A confidence bar's width is data and snaps; only its authority colour eases.
- **Don't** stack an opacity modifier on an ink token to invent a new level. Four exist; use them.

<!-- Audit trail: contrast measured 2026-09-22 against the live harness across every
     rendered text node: 0 failures at WCAG AA, placeholder text at 6.41:1. -->
