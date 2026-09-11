import { test, expect, type Page } from "@playwright/test";

/**
 * Case integrity — the visible states the 2026-09-11 audits demanded, driven
 * end to end through the harness. No paid investigation is ever started: the
 * harness stubs the Supabase client, and no test presses "Start investigation"
 * or "Start this pivot".
 *
 * Scenarios come from `?scenario=` (see src/dev/supabase-mock.ts).
 */

const THREAD = "/chat/11111111-2222-4333-8444-555555555555";
const DRAFT = "/chat/22222222-3333-4444-8555-666666666666";

async function blockExternalOrigins(page: Page) {
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) return route.continue();
    return route.abort();
  });
}

async function open(page: Page, path: string, { waitHydrated = true } = {}) {
  await blockExternalOrigins(page);
  await page.goto(path);
  await page.getByRole("tab", { name: /Overview/ }).first().waitFor({ state: "visible" });
  if (waitHydrated) await expect(page.getByText("Syncing case…")).toHaveCount(0, { timeout: 10_000 });
}

// Each state runs once, on the mid desktop project (see `testIgnore` in
// playwright.config.ts); the tab-strip suite covers the three desktop widths.

test.describe("canonical case snapshot", () => {
  test("1 · initial syncing: skeletons, never a false 0", async ({ page }) => {
    await open(page, `${THREAD}?scenario=syncing`, { waitHydrated: false });
    await expect(page.getByText("Syncing case…").first()).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/\b0 tools?\b/);
  });

  test("header tool count = Tools tab badge = Tools panel count", async ({ page }) => {
    await open(page, THREAD);
    const header = page.getByRole("region", { name: "Case summary" });
    const headerTools = await header.getByText(/^tools?$/).locator("xpath=preceding-sibling::*[1]").textContent();
    const badge = (await page.getByRole("tab", { name: /Tools/ }).textContent())?.replace(/\D/g, "");
    await page.getByRole("tab", { name: /Tools/ }).click();
    // MetricCard: the label sits in a row, the figure in the next block.
    const panel = await page.getByText("Tool calls", { exact: true }).locator("xpath=../following-sibling::div[1]").textContent();
    expect(headerTools).toBe("18");
    expect(badge).toBe("18");
    expect(panel?.trim()).toBe("18");
  });

  test("2 · active run: a fresh heartbeat reads Running", async ({ page }) => {
    await open(page, `${THREAD}?scenario=running`);
    await expect(page.getByRole("region", { name: "Case summary" }).getByText("Running", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: /run/i })).toHaveCount(0);
  });

  test("5 · reconciliation from interrupted to complete lands in one version, and is announced", async ({ page }) => {
    await open(page, `${THREAD}?scenario=reconcile`);
    const header = page.getByRole("region", { name: "Case summary" });
    await expect(header.getByText("Interrupted", { exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Tools/ })).toContainText("16");

    // ~2.5s later the run finalizes and a realtime UPDATE lands.
    await expect(header.getByText("Complete", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("tab", { name: /Tools/ })).toContainText("18");
    await expect(header).toContainText("18");
    await expect(page.getByRole("status").filter({ hasText: "Case updated" })).toContainText("Status Interrupted → Complete");
    await expect(page.getByRole("status").filter({ hasText: "Case updated" })).toContainText("Tools 16 → 18");
  });

  test("refresh re-reads the case without starting anything", async ({ page }) => {
    const posts: string[] = [];
    page.on("request", (r) => { if (r.method() === "POST") posts.push(r.url()); });
    await open(page, THREAD);
    await page.getByRole("button", { name: "Refresh case data" }).click();
    await expect(page.getByRole("region", { name: "Case summary" })).toContainText(/Synced|Updated/);
    expect(posts).toEqual([]);
  });
});

test.describe("interrupted-run recovery", () => {
  test("4 · interrupted, not resumable: explains recovery and offers no retry", async ({ page }) => {
    await open(page, `${THREAD}?scenario=interrupted`);
    const banner = page.getByRole("region", { name: "Model connection failed" });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("STREAM_ERROR");
    await expect(banner).toContainText("Spend so far");
    const unavailable = banner.getByRole("button", { name: /Recovery unavailable/ });
    await expect(unavailable).toHaveAttribute("aria-disabled", "true");
    await expect(banner).toContainText("does not issue a resumable run ID");
    await expect(banner.getByRole("button", { name: /retry|resume/i })).toHaveCount(0);
  });

  test("view failed tools opens Tools › Health", async ({ page }) => {
    await open(page, `${THREAD}?scenario=stale`);
    await page.getByRole("button", { name: /View failed tools/ }).click();
    await expect(page.getByRole("tab", { name: /Tools/ })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("button", { name: "Health", pressed: true })).toBeVisible();
  });

  test("an analyst Stop reads Stopped, never Complete", async ({ page }) => {
    await open(page, `${THREAD}?scenario=stopped`);
    await expect(page.getByRole("region", { name: "Case summary" }).getByText("Stopped", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Case summary" }).getByText("Complete", { exact: true })).toHaveCount(0);
  });
});

test.describe("composer preflight", () => {
  test("6 · empty prompt: labelled, helped, and not submittable", async ({ page }) => {
    await open(page, DRAFT);
    const box = page.getByLabel("Investigation request");
    await expect(box).toBeVisible();
    const helpId = await box.getAttribute("aria-describedby");
    expect(helpId).toBeTruthy();
    await expect(page.locator(`[id="${helpId}"]`)).toContainText("Enter one primary target");
    await expect(page.getByRole("button", { name: "Start investigation" })).toBeDisabled();
  });

  test("7 · invalid target: a chosen type the request does not contain", async ({ page }) => {
    await open(page, DRAFT);
    await page.getByLabel("Investigation request").fill("Tristen Ufland, Sacramento");
    await page.getByLabel("Target type").selectOption("email");
    await expect(page.getByRole("button", { name: "Start investigation" })).toBeDisabled();
    await expect(page.getByText(/No email found in the request/)).toBeVisible();
  });

  test("7 · invalid objective blocks submit and is associated with its field", async ({ page }) => {
    await open(page, DRAFT);
    await page.getByLabel("Investigation request").fill("analyst@example.com");
    await page.getByRole("button", { name: /Scope & controls/ }).click();
    const objective = page.getByLabel("Objective");
    await objective.fill("tbd");
    await expect(objective).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByRole("button", { name: "Start investigation" })).toBeDisabled();
  });

  test("8 · valid preflight: parsed target and a pre-submit summary", async ({ page }) => {
    await open(page, DRAFT);
    await page.getByLabel("Investigation request").fill("analyst@example.com — who controls this mailbox?");
    await expect(page.getByLabel("Target type")).toHaveValue("email");
    await expect(page.getByText(/Target: analyst@example\.com \(email\) · Objective: .* · Scope: .* · Depth: .* · Budget: .*/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Start investigation" })).toBeEnabled();
  });

  test("Enter writes a new line; it never submits", async ({ page }) => {
    await open(page, DRAFT);
    const box = page.getByLabel("Investigation request");
    await box.fill("analyst@example.com");
    await box.press("Enter");
    await expect(box).toHaveValue("analyst@example.com\n");
  });
});

test.describe("next steps", () => {
  test("9 · a malformed generated pivot is quarantined and cannot run", async ({ page }) => {
    await open(page, `${THREAD}?scenario=malformed`);
    const steps = page.getByRole("region", { name: "Next steps" });
    await expect(steps.getByText("Suggestion needs repair").first()).toBeVisible();
    const repair = steps.locator('[data-suggestion-state="needs-repair"]').first();
    await expect(repair.getByRole("button")).toHaveCount(0);
  });

  test("Run opens a preview inside the app; nothing starts from the row", async ({ page }) => {
    const posts: string[] = [];
    page.on("request", (r) => { if (r.method() === "POST") posts.push(r.url()); });
    await open(page, THREAD);
    const steps = page.getByRole("region", { name: "Next steps" });
    // The transcript finishes its load-time scroll-to-bottom a few hundred ms
    // after hydration; a click in that window can land beside the moving button
    // (seen in a trace). Retry only while the row is still closed, so a click
    // that DID open the preview is never undone by the retry.
    const run = steps.getByRole("button", { name: /^Run Verify/ }).first();
    await expect(async () => {
      if ((await run.getAttribute("aria-expanded")) !== "true") await run.click();
      await expect(steps.getByText("Before this pivot runs")).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 8000 });
    await expect(steps.getByRole("button", { name: "Start this pivot" })).toBeFocused();
    expect(posts).toEqual([]);
  });
});

test.describe("report readiness and exports", () => {
  test("10 · below the report-safe bar: marked UNVERIFIED DRAFT, and report-safe export is disabled", async ({ page }) => {
    await open(page, THREAD);
    await page.getByRole("tab", { name: /Report/ }).click();
    await expect(page.getByText(/Unverified draft · \d+% ready/)).toBeVisible();
    await expect(page.getByRole("note", { name: /Unverified draft/ })).toBeVisible();
    await page.getByRole("button", { name: "Export draft — not report-safe" }).click();
    await expect(page.getByRole("menuitem", { name: /Report-safe export/ })).toHaveAttribute("aria-disabled", "true");
    await page.getByRole("menuitem", { name: /Markdown/ }).click();
    const dialog = page.getByRole("dialog", { name: "Export an unverified draft?" });
    await expect(dialog).toContainText("Report readiness");
    await expect(dialog).toContainText("Verified");
    await expect(dialog).toContainText("Needs review");
    await expect(dialog).toContainText("Conflict (authority state)");
    await expect(dialog.getByRole("button", { name: /Export draft/ })).toBeDisabled();
  });

  test("11 · at or above the bar: report-safe", async ({ page }) => {
    await open(page, `${THREAD}?scenario=ready`);
    await page.getByRole("tab", { name: /Report/ }).click();
    await expect(page.getByText("Report-safe", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Export report" })).toBeVisible();
    await expect(page.getByRole("note", { name: /Unverified draft/ })).toHaveCount(0);
  });
});

test.describe("12 · mobile 390px", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("navigation is labelled, keyboard-operable, and names the current overflow section", async ({ page }) => {
    await open(page, THREAD);
    for (const name of ["Overview", "Investigate", "Evidence"]) {
      await expect(page.getByRole("tab", { name: new RegExp(name) })).toBeVisible();
    }
    const more = page.getByRole("button", { name: "More sections: Tools, Graph, Report" });
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await more.focus();
    await page.keyboard.press("ArrowDown");
    await expect(more).toHaveAttribute("aria-expanded", "true");
    await page.getByRole("menuitemradio", { name: /Graph/ }).click();
    const current = page.getByRole("button", { name: "More, current section: Graph" });
    await expect(current).toBeVisible();
    await expect(current).toContainText("Graph");
    // Escape returns focus to the trigger.
    await current.focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");
    await expect(current).toBeFocused();
  });

  test("the case strip shows identity and run state; the composer stays reachable", async ({ page }) => {
    await open(page, `${THREAD}?scenario=interrupted`);
    await expect(page.getByText("Interrupted", { exact: true }).first()).toBeVisible();
    await expect(page.getByLabel("Investigation request")).toBeInViewport();
    await expect(page.getByRole("button", { name: "Start investigation" })).toBeInViewport();
    // No page-level horizontal overflow.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("graph defaults to a readable list", async ({ page }) => {
    await open(page, THREAD);
    await page.getByRole("button", { name: "More sections: Tools, Graph, Report" }).click();
    await page.getByRole("menuitemradio", { name: /Graph/ }).click();
    await expect(page.getByRole("button", { name: "List", pressed: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Linked entities/ })).toBeVisible();
  });
});

test.describe("read-only case view", () => {
  test("renders Tools from the same case snapshot (no provider crash)", async ({ page }) => {
    await blockExternalOrigins(page);
    await page.goto("/cases/11111111-2222-4333-8444-555555555555");
    const tools = page.getByRole("tab", { name: /Tools/ });
    await expect(tools).toContainText("18");
    await tools.click();
    await expect(page.getByText("Tool calls", { exact: true })).toBeVisible();
    await expect(page.getByText(/unexpected error/i)).toHaveCount(0);
  });
});
