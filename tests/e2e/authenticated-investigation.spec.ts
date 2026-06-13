import { test, expect, Page } from "@playwright/test";

/**
 * LEVEL 2 — Authenticated real investigation flow.
 *
 * SKIPPED unless E2E_EMAIL + E2E_PASSWORD are provided AND the app is pointed at
 * a live backend (either PLAYWRIGHT_BASE_URL=<deployed app>, or a local dev server
 * with real VITE_SUPABASE_URL + VITE_SUPABASE_PUBLISHABLE_KEY in .env.local).
 *
 * Credentials are read ONLY from the environment — never hardcoded, never committed.
 * Use a DEDICATED low-permission test account, not a personal login. A real run may
 * consume backend/API credits.
 *
 * Runs in both desktop (chromium) and mobile (webkit/iPhone) projects from the config.
 */

const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;
const HAS_CREDS = Boolean(EMAIL && PASSWORD);

test.describe("Level 2 — authenticated investigation flow", () => {
  test.skip(
    !HAS_CREDS,
    "Set E2E_EMAIL + E2E_PASSWORD (and point at a live backend) to run the real investigation flow.",
  );

  const pageErrors: string[] = [];
  test.beforeEach(async ({ page }) => {
    pageErrors.length = 0;
    page.on("pageerror", (e) => pageErrors.push(String(e)));

    // 1-2. log in with the dedicated test account
    await page.goto("/auth", { waitUntil: "networkidle" });
    await page.locator('input[type="email"]').first().fill(EMAIL!);
    await page.locator('input[type="password"]').first().fill(PASSWORD!);
    await page.getByRole("button", { name: /sign in|log in/i }).first().click();
    // 3. land in the main app (IndexRedirect creates/opens a thread)
    await page.waitForURL(/\/chat\//, { timeout: 25_000 });
  });

  test("create case → seed → run → progress → tool panels → report → sidebar", async ({ page }) => {
    expect(await page.locator("#root").innerHTML()).not.toHaveLength(0);

    // 4. enter a safe, benign test seed
    const seedInput = page.locator("textarea, input[type=text]").first();
    await expect(seedInput).toBeVisible();
    await seedInput.fill("example.com");

    // 5. submit / run
    await page.getByRole("button", { name: /run|send|start|investigat/i }).first().click();

    // 6. progress / streaming / status appears
    await expect(
      page.locator("text=/running|progress|streaming|working|analy|tool|step/i").first(),
    ).toBeVisible({ timeout: 45_000 });

    // 7. tool-call panels render (display naming) — best-effort, non-fatal if absent quickly
    await page
      .locator('[data-testid*="tool"], text=/tool|search|lookup|scan/i')
      .first()
      .waitFor({ timeout: 60_000 })
      .catch(() => {});

    // 8. report / output area appears
    await expect(
      page.locator('[data-testid*="report"], text=/report|summary|findings|output|invocation/i').first(),
    ).toBeVisible({ timeout: 120_000 });

    // 9. sidebar / case drawer opens and closes
    const drawerToggle = page
      .getByRole("button", { name: /menu|cases|sidebar|threads|drawer/i })
      .first();
    if (await drawerToggle.isVisible().catch(() => false)) {
      await drawerToggle.click();
      await page.waitForTimeout(300);
      await drawerToggle.click();
    }

    expect(pageErrors, `uncaught page errors during flow:\n${pageErrors.join("\n")}`).toHaveLength(0);
  });
});
