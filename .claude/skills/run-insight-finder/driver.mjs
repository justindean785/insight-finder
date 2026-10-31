#!/usr/bin/env node
/**
 * Drive the Insight Finder UI harness (vite.harness.config.ts) with headless Chromium.
 *
 * Steps run in order, from argv:
 *   node .claude/skills/run-insight-finder/driver.mjs \
 *     viewport 1280x720  goto /chat/11111111-2222-4333-8444-555555555555 \
 *     tab Overview  shot overview  tab Evidence  shot evidence
 *
 * Steps:
 *   goto <path>        navigate (relative to BASE, default http://127.0.0.1:5174)
 *   viewport <WxH>     resize the page
 *   tab <name>         click the workspace tab whose accessible name matches <name> (regex, i)
 *   click <text>       click the first visible element containing <text>
 *   wait <text>        wait until <text> is visible
 *   fill <ph> <text>   type <text> into the field whose placeholder contains <ph> (React-safe)
 *   press <key>        press a key on the focused element (Enter, Escape, ...)
 *   settle             wait until the "Loading workspace" placeholder is gone (lazy tab chunks)
 *   shot <name>        full-page screenshot -> $OUT/<name>.png
 *   text               print the page's visible body text (first 3000 chars)
 *   sleep <ms>         fixed wait (only for animations; prefer `wait`)
 *
 * Exits non-zero on any step failure or on console errors (set ALLOW_CONSOLE_ERRORS=1 to
 * report them without failing). Env: BASE, OUT (default /tmp/insight-finder-shots).
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE ?? "http://127.0.0.1:5174";
const OUT = process.env.OUT ?? "/tmp/insight-finder-shots";
const THREAD = "/chat/11111111-2222-4333-8444-555555555555";
fs.mkdirSync(OUT, { recursive: true });

const args = process.argv.slice(2);
if (args.length === 0) args.push("goto", THREAD, "tab", "Overview", "settle", "shot", "overview");

// The repo's playwright wants its own Chromium revision; the cloud container ships a
// different one at /opt/pw-browsers/chromium and forbids `playwright install`.
const PINNED = "/opt/pw-browsers/chromium";
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH ?? (fs.existsSync(PINNED) ? PINNED : undefined);
const browser = await chromium.launch({ args: ["--no-sandbox"], executablePath });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
const consoleErrors = [];
// Expected failures, ignored: Google Fonts from index.html (headless Chromium does not use the
// container's HTTPS proxy -> ERR_TUNNEL_CONNECTION_FAILED; fonts fall back), and the app's
// /health maintenance probe to the harness's fake SUPABASE_URL (https://harness.local never
// resolves; only the chat transport is mocked). Anything else that fails is reported.
const IGNORED = /fonts\.(googleapis|gstatic)\.com|\/\/harness\.local\//;
const failedUrls = [];
page.on("requestfailed", (r) => failedUrls.push(r.url()));
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
let failed = false;
try {
  for (let i = 0; i < args.length; i++) {
    const step = args[i];
    const arg = args[i + 1];
    switch (step) {
      case "goto":
        await page.goto(new URL(arg, BASE).toString(), { waitUntil: "domcontentloaded" });
        i++; break;
      case "viewport": {
        const [w, h] = arg.split("x").map(Number);
        await page.setViewportSize({ width: w, height: h });
        i++; break;
      }
      case "tab": {
        const t = page.getByRole("tab", { name: new RegExp(esc(arg), "i") }).first();
        await t.waitFor({ state: "visible", timeout: 20_000 });
        await t.click();
        i++; break;
      }
      case "click":
        await page.getByText(arg, { exact: false }).first().click({ timeout: 10_000 });
        i++; break;
      case "wait":
        await page.getByText(arg, { exact: false }).first().waitFor({ state: "visible", timeout: 20_000 });
        i++; break;
      case "fill": {
        const ph = arg;
        const text = args[i + 2];
        await page.getByPlaceholder(new RegExp(esc(ph), "i")).first().fill(text, { timeout: 10_000 });
        console.log(`ok fill ${ph} ${text}`);
        i += 2;
        continue;
      }
      case "press":
        await page.keyboard.press(arg);
        i++; break;
      case "settle":
        await page.getByText(/loading workspace/i).first().waitFor({ state: "hidden", timeout: 30_000 });
        console.log("ok settle");
        continue;
      case "shot": {
        const file = path.join(OUT, `${arg}.png`);
        await page.screenshot({ path: file, fullPage: true });
        console.log(`shot ${file}`);
        i++; break;
      }
      case "text":
        console.log((await page.locator("body").innerText()).slice(0, 3000));
        break;
      case "sleep":
        await page.waitForTimeout(Number(arg));
        i++; break;
      default:
        throw new Error(`unknown step: ${step}`);
    }
    console.log(`ok ${step}${arg && step !== "text" ? ` ${arg}` : ""}`);
  }
} catch (e) {
  failed = true;
  console.error(`FAIL ${e.message.split("\n")[0]}`);
  const file = path.join(OUT, "failure.png");
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  console.error(`failure screenshot ${file}`);
}
// The console line for a failed request carries no URL and can arrive before `requestfailed`,
// so decide at the end: if every failed request was an expected one, drop the generic network lines.
if (failedUrls.length && failedUrls.every((u) => IGNORED.test(u))) {
  for (let k = consoleErrors.length - 1; k >= 0; k--)
    if (/^Failed to load resource: net::ERR_/.test(consoleErrors[k])) consoleErrors.splice(k, 1);
}
const otherFailed = failedUrls.filter((u) => !IGNORED.test(u));
if (otherFailed.length) {
  console.error(`failed requests: ${otherFailed.slice(0, 10).join(", ")}`);
  // An unexpected failed request is a failure on its own: an aborted request fires
  // `requestfailed` with no console error, and must not let the run exit 0.
  if (!process.env.ALLOW_CONSOLE_ERRORS) failed = true;
}
if (consoleErrors.length) {
  console.error(`console errors (${consoleErrors.length}):`);
  for (const e of consoleErrors.slice(0, 20)) console.error(`  ${e.slice(0, 300)}`);
  if (!process.env.ALLOW_CONSOLE_ERRORS) failed = true;
}
await browser.close();
process.exit(failed ? 1 : 0);
