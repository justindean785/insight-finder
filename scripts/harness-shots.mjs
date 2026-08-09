/**
 * Screenshot every workspace tab out of the UI harness.
 *
 *   (setsid npx vite --config vite.harness.config.ts &)
 *   node scripts/harness-shots.mjs [outDir]
 *
 * Reads the thread id from src/dev/fixtures.json when a real snapshot is
 * present, otherwise falls back to the synthetic thread id.
 */
import { chromium } from "playwright";
import { readFileSync, existsSync, mkdirSync } from "node:fs";

const OUT = process.argv[2] ?? "./ui-shots";
const BASE = process.env.HARNESS_URL ?? "http://127.0.0.1:5174";
const SYNTHETIC_THREAD = "11111111-2222-4333-8444-555555555555";

const threadId = existsSync("src/dev/fixtures.json")
  ? JSON.parse(readFileSync("src/dev/fixtures.json", "utf8")).threadId
  : SYNTHETIC_THREAD;

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", String(e).slice(0, 180)));
page.on("console", (m) => {
  if (m.text().startsWith("[harness]")) console.log(m.text());
});

await page.goto(`${BASE}/chat/${threadId}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);

for (const tab of ["chat", "evidence", "tools", "graph", "report"]) {
  const el = page.locator(`#workspace-tab-${tab}`).first();
  if (await el.count()) {
    await el.click();
    await page.waitForTimeout(2500);
  }
  await page.screenshot({ path: `${OUT}/real-${tab}.png` });
  console.log("captured", tab);
}

await browser.close();
