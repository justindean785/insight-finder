---
name: Insight Finder
description: A forensic evidence console for OSINT analysts, lit like an operations room at night.
colors:
  ground: "#000000"
  surface-1: "#080E1B"
  surface-2: "#0C1424"
  surface-3: "#131D32"
  surface-4: "#1C2943"
  ink: "#EDF2F7"
  ink-muted: "#C4CDD9"
  ink-subtle: "#909CAD"
  ink-faint: "#677383"
  film: "#EBF6FF"
  indigo-signal: "#6859F8"
  indigo-deep: "#3017D3"
  inference-violet: "#C879F6"
  hairline: "#222E44"
  hairline-subtle: "#151D2E"
  hairline-strong: "#364968"
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
  surface: "13px"
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

**Creative North Star: "The Cold Room"**

The product is an operations room at night. A true black ground, cold platinum ink, and one electric indigo that means LIVE, LINKED or ACTIVE. Depth never comes from lighter greys; it comes from light, as translucent films and low-alpha blooms stacked on a void. An analyst sits here for hours reading dense tables, so the room is dim and the instruments are bright.

The system serves a single obligation stated in PRODUCT.md: the interface "must never make unverified data look confirmed." Every visual decision below is downstream of that. Colour is spent on authority, never on magnitude. A confidence of 38 is not "red"; it is a small number. Only the authority ladder, which answers whether a claim is corroborated, contested, or unlinked to the subject, may spend colour on a verdict.

This is a forensic instrument panel, not a hacker movie prop. Glass, blur and monospace chrome are the deliberate identity here, not defaults to avoid. What is restrained is how those materials are used, not whether they appear at all.

**Key Characteristics:**
- True black ground with tinted translucent panes floating on it
- One indigo accent, used for state and never as a large painted fill
- An eight-state authority ladder carrying colour plus icon plus word
- Density without strain: an 11px reading floor, tabular numerals everywhere
- Machined corners (13px on shared surfaces), never consumer rounding

## 2. Colors

A cold palette on a black ground, where every hue is spoken for and none is decorative.

### Primary
- **Indigo Signal** (#6859F8): the one accent. Focus rings, active tabs, the live rail, the top edge of a pane, the composer when it has the caret. It marks a surface as live. Its deep form, **Indigo Deep** (#3017D3), is reserved for pressed and gradient-foot states.

### Secondary
- **Inference Violet** (#C879F6): the second axis. Where indigo means observed evidence, violet means inference. It lights the far corner of the room and the trailing rim of a pane. Held 32 degrees off indigo so the two axes never read as one.

### Tertiary
- **Film** (#EBF6FF): not a colour so much as light. The single most load-bearing token in the system. Every translucent highlight (pane grounds, hairlines, specular caps, the blueprint grid) is `--film` at an alpha under 12%.

### Neutral
- **Ground** (#000000): the page. True black, so a pane reads as an object rather than as a slightly different grey.
- **Surface 1 through 4** (#080E1B, #0C1424, #131D32, #1C2943): a strictly monotonic ramp used as pane tint, hover, and selection. Never as a border.
- **The ink ramp**, four levels, cold platinum throughout. Every level is AA-safe on both grounds it can land on (true black and surface-1), so none of them is a trap:
  - **Ink 1 / Primary** (#EDF2F7): values, headings, anything the analyst is reading for content. 18.62 on black.
  - **Ink 2 / Secondary** (#C4CDD9): supporting copy and descriptions. 13.09 on black.
  - **Ink 3 / Tertiary** (#909CAD): source labels, timestamps, column heads. 7.54 on black, 6.92 on a pane.
  - **Ink 4 / Reference** (#677383): counts, units, inert chrome. 5.02 on black, 4.61 on a pane.
- **Hairline / Subtle / Strong** (#222E44, #151D2E, #364968): the border ramp, strictly monotonic.

### The Authority Ladder
Eight states, each with a colour, an icon and a word. Never colour alone.
- **Verified** (#2DBE7A) · **Infrastructure** (#3AACEE) · **Probable** (#399372) · **Review** (#F6AE31) · **Weak** (#74839A) · **Quarantined** (#939CA9) · **Conflict** (#EF485E) · **Failed** (#49525F)

Quarantined is deliberately neutral and hatched, never a confidence hue: a quarantined row is not a low-confidence row, it is a row whose link to the subject is unproven.

### Named Rules

**The Authority Rule.** Hue belongs to authority, not to magnitude. The authority ladder is the only scale permitted to spend colour on a verdict. A confidence numeral renders in ink, always, because the bar beside it already says how big the number is.

**The Stated Is Not Measured Rule.** A verdict the agent typed and a verdict the engine computed must never look alike. The computed one is a filled chip carrying an icon and a number. The stated one is hollow, dashed, drawn from the ink ramp, and quieter than the sentence it sits in. The fill is the tell: it belongs to a value something actually calculated, and filling a stated label back in erases the only difference between a measurement and an opinion. Measured on a real run, 2026-09-22: the transcript published "Confirmed (95)" while the engine held zero finding rows and a maximum confidence of 65, and the two were painted identically.

**The One Meaning Rule.** One meaning per token. Aliasing across roles is how this system previously ended up with an authority ladder that was secretly the confidence ramp wearing a hat.

**The Light Source Rule.** Indigo is a light source, not a fill. It appears as a rim, a bloom, a 1px edge, an active state. The moment it becomes a large painted area it stops meaning "look here" and starts meaning nothing.

**The Two Axes Rule.** Indigo is evidence, violet is inference. The room is lit from the top left in indigo and the far corner in violet, and panes carry the same pair at their rims. Nothing else may claim either hue.

## 3. Typography

**Display Font:** Sora (falling back to IBM Plex Sans)
**Body Font:** IBM Plex Sans (falling back to system-ui)
**Data Font:** JetBrains Mono (falling back to ui-monospace)
**Figure Font:** Newsreader, a light text serif, reserved for numerals and case mastheads

**Character:** A geometric display face against a humanist body face is a real contrast axis, not two near-identical sans-serifs competing. The serif appears only where a document voice is wanted: a case title reads as a masthead, not a dashboard heading.

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

**The Data Face Rule.** Monospace is a data face, not a body face. Reserve it for values a reader may need to compare character by character: selectors, IDs, timestamps, hashes, JSON. Labels and prose stay in the sans, or the console reads as terminal cosplay.

**The Micro Floor Rule.** Dense labels may run below body size but never below 11px, and never combine small size with both heavy tracking and reduced opacity. Pick at most one intensifier.

**The Ink Ramp Rule.** Four named levels, and an opacity modifier on ink is forbidden. The system shipped with two levels while the product needed four, so 48 files improvised the difference: 242 occurrences of 21 distinct values (`text-muted-foreground/70`, `/60`, `/55`, `/45`). That is a second, drifting source of truth for the one thing an analyst does constantly, which is read. Reach for `text-subtle-foreground` or `text-faint-foreground`, never `text-muted-foreground/60`.

**The Visible Ink Rule.** Two treatments are permitted to paint a gradient and clip it to text: the `h1, h2` top-lit ramp and the `.stat-figure` headline numerals. This is a sanctioned exception, decided 2026-09-22, and the only one. It carries a hard condition: a gradient may never be the sole reason text is visible. Both set `color: transparent`, so unlayered fallbacks restore solid ink under `forced-colors: active`, under `print`, and where `background-clip: text` is unsupported. Any new clipped-text treatment ships with the same three fallbacks or it does not ship.

## 4. Elevation

Depth is light on a void, not a grey ramp. Surfaces are separated by a translucent film, a specular cap where light would catch the top edge, and a single contained shadow. Because the ground is true black, a pane is legible as an object even at 5% film alpha.

Blur marks elevation and has a budget: one blur value per tier, never escalated ad hoc per component.

### Shadow Vocabulary
- **Pane** (`inset 0 1px 0 film/0.085, 0 14px 38px -22px black/0.98`): the resting surface. One inner hairline, one contained shadow.
- **Raised** (`inset 0 1px 0 film/0.075, 0 18px 44px -26px black/0.95`): drawers, popovers, floating tiles.
- **Refracted rim** (`inset 1px 0 0 indigo/0.05, inset -1px 0 0 violet/0.05`): the two axes read at the pane edge, where real glass bends light. Hairline only.
- **Blur tiers**: 22 to 26px with 145 to 170% saturation on panes; 28px on overlays.

### Named Rules

**The Glow Is State Rule.** A glow or halo must map to something real: active selection, live status, a confidence tier, an error. A glow with nothing behind it is the amateur tell. Cut it.

**The Blur Budget Rule.** Backdrop blur marks elevation, not surface. One intensity per tier. If two adjacent components blur by different amounts for no structural reason, one of them is wrong.

## 5. Components

### Panels
- **Corner Style:** 13px, a machined edge. Large radii are what make a dense data surface read as consumer software.
- **Background:** an off-axis sheen, a vertical film gradient, then a two-stop surface tint that is colder at the foot so a large pane does not read as one flat sheet.
- **Border:** 1px film at 10%, with the top edge lifted to 20%.
- **Shadow Strategy:** see Elevation. One cap, one contained shadow, one refracted rim.

### Transcript Cards
- **Character:** the same material as a panel. The transcript is not a separate screen.
- **Speaker identity:** a 72px tinted wash at the head of the card in the speaker's own hue (analyst, agent, tool, system, failed). Failure is the one speaker permitted to raise its voice.
- **Header:** 36px, uppercase label type, a film hairline beneath.

### Authority Chips
- **Style:** a bordered chip at 10% tint of its own state colour, carrying an icon and a word.
- **Rule:** the two states that deny authority (quarantined, failed) additionally carry a texture, because on a 300-row ledger hue is the first thing that stops being legible.

### Confidence
- **Bar:** a 1.5px track with a tier-coloured fill.
- **Numeral:** ink, never the tier colour. The bar's length already says how big the number is; colouring the numeral too made a low score look like a failure rather than like a small measurement.

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
- **Do** keep the indigo as a rim, an edge, a bloom or an active state.
- **Do** keep body text at 4.5:1 and large text at 3:1 against the composited surface, not against the token in isolation. Measure through the glass, not each layer alone.
- **Do** use the shared `.panel` material for any new surface. It replaced six near-identical materials and exists so the workspace reads as one instrument.
- **Do** keep monospace for values a reader compares character by character.
- **Do** give every animation a `prefers-reduced-motion` alternative.
- **Do** ship the three fallbacks (`forced-colors`, `print`, `@supports not`) with any text that relies on `background-clip: text`. Transparent ink that never repaints is invisible text, not a subtle heading.

### Don't:
- **Don't** build "generic SaaS dashboards (gradient hero metrics, identical card grids, purple-glow marketing shells)."
- **Don't** reach for "Hollywood hacker cliché: neon-green matrix rain, glitch effects, scanline overlays, skull iconography, decorative 'typing' animations."
- **Don't** use "glass/glow used as generic decoration rather than a deliberate material with a budget," which is the tell separating a designed forensic console from AI slop wearing a dark theme.
- **Don't** ship "anything that renders a single-source lead with the same visual weight as a corroborated finding." This is the integrity failure mode and it outranks every aesthetic concern.
- **Don't** use a `border-left` or `border-right` above 1px as a coloured accent on a card, list item, callout or alert. A left rule on a genuine blockquote is typography and is permitted; an accent strip on a card is not.
- **Don't** fill a label the agent typed in prose, or draw it from the confidence ramp. Hollow, dashed, ink ramp. The filled chip means a number was computed.
- **Don't** colour a confidence numeral by its value.
- **Don't** give a quarantined row a confidence hue. Quarantine is a linkage state, not a low score.
- **Don't** round a data surface past 16px, or it reads as consumer software.
- **Don't** let a new surface invent its own blur, radius or border alpha. That is how the six-material drift happened the first time.
- **Don't** animate a layout property to show a data change. A confidence bar's width is data and snaps; only its authority colour eases.
- **Don't** stack an opacity modifier on an ink token to invent a new level. Four exist; use them.

<!-- Audit trail: contrast measured 2026-09-22 against the live harness across every
     rendered text node: 0 failures at WCAG AA, placeholder text at 6.41:1. -->
