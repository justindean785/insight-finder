import { test, expect, type Page } from "@playwright/test";

/**
 * Intelligence → Credits — real per-run economics.
 *
 * Drives the harness (src/dev/supabase-mock.ts: nine fixture runs, relative to now; eight are
 * inside the 30-day window) at desktop and phone widths. What it pins: the figures on screen
 * equal the arithmetic over the fixtures, a missing value is "not recorded" and never $0, the
 * owner account reads "Unlimited" instead of a fake balance, and an empty window says so.
 *
 * Expected figures, derived by hand from the fixtures (not read back from the code):
 *   30-day spend  142,300+232,900+198,400+487,000+0+301,500+410,000 = $1.7721 -> "$1.77"
 *   14-day spend  all of those except the 18-day-old $0.410 run     = $1.3621 -> "$1.36"
 *   one run in the window has no recorded cost; average = 1.7721 / 7 = $0.253
 *   endings recorded on 7 runs, 3 forced -> 43%
 *   salvage 53.7 s + 72.6 s over 711.6 s of timed run time -> 18%, 6 timed runs
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
  await expect(page.getByTestId("run-economics")).toBeVisible();
}

const noHorizontalOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

for (const viewport of [{ width: 1280, height: 720 }, { width: 375, height: 812 }]) {
  test.describe(`credits @ ${viewport.width}px`, () => {
    test.use({ viewport, hasTouch: viewport.width < 768 });

    test("beta account: balance, honest 30-day summary, and the run list", async ({ page }) => {
      await open(page, "/brain?tab=credits");

      const account = page.getByTestId("credit-account");
      await expect(account).toContainText("$0.312");
      await expect(account).toContainText("balance left");
      await expect(account).toContainText("$0.188 spent in total");
      await expect(account).toContainText("$0.041 today");

      await expect(page.getByTestId("run-econ-spend30")).toContainText("$1.77");
      await expect(page.getByTestId("run-econ-spend30")).toContainText("$1.36 in the last 14 days");
      await expect(page.getByTestId("run-econ-spend30")).toContainText("1 run had no recorded cost");
      await expect(page.getByTestId("run-econ-avg")).toContainText("$0.253");
      await expect(page.getByTestId("run-econ-avg")).toContainText("7 of 8 runs have a recorded cost");
      await expect(page.getByTestId("run-econ-forced")).toContainText("43%");
      await expect(page.getByTestId("run-econ-forced")).toContainText("the run did not fail");
      await expect(page.getByTestId("run-econ-salvage")).toContainText("18%");
      await expect(page.getByTestId("run-econ-salvage")).toContainText("6 timed runs");

      // Honesty copy is text, not a hover title: it must be on the page.
      await expect(page.getByTestId("run-economics")).toContainText("internal meter");
      await expect(page.getByTestId("run-economics")).toContainText("not a provider invoice");

      // The run 40 days back is outside the window: eight rows, and its $0.900 never appears.
      await expect(page.getByTestId("run-row")).toHaveCount(8);
      await expect(page.getByTestId("run-economics")).not.toContainText("$0.900");

      const first = page.getByTestId("run-row").nth(0);
      await expect(first).toContainText("$0.142");
      await expect(first).toContainText("141.5k in");
      await expect(first).toContainText("Ended on its own");

      // Forced finalization with a salvage call and one step that carried no usage.
      const forced = page.getByTestId("run-row").nth(1);
      await expect(forced).toContainText("Time limit — report forced");
      await expect(forced).toContainText("loop 1m 39s · report salvage 54s · other 2s");
      await expect(forced).toContainText("131.0k+ in");
      await expect(forced).toContainText("some steps had no usage");

      // A stream error is labelled as one; a never-classified, never-costed run says so and is not $0.
      await expect(page.getByTestId("run-row").nth(4)).toContainText("Stream error");
      const unknown = page.getByTestId("run-row").nth(5);
      await expect(unknown).toContainText("cost not recorded");
      await expect(unknown).toContainText("Not recorded");
      // A run from before timing shipped keeps its cost and says its time split is missing.
      const legacy = page.getByTestId("run-row").nth(6);
      await expect(legacy).toContainText("$0.301");
      await expect(legacy).toContainText("Time split not recorded");

      expect(await noHorizontalOverflow(page), "no horizontal page scroll").toBe(true);
    });

    test("owner account: Unlimited, with no balance to run down", async ({ page }) => {
      await open(page, "/brain?tab=credits&scenario=credits-unlimited");
      const account = page.getByTestId("credit-account");
      await expect(account).toContainText("Unlimited");
      await expect(account).toContainText("never debited");
      await expect(account).not.toContainText("balance left");
      await expect(page.getByTestId("run-econ-spend30")).toContainText("$1.77");
      expect(await noHorizontalOverflow(page)).toBe(true);
    });

    test("yesterday's ledger total is not shown as today's spend", async ({ page }) => {
      await open(page, "/brain?tab=credits&scenario=credits-stale-day");
      const account = page.getByTestId("credit-account");
      await expect(account).toContainText("$0.188 spent in total");
      await expect(account).toContainText("$0.000 today");
      await expect(account).not.toContainText("$0.041");
    });

    test("when the newest run has no recorded cost, 'last run' is unknown, not an older run's cost", async ({ page }) => {
      await open(page, "/brain?tab=credits&scenario=runs-newest-unrecorded");
      const spend = page.getByTestId("spend-card");
      await expect(spend).toContainText("— last run");
      await expect(spend).not.toContainText("$0.233 last run"); // the next-newest run's cost
      await expect(page.getByTestId("run-row").nth(0)).toContainText("cost not recorded");
    });

    test("no finished runs: the tab says so and shows no figures", async ({ page }) => {
      await open(page, "/brain?tab=credits&scenario=runs-empty");
      await expect(page.getByTestId("run-econ-empty")).toContainText("No finished runs in the last 30 days");
      await expect(page.getByTestId("run-econ-spend30")).toHaveCount(0);
      await expect(page.getByTestId("run-row")).toHaveCount(0);
      expect(await noHorizontalOverflow(page)).toBe(true);
    });
  });
}
