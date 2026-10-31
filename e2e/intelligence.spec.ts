import { test, expect, type Page } from "@playwright/test";

/**
 * Intelligence (/brain) — one honest population per number.
 *
 * Drives the harness (src/dev/supabase-mock.ts: 12 memories by default,
 * `?scenario=memories-overcap` for 520, `?scenario=memories-empty` for none)
 * at desktop and phone widths. What it pins: the header names the recent
 * sample and its stored denominator as TEXT (no hover), the Overview tile
 * says "Stored, all time", and the confidence readings carry different nouns
 * (memory vs. artifact). Each case sets its own viewport, so the suite runs
 * once, on the mid project (see playwright.config.ts).
 */

async function blockExternalOrigins(page: Page) {
  await page.route("**/*", (route) => {
    const url = route.request().url();
    return url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost") ? route.continue() : route.abort();
  });
}

async function open(page: Page, path: string) {
  await blockExternalOrigins(page);
  await page.goto(path);
  await page.locator("#shell-main").waitFor();
  await expect(page.getByTestId("memory-sample-caption")).not.toHaveText("… of —");
}

const noHorizontalOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

for (const viewport of [{ width: 1280, height: 720 }, { width: 375, height: 812 }]) {
  test.describe(`intelligence @ ${viewport.width}px`, () => {
    test.use({ viewport, hasTouch: viewport.width < 768 });

    test("12 stored memories: caption says all stored; Overview owns the stored total and the artifact noun", async ({ page }) => {
      await open(page, "/brain?tab=overview");
      const caption = page.getByTestId("memory-sample-caption");
      await expect(caption).toHaveText("12 memories (all stored)");
      await expect(caption).toBeVisible();
      await expect(page.getByText("Recent memory sample")).toBeVisible();
      await expect(page.getByText("Hits (recalls + re-saves)")).toBeVisible();
      await expect(page.getByText("Memory confidence (sample)")).toBeVisible();
      await expect(page.getByText("Stored, all time")).toBeVisible();
      await expect(page.getByText("Artifact confidence", { exact: true })).toBeVisible();
      await expect(page.getByText("Most-recorded sources")).toBeVisible();
      await expect(page.getByText(/volume, not reliability/)).toBeVisible();
      // Memory confidence (66, over the 12 fixtures) and artifact confidence (49, from the RPC) differ on purpose.
      await expect(page.getByTestId("memory-sample-group")).toContainText("66%");
      await expect(page.locator("#shell-main")).toContainText("49%");
      // The retired shared labels are gone.
      await expect(page.locator("#shell-main")).not.toContainText(/RECALLS|AVG CONFIDENCE|Avg confidence|Top sources/);
      // Scope is text, not hover: nothing in the header carries a title.
      expect(await page.locator("header [title]").count()).toBe(0);
      expect(await noHorizontalOverflow(page), "no horizontal page scroll").toBe(true);
    });

    test("520 stored memories: the header names the 500-row sample against the stored total", async ({ page }) => {
      await open(page, "/brain?tab=overview&scenario=memories-overcap");
      await expect(page.getByTestId("memory-sample-caption")).toHaveText("500 most recent of 520");
      await expect(page.getByTestId("memory-sample-caption")).toBeVisible();
      await expect(page.getByText("520", { exact: true })).toBeVisible();
      expect(await noHorizontalOverflow(page)).toBe(true);
    });

    test("no memories: the empty caption and the Memories tab empty state agree", async ({ page }) => {
      await open(page, "/brain?tab=memories&scenario=memories-empty");
      await expect(page.getByTestId("memory-sample-caption")).toHaveText("0 memories (all stored)");
      await expect(page.getByText("No memories yet.")).toBeVisible();
      await expect(page.getByTestId("memories-tab-caption")).toHaveText("Showing 0 in sample");
    });
  });
}

/**
 * The disclosure that explains the shown-rows population, the hidden exclusions
 * and the hit-count definition is open on desktop and tap-to-open below it. The
 * breakpoint has to match `useIsMobile()` (768px) and Tailwind's `md:` (768px) —
 * NOT `sm:` (640px). This case covers 720px, inside the former dead zone: the
 * summary is visible and the paragraph is reachable by clicking it.
 */
test.describe("intelligence @ 720px (useIsMobile ↔ md: must agree)", () => {
  test.use({ viewport: { width: 720, height: 900 }, hasTouch: true });

  test("the explanation disclosure's summary is visible and tappable", async ({ page }) => {
    await open(page, "/brain?tab=overview");
    const summary = page.getByText("What these numbers mean");
    await expect(summary).toBeVisible();
    const paragraph = page.getByText(/hit count rises when memory_recall surfaces it/);
    await expect(paragraph).toBeHidden();
    await summary.click();
    await expect(paragraph).toBeVisible();
  });
});
