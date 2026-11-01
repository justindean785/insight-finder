import { test, expect, type Page } from "@playwright/test";

/**
 * Intelligence → Sources → "What works, what doesn't".
 *
 * Drives the harness `?scenario=tool-observations` (src/dev/supabase-mock.ts: 8 tools, rows relative to
 * now). Every expected figure below was derived by hand from the fixture design comments, NOT read back
 * from the code:
 *   tools 8; real attempts 69; failed 34
 *   kinds: plan/credential 9 (jina 4 + oathnet 1 + fofa 4), timeouts and server errors 19
 *          (jina 2 + gemini 3 + serus 8 + http_fingerprint 6), input rejected 6 (memory_save)
 *   flagged (>=5 recent attempts, >=60% failed, >=2 cases): jina_reader_scrape (6 of 8, 75%),
 *          memory_save (6 of 6, 100%), gemini_deep_dork (3 of 5, exactly 60%)
 *   NOT flagged: serus_darkweb_scan (recovered), http_fingerprint (one case), fofa_search (4 attempts)
 *   order: flagged first by attempts (jina 12, memory_save 6, gemini 5), then serus 13, exa 12, oathnet 11,
 *          http_fingerprint 6, fofa 4
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
  await expect(page.getByTestId("tool-observations")).toBeVisible();
}

const noHorizontalOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

for (const viewport of [{ width: 1280, height: 720 }, { width: 375, height: 812 }]) {
  test.describe(`tool observations @ ${viewport.width}px`, () => {
    test.use({ viewport, hasTouch: viewport.width < 768 });

    test("totals, failure kinds and the flagged tools match the fixture arithmetic", async ({ page }) => {
      await open(page, "/brain?tab=sources&scenario=tool-observations");

      await expect(page.getByTestId("obs-total-tools")).toContainText("8");
      await expect(page.getByTestId("obs-total-attempts")).toContainText("69");
      await expect(page.getByTestId("obs-total-failed")).toContainText("34");
      await expect(page.getByTestId("obs-class-credential_plan")).toContainText("9");
      await expect(page.getByTestId("obs-class-transport")).toContainText("19");
      await expect(page.getByTestId("obs-class-input_rejected")).toContainText("6");
      // Kinds with no failures are not listed at all.
      await expect(page.getByTestId("obs-class-rate_limited")).toHaveCount(0);
      await expect(page.getByTestId("obs-class-other")).toHaveCount(0);

      await expect(page.getByTestId("obs-flagged-count")).toHaveText("3");
      const jina = page.locator('[data-testid="obs-flagged"][data-tool="jina_reader_scrape"]');
      await expect(jina).toContainText("6 of 8 real attempts failed in the last 14 days (75%) · mostly plan or credential refusals");
      await expect(page.locator('[data-testid="obs-flagged"][data-tool="memory_save"]'))
        .toContainText("6 of 6 real attempts failed in the last 14 days (100%) · mostly input the tool rejected");
      // Exactly 60% is flagged (the boundary is inclusive).
      await expect(page.locator('[data-testid="obs-flagged"][data-tool="gemini_deep_dork"]'))
        .toContainText("3 of 5 real attempts failed in the last 14 days (60%) · mostly timeouts and server errors");

      // A recovered tool, a one-case tool and a below-the-floor tool are not flagged.
      for (const tool of ["serus_darkweb_scan", "http_fingerprint", "fofa_search", "oathnet_lookup", "exa_search"]) {
        await expect(page.locator(`[data-testid="obs-flagged"][data-tool="${tool}"]`)).toHaveCount(0);
      }

      expect(await noHorizontalOverflow(page), "no horizontal page scroll").toBe(true);
    });

    test("the list orders flagged tools first and states exclusions as text", async ({ page }) => {
      await open(page, "/brain?tab=sources&scenario=tool-observations");
      const tools = await page.getByTestId("obs-row").evaluateAll((els) => els.map((e) => e.getAttribute("data-tool")));
      expect(tools).toEqual([
        "jina_reader_scrape", "memory_save", "gemini_deep_dork",
        "serus_darkweb_scan", "exa_search", "oathnet_lookup", "http_fingerprint", "fofa_search",
      ]);

      const jinaRow = page.locator('[data-testid="obs-row"][data-tool="jina_reader_scrape"]');
      await expect(jinaRow).toContainText("50% of 12");
      await expect(jinaRow).toContainText("6 succeeded · 4 plan or credential refusals · 2 timeouts and server errors · 2 skipped (not counted)");

      // Empties and cache hits are visible but do not change the 11 real attempts or the 91%.
      const oath = page.locator('[data-testid="obs-row"][data-tool="oathnet_lookup"]');
      await expect(oath).toContainText("91% of 11");
      await expect(oath).toContainText("3 no-record (not counted)");

      // Honesty copy is on the page as text, not in a hover title.
      await expect(page.getByTestId("tool-observations")).toContainText("A flag is an observation only");
      await expect(page.getByTestId("obs-refusal-note")).toContainText("not proof a key is dead");
    });

    test("no tool calls: says so and lists nothing", async ({ page }) => {
      await open(page, "/brain?tab=sources");
      await expect(page.getByTestId("obs-empty")).toContainText("No tool calls in the last 30 days");
      await expect(page.getByTestId("obs-row")).toHaveCount(0);
      expect(await noHorizontalOverflow(page)).toBe(true);
    });
  });
}
