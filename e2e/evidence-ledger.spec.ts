import { test, expect, type Page } from "@playwright/test";

/**
 * Evidence ledger geometry. The column head and the rows are two separate grids that must share one set of column
 * offsets, otherwise AUTHORITY / SOURCE labels float over the wrong cells. Measured on main (1440px): rows inherited a
 * 0.5rem gap from `[data-density-row]` while the head used 0.75rem, so the labels drifted 8px / 4px.
 */
const THREAD = "/chat/11111111-2222-4333-8444-555555555555";

async function openEvidence(page: Page) {
  await page.route("**/*", (route) => {
    const url = route.request().url();
    return url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost") ? route.continue() : route.abort();
  });
  await page.goto(THREAD);
  await page.getByRole("tab", { name: /^Evidence/ }).first().click();
  await page.locator(".ledger-row").first().waitFor({ state: "visible" });
}

test.describe("evidence ledger", () => {
  test("head and row columns share the same offsets (within 1px)", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "894x617", "four-column layout needs >= 900px");
    await openEvidence(page);
    const g = await page.evaluate(() => {
      // A cell with no box (an empty Source cell takes no slot) has no offset to compare.
      const lefts = (el: Element) =>
        Object.fromEntries(
          Array.from(el.querySelectorAll("[data-ledger-col]"))
            .filter((c) => c.getBoundingClientRect().width > 0)
            .map((c) => [(c as HTMLElement).dataset.ledgerCol, c.getBoundingClientRect().left]),
        );
      const head = document.querySelector(".ledger-head")!;
      const row = document.querySelector(".ledger-row")!;
      return { head: lefts(head), row: lefts(row) };
    });
    for (const col of Object.keys(g.head)) {
      if (!(col in g.row)) continue;
      expect(Math.abs(g.head[col] - g.row[col]), `${col} header vs cell`).toBeLessThanOrEqual(1);
    }
  });

  test("a row with no source gives its width to the authority line, which is not cut off", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "894x617", "four-column layout needs >= 900px");
    await openEvidence(page);
    const r = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll(".ledger-row")) as HTMLElement[];
      const empty = rows.filter((row) => {
        const src = row.querySelector('[data-ledger-col="source"]');
        return !!src && (src.textContent ?? "").trim() === "";
      });
      return empty.map((row) => {
        const status = row.querySelector('[data-ledger-col="status"]') as HTMLElement;
        const meta = status.querySelector(".ledger-meta") as HTMLElement | null;
        return {
          statusWidth: status.getBoundingClientRect().width,
          clipped: meta ? meta.scrollWidth > meta.clientWidth + 1 : false,
          sourceHidden: getComputedStyle(row.querySelector('[data-ledger-col="source"]')!).display === "none",
        };
      });
    });
    expect(r.length, "the fixture has rows without a printed source").toBeGreaterThan(0);
    for (const x of r) {
      expect(x.sourceHidden, "an empty Source cell takes no grid slot").toBe(true);
      expect(x.statusWidth, "authority spans the freed column").toBeGreaterThan(250);
      expect(x.clipped, "authority basis clipped with an ellipsis").toBe(false);
    }
  });
});
