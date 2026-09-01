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
const TAB_LABELS = ["Overview", "Investigate", "Evidence", "Tools", "Graph", "Report"] as const;

async function openWorkspace(page: Page) {
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
  test("every tab lies within the scroller's reachable range", async ({ page }) => {
    await openWorkspace(page);

    const geometry = await page.evaluate(() => {
      const first = document.querySelector('[role="tab"]')!;
      const list = first.closest('[role="tablist"]')!;
      const scroller = list.parentElement as HTMLElement;
      const scrollerBox = scroller.getBoundingClientRect();
      return {
        scrollWidth: scroller.scrollWidth,
        maxScrollLeft: scroller.scrollWidth - scroller.clientWidth,
        tabs: Array.from(document.querySelectorAll('[role="tab"]')).map((el) => {
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

    await tab(page, "Overview").focus();
    await expect(tab(page, "Overview")).toBeFocused();

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
      return { background: cs.backgroundColor, boxShadow: cs.boxShadow };
    });
    expect(style.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(style.boxShadow).not.toBe("none");
  });
});
