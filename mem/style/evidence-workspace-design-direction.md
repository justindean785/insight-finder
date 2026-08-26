---
name: Frontend design direction — "Dossier, alive" + the token audit that grounds it
description: The theme is 99.4% tokenized so a recolour is an index.css edit, BUT .panel is a hue-neutral white film so surface tokens barely paint anything; --danger/--confidence-low/--authority-conflict are the same value; chosen direction is editorial masthead on true black glass with motion
type: style
---
**Measured 2026-08-26 on `a38963c`.** Do not re-derive these — they were measured, not guessed.

## The token audit

- **102 CSS custom properties** in `src/index.css`; **1,608** token-based utility usages vs **10**
  hardcoded palette usages across `src/`. **99.4% tokenized.** Only 4 files carry any hardcoded
  colour (`ToolHealthPanel.tsx` ×2, `AdminSecurity.tsx`, `ui/toast.tsx`, `ThreadSidebar.tsx` ×1).
  So a recolour is an `index.css` edit, not a component sweep — and it barely collides with B1–B7,
  which touch component logic.

- ⚠️ **`--surface-0`…`--surface-4` barely paint anything.** `.panel` — the single consolidated
  surface (`index.css:288`) — is `background: hsl(0 0% 100% / 0.026)`, a **hue-neutral 2.6% white
  film** over whatever is behind it. Overriding the surface ramp produces almost no visible change.
  To shift temperature you must tint the panel film itself or lift the base lightness. **This is why
  a "change the colour scheme" pass looks like nothing happened** — measured, not theorised.

- ⚠️ **Three tokens are the SAME value:** `--danger`, `--confidence-low` and `--authority-conflict`
  are all `358 92% 64%`. So "low confidence", "danger" and "conflict" render identically, which is
  why a 38% reads as an alarm next to a `Conflict` chip. **Breaking this is the single highest-value
  colour fix in the app.**

- The file's own comment promises *"a near-black base with a faint cool intel-blue cast"* but
  `--background: 0 0% 3%` is **0% saturation** — pure neutral. 46 of the tokens sit at hue 0. The
  stated intent was never implemented.

- Three greens within 16° of hue: `--conf-confirmed` 158, `--confidence-high` 152, `--conf-likely` 142.

## The chosen direction — "Dossier, alive"

JD reviewed three static directions (Vault / Terminal / Dossier) and picked **Dossier**, then asked
for it "more creative/animated", "dark black", "glassy", "expensive, a real tool not a joke".

Design canvas (holds the authored source; recover working files with
`seed-canvas.mjs --extract`): **https://claude.ai/code/artifact/f7d1ecf7-44eb-470f-a1a4-94249467697a**

Direction = editorial-intelligence-document on true black glass:
- Masthead column (~400px): Newsreader serif 52px subject name, roman-numeral register,
  classification band, rotating NOT-PROMOTABLE seal
- True black `#000` ground, layered glass, breathing radial field, CRT scanlines, vignette
- Palette: cream `#EFE9DE` / muted `#A39A8C`, oxblood `#C4695C` accent, verified `#78A588`,
  review `#C9A961`, quarantine `#9C9184`
- Motion on load: masthead rises, rules draw L→R, register entries stagger, confidence bars fill,
  scan sweep, seal ring rotates, live dot pulses, caret blinks

**The design decision that must survive porting:** confidence is **no longer coloured by value**.
The numeral is neutral; a hairline bar carries magnitude; hue is reserved for AUTHORITY alone.
Oxblood appears exactly once per screen — on a real conflict.

**Open risks, not yet resolved:** the masthead costs ~400px of width on every screen and has not
been checked against the Graph or Tools tabs; PNG/PDF export falls back from Newsreader.

## How to see the app before/after (this works — used it)

```bash
npx vite --config vite.harness.config.ts     # → 127.0.0.1:5174
# open /chat/11111111-2222-4333-8444-555555555555   (signed-in workspace, all 5 tabs, mock data)
```
Screenshots: Chromium is at **`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`** (NOT the
`chromium/` path Playwright's default expects); `npm i playwright-core` in a scratch dir, then
`chromium.launch({ executablePath: '<that path>', args:['--no-sandbox'] })`.

To trial a palette without touching components: append a bare `:root{…}` override block to the END
of `src/index.css` (unlayered beats `@layer base`), screenshot, then `git checkout src/index.css`.
