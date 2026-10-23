import { test, expect, type Page } from "@playwright/test";

/**
 * AppShell — the one frame around every signed-in workspace screen (Stage A).
 *
 * These drive the shipped shell with real keys and clicks: the phone cases
 * drawer (focus in, trapped, returned; the case, tab and live transcript
 * survive it), the command palette's scope (screens everywhere, case-only
 * commands only in a live case, and navigation never starting a run), and the
 * tablet rail overlay's focus hand-off. Each case sets its own viewport, so the
 * suite runs once, on the mid project (see playwright.config.ts).
 */

const CASE = "/chat/11111111-2222-4333-8444-555555555555";

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
}

const activeLabel = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null);

/**
 * Open the phone cases drawer and wait until it is actually ready for keys.
 * "Visible" is not enough: the dialog paints before Radix attaches its Escape
 * handler (a passive effect), so an immediate Escape is intermittently lost.
 * Focus landing inside the dialog happens at the same mount, so it is the
 * observable "ready" signal.
 */
async function openCasesDrawer(page: Page) {
  await page.getByRole("button", { name: "Open cases" }).click();
  await expect(page.getByRole("dialog", { name: "Investigations" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
}

test.describe("app shell — phone cases drawer", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("focus moves in, stays trapped, and returns to Open cases on Esc", async ({ page }) => {
    await open(page, CASE);
    await page.getByRole("tab", { name: /^Evidence/ }).waitFor();
    await page.getByRole("button", { name: "Open cases" }).click();
    const drawer = page.getByRole("dialog", { name: "Investigations" });
    await expect(drawer).toBeVisible();
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
    for (let i = 0; i < 20; i++) await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')), "Tab stays inside the drawer").toBe(true);
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    expect(await activeLabel(page)).toBe("Open cases");
  });

  test("opening and closing the drawer keeps the case, the tab and the live transcript", async ({ page }) => {
    await open(page, CASE);
    await page.locator("#workspace-tabpanel-chat > *").first().waitFor();
    await page.evaluate(() => {
      (document.getElementById("workspace-tabpanel-chat")!.firstElementChild as HTMLElement & { __mark?: number }).__mark = 7;
    });
    await page.getByRole("tab", { name: /^Evidence/ }).click();
    await openCasesDrawer(page);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe(CASE);
    await expect(page.getByRole("tab", { name: /^Evidence/ })).toHaveAttribute("aria-selected", "true");
    expect(await page.evaluate(() =>
      (document.getElementById("workspace-tabpanel-chat")!.firstElementChild as HTMLElement & { __mark?: number }).__mark,
    ), "the transcript was not remounted").toBe(7);
  });

  test("opening and closing the drawer keeps the Report's reading position", async ({ page }) => {
    await open(page, CASE);
    await page.getByRole("tab", { name: /^Report/ }).click();
    const report = page.locator("#workspace-tabpanel-report");
    await expect.poll(() => report.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(800);
    await report.evaluate((el) => { el.scrollTop = 600; });
    await openCasesDrawer(page);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await report.evaluate((el) => el.scrollTop)).toBe(600);
  });

  test("the Report's last control is visible and clickable above the tab bar at the end of scrolling", async ({ page }) => {
    await open(page, CASE);
    await page.getByRole("tab", { name: /^Report/ }).click();
    const report = page.locator("#workspace-tabpanel-report");
    await expect.poll(() => report.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(800);
    await report.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    // The report ends with the "Raw markdown" disclosure (a <summary>, which has no button role).
    const last = report.locator("summary", { hasText: "Raw markdown" });
    await expect(last).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Workspace sections" });
    const [box, navBox] = [await last.boundingBox(), await nav.boundingBox()];
    expect(box!.y + box!.height, "the last control ends above the tab bar").toBeLessThanOrEqual(navBox!.y);
    // What a tap at its centre actually hits — nothing may sit on top of it.
    const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest("summary")?.textContent ?? "", [box!.x + box!.width / 2, box!.y + box!.height / 2]);
    expect(hit).toMatch(/Raw markdown/);
  });

  test("navigating from the drawer closes it", async ({ page }) => {
    await open(page, "/cases");
    await page.getByRole("button", { name: "Open cases" }).click();
    await page.getByRole("dialog").getByRole("link", { name: "Intelligence" }).click();
    await expect(page).toHaveURL(/\/brain/);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("the drawer has no collapse control that does nothing", async ({ page }) => {
    await open(page, "/cases");
    await page.getByRole("button", { name: "Open cases" }).click();
    await expect(page.getByRole("dialog").getByRole("button", { name: "Collapse sidebar" })).toHaveCount(0);
  });
});

test.describe("app shell — command palette", () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  const SCREENS: [string, string, boolean][] = [
    ["live case", CASE, true],
    ["cases", "/cases", false],
    ["case viewer", "/cases/11111111-2222-4333-8444-555555555555", false],
    ["intelligence", "/brain", false],
    ["settings", "/settings", false],
  ];

  for (const [name, path, inCase] of SCREENS) {
    test(`⌘K on ${name}: ${inCase ? "case commands and screens" : "screens only"}; Go to navigates without a run`, async ({ page }) => {
      await page.addInitScript(() => {
        const w = window as Window & { __reruns?: number };
        w.__reruns = 0;
        addEventListener("swarmbot:rerun", () => { w.__reruns = (w.__reruns ?? 0) + 1; });
      });
      const writes: string[] = [];
      page.on("request", (r) => { if (r.method() !== "GET") writes.push(`${r.method()} ${r.url()}`); });
      await open(page, path);
      await page.keyboard.press("Control+k");
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText("Go to", { exact: true })).toBeVisible();
      await expect(dialog.getByText("Quick actions", { exact: true })).toHaveCount(inCase ? 1 : 0);
      await expect(dialog.getByText(/^Jump to /)).toHaveCount(inCase ? 3 : 0);
      await dialog.getByRole("option", { name: /^Intelligence/ }).first().click();
      await expect(page).toHaveURL(/\/brain/);
      expect(await page.evaluate(() => (window as Window & { __reruns?: number }).__reruns)).toBe(0);
      expect(writes, "palette navigation must not create a case or start a run").toEqual([]);
    });
  }

  test("typing k in the composer types text and does not open the palette", async ({ page }) => {
    await open(page, CASE);
    const composer = page.locator("textarea").first();
    await composer.click();
    await composer.pressSequentially("kkk K");
    await expect(composer).toHaveValue(/kkk K$/);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});

test.describe("app shell — tablet rail", () => {
  test.use({ viewport: { width: 1024, height: 768 } });

  test("starts collapsed; expanding overlays the page and hands focus in and back", async ({ page }) => {
    await open(page, CASE);
    // Let the case finish loading first: the workspace focuses its composer on
    // load, which would otherwise take focus from the rail mid-test.
    await page.locator("#workspace-tabpanel-chat textarea").first().waitFor();
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe("TEXTAREA");
    const rail = page.locator('aside[aria-label="Cases"]');
    const railWidth = () => rail.evaluate((a) => Math.round(a.getBoundingClientRect().width));
    await expect.poll(railWidth).toBe(56);
    const before = await page.locator("#shell-main").evaluate((m) => m.getBoundingClientRect().width);
    await rail.getByRole("button", { name: "Expand sidebar" }).focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => activeLabel(page)).toBe("Collapse sidebar");
    await expect.poll(railWidth).toBe(288);
    expect(await page.locator("#shell-main").evaluate((m) => m.getBoundingClientRect().width), "overlay, not squeeze").toBe(before);
    await page.keyboard.press("Escape");
    await expect.poll(() => activeLabel(page)).toBe("Expand sidebar");
    await expect.poll(railWidth).toBe(56);
  });

  test("icon-only rail controls are named, marked current, and tooltipped on focus", async ({ page }) => {
    await open(page, "/cases");
    const rail = page.locator('aside[aria-label="Cases"]');
    await expect(rail.getByRole("link", { name: "All cases" })).toHaveAttribute("aria-current", "page");
    await rail.getByRole("link", { name: "Intelligence" }).focus();
    await expect(page.getByRole("tooltip")).toHaveText("Intelligence");
  });
});

test.describe("graph — seed node selection", () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  async function openGraph(page: Page) {
    await open(page, CASE);
    await page.getByRole("tab", { name: /^Graph/ }).click();
    const seed = page.getByRole("button", { name: /, seed$/ });
    await expect(seed).toBeVisible();
    return seed;
  }

  // `selected` is React Flow's own selected-state class on the node wrapper —
  // the hook EntityNode's ring hangs off — not a style string of ours.
  test("clicking the seed selects it and opens its detail; clicking the canvas clears both", async ({ page }) => {
    const seed = await openGraph(page);
    await expect(seed).not.toHaveClass(/\bselected\b/);
    await seed.click();
    await expect(seed).toHaveClass(/\bselected\b/);
    await expect(page.getByRole("button", { name: "Close detail" })).toBeVisible();
    await page.locator(".react-flow__pane").click({ position: { x: 20, y: 20 } });
    await expect(seed).not.toHaveClass(/\bselected\b/);
    await expect(page.getByRole("button", { name: "Close detail" })).toHaveCount(0);
  });

  test("the seed is a named button that the keyboard can select and release", async ({ page }) => {
    const seed = await openGraph(page);
    await seed.focus();
    await page.keyboard.press("Enter");
    await expect(seed).toHaveClass(/\bselected\b/);
    await expect(page.getByRole("button", { name: "Close detail" })).toBeVisible();
    await seed.focus();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Close detail" })).toHaveCount(0);
  });
});

test.describe("case sheet — collapse to a strip", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("hides to a strip that keeps the decision count, remembers it, and restores without remounting the transcript", async ({ page }) => {
    await open(page, CASE);
    const sheet = page.getByRole("complementary", { name: "Case sheet" });
    await expect(sheet.getByRole("button", { name: "Hide case sheet", exact: true })).toBeVisible();
    await page.locator("#workspace-tabpanel-chat > *").first().waitFor();
    await page.evaluate(() => {
      (document.getElementById("workspace-tabpanel-chat")!.firstElementChild as HTMLElement & { __mark?: number }).__mark = 9;
    });
    const chatWidth = () => page.locator("#workspace-tabpanel-chat").evaluate((el) => Math.round(el.getBoundingClientRect().width));
    const before = await chatWidth();

    await sheet.getByRole("button", { name: "Hide case sheet", exact: true }).click();
    await expect(sheet.getByRole("button", { name: "Show case sheet", exact: true })).toHaveAttribute("aria-expanded", "false");
    // The decision count stays on screen while the sheet is folded.
    await expect(sheet.getByRole("button", { name: /needs? your call/ })).toBeVisible();
    await expect.poll(chatWidth, "the transcript takes the freed width").toBeGreaterThan(before + 300);
    expect(await page.evaluate(() =>
      (document.getElementById("workspace-tabpanel-chat")!.firstElementChild as HTMLElement & { __mark?: number }).__mark,
    ), "the transcript was not remounted").toBe(9);

    await page.reload();
    await expect(page.getByRole("complementary", { name: "Case sheet" }).getByRole("button", { name: "Show case sheet", exact: true }), "remembered").toBeVisible();

    await page.getByRole("complementary", { name: "Case sheet" }).getByRole("button", { name: "Show case sheet", exact: true }).click();
    await expect(page.getByRole("complementary", { name: "Case sheet" }).getByRole("button", { name: "Hide case sheet", exact: true })).toBeVisible();
    await expect.poll(chatWidth).toBe(before);
  });
});
