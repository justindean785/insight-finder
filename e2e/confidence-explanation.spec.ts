import { test, expect, type Page } from "@playwright/test";

/**
 * The ⓘ "Why this score?" popover on the Evidence board, driven through the
 * harness (no credentials, no network, no paid call).
 *
 * Contracts, each of which a unit test in jsdom cannot see:
 *   1. it discloses what the row recorded (stored score, cap, source classes,
 *      authority) and says the score is uncalibrated,
 *   2. it stays inside the viewport — at 1440px AND on a 390px phone,
 *   3. ONE Escape closes it and hands focus back to the trigger, however long
 *      the pointer has rested on the row. Every Evidence row is wrapped in a
 *      peek HoverCard (open delay 250 ms). With the pointer on the row it opens
 *      AFTER the popover, becomes the topmost dismissable layer, and the first
 *      Escape used to dismiss the peek instead — the popover needed a second
 *      press. Only one overlay may be open at a time.
 */
const THREAD = "/chat/11111111-2222-4333-8444-555555555555";

const VIEWPORTS = [
  { name: "desktop 1440", width: 1440, height: 900 },
  { name: "phone 390", width: 390, height: 844 },
] as const;

async function openEvidence(page: Page, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await page.route("**/*", (route) => {
    const url = route.request().url();
    return url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost") ? route.continue() : route.abort();
  });
  await page.goto(THREAD);
  await expect(page.getByText("Syncing case…")).toHaveCount(0, { timeout: 10_000 });
  await page.getByRole("tab", { name: /^Evidence/ }).first().click();
  await page.locator(".ledger-row").first().waitFor({ state: "visible" });
}

const trigger = (page: Page) =>
  page.locator(".ledger-row").first().getByRole("button", { name: /^Why is this score/ });

/** Every Radix popper (popover AND hover card) renders inside one of these wrappers. */
const overlayLayers = (page: Page) => page.locator("[data-radix-popper-content-wrapper]");

for (const vp of VIEWPORTS) {
  test.describe(`confidence explanation · ${vp.name}`, () => {
    test("opens and discloses the recorded score without arithmetic", async ({ page }) => {
      await openEvidence(page, vp);
      await trigger(page).scrollIntoViewIfNeeded();
      await trigger(page).click();

      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText("Why this score?")).toBeVisible();
      await expect(dialog.getByText(/Machine assessment · uncalibrated/)).toBeVisible();
      await expect(dialog.getByText("Stored machine score", { exact: true })).toBeVisible();
      await expect(dialog.getByText("Recorded cap", { exact: true })).toBeVisible();
      await expect(dialog.getByText("Independent source classes", { exact: true })).toBeVisible();
      await expect(dialog.getByText("Subject authority", { exact: true })).toBeVisible();
      await expect(dialog).not.toContainText(/Baseline reliability|Corroboration ×|Stale \(>30d\)|Fresh \(<24h\)/);
    });

    test("stays inside the viewport", async ({ page }) => {
      await openEvidence(page, vp);
      await trigger(page).scrollIntoViewIfNeeded();
      await trigger(page).click();

      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      const box = (await dialog.boundingBox())!;
      expect(box, "dialog has a box").not.toBeNull();
      expect(box.x, "left edge on screen").toBeGreaterThanOrEqual(0);
      expect(box.y, "top edge on screen").toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, "right edge on screen").toBeLessThanOrEqual(vp.width + 0.5);
      expect(box.y + box.height, "bottom edge on screen").toBeLessThanOrEqual(vp.height + 0.5);
    });

    test("Escape closes it and returns focus to the trigger", async ({ page }) => {
      await openEvidence(page, vp);
      await trigger(page).scrollIntoViewIfNeeded();
      await trigger(page).click();

      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();

      await page.keyboard.press("Escape");

      await expect(dialog).toBeHidden();
      await expect(trigger(page)).toBeFocused();
    });

    test("ONE Escape still closes it after the pointer has rested on the row past the peek card's open delay", async ({ page }) => {
      // The fake clock lets the 250 ms peek delay elapse deterministically — no
      // sleeping, and no dependence on how fast this machine is.
      await page.clock.install();
      await openEvidence(page, vp);
      await trigger(page).scrollIntoViewIfNeeded();
      await trigger(page).click();

      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();

      await page.clock.fastForward(1_000);

      // Only one overlay at a time: the popover must not share the screen with
      // the row's peek card.
      await expect(overlayLayers(page)).toHaveCount(1);

      await page.keyboard.press("Escape");

      await expect(dialog).toBeHidden();
      await expect(trigger(page)).toBeFocused();
    });
  });
}

test("reopens after a rapid resize and still closes on one Escape each time", async ({ page }) => {
  await openEvidence(page, VIEWPORTS[0]);
  const dialog = page.getByRole("dialog");

  for (const width of [1440, 390, 1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await trigger(page).scrollIntoViewIfNeeded();
    await trigger(page).click();

    await expect(dialog).toBeVisible();
    await expect(dialog).toBeFocused();

    await page.keyboard.press("Escape");

    await expect(dialog).toBeHidden();
    await expect(trigger(page)).toBeFocused();
  }
});
