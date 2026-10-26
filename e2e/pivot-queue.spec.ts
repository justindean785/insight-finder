import { expect, test } from "@playwright/test";

test("mounted transcript and late Workbench reconcile missed tool events, including mobile", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const posts: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST") posts.push(r.url()); });
  await page.route("**/*", (route) => {
    const url = route.request().url();
    return url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost") ? route.continue() : route.abort();
  });
  await page.goto("/chat/11111111-2222-4333-8444-555555555555?scenario=pivot-queue");
  const summary = page.getByRole("complementary", { name: "Next pivots summary" });
  await expect(summary).toContainText("3 next pivots ranked");
  await page.evaluate(() => (window as unknown as { __harnessFinishPivotRun: () => void }).__harnessFinishPivotRun());
  await page.getByRole("button", { name: "Open Next pivots" }).click();
  const next = page.getByRole("tabpanel", { name: "Next" });
  await expect(next.locator("header")).toHaveText("Next steps2");
  await expect(next).not.toContainText("alpha@example.test");
  await expect(summary).toContainText("2 next pivots ranked");

  await page.setViewportSize({ width: 390, height: 844 });
  const steps = page.getByRole("region", { name: "Next steps" }).filter({ visible: true });
  await expect(steps.locator("header")).toHaveText("Next steps2");
  await expect(steps).not.toContainText("alpha@example.test");
  await expect(steps).not.toContainText("Summarize findings");
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(summary).toContainText("2 next pivots ranked");
  expect(posts).toEqual([]);
});
