import { test, expect, type Page, type Locator } from "@playwright/test";

/**
 * Workspace tab strip — reachability contract.
 *
 * The defect this pins (reported at an authenticated 894x617 viewport):
 *   - "Overview" rendered underneath the z-10 left rail and swallowed pointer
 *     clicks, while keyboard Enter still activated it;
 *   - "Report" was clipped off the right edge with no way to scroll to it.
 *
 * Root cause was `justify-content: center` on a horizontally scrollable flex
 * container. Centred overflow is split across BOTH sides, and the left half
 * lands at a negative offset `scrollLeft` can never reach — so the first tab is
 * permanently off-origin. Focus does not care about paint order, which is
 * exactly why the keyboard worked and the mouse did not; that asymmetry is the
 * signature of this bug and is asserted directly below.
 *
 * These tests DRIVE the shipped control flow rather than re-describing it: each
 * one performs a real pointer click at the tab's own centre point, or a real
 * key press, and then asserts the panel actually changed. A test that only
 * queried bounding boxes would have passed against the broken build.
 */

const THREAD = "/chat/11111111-2222-4333-8444-555555555555";
const TAB_LABELS = ["Investigate", "Overview", "Evidence", "Graph", "Activity", "Report"] as const;

/**
 * The harness is self-contained — the Supabase client is stubbed and no fixture
 * needs the network. The one thing that still reaches out is the Google Fonts
 * <link> in index.html, and it is expensive: measured here, a navigation that
 * waits on it takes 12,558ms, versus 99ms with external origins blocked. On a
 * runner without egress it is a multi-minute tax on a 30-test suite; with egress
 * it is a third party in the critical path of a layout test.
 *
 * Blocking every non-localhost origin makes the suite hermetic and ~35x faster.
 * The trade is that type renders in fallback metrics rather than Sora/IBM Plex,
 * which changes tab widths — so `assertStripOverflows` below refuses to let that
 * silently turn the 894x617 case into a vacuous pass.
 */
async function blockExternalOrigins(page: Page) {
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) {
      return route.continue();
    }
    return route.abort();
  });
}

/**
 * Since Stage A the shell collapses the cases rail to a 56px icon strip below
 * 1280px, so at 894x617 the six tabs now FIT (684px of tabs in an 838px page
 * area) — the reported clipping is gone structurally, which the test
 * "fits at 894px once the rail collapses" pins. The strip still scrolls as a
 * safety net (long count badges, larger type), and that path is what this
 * suite exists to keep honest. So on the 894 project the page area is narrowed
 * to 560px, beside the real rail, to keep every reachability test below
 * exercising overflow; `the 894px case still exercises overflow` still refuses
 * a vacuous pass.
 */
const OVERFLOW_PAGE_WIDTH = 560;

async function openWorkspace(page: Page, { constrain = true }: { constrain?: boolean } = {}) {
  await blockExternalOrigins(page);
  if (constrain && test.info().project.name === "894x617") {
    await page.addInitScript((w) => {
      const apply = () => {
        const style = document.createElement("style");
        style.textContent = `#shell-main{max-width:${w}px}`;
        document.head.appendChild(style);
      };
      if (document.head) apply();
      else document.addEventListener("DOMContentLoaded", apply);
    }, OVERFLOW_PAGE_WIDTH);
  }
  await page.goto(THREAD);
  // The strip is the gate for every assertion here; wait on it rather than on a
  // blanket networkidle, which the harness's mocked client never settles into
  // the same way twice.
  await page.getByRole("tab", { name: /Overview/i }).first().waitFor({ state: "visible" });
}

function tab(page: Page, label: string): Locator {
  return page.getByRole("tab", { name: new RegExp(label, "i") }).first();
}

/** The element actually painted on top at a point — what a real click would hit. */
async function topmostAt(page: Page, x: number, y: number) {
  return page.evaluate(([px, py]) => {
    const el = document.elementFromPoint(px, py);
    if (!el) return { hitsTab: false, describe: "no element at point" };
    const owner = el.closest('[role="tab"]');
    return {
      hitsTab: !!owner,
      describe: owner
        ? (owner.textContent || "").trim()
        : `${el.tagName}.${String((el as HTMLElement).className || "").slice(0, 60)}`,
    };
  }, [Math.round(x), Math.round(y)] as const);
}

test.describe("workspace tab strip", () => {
  test("renders all six tabs", async ({ page }) => {
    await openWorkspace(page);
    for (const label of TAB_LABELS) {
      await expect(tab(page, label), `${label} should exist`).toBeVisible();
    }
  });

  /**
   * Requirement 1 — fully visible OR horizontally scrollable.
   *
   * "Scrollable" is not a vibe: every tab must sit inside the scroller's own
   * scrollable range [0, scrollWidth - clientWidth]. The old build failed this
   * because the first tab sat at a NEGATIVE offset, outside that range in the
   * one direction no scroll can recover.
   */
  /**
   * Guard against a vacuous pass, in the same spirit as this repo's
   * SECURITY DEFINER assertion in CI: at 894x617 the strip MUST actually
   * overflow, or the reachability assertions below are proving nothing. If a
   * font change, a shorter label or a narrower tab ever makes six tabs fit at
   * this width, this fails loudly rather than going quietly green.
   */
  test("the 894px case still exercises overflow", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "894x617", "overflow is only expected at the narrow viewport");
    await openWorkspace(page);
    const maxScrollLeft = await page.evaluate(() => {
      const list = document.querySelector('[role="tablist"][aria-label="Investigation workspace"]')!;
      const scroller = list.parentElement as HTMLElement;
      return scroller.scrollWidth - scroller.clientWidth;
    });
    expect(
      maxScrollLeft,
      "the six tabs now fit at 894px, so the reachability tests no longer exercise the overflow path this suite exists for",
    ).toBeGreaterThan(0);
  });

  test("fits at 894px once the rail collapses", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "894x617", "the reported viewport");
    await openWorkspace(page, { constrain: false });
    const g = await page.evaluate(() => {
      const list = document.querySelector('[role="tablist"][aria-label="Investigation workspace"]')!;
      const scroller = list.parentElement as HTMLElement;
      const rail = document.querySelector('aside[aria-label="Cases"]')!.getBoundingClientRect().width;
      return { overflow: scroller.scrollWidth - scroller.clientWidth, rail };
    });
    expect(g.rail, "tablet widths start with the icon rail").toBe(56);
    expect(g.overflow, "all six tabs are visible without scrolling").toBeLessThanOrEqual(0);
  });

  test("every tab lies within the scroller's reachable range", async ({ page }) => {
    await openWorkspace(page);

    const geometry = await page.evaluate(() => {
      // The workspace strip only: the right-hand Workbench has its own tablist (hidden below xl).
      const list = document.querySelector('[role="tablist"][aria-label="Investigation workspace"]')!;
      const scroller = list.parentElement as HTMLElement;
      const scrollerBox = scroller.getBoundingClientRect();
      return {
        scrollWidth: scroller.scrollWidth,
        maxScrollLeft: scroller.scrollWidth - scroller.clientWidth,
        tabs: Array.from(list.querySelectorAll('[role="tab"]')).map((el) => {
          const b = el.getBoundingClientRect();
          return {
            label: (el.textContent || "").trim(),
            // Offset of the tab from the scroller's content origin.
            offsetLeft: b.left - scrollerBox.left + scroller.scrollLeft,
            width: b.width,
          };
        }),
      };
    });

    for (const t of geometry.tabs) {
      // The defect itself: a negative offset is outside the scrollable range in
      // the one direction `scrollLeft` cannot go, so no amount of scrolling
      // brings the tab back. This is the assertion that fails on the old build.
      expect(
        t.offsetLeft,
        `"${t.label}" starts ${t.offsetLeft.toFixed(0)}px from the content origin — a negative offset can never be scrolled to`,
      ).toBeGreaterThanOrEqual(-0.5);

      // And nothing may escape the far end of the scrollable content either.
      // Note the bound is scrollWidth, NOT maxScrollLeft: the last tab legitimately
      // begins well past the maximum scroll position — what matters is that it
      // ends inside the content box, so scrolling to the end reveals it.
      expect(
        t.offsetLeft + t.width,
        `"${t.label}" ends past the scrollable content and can never be revealed`,
      ).toBeLessThanOrEqual(geometry.scrollWidth + 1);
    }
  });

  /**
   * Requirement 2a — pointer.
   *
   * `scrollIntoViewIfNeeded` first, because a scrollable strip is allowed to
   * require scrolling; what is NOT allowed is for the tab to be occluded once
   * it is in view. The hit test asserts that directly, so an element painted
   * over the tab fails here even though Playwright's own click would have
   * force-scrolled and succeeded.
   */
  for (const label of TAB_LABELS) {
    test(`"${label}" activates by pointer and is not occluded`, async ({ page }) => {
      await openWorkspace(page);
      const t = tab(page, label);

      await t.scrollIntoViewIfNeeded();
      const box = await t.boundingBox();
      expect(box, `${label} should have a layout box`).not.toBeNull();

      const cx = box!.x + box!.width / 2;
      const cy = box!.y + box!.height / 2;
      const hit = await topmostAt(page, cx, cy);
      expect(
        hit.hitsTab,
        `a real click at "${label}"'s centre would land on ${hit.describe} instead of the tab`,
      ).toBe(true);

      // A genuine pointer click at that point — not a synthetic .click() on the
      // locator, which would bypass exactly the occlusion this test exists for.
      await page.mouse.click(cx, cy);
      await expect(t).toHaveAttribute("aria-selected", "true");
    });
  }

  /**
   * Requirement 2b — keyboard.
   *
   * The strip is a roving-tabindex tablist, so only the active tab is in the
   * tab order; the rest are reached with Arrow keys. Enter/Space must activate.
   */
  test("every tab activates by keyboard", async ({ page }) => {
    await openWorkspace(page);

    await tab(page, TAB_LABELS[0]).focus();
    await expect(tab(page, TAB_LABELS[0])).toBeFocused();

    for (let i = 1; i < TAB_LABELS.length; i += 1) {
      await page.keyboard.press("ArrowRight");
      const expected = TAB_LABELS[i];
      await expect(tab(page, expected), `ArrowRight should move focus to ${expected}`).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(
        tab(page, expected),
        `Enter should activate ${expected}`,
      ).toHaveAttribute("aria-selected", "true");
    }
  });

  /**
   * Requirement 3 — the #523 material styling survives the layout fix.
   *
   * The active tab must still be a lit key, not a flat rectangle. Asserting the
   * computed background is non-transparent and that the strip still carries its
   * accent rail is enough to catch a regression that strips the styling while
   * "fixing" the layout.
   */
  test("active tab keeps its material styling", async ({ page }) => {
    await openWorkspace(page);
    const active = page.locator('[role="tab"][aria-selected="true"]').first();
    const style = await active.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { boxShadow: cs.boxShadow };
    });
    // Case desk (JD's prototype, 2026-11-02): the active tab is marked by its
    // 2px lavender underline and brighter ink, with no filled ground, so the
    // underline is what this guards.
    expect(style.boxShadow).not.toBe("none");
    expect(style.boxShadow).toMatch(/inset/);
  });

  /**
   * The right-hand workbench strip at the NARROW sheet (320px, lg up to xl).
   * With both count chips showing, its three tabs used to overflow underneath
   * the sheet's fold button: "Connections" was painted under the icon and its
   * right half took the fold button's click instead of the tab's.
   */
  test("workbench tabs never sit under the sheet's fold button at the 320px sheet", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "1440x900", "one run at an explicit viewport is enough");
    await page.setViewportSize({ width: 1100, height: 800 });
    await openWorkspace(page);
    const strip = page.locator('[role="tablist"][aria-label="Workbench"]');
    await strip.waitFor({ state: "visible" });
    const fold = await page.getByRole("button", { name: "Hide case sheet" }).boundingBox();
    expect(fold).not.toBeNull();
    for (const t of await strip.getByRole("tab").all()) {
      const box = (await t.boundingBox())!;
      expect(box.x + box.width, `"${await t.innerText()}" ends before the fold button`).toBeLessThanOrEqual(fold!.x);
    }
    // A real pointer click on the far edge of the last tab selects the tab.
    const last = strip.getByRole("tab", { name: /^Connections/ });
    const box = (await last.boundingBox())!;
    await page.mouse.click(box.x + box.width - 3, box.y + box.height / 2);
    await expect(last).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#case-sheet")).toBeVisible();
  });
});
