import { defineConfig, devices } from "@playwright/test";

// Smoke E2E for Insight Finder / Swarmbot.
// BASE_URL lets you point at a deployed Lovable app instead of localhost:
//   PLAYWRIGHT_BASE_URL="https://<your-lovable-url>" npx playwright test
// When unset, Playwright boots the local Vite dev server on :8080.
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:8080";
const useLocalServer = !process.env.PLAYWRIGHT_BASE_URL;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: BASE_URL,
    trace: "on",
    screenshot: "on",
    video: "retain-on-failure",
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-iphone", use: { ...devices["iPhone 13"] } },
  ],
  webServer: useLocalServer
    ? {
        command: "npm run dev",
        url: "http://localhost:8080",
        reuseExistingServer: true,
        timeout: 60_000,
      }
    : undefined,
});
