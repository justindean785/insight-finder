---
name: run-insight-finder
description: Run, start, launch, drive, or screenshot the Insight Finder (Swarmbot) web UI, including the signed-in case workspace (Overview, Investigate, Evidence, Tools, Graph, Report tabs) and a live mocked investigation run, with no credentials and no network. Use when asked to see a UI change working, screenshot a tab, reproduce a frontend bug, or run the frontend/e2e tests.
---

Insight Finder's frontend is a Vite + React app. To drive it headless, start the **UI harness**
(`vite.harness.config.ts`, which swaps the Supabase client and the chat transport for fixtures),
then run `.claude/skills/run-insight-finder/driver.mjs`. The driver is a step-based Playwright
script that clicks tabs, types into the composer and takes screenshots. All paths here are
relative to the repo root.

This covers the **frontend only**. Edge functions (`supabase/functions/`) never run locally from
here: test them with `npm run test:edge` (Deno), and ship them with the `edge-deploy` skill.

## Setup

Node 22 and npm are preinstalled in the cloud container. The package manager is npm (there is
no pnpm lockfile).

```bash
npm ci --no-audit --no-fund
```

## Run (agent path)

Start the harness in the background, then poll until it serves:

```bash
(npx vite --config vite.harness.config.ts > /tmp/harness.log 2>&1 &)
timeout 60 bash -c 'until curl -sf http://127.0.0.1:5174 >/dev/null; do sleep 1; done' && echo UP
```

Drive it. Steps run left to right. Screenshots go to `/tmp/insight-finder-shots/<name>.png`
(override with `OUT=`). With no arguments the driver opens the fixture case on Overview and saves
`overview.png`.

```bash
# Every main tab of the fixture case (a finished investigation with 55 artifacts)
node .claude/skills/run-insight-finder/driver.mjs \
  goto /chat/11111111-2222-4333-8444-555555555555 \
  tab Overview settle shot overview \
  tab Evidence settle shot evidence \
  tab Report settle shot report

# A real user flow: send a message and watch the mocked run stream in
node .claude/skills/run-insight-finder/driver.mjs \
  goto /chat/11111111-2222-4333-8444-555555555555 \
  tab Investigate settle \
  fill "Ask about this case" "check the domain again" press Control+Enter \
  wait "Working the seed" shot running-mid sleep 8000 shot running-later

# Signed-in home page, plus its visible text
node .claude/skills/run-insight-finder/driver.mjs goto / shot home text
```

| step | what it does |
|---|---|
| `goto <path>` | navigate (base `http://127.0.0.1:5174`, override with `BASE=`) |
| `viewport <WxH>` | resize the page (default 1280x720; the e2e suite also uses 894x617 and 1440x900) |
| `tab <name>` | click the workspace tab whose accessible name matches `<name>` (case-insensitive regex) |
| `settle` | wait for the "Loading workspace" placeholder to go away. **Use it after every `tab`.** |
| `fill <placeholder> <text>` | type into the field whose placeholder contains `<placeholder>` (React-safe) |
| `press <key>` | press a key, for example `Control+Enter` or `Escape` |
| `click <text>` / `wait <text>` | click, or wait for, the first visible element containing `<text>` |
| `shot <name>` | full-page screenshot |
| `text` | print the page's visible text (first 3000 characters) |
| `sleep <ms>` | fixed wait. Only for watching the scripted run advance; otherwise use `wait`. |

The driver exits 1 if a step fails, in which case it saves `failure.png`. It also exits 1 if the
page logs a console error. Expected failures are filtered out (see Gotchas). Set
`ALLOW_CONSOLE_ERRORS=1` to report errors without failing.

**Look at the screenshots** (Read the PNG). An exit code of 0 only means no step threw.

Stop the harness:

```bash
kill $(lsof -ti:5174 -sTCP:LISTEN)
```

## Run (human path)

`npm run dev` serves the real app on Vite's default port, against the **production** Supabase
backend. It needs a real login, so it is useless headless. Use the harness.

## Test

```bash
npx vitest run          # frontend unit suite
PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:e2e
```

- **`vitest`:** 2965 passed / 1 skipped across 247 files on `main` `6596812` (2026-10-30).
- **`test:e2e`:** about 3 minutes, measured at 95 passed / 13 skipped on `main` `6596812`
  (2026-10-30). It starts its **own** harness on port 5175 and never reuses a running one unless
  `PW_REUSE_HARNESS=1` is set. PR CI does **not** run it, so run it by hand for any change under
  `src/`.
- **Other checks:** before pushing, also run `npm run lint`, `npm run typecheck` and
  `npm run build`, as CI does. `npm run lint` also lints `supabase/functions/` and this driver
  (it passes).

## Gotchas

- **The repo's Playwright wants a Chromium revision the container doesn't have.** Plain
  `chromium.launch()` fails with `Executable doesn't exist at
  /opt/pw-browsers/chromium_headless_shell-1234/...`, and running `npx playwright install` is
  forbidden here. Point at `/opt/pw-browsers/chromium` (a symlink to the pinned
  `chromium-1243`). The driver does this itself. For `test:e2e`, set `PLAYWRIGHT_CHROMIUM_PATH`.
  The `chromium-1194` path in CLAUDE.md is stale.
- **Tab content is lazy-loaded.** Right after `tab X`, the main pane shows an "Insight Finder ·
  LOADING WORKSPACE" card, and a screenshot taken then shows only that card. Always run `settle`
  after `tab`.
- **Enter does not send.** In the case composer, Enter inserts a new line and `Control+Enter`
  sends (the hint over the field says so). With `press Enter` nothing happens: the text just sits
  in the box.
- **The live-run state is scripted.** Sending any message streams a fixed run from
  `src/dev/fetch-retry-mock.ts`. It shows the text "Working the seed. Opening with search and a
  breach sweep.", flips the status to **Analyzing**, shows a stage card that counts tools, and
  shows a red **Stop investigation** button. It shows UI states, not agent behaviour.
- **Two network failures are expected and filtered out:**
  - Google Fonts from `index.html`: headless Chromium doesn't use the container's HTTPS proxy, so
    the request fails with `ERR_TUNNEL_CONNECTION_FAILED`.
  - The `?health=1&maintenance=1` probe that `ChatWindow.tsx` fires at `https://harness.local`,
    a fake host that never resolves.

  Any other failed request is printed as `failed requests: …` and counts as a failure.
- **The harness port is strict.** `vite.harness.config.ts` sets `strictPort`, so a second
  harness on :5174 errors instead of moving to another port. Kill the old one first. Port 5175
  belongs to the e2e suite.
- **The fixture data is fixed.** It holds one finished case, "James Harker — logistics", with
  thread `11111111-2222-4333-8444-555555555555` and 55 artifacts across the
  verified / review / conflict / quarantined states. To show a new state, extend
  `src/dev/supabase-mock.ts`. Don't point the harness at production.

## Troubleshooting

- **`browserType.launch: Executable doesn't exist at /opt/pw-browsers/chromium_headless_shell-1234/…`**:
  the Chromium revision doesn't match. Set
  `PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium`. Never run `playwright install`.
- **The screenshot shows only "LOADING WORKSPACE"**: a `settle` is missing after `tab`.
- **`console errors (1): Failed to load resource: net::ERR_TUNNEL_CONNECTION_FAILED`** with a
  `failed requests:` line: a request other than fonts or `harness.local` failed. Read the URL; it
  is real.
