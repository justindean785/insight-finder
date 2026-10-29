import { defineConfig, devices } from "@playwright/test";

/**
 * E2E config for the workspace chrome.
 *
 * It drives the HARNESS build (`vite.harness.config.ts`), not the real app:
 * that config aliases `@/integrations/supabase/client` to `src/dev/supabase-mock.ts`,
 * so these specs render the authenticated workspace with no credentials and no
 * network. The mock reports a signed-in session by default, which is what makes
 * an "authenticated viewport" reproducible in CI.
 *
 * Chromium is preinstalled in the container at PLAYWRIGHT_BROWSERS_PATH; the
 * `executablePath` below is only used when that env var points at the pinned
 * build, and is otherwise left to Playwright's own resolution.
 */
const HARNESS_PORT = 5175;

export default defineConfig({
  testDir: "./e2e",
  // Serial on purpose: all three projects share ONE vite dev server, and running
  // them fully parallel saturated it badly enough that it dropped connections
  // mid-run (ERR_CONNECTION_REFUSED on later specs). This suite is ~30 short
  // tests; the stability is worth more than the wall-clock.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],

  use: {
    baseURL: `http://127.0.0.1:${HARNESS_PORT}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    /**
     * Opt-in override for environments that ship a Chromium whose revision does
     * not match this @playwright/test version — the Claude Code container is one
     * (it pins chromium-1194 under /opt/pw-browsers and forbids re-downloading).
     * Set PLAYWRIGHT_CHROMIUM_PATH to that binary; unset, Playwright resolves
     * its own browser as normal, so a laptop checkout needs no special setup.
     */
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } }
      : {}),
  },

  /**
   * The three viewports the tab-clipping defect was reported and fixed against.
   * 894x617 is the one that actually broke: it is wide enough for the desktop
   * strip to render all six tabs, but too narrow to fit them, which is the exact
   * band where the old `justify-content: center` pushed the first tab into
   * unreachable negative scroll space.
   */
  // The case-integrity state suite is viewport-independent (its mobile cases
  // set their own 390px viewport), so it runs once, on the mid project. So
  // does the app-shell suite: each case sets the viewport it is about.
  projects: [
    { name: "894x617", testIgnore: /(case-integrity|app-shell)\.spec\.ts/, use: { ...devices["Desktop Chrome"], viewport: { width: 894, height: 617 } } },
    { name: "1280x720", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 720 } } },
    { name: "1440x900", testIgnore: /(case-integrity|app-shell)\.spec\.ts/, use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
  ],

  webServer: {
    command: `npx vite --config vite.harness.config.ts --port ${HARNESS_PORT} --strictPort`,
    url: `http://127.0.0.1:${HARNESS_PORT}`,
    /**
     * Never adopt a server by default. Reuse used to be on for every local run,
     * and a harness left on this port by ANOTHER worktree was silently tested in
     * place of this checkout: on 2026-10-26 a day-old server from a stale tree
     * produced 4 case-integrity failures that read as a macOS-only flake. With
     * reuse off, a busy port fails the run up front instead. Set
     * PW_REUSE_HARNESS=1 to reuse a harness you started from THIS checkout.
     * CI never reuses, whatever the env carries.
     */
    reuseExistingServer: !process.env.CI && process.env.PW_REUSE_HARNESS === "1",
    timeout: 120_000,
  },
});
