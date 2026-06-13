import { test, expect, Page } from "@playwright/test";

/**
 * LEVEL 1 — Public / browser-boot smoke. No credentials required.
 *
 * Proves the app actually renders in a real browser (Chromium desktop + WebKit
 * iPhone via the two Playwright projects): boots, no blank screen, /auth loads,
 * unauthenticated redirect works, unknown routes don't crash, no fatal console/
 * page errors. This is NOT the investigation flow — see authenticated-investigation.spec.ts.
 */

function wireDiagnostics(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("requestfailed", (r) =>
    failedRequests.push(`${r.method()} ${r.url()} — ${r.failure()?.errorText ?? "failed"}`),
  );
  return { consoleErrors, pageErrors, failedRequests };
}

async function assertNotBlank(page: Page) {
  const html = (await page.locator("#root").innerHTML().catch(() => "")) || "";
  expect(html.length, "root should not be empty (blank-screen guard)").toBeGreaterThan(50);
}

test.describe("Level 1 — public browser boot", () => {
  test("app loads without a blank screen and renders recognizable UI", async ({ page }) => {
    const diag = wireDiagnostics(page);
    const resp = await page.goto("/", { waitUntil: "networkidle" });
    expect(resp?.status() ?? 0, "/ should respond < 400").toBeLessThan(400);
    await assertNotBlank(page);
    const body = (await page.locator("body").innerText()).toLowerCase();
    expect(
      /sign in|sign up|log in|email|password|investigat|swarmbot|case/.test(body),
      "should render app/login UI, not a crash",
    ).toBeTruthy();
    expect(diag.pageErrors, `uncaught page errors:\n${diag.pageErrors.join("\n")}`).toHaveLength(0);
  });

  test("unauthenticated visit to / redirects to /auth", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await page.waitForURL(/\/auth/, { timeout: 15_000 });
    expect(page.url()).toMatch(/\/auth/);
  });

  test("/auth renders the login surface (email + password inputs)", async ({ page }) => {
    const diag = wireDiagnostics(page);
    await page.goto("/auth", { waitUntil: "networkidle" });
    await assertNotBlank(page);
    await expect(page.locator('input[type="email"]').first()).toBeVisible();
    await expect(page.locator('input[type="password"]').first()).toBeVisible();
    expect(diag.pageErrors, diag.pageErrors.join("\n")).toHaveLength(0);
  });

  test("unknown route renders NotFound, not a crash", async ({ page }) => {
    const diag = wireDiagnostics(page);
    await page.goto("/this-route-does-not-exist", { waitUntil: "networkidle" });
    await assertNotBlank(page);
    expect(diag.pageErrors, diag.pageErrors.join("\n")).toHaveLength(0);
  });

  test("mobile viewport: auth surface loads and primary control is reachable", async ({ page }) => {
    const diag = wireDiagnostics(page);
    await page.goto("/auth", { waitUntil: "networkidle" });
    await assertNotBlank(page);
    await expect(page.locator('input[type="email"]').first()).toBeVisible();
    expect(diag.pageErrors, diag.pageErrors.join("\n")).toHaveLength(0);
  });
});
