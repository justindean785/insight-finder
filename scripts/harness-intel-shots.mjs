/** Screenshot the merged Intelligence section out of the UI harness. */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const OUT = process.argv[2] ?? "./ui-shots";
const BASE = process.env.HARNESS_URL ?? "http://127.0.0.1:5174";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", String(e).slice(0, 180)));

for (const tab of ["overview", "analysis", "memories"]) {
  await page.goto(`${BASE}/brain?tab=${tab}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4500);
  await page.screenshot({ path: `${OUT}/intel-${tab}.png`, fullPage: tab === "analysis" });
  console.log("captured", tab);
}

// The redirect must land on the Overview tab, not 404.
await page.goto(`${BASE}/insights`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
console.log("/insights redirected to:", page.url());

await browser.close();
